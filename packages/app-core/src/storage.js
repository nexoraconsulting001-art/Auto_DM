/**
 * What an app keeps on the device about a sign-in, and where: all of it in SecureStore (the Keychain on iOS, the
 * Keystore on Android), tied to this device and left out of backups. The access token is never stored at all: it
 * lives in memory for its fifteen minutes. Nothing here may be moved to AsyncStorage or a file; a test fails on any
 * import of AsyncStorage.
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** Everything about a sign-in. Signing out deletes each of these. */
export const SESSION_KEYS = Object.freeze(['refresh', 'device_secret', 'lock', 'lock_offered', 'tenant', 'snapshot']);
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `prefix` keeps two apps, or two builds of one, apart: 'bhava.owner' for the owner app. */
export function createSecureStore({ prefix, secureStore = SecureStore, crypto = Crypto } = {}) {
  if (!/^[a-z][a-z0-9.]{2,40}$/.test(prefix ?? '')) throw new Error('A storage prefix is required, such as "bhava.owner"');
  const options = { keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const key = (name) => `${prefix}.${name}`;
  const read = (name) => secureStore.getItemAsync(key(name), options).catch(() => null);
  const write = (name, value) => (value === null || value === undefined || value === '' ? secureStore.deleteItemAsync(key(name), options) : secureStore.setItemAsync(key(name), String(value), options));

  return {
    getRefreshToken: () => read('refresh'),
    setRefreshToken: (token) => write('refresh', token),

    /** The secret that proves this device at a re-auth, shown once by the server when fingerprint or face unlock is turned on. */
    getDeviceSecret: () => read('device_secret'),
    setDeviceSecret: (secret) => write('device_secret', secret),

    /** Whether the app asks for fingerprint, face or the device passcode before releasing the refresh token. */
    isLockEnabled: async () => (await read('lock')) === '1',
    setLockEnabled: (on) => write('lock', on ? '1' : null),
    /** Whether fingerprint or face unlock was offered since this sign-in, so the offer is made once and not on every launch. */
    wasLockOffered: async () => (await read('lock_offered')) === '1',
    setLockOffered: () => write('lock_offered', '1'),

    /** The language the person chose in the app, or null for the phone's own. Kept across sign-outs: it is not about anyone. */
    getLocale: async () => {
      const value = await read('locale');
      return /^[a-z]{2}$/.test(value ?? '') ? value : null;
    },
    setLocale: (locale) => write('locale', /^[a-z]{2}$/.test(locale ?? '') ? locale : null),

    /** The business last worked in, so a restart opens the same one. */
    getTenantId: async () => {
      const value = Number(await read('tenant'));
      return Number.isInteger(value) && value > 0 ? value : null;
    },
    setTenantId: (id) => write('tenant', id),

    /** Who was signed in and where, without any token: what the app shows before the network answers. */
    getSnapshot: async () => {
      try {
        return JSON.parse((await read('snapshot')) ?? 'null');
      } catch {
        return null;
      }
    },
    setSnapshot: (snapshot) => write('snapshot', snapshot ? JSON.stringify(snapshot) : null),

    /** Chosen once at install and never changed: what Settings > Devices lists, and what a revoke ends. */
    async getDeviceId() {
      const held = await read('device_id');
      if (held && DEVICE_ID.test(held)) return held;
      const bytes = await crypto.getRandomBytesAsync(24);
      const id = Array.from(bytes, (b) => B64URL[b % 64]).join('');
      await write('device_id', id);
      return id;
    },

    /**
     * Signing out, a revoked device and a revoked family all end here: the refresh token, the device's unlock secret,
     * the lock, the business and what was known about it leave SecureStore. The device id stays: it names this phone in
     * Settings > Devices and is no secret.
     */
    async clearSession() {
      await Promise.all(SESSION_KEYS.map((name) => write(name, null)));
    },
  };
}
