import crypto from 'node:crypto';

/**
 * Seller accounts and app sessions (PRD 5.11, 10.2, 10.3, 10.6): the numbers and the pure rules every part shares.
 * The routes are in src/contracts/api/{auth,team,app}.js; the tables in migrations 500 to 502; the work in
 * src/modules/accounts. Nothing here reads the database, the clock of a provider or the network.
 */

/** A one-time code: 6 digits, used once, 5 minutes, at most 5 wrong tries, never logged, compared in constant time. */
export const CODE_RULES = Object.freeze({
  digits: 6,
  ttlMs: 5 * 60_000,
  maxAttempts: 5,
  /** The app's Resend button wakes after this long; a second send inside it answers the same and sends nothing. */
  resendAfterMs: 30_000,
});

/**
 * Limits for platform.rateLimit.hit(scope, subject, limit). `subject` for a number is its E.164 form and for an
 * address the caller's IP: rateLimit stores only a hash. Over a limit the answer is 429 `rate_limited` whether or
 * not the number has an account.
 */
export const AUTH_LIMITS = Object.freeze({
  codeSendsPerNumber: Object.freeze({ scope: 'seller_code_sends_number', limit: 5, windowMs: 60 * 60_000 }),
  codeSendsPerAddress: Object.freeze({ scope: 'seller_code_sends_ip', limit: 20, windowMs: 60 * 60_000 }),
  codeTriesPerNumber: Object.freeze({ scope: 'seller_code_tries_number', limit: 10, windowMs: 15 * 60_000 }),
  codeTriesPerAddress: Object.freeze({ scope: 'seller_code_tries_ip', limit: 30, windowMs: 15 * 60_000 }),
  providerSignInsPerAddress: Object.freeze({ scope: 'seller_provider_signins_ip', limit: 30, windowMs: 15 * 60_000 }),
  refreshesPerAddress: Object.freeze({ scope: 'seller_refreshes_ip', limit: 120, windowMs: 15 * 60_000 }),
  deviceSecretTries: Object.freeze({ scope: 'seller_device_secret_tries', limit: 5, windowMs: 15 * 60_000 }),
});

export const CODE_PURPOSES = Object.freeze(['signin', 'reauth', 'link']);
export const IDENTITY_KINDS = Object.freeze(['phone', 'google', 'apple']);
export const ACCOUNT_TYPES = Object.freeze(['seller', 'creator']);

/** The apps that call the API, and the platforms they run on. `web` is the console in a browser: it has no minimum version. */
export const APPS = Object.freeze(['owner', 'shopper']);
export const APP_PLATFORMS = Object.freeze(['android', 'ios']);
export const DEVICE_PLATFORMS = Object.freeze(['android', 'ios', 'web']);
/** What an app sends on every request. Below the minimum version the API answers 426 `update_required` with the store link. */
export const APP_HEADERS = Object.freeze({ app: 'x-app', version: 'x-app-version', platform: 'x-app-platform' });

/** How long a re-auth lasts, how long a browser hand-off code lives, and how long before a deletion is carried out. */
export const FRESH_MINUTES = 5;
export const HANDOFF_SECONDS = 60;
export const DELETION_GRACE_DAYS = 30;
export const INVITE_DAYS = 7;
/** A cookie session for the web console, as before. Access and refresh lifetimes are config: ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS. */
export const COOKIE_SESSION_DAYS = 30;

/** Why a refresh family ended. `token_reuse` is a refresh token presented a second time (P-05). */
export const REVOKE_REASONS = Object.freeze(['signed_out', 'token_reuse', 'device_revoked', 'staff_removed', 'account_deleted', 'support']);

/** The device id an app chooses at install and sends with every sign-in. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const APP_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
export const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * A phone number as typed, in E.164, or null. Ten digits starting 6 to 9 are an Indian mobile; anything else must
 * arrive with its country code. Never guess a country for a number that already has one.
 */
export function toE164(value) {
  const raw = String(value ?? '').trim().replace(/[\s().-]/g, '');
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^0[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  const international = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return E164.test(international) ? international : null;
}

/** The ten digits users.phone holds for an Indian number, or null for any other country: such a number matches no seller account's phone. */
export const localPhone = (e164) => (/^\+91[6-9]\d{9}$/.test(String(e164)) ? String(e164).slice(3) : null);

/** A number for a person to recognise and nobody else to use: +91 ••••• •3210. */
export function maskPhone(e164) {
  const digits = String(e164 ?? '');
  return digits.length < 6 ? '' : `${digits.slice(0, 3)} ••••• •${digits.slice(-4)}`;
}

/** An email the same way: a•••@example.com. */
export function maskEmail(email) {
  const [name, host] = String(email ?? '').split('@');
  return name && host ? `${name[0]}•••@${host}` : '';
}

/** A new code: uniform over 000000 to 999999, from the system's random source. */
export function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_RULES.digits)).padStart(CODE_RULES.digits, '0');
}

export const isCode = (value) => typeof value === 'string' && new RegExp(`^\\d{${CODE_RULES.digits}}$`).test(value);

const keyed = (secret, label, value) => {
  if (!secret) throw new Error('A keyed hash needs the server secret');
  return crypto.createHmac('sha256', String(secret)).update(`${label}\n${value}`).digest('base64url');
};

/**
 * What the tables hold in place of a number, an email or a code. Keyed with the server's secret (config.sessionSecret),
 * so a copy of the database alone cannot be searched for a number, and a 6-digit code cannot be found by trying a million.
 * A code's hash also names its subject and purpose: a code sent to one number, or for one purpose, opens nothing else.
 */
export const subjectHash = (secret, kind, subject) => keyed(secret, `subject:${kind}`, String(subject).trim().toLowerCase());
export const codeHash = (secret, { purpose, subject, code }) => keyed(secret, `code:${purpose}:${subject}`, String(code));
/** Refresh tokens, hand-off codes, invitation tokens and device secrets are long random values: a plain hash is enough. */
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Equal or not, in the same time whatever the two hold. Always compare hashes with this, never with ===. */
export function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}

/** PKCE (RFC 7636), S256 only: the challenge an app sends at the start of a browser sign-in, for the verifier it sends at the end. */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(String(verifier)).digest('base64url');
export const pkceMatches = (verifier, challenge) => PKCE_VERIFIER.test(String(verifier)) && sameSecret(pkceChallenge(verifier), challenge);

/** [major, minor, patch], or null when it is not three numbers. */
export function parseVersion(value) {
  return APP_VERSION.test(String(value ?? '')) ? String(value).split('.').map(Number) : null;
}

/** True when `version` is older than `minimum`. A version that cannot be read counts as too old. */
export function isBelowMinimum(version, minimum) {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (!need) return false;
  if (!have) return true;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] < need[i];
  return false;
}

/**
 * The review login (PRD 5.11): the fixed code works only for the review number, and only with the flag on.
 * `login` is the review_logins row, or null. Returns '' when the code may be accepted, or why not: the caller logs
 * every answer in review_login_uses and treats anything but '' as an ordinary wrong code.
 */
export function reviewCodeProblem(login, { phone, codeMatches }) {
  if (!login || !sameSecret(login.phone, phone)) return 'wrong_number';
  if (!login.enabled) return 'flag_off';
  return codeMatches ? '' : 'wrong_code';
}
