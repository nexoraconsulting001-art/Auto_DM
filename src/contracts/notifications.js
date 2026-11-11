/**
 * Notifications to sellers (PRD 5.13) and owner push (10.5), as data. No imports, so the server, the worker, the console
 * and the owner app read the same rules. One service, ctx.notify (src/modules/notifications), turns each event into
 * deliveries on push, email, WhatsApp and in-app. There is no SMS.
 *
 * Sellers hear from Bhava: Bhava's name, Bhava's sender, Bhava's own WhatsApp number. Shoppers only ever hear from the
 * seller, through ctx.shopperMessages (src/contracts/shopper-messages.js), which stays the only path to a shopper.
 * Nothing here may be used to reach a shopper.
 *
 * The numbers every part keeps to are NOTIFY_RULES. What they mean:
 *
 *   Once.      The same (business, kind, key) inside dedupeMs is one event: emit() answers null for the repeat (F-57).
 *              After that the key may be used again, for something that really did happen again.
 *   Tries.     A delivery is tried maxAttempts times, backoffMs apart, then marked failed with the provider's kind as the
 *              reason (F-59). Only a retryable failure is tried again.
 *   Collapse.  Push only, and only kinds with `collapse`. The first event of a kind for a business opens a group: its push
 *              waits collapseHoldMs, and every event of that kind for that business that arrives meanwhile joins it
 *              (status `collapsed`, collapsed_into the group's delivery). The one push that goes out uses the wording
 *              for many with the count ("5 new orders", P-21). An event that arrives after the push went, but inside
 *              collapseMs of the group's first event, sends the group's push again with the new count and the same
 *              collapseKey, so the phone still shows one. Critical kinds never wait and never collapse (P-20).
 *   Quiet.     A person's quiet hours hold push and WhatsApp for kinds that are not critical until they end. Email and
 *              in-app are not held. A critical kind is never delayed.
 *   Tokens.    A push token the provider calls unregistered or invalid is deleted at once (P-23).
 *   Members.   Recipients are worked out when the event is handed out, and checked again before each try: an account
 *              removed from the business (users.removed_at) gets nothing more from it, queued deliveries included
 *              (status `dropped`, reason `removed`).
 *   Privacy.   An event's data is ids and numbers only (dataProblem). A push carries tenantId, the kind and a deep link,
 *              and its words never hold a shopper's name, phone, address or payment detail (pushProblem, P-22).
 */
export const NOTIFY_CHANNELS = Object.freeze(['push', 'email', 'whatsapp', 'inapp']);

export const NOTIFY_RULES = Object.freeze({
  dedupeMs: 10 * 60_000,
  maxAttempts: 3,
  backoffMs: Object.freeze([30_000, 120_000]), // before the 2nd and the 3rd try
  collapseMs: 60_000,
  collapseHoldMs: 45_000,
  /** How long a push is worth delivering: the provider drops it after this. */
  pushTtlSeconds: 6 * 3600,
  /** How often the worker looks for work, so a critical push leaves well inside 30 s. */
  pollMs: 5000,
});

export const DELIVERY_STATUSES = Object.freeze(['queued', 'sent', 'failed', 'dropped', 'collapsed']);

/** Why a delivery ended without being sent, beside a provider's error kind. */
export const DELIVERY_REASONS = Object.freeze({
  /** The channel has no sender configured (no PUSH_DRIVER, no platform WhatsApp number, no platform email). The others still deliver. */
  notConfigured: 'not_configured',
  /** The person switched this kind off on this channel. */
  prefOff: 'pref_off',
  /** Removed from the business since the event. */
  removed: 'removed',
  /** No device, no verified phone or no email address to send to. */
  noAddress: 'no_address',
  /** The words or the payload broke a rule below; nothing was sent. */
  content: 'content',
  /** The provider may have sent it and the answer was lost: a WhatsApp message is never sent again on a guess. */
  unknownDelivery: 'unknown_delivery',
});

/**
 * Who an event is for. emit() takes one of these as `audience`, or leaves it out for the kind's own:
 *   'owner'             the owner or owners
 *   'managers'          owners and managers
 *   'orders', 'automations', ...   owners, managers and staff holding that permission (PERMISSIONS in api/access.js)
 *   { userId }          one account in this business (a report's reader, the person who just signed in)
 * A removed account is never in any of them.
 */
export const NOTIFY_AUDIENCES = Object.freeze(['owner', 'managers', 'catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox']);

/** The only values wording may carry. None can hold anything about a shopper: counts, the order's number, and the workspace's own name. */
export const WORDING_PLACEHOLDERS = Object.freeze(['count', 'business', 'orderNumber', 'percent', 'days', 'account']);

/** Email layouts (src/modules/notifications renders them). Every one is Bhava's: its logo, its sender, its footer. */
export const EMAIL_LAYOUTS = Object.freeze(['alert', 'security', 'report', 'account']);

/** What Bhava's WhatsApp templates are called in its own account. PLATFORM_WHATSAPP_TEMPLATES may rename any of them. */
export const CODE_TEMPLATE = 'login_code';

const event = (spec) => Object.freeze({ critical: false, collapse: false, mandatory: false, ...spec, channels: Object.freeze(spec.channels), one: Object.freeze(spec.one), many: Object.freeze(spec.many) });

/**
 * Every kind of notification. Adding one is adding a row here and nothing else: there is never code for one business.
 *
 *   label      what the settings screen calls it
 *   critical   never delayed by quiet hours, never held to collapse
 *   mandatory  a security notice: preferences cannot switch it off
 *   audience   who gets it unless emit() says otherwise
 *   channels   the channels it uses until the person chooses. In-app is always among them: it is the record
 *   collapse   same-kind events for one business become one push
 *   one, many  the wording, as { title, body }: `many` when a push stands for {count} events. Bhava's words to a seller
 *   email      the layout id (EMAIL_LAYOUTS)
 *   whatsapp   the template name in Bhava's own WhatsApp account, '' when the kind never goes by WhatsApp
 *   link       where a tap goes, as a path filled from the event's data: appLink(path) for the owner app,
 *              consoleLink(path) for the web console
 */
export const NOTIFY_EVENTS = Object.freeze({
  'order.new': event({
    label: 'New orders', audience: 'orders', channels: ['push', 'email', 'inapp'], collapse: true,
    one: { title: 'New order', body: 'Order {orderNumber} is in. Tap to see it.' },
    many: { title: '{count} new orders', body: 'Tap to see them.' },
    email: 'alert', whatsapp: 'bhava_order_new', link: '/orders/{orderId}',
  }),
  'order.cod_to_confirm': event({
    label: 'Cash on delivery orders to confirm', audience: 'orders', channels: ['push', 'inapp'], critical: true,
    one: { title: 'Cash on delivery order to confirm', body: 'Order {orderNumber} is waiting for you to confirm it.' },
    many: { title: '{count} cash on delivery orders to confirm', body: 'Tap to confirm them.' },
    email: 'alert', whatsapp: 'bhava_cod_to_confirm', link: '/orders/{orderId}',
  }),
  'token.expiring': event({
    label: 'A connection is about to run out', audience: 'owner', channels: ['push', 'email', 'inapp'],
    one: { title: 'Reconnect {account} soon', body: 'The connection runs out in {days} days. Reconnect to keep your automations running.' },
    many: { title: '{count} connections run out soon', body: 'Reconnect them to keep your automations running.' },
    email: 'alert', whatsapp: '', link: '/settings/instagram',
  }),
  'token.invalid': event({
    label: 'A connection stopped working', audience: 'owner', channels: ['push', 'email', 'whatsapp', 'inapp'], critical: true,
    one: { title: 'Reconnect {account} now', body: 'The connection stopped working, so replies are paused. Reconnect to resume.' },
    many: { title: '{count} connections stopped working', body: 'Replies are paused. Reconnect to resume.' },
    email: 'alert', whatsapp: 'bhava_token_invalid', link: '/settings/instagram',
  }),
  'dm.usage_80': event({
    label: 'Messages nearly used up', audience: 'owner', channels: ['email', 'inapp'],
    one: { title: 'You have used {percent}% of this month\'s messages', body: 'See your plan to add more before they run out.' },
    many: { title: 'You have used {percent}% of this month\'s messages', body: 'See your plan to add more before they run out.' },
    email: 'alert', whatsapp: '', link: '/settings/plan',
  }),
  'dm.usage_100': event({
    label: 'Messages used up', audience: 'owner', channels: ['push', 'email', 'inapp'], critical: true,
    one: { title: 'This month\'s messages are used up', body: 'Automatic replies have stopped. Change your plan to resume.' },
    many: { title: 'This month\'s messages are used up', body: 'Automatic replies have stopped. Change your plan to resume.' },
    email: 'alert', whatsapp: 'bhava_usage_full', link: '/settings/plan',
  }),
  needs_human: event({
    label: 'Conversations that need a person', audience: 'inbox', channels: ['push', 'inapp'], collapse: true,
    one: { title: 'A conversation needs you', body: 'Someone is waiting for a reply from a person.' },
    many: { title: '{count} conversations need you', body: 'People are waiting for a reply from a person.' },
    email: 'alert', whatsapp: '', link: '/inbox/needs-human',
  }),
  'reach_guard.alert': event({
    label: 'Reach Guard alerts', audience: 'owner', channels: ['push', 'email', 'inapp'], critical: true,
    one: { title: 'Reach Guard paused sending', body: 'Sending is paused on {account} to protect its reach. Tap to see why.' },
    many: { title: 'Reach Guard paused sending', body: 'Sending is paused on {count} accounts to protect their reach.' },
    email: 'alert', whatsapp: '', link: '/reach-guard',
  }),
  'payment.failed': event({
    label: 'Payments that did not go through', audience: 'orders', channels: ['push', 'inapp'], collapse: true,
    one: { title: 'A payment did not go through', body: 'Order {orderNumber} is still unpaid.' },
    many: { title: '{count} payments did not go through', body: 'Tap to see the orders.' },
    email: 'alert', whatsapp: '', link: '/orders/{orderId}',
  }),
  'return.requested': event({
    label: 'Return requests', audience: 'orders', channels: ['push', 'email', 'inapp'], collapse: true,
    one: { title: 'Return requested', body: 'A return was requested on order {orderNumber}.' },
    many: { title: '{count} returns requested', body: 'Tap to see them.' },
    email: 'alert', whatsapp: '', link: '/returns/{returnId}',
  }),
  'report.weekly': event({
    label: 'Weekly report', audience: 'owner', channels: ['push', 'email', 'inapp'],
    one: { title: 'Your weekly report is ready', body: 'See how {business} did this week.' },
    many: { title: 'Your weekly report is ready', body: 'See how {business} did this week.' },
    email: 'report', whatsapp: '', link: '/reports/{reportRunId}',
  }),
  'report.monthly': event({
    label: 'Monthly report', audience: 'owner', channels: ['push', 'email', 'inapp'],
    one: { title: 'Your monthly report is ready', body: 'See how {business} did this month.' },
    many: { title: 'Your monthly report is ready', body: 'See how {business} did this month.' },
    email: 'report', whatsapp: '', link: '/reports/{reportRunId}',
  }),
  'staff.changed': event({
    label: 'Changes to your team', audience: 'owner', channels: ['email', 'inapp'], mandatory: true,
    one: { title: 'Your team changed', body: 'Someone was added to, changed in or removed from the team of {business}.' },
    many: { title: 'Your team changed', body: '{count} changes were made to the team of {business}.' },
    email: 'security', whatsapp: '', link: '/settings/team',
  }),
  'device.signed_in': event({
    label: 'New sign-ins', audience: 'owner', channels: ['push', 'email', 'inapp'], critical: true, mandatory: true,
    one: { title: 'New sign-in to your account', body: 'A new device signed in. If this was not you, remove it under Devices.' },
    many: { title: 'New sign-ins to your account', body: '{count} new devices signed in. If this was not you, remove them under Devices.' },
    email: 'security', whatsapp: '', link: '/settings/devices',
  }),
  'account.deletion_requested': event({
    label: 'Account deletion', audience: 'owner', channels: ['email', 'whatsapp', 'inapp'], critical: true, mandatory: true,
    one: { title: 'Account deletion requested', body: 'Your account will be deleted in {days} days. Sign in to cancel.' },
    many: { title: 'Account deletion requested', body: 'Your account will be deleted in {days} days. Sign in to cancel.' },
    email: 'account', whatsapp: 'bhava_account_deletion', link: '/settings/account',
  }),
  // Used in Phase 6: where the business's own app stands in store review.
  'app.review_state': event({
    label: 'Your app in store review', audience: 'owner', channels: ['push', 'email', 'inapp'],
    one: { title: 'Your app\'s review moved on', body: 'See where the app for {business} stands.' },
    many: { title: 'Your app\'s review moved on', body: 'See where the app for {business} stands.' },
    email: 'account', whatsapp: '', link: '/app',
  }),
});

export const NOTIFY_KINDS = Object.freeze(Object.keys(NOTIFY_EVENTS));

/** Kinds starting with these are kept for a later phase: emit() refuses them until their rows are added above. billing.* is Phase 7. */
export const RESERVED_PREFIXES = Object.freeze(['billing.']);
export const isReservedKind = (kind) => RESERVED_PREFIXES.some((prefix) => String(kind).startsWith(prefix));

/**
 * What already exists and feeds the service, without those modules changing (the notifications module drains them):
 *
 *   alerts             repos.alerts.raise rows with audience 'owner' and notified_at empty. `alerts` maps the alert's kind to
 *                      a notification kind; an alert kind not listed stays in-app in the alerts list only. Key `alert:<id>`.
 *   reportDeliveries   report_deliveries rows still queued with notified_at empty, to their one reader ({ userId }), on the
 *                      row's own channel. Key `report_delivery:<id>`. The kind follows the report's period.
 *   orderEvents        the order event bus (ctx.orderEvents.on in setup). `order.confirmed` is "a new order": a cash on
 *                      delivery one becomes order.cod_to_confirm, any other order.new. Key `order:<orderId>`.
 */
export const NOTIFY_SOURCES = Object.freeze({
  alerts: Object.freeze({
    'thread.handoff': 'needs_human',
    'reach_guard.tripped': 'reach_guard.alert',
    'reach_guard.permission_needed': 'reach_guard.alert',
    'return.requested': 'return.requested',
    'token.expiring': 'token.expiring',
    'token.invalid': 'token.invalid',
  }),
  orderEvents: Object.freeze({ 'order.confirmed': 'order.new', 'payment.failed': 'payment.failed' }),
  reportPeriods: Object.freeze({ weekly: 'report.weekly', monthly: 'report.monthly' }),
});

/** What sendCode() may be asked for: the purposes of seller_login_codes. */
export const CODE_PURPOSES = Object.freeze(['signin', 'reauth', 'link']);

/**
 * sendCode()'s answer is { outcome: 'sent' | 'failed', reason, retryable }. It never throws for a provider's refusal.
 *   not_configured   Bhava's WhatsApp number is not set up: offer Google sign-in
 *   no_whatsapp      the number cannot receive WhatsApp: "Use Google sign-in" (F-118). There is no SMS fallback
 *   invalid          not a number, not a six digit code, or not a purpose
 *   provider         the provider refused or could not be reached; `retryable` says whether asking again may work
 *   unknown_delivery it may have gone out: the person can ask for a new code, the same one is never sent twice
 */
export const CODE_REASONS = Object.freeze({ ok: 'ok', notConfigured: 'not_configured', noWhatsApp: 'no_whatsapp', invalid: 'invalid', provider: 'provider', unknownDelivery: 'unknown_delivery' });
/** WhatsApp's error codes for a number it cannot deliver to. */
export const NO_WHATSAPP_CODES = Object.freeze(['131026', '131030', '131021', '1013']);

// ---- Links ----

export const OWNER_APP_LINK_SCHEME = 'bhavabusiness'; // OWNER_APP_SCHEME in api/provider.js; a test keeps them equal
const LINK_PATH = /^\/[a-z0-9][a-z0-9/_-]{0,190}$/;
export const isLinkPath = (path) => typeof path === 'string' && (path === '/' || (LINK_PATH.test(path) && !path.includes('//')));
/** The same record in the owner app and in the web console. A push carries the path; each client opens its own form of it. */
export const appLink = (path) => `${OWNER_APP_LINK_SCHEME}:/${path}`;
export const consoleLink = (path) => `/admin${path === '/' ? '' : path}`;

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
/** Fills {name} from `values`. A value that is missing leaves nothing behind, never the braces. */
export const fill = (template, values = {}) => String(template).replace(PLACEHOLDER, (_m, name) => (values[name] === undefined || values[name] === null ? '' : String(values[name]))).replace(/\s{2,}/g, ' ').trim();

/** The path a kind links to, from the event's data. Falls back to the list (the path up to the first missing id). */
export function linkFor(kind, data = {}) {
  const pattern = NOTIFY_EVENTS[kind]?.link ?? '/';
  let missing = false;
  const path = pattern.replace(PLACEHOLDER, (_m, name) => {
    const value = data[name];
    if (value === undefined || value === null || !/^[A-Za-z0-9_-]{1,64}$/.test(String(value))) missing = true;
    return missing ? '\0' : String(value).toLowerCase();
  });
  if (!missing) return path;
  const cut = path.slice(0, path.indexOf('\0')).replace(/\/+$/, '');
  return cut || '/';
}

/** The words for an event, or for `count` of them. `values` come from the event's data and the business's own name. */
export function wordingFor(kind, { count = 1, values = {} } = {}) {
  const spec = NOTIFY_EVENTS[kind];
  if (!spec) throw new Error(`"${kind}" is not a notification kind (src/contracts/notifications.js)`);
  const words = count > 1 ? spec.many : spec.one;
  const filled = { ...values, count };
  return { title: fill(words.title, filled), body: fill(words.body, filled) };
}

// ---- The wording rules, as checks ----

/**
 * An event's data is ids and numbers only: a flat object whose values are whole numbers, booleans or short id-like text
 * (an order number, a status, 'instagram'). A handle, a name or a number someone can be reached on is never one: {account}
 * in the wording is the channel's name (Instagram, Facebook), not a handle. Returns null or the reason.
 */
const DATA_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,39}$/;
export function dataProblem(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'data is an object';
  const entries = Object.entries(data);
  if (entries.length > 12) return 'data holds at most 12 values';
  for (const [key, value] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(key)) return `"${key}" is not a data key`;
    if (/(name|phone|email|address|text|message|token|card|upi|vpa|pincode)/i.test(key) && !/^(orderNumber|account)$/.test(key)) return `"${key}" could hold personal data`;
    if (typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return `"${key}" is not a whole number`;
      continue;
    }
    if (typeof value !== 'string' || !DATA_TEXT.test(value)) return `"${key}" is not an id, a number or a status`;
    if (/^\+?\d{10,15}$/.test(value)) return `"${key}" looks like a phone number`;
  }
  return null;
}

/** The only keys a push's data may carry. tenantId and link are always there (PRD 10.5). */
export const PUSH_DATA_KEYS = Object.freeze(['tenantId', 'link', 'kind', 'eventId', 'count']);

const PHONE_LIKE = /(?<![A-Za-z0-9#-])\+?\d[\d\s-]{8,}\d/; // ten digits or more, however they are spaced
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MONEY_LIKE = /₹|\bRs\.?\s?\d|\bINR\b|\bUPI\b|\bcard\b|\bVPA\b/i;
const ADDRESS_LIKE = /\bpin ?code\b|\bdeliver(y|ing)? to\b|\bship(ping)? to\b/i;

/**
 * A push that may leave (P-22, Apple 4.5.4): no phone number, no email address, no amount or payment detail, no address,
 * a tenantId and a deep link in its data, and nothing else there. Run on the finished title, body and data, so it
 * holds whatever a caller put in the event. Returns null or the reason.
 */
export function pushProblem({ title, body, data } = {}) {
  const text = `${title ?? ''}\n${body ?? ''}`;
  if (!String(title ?? '').trim()) return 'a push needs a title';
  if (text.length > 240) return 'a push is at most 240 characters';
  if (PHONE_LIKE.test(text)) return 'a push never holds a phone number';
  if (EMAIL_LIKE.test(text)) return 'a push never holds an email address';
  if (MONEY_LIKE.test(text)) return 'a push never holds an amount or a payment detail';
  if (ADDRESS_LIKE.test(text)) return 'a push never holds an address';
  if (data === null || typeof data !== 'object') return 'a push carries data';
  for (const key of Object.keys(data)) if (!PUSH_DATA_KEYS.includes(key)) return `a push's data has no "${key}"`;
  if (!/^[1-9]\d*$/.test(String(data.tenantId ?? ''))) return 'a push carries tenantId';
  if (!isLinkPath(data.link)) return 'a push carries a deep link';
  return null;
}

/**
 * The wording of a kind, checked once for every kind by a test: only the placeholders in WORDING_PLACEHOLDERS (none of
 * which can hold a shopper's name, phone, address or payment detail), the same rules a push is held to, and a link
 * pattern that is a path of ids.
 */
export function wordingProblem(kind) {
  const spec = NOTIFY_EVENTS[kind];
  if (!spec) return 'not a kind';
  for (const words of [spec.one, spec.many]) {
    for (const part of [words.title, words.body]) {
      for (const [, name] of String(part).matchAll(PLACEHOLDER)) if (!WORDING_PLACEHOLDERS.includes(name)) return `{${name}} is not a wording placeholder`;
    }
    const problem = pushProblem({ ...wordingFor(kind, { count: words === spec.many ? 5 : 1, values: { business: 'Shop', orderNumber: 'MM-1001', percent: 80, days: 7, account: 'Instagram' } }), data: { tenantId: 1, link: '/' } });
    if (problem) return problem;
  }
  if (!isLinkPath(spec.link.replace(PLACEHOLDER, 'x'))) return 'the link is a path';
  if (typeof spec.label !== 'string' || !spec.label || pushProblem({ title: spec.label, data: { tenantId: 1, link: '/' } })) return 'a label in plain words';
  if (!spec.channels.includes('inapp')) return 'in-app is always a channel';
  if (!spec.channels.every((c) => NOTIFY_CHANNELS.includes(c))) return 'an unknown channel';
  if (!EMAIL_LAYOUTS.includes(spec.email)) return 'an unknown email layout';
  if (spec.whatsapp !== '' && !/^[a-z0-9_]{1,60}$/.test(spec.whatsapp)) return 'a WhatsApp template name is lower case, digits and underscores';
  if (spec.channels.includes('whatsapp') && !spec.whatsapp) return 'a WhatsApp channel needs a template';
  if (spec.critical && spec.collapse) return 'a critical kind never waits to collapse';
  return null;
}

/** The platform's name: every seller message carries it, and nothing to a shopper ever does. */
export const BRAND_NAME = 'Bhava';
/** The one place a business's logo may appear in a seller message: an image marked as the workspace badge. */
export const WORKSPACE_BADGE = 'data-workspace-badge';
/** The one other image a seller email may hold: Bhava's own logo. */
export const BRAND_LOGO = 'data-bhava-logo';

/**
 * A seller email that may leave (F-58, F-88): it says Bhava, it is from Bhava's sender, and every image in it is either
 * Bhava's logo or the workspace badge, of which there is at most one. Returns null or the reason.
 */
export function sellerEmailProblem({ from, html } = {}, { platformFrom } = {}) {
  if (!platformFrom || String(from ?? '').toLowerCase() !== String(platformFrom).toLowerCase()) return 'a seller email is from Bhava\'s sender';
  const markup = String(html ?? '');
  if (!markup.includes(BRAND_NAME)) return 'a seller email is Bhava-branded';
  const images = markup.match(/<img\b[^>]*>/gi) ?? [];
  const badges = images.filter((tag) => tag.includes(WORKSPACE_BADGE));
  if (badges.length > 1) return 'the business logo shows once, as the workspace badge';
  if (images.some((tag) => !tag.includes(WORKSPACE_BADGE) && !tag.includes(BRAND_LOGO))) return 'the only images are Bhava\'s logo and the workspace badge';
  if (/background(-image)?\s*:[^;"']*url\(/i.test(markup)) return 'no background images';
  return null;
}

// ---- Preferences ----

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, from: '22:00', to: '07:00', timezone: DEFAULT_TIMEZONE });
/** The channels quiet hours hold. Email and in-app wake nobody. */
export const QUIET_CHANNELS = Object.freeze(['push', 'whatsapp']);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return typeof zone === 'string' && zone.length <= 64;
  } catch {
    return false;
  }
}

/**
 * A person's choices with every default filled in: { quietHours, events: { [kind]: { push, email, whatsapp, inapp } } }.
 * `saved` is what notification_prefs holds (only what differs from the defaults). In-app is always on; a mandatory kind
 * keeps its own channels whatever was saved; a channel a kind has no template for (WhatsApp) stays off.
 */
export function resolvePrefs(saved = {}) {
  const quiet = saved?.quietHours ?? {};
  const quietHours = {
    enabled: quiet.enabled === true,
    from: CLOCK.test(quiet.from ?? '') ? quiet.from : DEFAULT_QUIET_HOURS.from,
    to: CLOCK.test(quiet.to ?? '') ? quiet.to : DEFAULT_QUIET_HOURS.to,
    timezone: isTimezone(quiet.timezone) ? quiet.timezone : DEFAULT_TIMEZONE,
  };
  const events = {};
  for (const [kind, spec] of Object.entries(NOTIFY_EVENTS)) {
    const chosen = saved?.events?.[kind] ?? {};
    events[kind] = Object.fromEntries(NOTIFY_CHANNELS.map((channel) => {
      const byDefault = spec.channels.includes(channel);
      if (channel === 'inapp') return [channel, true];
      if (channel === 'whatsapp' && !spec.whatsapp) return [channel, false];
      if (spec.mandatory) return [channel, byDefault];
      return [channel, typeof chosen[channel] === 'boolean' ? chosen[channel] : byDefault];
    }));
  }
  return { quietHours, events };
}

/** Why a choice cannot be saved, or null: in-app cannot be switched off, a mandatory kind cannot be changed, WhatsApp needs a template. */
export function prefProblem(kind, channel, enabled) {
  const spec = NOTIFY_EVENTS[kind];
  if (!spec || !NOTIFY_CHANNELS.includes(channel) || typeof enabled !== 'boolean') return 'invalid';
  if (channel === 'inapp' && !enabled) return 'In-app notifications are always on.';
  if (spec.mandatory && enabled !== spec.channels.includes(channel)) return 'Security notices cannot be changed.';
  if (channel === 'whatsapp' && enabled && !spec.whatsapp) return 'This notification is not sent by WhatsApp.';
  return null;
}

const minutesOf = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
function localMinutes(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const read = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

/** Null when `at` is outside the person's quiet hours, or the Date they end. Hours that are equal mean none. */
export function quietUntil(quietHours, at = new Date()) {
  if (!quietHours?.enabled) return null;
  const from = minutesOf(quietHours.from);
  const to = minutesOf(quietHours.to);
  if (from === to) return null;
  const now = localMinutes(at, quietHours.timezone);
  const inside = from < to ? now >= from && now < to : now >= from || now < to;
  if (!inside) return null;
  const wait = (to - now + 1440) % 1440 || 1440;
  const end = new Date(at.getTime() + wait * 60_000);
  end.setUTCSeconds(0, 0);
  return end;
}

/**
 * When a delivery of `kind` on `channel` may go for a person with `prefs` (from resolvePrefs): null when they switched it
 * off, otherwise a Date. A critical kind is always `now`: quiet hours never delay it. A kind that collapses holds its push
 * for collapseHoldMs first.
 */
export function deliverAt(kind, channel, prefs, now = new Date()) {
  const spec = NOTIFY_EVENTS[kind];
  if (!spec || !prefs?.events?.[kind]?.[channel]) return null;
  if (spec.critical) return now;
  let at = channel === 'push' && spec.collapse ? new Date(now.getTime() + NOTIFY_RULES.collapseHoldMs) : now;
  if (QUIET_CHANNELS.includes(channel)) {
    const until = quietUntil(prefs.quietHours, at);
    if (until) at = until;
  }
  return at;
}

/** When the next try is due after `attempt` tries failed, or null when that was the last (F-59). */
export function nextAttemptAt(attempt, now = new Date()) {
  if (attempt >= NOTIFY_RULES.maxAttempts) return null;
  return new Date(now.getTime() + NOTIFY_RULES.backoffMs[Math.max(1, Math.min(attempt, NOTIFY_RULES.backoffMs.length)) - 1]);
}

/** The collapseKey a group's push carries, so a second send replaces the first on the phone. */
export const collapseKeyFor = ({ tenantId, kind, groupId }) => `t${tenantId}.${kind}.${groupId}`.slice(0, 64);

// ---- Push ----

export const PUSH_PLATFORMS = Object.freeze(['android', 'ios']);
/** What a push provider's refusal is called (ProviderError.kind in src/adapters/push). The first two delete the token. */
export const PUSH_ERROR_KINDS = Object.freeze(['unregistered', 'invalid_token', 'throttled', 'unavailable', 'timeout']);
export const PUSH_TOKEN_GONE = Object.freeze(['unregistered', 'invalid_token']);
export const PUSH_TOKEN = /^[A-Za-z0-9_:.-]{16,4096}$/;
