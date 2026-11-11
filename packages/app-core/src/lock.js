/**
 * Fingerprint, face or device-passcode unlock (PRD 10.3, F-110). It only releases the refresh token this device
 * already holds, by letting `session.resume()` run: it never replaces the server's own checks, and a session the
 * server has ended stays ended. Works the same on Android and iOS; a device with nothing enrolled is simply not offered it.
 */
import * as LocalAuthentication from 'expo-local-authentication';

export function createLock({ store, localAuth = LocalAuthentication }) {
  async function available() {
    try {
      return (await localAuth.hasHardwareAsync()) && (await localAuth.isEnrolledAsync());
    } catch {
      return false;
    }
  }

  /** Asks the person. `reason` is: null (unlocked), 'cancelled', 'unavailable' or 'failed'. */
  async function ask(promptMessage) {
    if (!(await available())) return { ok: false, reason: 'unavailable' };
    let result;
    try {
      result = await localAuth.authenticateAsync({ promptMessage, disableDeviceFallback: false, cancelLabel: undefined });
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (result?.success) return { ok: true, reason: null };
    return { ok: false, reason: ['user_cancel', 'system_cancel', 'app_cancel'].includes(result?.error) ? 'cancelled' : 'failed' };
  }

  return {
    available,
    enabled: () => store.isLockEnabled(),
    /** Turns the lock on, after the person proves they can pass it. */
    async enable(promptMessage) {
      const result = await ask(promptMessage);
      if (result.ok) await store.setLockEnabled(true);
      return result;
    },
    disable: () => store.setLockEnabled(false),
    /** At launch with the lock on. On success the caller runs `session.resume()`. */
    unlock: (promptMessage) => ask(promptMessage),
  };
}
