import { z } from 'zod';
import { APP_VERSION, DEVICE_ID } from '../accounts.js';
import { NOTIFY_CHANNELS, NOTIFY_KINDS, PUSH_PLATFORMS, PUSH_TOKEN } from '../notifications.js';
import { SIGNED_IN } from './access.js';
import { Count, Id, ListQuery, Timestamp, page } from './common.js';

/**
 * A seller's notifications (PRD 5.13, 10.5): the in-app list, the preferences, and the owner app's push token. The
 * work is in src/modules/notifications; the kinds, the wording and the rules are in src/contracts/notifications.js.
 *
 * Every route is for the signed-in seller's own account in the current business: nobody reads or changes another
 * person's list, choices or devices, so none takes a user id. A shopper's session is refused (403).
 */
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 22:00');
const Kind = z.enum(NOTIFY_KINDS);
const ChannelChoices = z.object(Object.fromEntries(NOTIFY_CHANNELS.map((channel) => [channel, z.boolean()])));

export const Notification = z.object({
  id: Id,
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  /** A path: the app opens it with its own scheme, the console under /admin (appLink and consoleLink). */
  link: z.string(),
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
});

export const NotificationListQuery = ListQuery.extend({ unread: z.enum(['1']).optional() });

/** Mark some as read, or all of them. */
export const NotificationsRead = z.union([
  z.object({ ids: z.array(Id).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export const QuietHours = z.object({ enabled: z.boolean(), from: Clock, to: Clock, timezone: z.string().min(1).max(64) });

export const NotificationPrefs = z.object({
  quietHours: QuietHours,
  /** Every kind, every channel, with the defaults filled in. */
  events: z.record(z.string(), ChannelChoices),
  /** What the settings screen needs to draw each row: which channels can be chosen, and which kinds cannot be changed. */
  kinds: z.array(z.object({
    kind: z.string(),
    label: z.string(),
    /** Never delayed by quiet hours. */
    critical: z.boolean(),
    /** A security notice: shown, and cannot be switched off. */
    mandatory: z.boolean(),
    /** The channels a person may switch for this kind. In-app is always on and is never among them. */
    channels: z.array(z.enum(NOTIFY_CHANNELS)),
  })),
  /** Which senders are set up at all. A channel that is false is shown as unavailable. */
  available: z.object({ push: z.boolean(), email: z.boolean(), whatsapp: z.boolean(), inapp: z.boolean() }),
});

/** Only what changes. A choice that cannot be made (in-app off, a security notice) is a validation error on that field. */
export const NotificationPrefsInput = z.object({
  quietHours: QuietHours.partial().optional(),
  events: z.partialRecord(Kind, ChannelChoices.partial()).optional(),
}).refine((v) => v.quietHours !== undefined || v.events !== undefined, { message: 'Nothing to change' });

/** The owner app's push token for this device. deviceId is the id the app signed in with. */
export const PushDeviceInput = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  platform: z.enum(PUSH_PLATFORMS),
  token: z.string().regex(PUSH_TOKEN, 'That is not a push token'),
  appVersion: z.string().regex(APP_VERSION).optional(),
});
export const PushDeviceParams = z.object({ id: z.string().regex(DEVICE_ID) });

export const notificationRoutes = {
  /** Newest first. `unread` is how many are unread in all, for the badge. */
  'notifications.list': { method: 'GET', path: '/notifications', access: SIGNED_IN, query: NotificationListQuery, response: page(Notification).extend({ unread: Count }) },
  'notifications.markRead': { method: 'POST', path: '/notifications/read', access: SIGNED_IN, body: NotificationsRead, status: 204, response: null },
  'notifications.prefs': { method: 'GET', path: '/notifications/prefs', access: SIGNED_IN, response: NotificationPrefs },
  'notifications.savePrefs': { method: 'PUT', path: '/notifications/prefs', access: SIGNED_IN, body: NotificationPrefsInput, response: NotificationPrefs },
};

export const pushRoutes = {
  /** Registers or replaces this device's token. The same token or device seen before moves to this person. */
  'push.register': { method: 'POST', path: '/push/devices', access: SIGNED_IN, body: PushDeviceInput, status: 204, response: null },
  /** Signing out of the app: this device gets no more pushes. :id is the device id. */
  'push.unregister': { method: 'DELETE', path: '/push/devices/:id', access: SIGNED_IN, params: PushDeviceParams, status: 204, response: null },
};
