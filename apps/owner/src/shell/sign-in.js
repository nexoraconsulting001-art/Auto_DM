/**
 * The three ways in (PRD 10.3, 5.11): a code on WhatsApp, Google in the system browser, and Apple on iOS. There is
 * no password and no SMS. Each ends with `session.adopt(answer)`. The native pieces are passed in, so the flows are
 * tested without a device.
 *
 * Google never runs in an embedded web view: the system browser opens the server's start page with a PKCE
 * challenge, and comes back to the app's own scheme with a single-use code that is useless without the verifier.
 */
import { OWNER_APP_CALLBACK, parseLink } from '@bhava/app-core';

const GOOGLE_START = '/auth/google/start'; // AUTH_PATHS.googleStart in src/contracts/api/provider.js; a test keeps them equal
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A random string of URL-safe characters: a PKCE verifier (43 to 128) or a nonce. */
export async function randomToken(crypto, length = 64) {
  const bytes = await crypto.getRandomBytesAsync(length);
  return Array.from(bytes, (b) => B64URL[b % 64]).join('');
}

const toBase64Url = (base64) => base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function pkceChallenge(crypto, verifier) {
  return toBase64Url(await crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: crypto.CryptoEncoding.BASE64 }));
}

/** Which buttons to show. Before the server answers: WhatsApp and Google, and Apple on iOS (Apple requires it there). */
export function signInOptions(requirements, platform) {
  const offered = requirements?.signIn ?? { whatsapp: true, google: true, apple: true };
  return { whatsapp: offered.whatsapp !== false, google: offered.google !== false, apple: platform === 'ios' && offered.apple !== false };
}

/** Why a sign-in did not finish, as a string key. */
export function signInProblem(error) {
  if (error?.code === 'cancelled') return 'signIn.cancelled';
  if (error?.status === 0 || error?.code === 'network') return 'signIn.network';
  return 'signIn.failed';
}

const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

export function createSignIn({ session, config, crypto, browser, apple }) {
  return {
    /** Sends the code. The answer is the same for every number, known or not. */
    startCode: (phone) => session.api.auth.start({ phone: String(phone).trim() }),

    async verifyCode(phone, code) {
      const answer = await session.api.auth.verify({ phone: String(phone).trim(), code: String(code).trim(), transport: 'bearer', device: await session.device() });
      return session.adopt(answer);
    },

    async google() {
      const verifier = await randomToken(crypto, 64);
      const challenge = await pkceChallenge(crypto, verifier);
      const start = `${config.apiOrigin}${GOOGLE_START}?target=app&challenge=${encodeURIComponent(challenge)}`;
      const result = await browser.openAuthSessionAsync(start, OWNER_APP_CALLBACK);
      if (result?.type !== 'success') throw cancelled();
      const link = parseLink(result.url);
      if (link?.kind !== 'auth' || !link.code) throw Object.assign(new Error('sign-in failed'), { code: link?.error === 'denied' ? 'cancelled' : 'failed' });
      const answer = await session.api.auth.exchange({ code: link.code, verifier, transport: 'bearer', device: await session.device() });
      return session.adopt(answer);
    },

    /** Apple is given the SHA-256 of a nonce; the server gets the raw one and checks the token against it. */
    async apple() {
      const nonce = await randomToken(crypto, 32);
      const hashed = await crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, nonce);
      let credential;
      try {
        credential = await apple.signInAsync({ requestedScopes: [apple.AppleAuthenticationScope.FULL_NAME, apple.AppleAuthenticationScope.EMAIL], nonce: hashed });
      } catch (error) {
        throw error?.code === 'ERR_REQUEST_CANCELED' ? cancelled() : error;
      }
      const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ').slice(0, 80);
      const answer = await session.api.auth.apple({ identityToken: credential.identityToken, nonce, ...(name ? { name } : {}), transport: 'bearer', device: await session.device() });
      return session.adopt(answer);
    },
  };
}
