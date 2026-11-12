/**
 * Push for the shopper (PRD 10.11). Three rules this file keeps:
 *   - the phone is asked for notifications only after the first order, and only after our own explainer; browsing never asks;
 *   - that first ask turns on Order updates and nothing else: Offers and New reels stay off until the shopper turns each on in
 *     the app's notification settings, with an explicit choice;
 *   - the app works fully if the phone says no.
 * `notifications` is expo-notifications (or a stand-in). `flag` keeps whether the explainer was shown on this phone.
 */
const FLAG = 'explained';

export function permissionOf(result, notifications) {
  if (result?.granted) return 'granted';
  const provisional = notifications?.IosAuthorizationStatus?.PROVISIONAL;
  if (provisional !== undefined && result?.ios?.status === provisional) return 'provisional';
  return result?.status === 'undetermined' ? 'not_asked' : 'denied';
}

export function createNotifier({ client, notifications, flag }) {
  const read = () => Promise.resolve(flag?.get(FLAG)).catch(() => null);
  return Object.freeze({
    prefs: () => client.call('pushPrefsGet'),

    /** Whether the explainer should be shown now: the phone was never asked and the explainer was not shown before. */
    async shouldExplain() {
      if ((await read()) === '1') return false;
      try {
        const prefs = await client.call('pushPrefsGet');
        return prefs.permission === 'not_asked';
      } catch {
        return false;
      }
    },

    /** "Not now" on the explainer: not asked again after the next order either. */
    async declineExplainer() {
      await flag?.set(FLAG, '1');
    },

    /** The system prompt (when the phone has not been asked), then this phone's address sent to the store. Changes no choice. */
    async registerDevice() {
      let permission = 'denied';
      let token = null;
      try {
        let result = await notifications.getPermissionsAsync();
        if (!result.granted && result.canAskAgain !== false) result = await notifications.requestPermissionsAsync();
        permission = permissionOf(result, notifications);
        if (permission === 'granted' || permission === 'provisional') token = (await notifications.getDevicePushTokenAsync())?.data ?? null;
      } catch {
        permission = permission === 'granted' ? 'granted' : 'denied';
      }
      if (typeof token !== 'string' || !token) {
        // Refused, or this build has no push: say so, and carry on. Nothing else changes.
        const said = permission === 'granted' || permission === 'provisional' ? 'not_asked' : permission;
        await client.call('pushDevice', { body: { token: null, permission: said } }).catch(() => {});
        return { permission, registered: false };
      }
      await client.call('pushDevice', { body: { token, permission } });
      return { permission, registered: true };
    },

    /**
     * "Turn on" on the explainer: the system prompt, then the device's address and Order updates, and only Order updates.
     * `orderToken` follows the order just placed, which is how a guest hears about it.
     */
    async accept({ orderToken } = {}) {
      await flag?.set(FLAG, '1');
      const done = await this.registerDevice();
      if (!done.registered) return done;
      await client.call('pushPrefsSave', { body: { orderUpdates: true, source: 'first_order_prompt' } });
      if (orderToken) await client.call('pushFollowOrder', { body: { orderToken } }).catch(() => {});
      return done;
    },

    /** Offers and New reels turn on only here, one at a time, with an explicit true. */
    save: (change) => client.call('pushPrefsSave', { body: { ...change, source: 'settings' } }),

    /** Turning Offers or New reels on from settings: the phone is asked first if it never was, then the choice is saved. */
    async enable(change) {
      const prefs = await client.call('pushPrefsGet');
      if (prefs.permission === 'not_asked') {
        const done = await this.registerDevice();
        if (!done.registered) return { saved: false, permission: done.permission };
      } else if (prefs.permission === 'denied') {
        return { saved: false, permission: 'denied' };
      }
      return { saved: true, prefs: await this.save(change) };
    },

    /** Sign-out: this phone hears nothing more. Best effort. */
    forget: () => client.call('pushDeviceRemove').catch(() => {}),
  });
}
