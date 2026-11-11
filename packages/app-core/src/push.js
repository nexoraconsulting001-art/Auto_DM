/**
 * Push on this device (PRD 10.5). The app registers the device's own FCM or APNs token with the API; Bhava's server
 * sends through its push adapter, and no third-party push service sits between. A build with no push
 * settings (no google-services file, no push entitlement) simply reports that push is off, and everything else works.
 *
 * A push's data carries `tenantId` and `link` (a path). Tapping one for another business switches to that business
 * first, then opens the record (P-13): `watchPushTaps({ router })` hands each tap to the link router (routing.js),
 * which also makes sure the same tap opens once. The push token is never logged and never put in the query cache.
 */
import * as Notifications from 'expo-notifications';
import { pushTarget, tapId } from './routing.js';

export { pushTarget };

/** `reason`: null (registered), 'denied', 'unavailable' (this build or device has no push) or 'failed' (the API refused or was not reached). */
export async function registerForPush({ api, store, app, notifications = Notifications }) {
  let token;
  try {
    let permission = await notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain !== false) permission = await notifications.requestPermissionsAsync();
    if (!permission.granted) return { registered: false, reason: 'denied' };
    token = (await notifications.getDevicePushTokenAsync())?.data;
  } catch {
    return { registered: false, reason: 'unavailable' };
  }
  if (typeof token !== 'string' || !token) return { registered: false, reason: 'unavailable' };
  return sendToken({ api, store, app, token });
}

async function sendToken({ api, store, app, token }) {
  try {
    await api.push.register({ deviceId: await store.getDeviceId(), platform: app.platform, token, appVersion: app.version });
  } catch {
    return { registered: false, reason: 'failed' };
  }
  return { registered: true, reason: null };
}

/** At sign-out, so this phone hears nothing more. Best effort: the server also drops tokens the provider rejects. */
export async function unregisterFromPush({ api, store }) {
  try {
    await api.push.unregister(await store.getDeviceId());
    return true;
  } catch {
    return false;
  }
}

/** FCM and APNs replace a device's token now and then: the new one is registered as it arrives. Returns the way to stop. */
export function watchPushToken({ api, store, app, notifications = Notifications }) {
  if (typeof notifications.addPushTokenListener !== 'function') return () => {};
  const subscription = notifications.addPushTokenListener((event) => {
    if (typeof event?.data === 'string' && event.data) sendToken({ api, store, app, token: event.data }).catch(() => {});
  });
  return () => subscription?.remove?.();
}

/**
 * How a push shows while the app is open, and Android's channel for it (Android 8 and later shows nothing without
 * one; on iOS there is no channel and the call does nothing). `channelName` is the words the phone's settings show.
 */
export async function configurePush({ notifications = Notifications, channelName }) {
  try {
    notifications.setNotificationHandler?.({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    await notifications.setNotificationChannelAsync?.('default', {
      name: channelName,
      importance: notifications.AndroidImportance?.HIGH ?? 4,
      lockscreenVisibility: notifications.AndroidNotificationVisibility?.PRIVATE ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens what a push points at: the business first, then the record. `open(path)` navigates. A push for a business
 * the person no longer belongs to opens nothing. The shell uses the link router instead, which also waits for the
 * new business's screens before it opens the record; this stays for a caller with nothing to wait for.
 */
export async function openPush(response, { session, open }) {
  const target = pushTarget(response);
  if (!target) return false;
  const state = session.getState();
  if (state.tenantId !== target.tenantId) {
    if (!state.businesses.some((business) => business.id === target.tenantId)) return false;
    await session.switchBusiness(target.tenantId);
  }
  open(target.path);
  return true;
}

const handledTaps = new Set();

/**
 * Listens for taps, including the one that launched the app. With `router` (createLinkRouter), each tap goes there;
 * otherwise `open(path)` is called after any switch. The tap that launched the app is handed back by the system each
 * time this is set up, and is opened only once. Returns the way to stop.
 */
export function watchPushTaps({ session, open, router, notifications = Notifications }) {
  const handle = (response) => {
    if (router) return router.openPush(response);
    const id = tapId(response);
    if (id && handledTaps.has(id)) return Promise.resolve(false);
    if (id) handledTaps.add(id);
    return openPush(response, { session, open }).catch(() => false);
  };
  const subscription = notifications.addNotificationResponseReceivedListener(handle);
  Promise.resolve(notifications.getLastNotificationResponseAsync?.()).then((last) => last && handle(last)).catch(() => {});
  return () => subscription.remove();
}
