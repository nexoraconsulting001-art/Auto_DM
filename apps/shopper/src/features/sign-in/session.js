/**
 * The shopper app's session (PRD 10.7): a guest session from the first call, and a signed-in one after Google, a WhatsApp code
 * or (on iOS) Sign in with Apple. Plain JavaScript with everything it touches handed in, so a test runs it against the real
 * server with no phone.
 *
 *   const session = createSession({ client, store, scheme, onWipe, random, sha256 });
 *   session.getAccessToken()        what the client asks before every call: the token in memory, or a refreshed or new guest one
 *   session.sendCode(phone)         WhatsApp code for signing in
 *   session.signInWithCode(phone, code) / signInWithGoogle({ browser }) / signInWithApple({ apple })
 *   session.signOut() / session.deleteAccount()      both wipe the refresh token, the cache and the cart, then start a guest again
 *
 * Rules kept here: the access token lives in memory only; the refresh token is in SecureStore (`store`) and nowhere else; a
 * refresh the server refuses signs the shopper out and wipes; a refresh that could not reach the server changes nothing.
 * Nothing here logs, and no token, code or phone number is put in a message or in the state.
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const GUEST_RETRY_MS = 20_000;

/** A random string of `length` characters from `alphabet`, from the device's own random bytes. */
export async function randomText(random, length, alphabet) {
  const bytes = await random(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const toBase64Url = (base64) => String(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createSession({ client, store, scheme, onWipe = [], beforeLeave = [], onReady = null, random, sha256, now = Date.now } = {}) {
  if (!client || !store) throw new Error('A session needs the store client and the secure store');
  let access = null;
  let accessUntil = 0;
  let state = Object.freeze({ status: 'starting', shopper: null });
  let flight = null;
  let blockedUntil = 0;
  let skipToken = false;
  let needMe = false;
  let healing = false;
  const listeners = new Set();

  const publish = (next) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };

  /** A call that must not wait for a token (the ones that make one). `client.call` reads the token before its first await. */
  function bare(id, options) {
    skipToken = true;
    try {
      return client.call(id, options);
    } finally {
      skipToken = false;
    }
  }

  async function device() {
    return { id: await store.getDeviceId(), name: '' };
  }

  async function adopt(answer) {
    // The new refresh token is stored before the access token is used.
    await store.setRefreshToken(answer.refreshToken);
    access = answer.accessToken;
    accessUntil = now() + Math.max(30, (answer.accessExpiresInSeconds ?? 900) - 30) * 1000;
    if ('guest' in answer) publish({ status: answer.guest || !answer.shopper ? 'guest' : 'signedIn', shopper: answer.guest ? null : answer.shopper });
    return state;
  }

  async function startGuest() {
    return adopt(await bare('appSessionStart', { body: { grant: 'guest', device: await device() } }));
  }

  async function wipe() {
    access = null;
    accessUntil = 0;
    await store.clearSession();
    await store.setRefreshToken(null);
    for (const hook of onWipe) {
      try {
        await hook();
      } catch {
        // A hook that fails must not keep the others from running.
      }
    }
  }

  async function ensure() {
    if (access && now() < accessUntil) return access;
    if (flight) return flight;
    if (now() < blockedUntil) return null;
    flight = (async () => {
      try {
        const refreshToken = await store.getRefreshToken();
        if (refreshToken) {
          try {
            const answer = await bare('appSessionRefresh', { body: { refreshToken } });
            await store.setRefreshToken(answer.refreshToken);
            access = answer.accessToken;
            accessUntil = now() + Math.max(30, (answer.accessExpiresInSeconds ?? 900) - 30) * 1000;
            needMe = state.status === 'starting';
            return access;
          } catch (error) {
            if (!error || error.status === 0 || error.status >= 500) throw error;
            // The server will not take this refresh token any more: the sign-in is over here too.
            await wipe();
            publish({ status: 'guest', shopper: null });
          }
        }
        await startGuest();
        return access;
      } catch {
        blockedUntil = now() + GUEST_RETRY_MS;
        return null;
      } finally {
        flight = null;
        if (needMe) {
          needMe = false;
          refreshState();
        }
      }
    })();
    return flight;
  }

  async function refreshState() {
    try {
      const me = await client.call('appMe');
      publish({ status: me.shopper ? 'signedIn' : 'guest', shopper: me.shopper ?? null });
    } catch {
      if (state.status === 'starting') publish({ status: 'guest', shopper: null });
    }
  }

  /** Ends this sign-in on the server (best effort), wipes this device, and opens a fresh guest session. */
  async function leave(endOnServer) {
    let next = null;
    // While the token still works: this phone stops hearing pushes for the shopper who is leaving.
    if (endOnServer) {
      for (const hook of beforeLeave) {
        try {
          await hook();
        } catch {
          // Best effort.
        }
      }
    }
    if (endOnServer && access) {
      try {
        next = await client.call('appSessionEnd');
      } catch {
        next = null;
      }
    }
    await wipe();
    publish({ status: 'guest', shopper: null });
    try {
      if (next?.accessToken) await adopt({ ...next, guest: true, shopper: null });
      else await startGuest();
    } catch {
      blockedUntil = now() + GUEST_RETRY_MS;
    }
  }

  return Object.freeze({
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * What the client asks before every call. A phone that has signed in before (or has a guest session) has a refresh token, and the
     * call waits for the short refresh. A phone with nothing yet does not hold the first calls back: they go without a token, the
     * guest session starts beside them, and the 401s they get are answered by onUnauthorized below, which asks the screens to read again.
     */
    async getAccessToken() {
      if (skipToken) return null;
      if (access && now() < accessUntil) return access;
      if (flight || (await store.getRefreshToken())) return ensure();
      ensure().then(() => onReady?.(), () => {});
      return null;
    },
    /** A 401: the token is dead or there was none. The session is made or refreshed, then what failed is read again. */
    onUnauthorized() {
      access = null;
      accessUntil = 0;
      if (healing) return;
      healing = true;
      ensure().then((token) => { if (token) onReady?.(); }, () => {}).finally(() => { healing = false; });
    },
    /** Asks who is signed in, once the app is open. */
    start: () => ensure().then(() => (state.status === 'starting' ? refreshState() : undefined)),
    refreshState,

    async sendCode(phone) {
      await ensure();
      return client.call('otpSend', { body: { phone, purpose: 'sign_in' } });
    },
    async signInWithCode(phone, code) {
      return adopt(await bare('appSessionStart', { body: { grant: 'otp', device: await device(), phone, code } }));
    },

    /** Google, in the system browser: the page comes back to the app's own link with a one-time code that only this app's verifier can use. */
    async signInWithGoogle({ browser }) {
      if (!random || !sha256) throw new Error('Google sign-in needs the device’s random bytes and SHA-256');
      const verifier = await randomText(random, 64, VERIFIER_CHARS);
      const challenge = toBase64Url(await sha256(verifier));
      const back = `${scheme}://auth`;
      const result = await browser.openAuthSessionAsync(client.pageUrl('googleStart', undefined, { challenge }), back);
      if (result?.type !== 'success' || typeof result.url !== 'string') return { signedIn: false, reason: 'cancelled' };
      const query = new URLSearchParams(result.url.split('?')[1] ?? '');
      const code = query.get('code');
      if (!code) return { signedIn: false, reason: query.get('error') || 'failed' };
      await adopt(await bare('appSessionStart', { body: { grant: 'handoff', device: await device(), code, codeVerifier: verifier } }));
      return { signedIn: true };
    },

    /** iOS only. The raw nonce goes to the server; Apple gets its SHA-256 in hex. */
    async signInWithApple({ apple, sha256Hex }) {
      if (!random || !sha256Hex) throw new Error('Sign in with Apple needs the device’s random bytes and SHA-256');
      const nonce = await randomText(random, 32, B64URL);
      let credential;
      try {
        credential = await apple.signInAsync({ requestedScopes: [apple.AppleAuthenticationScope.FULL_NAME, apple.AppleAuthenticationScope.EMAIL], nonce: await sha256Hex(nonce) });
      } catch (error) {
        if (error?.code === 'ERR_REQUEST_CANCELED') return { signedIn: false, reason: 'cancelled' };
        throw error;
      }
      const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ');
      await adopt(await bare('appApple', { body: { identityToken: credential.identityToken, nonce, device: await device(), ...(name ? { name } : {}) } }));
      return { signedIn: true };
    },

    async signOut() {
      await leave(true);
    },
    /** In-app account deletion (Apple 5.1.1(v)): the server runs its erasure flow, then this device forgets everything. */
    async deleteAccount() {
      const answer = await client.call('appAccountDelete', { body: { confirm: true } });
      await leave(false);
      return answer;
    },
  });
}
