/**
 * Fingerprint, face or device-passcode unlock (PRD 10.3, F-110, P-68). It only releases the refresh token this device
 * already holds, by letting `session.resume()` run: it never replaces the server's own checks, and a session the
 * server has ended stays ended. Works the same on Android and iOS; a device with nothing enrolled is not offered it.
 *
 * The way back in, in order: fingerprint or face; the device's own passcode, which the system offers when the
 * fingerprint or face fails or is locked out (`disableDeviceFallback` is false); and then a full sign-in with Google,
 * Apple or a WhatsApp code, which the lock screen offers and which drops the stored session first.
 */
import * as LocalAuthentication from 'expo-local-authentication';

/** expo-local-authentication's AuthenticationType: 1 fingerprint, 2 face, 3 iris. */
const FINGERPRINT = 1;
const FACE = 2;
const IRIS = 3;
const CANCELLED = ['user_cancel', 'system_cancel', 'app_cancel'];
const NOT_SET_UP = ['not_enrolled', 'not_available', 'passcode_not_set'];

export function createLock({ store, localAuth = LocalAuthentication }) {
  async function available() {
    try {
      return Boolean((await localAuth.hasHardwareAsync()) && (await localAuth.isEnrolledAsync()));
    } catch {
      return false;
    }
  }

  /**
   * Asks the person. `reason` is: null (unlocked), 'cancelled', 'unavailable' or 'failed'. Too many wrong tries with no
   * passcode to fall back on is 'failed' too: either way the lock screen then offers a full sign-in.
   */
  async function ask(promptMessage, { cancelLabel, fallbackLabel } = {}) {
    if (!(await available())) return { ok: false, reason: 'unavailable' };
    let result;
    try {
      result = await localAuth.authenticateAsync({ promptMessage, disableDeviceFallback: false, ...(cancelLabel ? { cancelLabel } : {}), ...(fallbackLabel ? { fallbackLabel } : {}) });
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (result?.success) return { ok: true, reason: null };
    if (CANCELLED.includes(result?.error)) return { ok: false, reason: 'cancelled' };
    if (NOT_SET_UP.includes(result?.error)) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'failed' };
  }

  return {
    available,
    /** 'face', 'fingerprint', 'iris' or null: which words to use ("Unlock with face"). */
    async kind() {
      try {
        const types = (await localAuth.supportedAuthenticationTypesAsync()) ?? [];
        if (types.includes(FACE)) return 'face';
        if (types.includes(FINGERPRINT)) return 'fingerprint';
        if (types.includes(IRIS)) return 'iris';
      } catch {
        // No answer: the words stay general.
      }
      return null;
    },
    enabled: () => store.isLockEnabled(),
    /** True once after a sign-in on a device that can use it and has not turned it on yet. */
    async shouldOffer() {
      if (await store.isLockEnabled()) return false;
      if (await store.wasLockOffered()) return false;
      return available();
    },
    /** The offer was answered, either way: it is not made again until the next sign-in. */
    markOffered: () => store.setLockOffered(),
    /** Turns the lock on, after the person proves they can pass it. */
    async enable(promptMessage, labels) {
      const result = await ask(promptMessage, labels);
      if (result.ok) await store.setLockEnabled(true);
      return result;
    },
    /** Turning it off also forgets the device's unlock secret: a re-auth then needs a WhatsApp code. */
    async disable() {
      await store.setLockEnabled(false);
      await store.setDeviceSecret(null);
    },
    /** At launch with the lock on, and before a sensitive change. On success the caller runs `session.resume()`. */
    unlock: (promptMessage, labels) => ask(promptMessage, labels),
  };
}
