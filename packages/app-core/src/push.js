/**
 * Push on this device (PRD 10.5). The app registers the device's own FCM or APNs token with the API; Bhava's server
 * sends through its push adapter, and no third-party push service sits between. A build with no push
 * settings (no google-services file, no push entitlement) simply reports that push is off, and everything else works.
 *
 * A push's data carries `tenantId` and `link` (a path). Tapping one for another business switches to that business
 * first, then opens the record (P-13).
 */
import * as Notifications from 'expo-notifications';
import { isLinkPath } from './links.js';

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

/** Where a tapped push leads: { tenantId, path }, or null for one that names no record. */
export function pushTarget(response) {
  const content = response?.notification?.request?.content;
  const data = content?.data ?? response?.notification?.request?.trigger?.remoteMessage?.data ?? response?.data ?? {};
  const tenantId = Number(data.tenantId);
  const path = typeof data.link === 'string' ? data.link : '';
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !isLinkPath(path)) return null;
  return { tenantId, path };
}

/**
 * Opens what a push points at: the business first, then the record. `open(path)` navigates. A push for a business
 * the person no longer belongs to opens nothing.
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

/** Listens for taps, including the one that launched the app. Returns the way to stop. */
export function watchPushTaps({ session, open, notifications = Notifications }) {
  const handle = (response) => openPush(response, { session, open }).catch(() => false);
  const subscription = notifications.addNotificationResponseReceivedListener(handle);
  Promise.resolve(notifications.getLastNotificationResponseAsync?.()).then((last) => last && handle(last)).catch(() => {});
  return () => subscription.remove();
}
