/**
 * What the console's sign-in and account screens need to know about the server, this browser and this device, as
 * plain functions with no React and no bundler names, so node's test runner can import them. The numbers and
 * patterns repeat src/contracts (accounts.js, api/provider.js), which the browser cannot import because they need
 * node:crypto; test/p5/console-accounts keeps each copy equal to the contract's.
 */

/** A one-time code: six digits (CODE_RULES.digits). */
export const CODE_DIGITS = 6;
export const isCode = (value) => new RegExp(`^\\d{${CODE_DIGITS}}$`).test(String(value ?? ''));

/** The id a device chooses once and sends with every sign-in (DEVICE_ID). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** PKCE, S256 only (PKCE_VERIFIER, PKCE_CHALLENGE). */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A page on this site to open after a Google sign-in (GoogleStartQuery.next). */
export const NEXT_PATH = /^\/(?!\/)[\w\-./?=&%#]*$/;
/** The browser half of Google sign-in (AUTH_PATHS.googleStart). It exists only on the sign-in host. */
export const GOOGLE_START = '/auth/google/start';
const E164 = /^\+[1-9]\d{7,14}$/;

/** A number as typed, in E.164, or null: the rule the server reads it by (toE164). */
export function toE164(value) {
  const raw = String(value ?? '').trim().replace(/[\s().-]/g, '');
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^0[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  const international = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return E164.test(international) ? international : null;
}

/** A number for its owner to recognise and nobody else to use: +91 ••••• •3210 (maskPhone). */
export function maskPhone(e164) {
  const digits = String(e164 ?? '');
  return digits.length < 6 ? '' : `${digits.slice(0, 3)} ••••• •${digits.slice(-4)}`;
}

/** The account's own phone as the API gives it (ten digits for India), masked for the screen. Empty for no number. */
export const maskOwnPhone = (phone) => maskPhone(toE164(phone) ?? '');

const BROWSERS = [[/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/SamsungBrowser/, 'Samsung Internet'], [/Firefox\/|FxiOS/, 'Firefox'], [/Chrome\/|CriOS/, 'Chrome'], [/Safari\//, 'Safari']];
const SYSTEMS = [[/Android/, 'Android'], [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'Mac'], [/CrOS/, 'Chromebook'], [/Linux/, 'Linux']];

/** What Settings > Devices calls this browser: "Chrome on Android". Nothing else is read from the user agent. */
export function deviceName(userAgent = '') {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Web browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

const DEVICE_KEY = 'bhava.device';

function randomId(cryptoSource) {
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * This browser's device id: chosen once and kept, so Settings > Devices lists one row for it and signing it out
 * there ends its session. Without storage (a private window) it lasts this page only.
 */
export function deviceId(storage, cryptoSource = globalThis.crypto) {
  try {
    const kept = storage?.getItem(DEVICE_KEY);
    if (kept && DEVICE_ID.test(kept)) return kept;
  } catch {
    // storage refused: a new id below
  }
  const made = randomId(cryptoSource);
  try {
    storage?.setItem(DEVICE_KEY, made);
  } catch {
    // kept for this page only
  }
  return made;
}

/** The device a sign-in from this browser names (DeviceInput): the web console is platform "web". */
export const webDevice = ({ storage, userAgent, cryptoSource } = {}) => ({ id: deviceId(storage, cryptoSource), name: deviceName(userAgent), platform: 'web' });

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE pair for a browser sign-in started to link Google: { verifier, challenge }. Needs a secure page (https or localhost). */
export async function pkcePair(cryptoSource = globalThis.crypto) {
  if (!cryptoSource?.subtle) throw new Error('This page needs a secure connection to link Google.');
  const bytes = new Uint8Array(32);
  cryptoSource.getRandomValues(bytes);
  const verifier = b64url(bytes);
  const digest = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** Where "Continue with Google" goes. `next` is the console page to open afterwards; anything that is not a plain path here becomes /admin. */
export function googleStartUrl({ next = '/admin', purpose = 'signin', challenge } = {}) {
  const params = new URLSearchParams({ target: 'web' });
  if (purpose !== 'signin') params.set('purpose', purpose);
  if (challenge) params.set('challenge', challenge);
  params.set('next', NEXT_PATH.test(next) && next.length <= 500 ? next : '/admin');
  return `${GOOGLE_START}?${params}`;
}

/**
 * Whether this server still has the phone-and-password sign-in (PASSWORD_LOGIN, tests and local runs only). The API
 * has no field that says so, so the route is asked: with the setting off the server answers 404 for it before anything
 * else looks at the request; with it on, a token that cannot be anyone's is refused with 401 by the bearer check, which
 * records no failed sign-in, counts against no limit and opens nothing. Anything else (offline, a fault) is no.
 */
export async function passwordLoginOn(send = (...args) => globalThis.fetch(...args)) {
  try {
    const response = await send('/api/v1/auth/login', { method: 'POST', headers: { authorization: 'Bearer -', accept: 'application/json' }, credentials: 'omit' });
    return response.status === 401;
  } catch {
    return false;
  }
}

/**
 * Whether this is the sign-in host (PLATFORM_APP_HOST), where Google sign-in starts. Only there does the start answer
 * with a redirect (to Google, or back to the sign-in page when Google is not set up), which is not followed here.
 * Anywhere else that path is one of the store's own pages.
 */
export async function googleStartsHere(send = (...args) => globalThis.fetch(...args)) {
  try {
    const response = await send(`${GOOGLE_START}?target=web`, { redirect: 'manual', credentials: 'same-origin' });
    return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  }
}

/**
 * What the sign-in page offers, from what the server said (P-11, F-117, F-118):
 *
 *   whatsapp  a 6-digit code on WhatsApp, unless app.requirements says no. When it could not be read, still yes.
 *   google    Continue with Google: set up on the server (app.requirements) and on the sign-in host, where it starts.
 *   password  phone and password, only while the route exists (PASSWORD_LOGIN) and never on the sign-in host: a password
 *             names its business by the address, and that host belongs to none, so the form could only fail there.
 *
 * There is never an SMS option.
 */
export function waysIn({ passwordRoute = false, requirements = null, signInHost = false } = {}) {
  return {
    whatsapp: requirements?.signIn?.whatsapp ?? true,
    google: Boolean(requirements?.signIn?.google) && Boolean(signInHost),
    password: Boolean(passwordRoute) && !signInHost,
    signInHost: Boolean(signInHost),
  };
}

/** True when the session's last sign-in or re-auth still counts, with a margin for the clocks; null when the session never said. */
export function isFresh(freshUntil, now = Date.now(), marginMs = 20_000) {
  if (freshUntil === undefined) return null;
  if (!freshUntil) return false;
  const until = new Date(freshUntil).getTime();
  return Number.isFinite(until) && until - marginMs > now;
}

const DELETION_KEY = 'bhava.deletion';

/** The timeline of a deletion just asked for, kept for the sign-in page this tab shows next (the session has ended). */
export function keepDeletion(storage, timeline) {
  try {
    storage?.setItem(DELETION_KEY, JSON.stringify({ requestedAt: timeline.requestedAt, dueAt: timeline.dueAt }));
  } catch {
    // shown from memory instead
  }
}

export function readDeletion(storage) {
  try {
    const value = JSON.parse(storage?.getItem(DELETION_KEY) ?? 'null');
    return value && value.requestedAt && value.dueAt ? value : null;
  } catch {
    return null;
  }
}

export function clearDeletion(storage) {
  try {
    storage?.removeItem(DELETION_KEY);
  } catch {
    // nothing kept
  }
}

/** Seconds left before "Send a new code" wakes, from when the last code went. */
export const secondsLeft = (sentAt, waitSeconds, now = Date.now()) => Math.max(0, Math.ceil((sentAt + waitSeconds * 1000 - now) / 1000));
