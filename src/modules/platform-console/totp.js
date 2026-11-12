import crypto from 'node:crypto';
import { PLATFORM_LOGIN } from '../../contracts/api/platform-ops.js';

/**
 * TOTP (RFC 6238 over RFC 4226) for the Platform Console's second factor (PRD 5.5), with node:crypto and nothing else.
 * SHA-1, 6 digits and 30 seconds are what every authenticator app expects from an otpauth:// address with no parameters.
 *
 * The secret is kept encrypted (platform_users.totp_secret_enc, by the secrets module) and is shown to its owner once, when
 * they enrol. Nothing here logs or stores anything: the sign-in routes do, and they remember the last step a code was
 * accepted for, so the same six digits never work twice.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Spaces, dashes, padding and lower case are what people and apps add; anything else is not a secret. */
export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('Not a base32 secret');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 random bits, as RFC 4226 recommends, in base32. */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export const stepAt = (ms = Date.now(), period = PLATFORM_LOGIN.totpPeriodSeconds) => Math.floor(ms / 1000 / period);

/** The code for one time step. */
export function codeForStep(secret, step, digits = PLATFORM_LOGIN.totpDigits) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpAt = (secret, ms = Date.now()) => codeForStep(secret, stepAt(ms));

/**
 * The time step `code` is good for, or null. One step either side of now is accepted for a clock that is a little off.
 * Pass the last step this person signed in with as `afterStep`: a code for that step or an earlier one is refused, so a
 * code seen over a shoulder cannot be used again. Compared in constant time.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = PLATFORM_LOGIN.totpWindow, afterStep = -1 } = {}) {
  const sent = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(sent)) return null;
  const current = stepAt(now);
  let found = null;
  for (let step = current - window; step <= current + window; step++) {
    const good = crypto.timingSafeEqual(Buffer.from(codeForStep(secret, step)), Buffer.from(sent));
    if (good && step > afterStep && found === null) found = step;
  }
  return found;
}

/** What an authenticator app scans. The account is the person's email; the issuer is Bhava's, never a seller's. */
export function otpauthUrl(secret, account, issuer = PLATFORM_LOGIN.issuer) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${PLATFORM_LOGIN.totpDigits}&period=${PLATFORM_LOGIN.totpPeriodSeconds}`;
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0, 1, i, l or o

/** Ten one-time codes such as `k7pd-3mwq-x2hn`, shown once. Store only hashRecoveryCode of each. */
export function generateRecoveryCodes(count = PLATFORM_LOGIN.recoveryCodes) {
  const one = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join('')).join('-');
  return Array.from({ length: count }, one);
}

/** Keyed with the server's secret, so a copy of the table alone is not a list of codes to try. */
export const hashRecoveryCode = (secret, code) => crypto.createHmac('sha256', String(secret)).update(`platform-recovery:${String(code ?? '').trim().toLowerCase()}`).digest('base64url');

/** The emailed sign-in code: digits only, from the system's random source. Store only hashLoginCode of it. */
export const generateLoginCode = (digits = PLATFORM_LOGIN.codeDigits) => String(crypto.randomInt(10 ** digits)).padStart(digits, '0');
export const hashLoginCode = (secret, userId, code) => crypto.createHmac('sha256', String(secret)).update(`platform-login:${Number(userId)}:${String(code ?? '')}`).digest('base64url');
