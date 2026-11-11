/**
 * A fresh check before a sensitive change (PRD 5.11, 10.4; P-17): replacing a payment or courier key, changing the
 * team, deleting the account. The server answers 403 `reauth_required` to a route marked fresh unless the person
 * signed in or proved themselves again in the last few minutes. Two ways to prove it:
 *
 *   on this device   fingerprint, face or passcode, which releases the device's unlock secret from SecureStore; the
 *                    secret goes to auth.reauthVerify. It exists only after fingerprint or face unlock was turned on.
 *   a WhatsApp code  auth.reauthStart sends one to the person's verified phone; auth.reauthVerify takes it back.
 *
 * No native module here: the lock is passed in. The secret and the code are never kept anywhere else or logged.
 */

/**
 * After fingerprint or face unlock is turned on: asks the server for this device's unlock secret and keeps it in
 * SecureStore. It needs a fresh session, which a sign-in a moment ago is; without one it simply is not kept, and a
 * re-auth uses a code instead. Answers whether it was kept.
 */
export async function enrollDeviceUnlock({ api, store }) {
  try {
    const answer = await api.auth.enableDeviceUnlock();
    if (typeof answer?.deviceSecret !== 'string' || !answer.deviceSecret) return false;
    await store.setDeviceSecret(answer.deviceSecret);
    return true;
  } catch {
    return false;
  }
}

export function createReauth({ session, store, lock }) {
  const done = (answer) => {
    session.setFresh(answer?.freshUntil ?? null);
    return { ok: true, reason: null };
  };

  return {
    /** True when the device itself can prove it: the lock is on, something is enrolled and the secret is held. */
    async canUseDevice() {
      const [secret, on, available] = await Promise.all([store.getDeviceSecret(), store.isLockEnabled(), lock.available()]);
      return Boolean(secret && on && available);
    },

    /**
     * Fingerprint, face or passcode, then the secret. `reason`: null, 'cancelled', 'unavailable', 'failed' (the lock
     * said no) or 'refused' (the server no longer takes this device's secret: the person uses a code instead, and the
     * secret is forgotten so it is not offered again).
     */
    async withDevice(prompt, labels) {
      const passed = await lock.unlock(prompt, labels);
      if (!passed.ok) return passed;
      const deviceSecret = await store.getDeviceSecret();
      if (!deviceSecret) return { ok: false, reason: 'unavailable' };
      try {
        return done(await session.api.auth.reauthVerify({ deviceSecret }));
      } catch (error) {
        if (error?.status === 0) return { ok: false, reason: 'network' };
        await store.setDeviceSecret(null);
        return { ok: false, reason: 'refused' };
      }
    },

    /** Sends a code on WhatsApp. `sent` false means the person has no verified phone. Same answer shape as the API. */
    start: () => session.api.auth.reauthStart(),

    /** The code back. Throws the API's error for a wrong or expired code, so the screen can say so. */
    async withCode(code) {
      return done(await session.api.auth.reauthVerify({ code: String(code ?? '').trim() }));
    },

    isFresh: () => session.isFresh(),
  };
}
