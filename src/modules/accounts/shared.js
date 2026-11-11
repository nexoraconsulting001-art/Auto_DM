import { E164, maskPhone } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';

/** The platform path: everything about people, codes and families is about no single business. */
export const platformOf = (db) => db.platform ?? db;

/** One sentence for every refused sign-in, whatever the reason, so a try learns nothing about which part was wrong. */
export const SIGN_IN_REFUSED = 'That didn’t work. Check the code, or ask for a new one.';
export const refused = () => new ApiError('unauthorized', SIGN_IN_REFUSED);

/**
 * Counts one hit against a limit from AUTH_LIMITS (platform.rateLimit, in Postgres, so it holds across every process)
 * and refuses with 429 when it is over. The subject is stored only as a hash.
 */
export async function limit(platform, spec, subject) {
  const hit = await platform.rateLimit.hit(spec.scope, String(subject ?? ''), spec);
  if (!hit.allowed) throw new ApiError('rate_limited');
}

/**
 * What users.phone holds for a person's account: the ten digits for an Indian number, E.164 for any other, and for a
 * person with no verified phone a value no typed number can ever equal, unique to them.
 */
export const accountPhone = (e164, personId) => {
  if (/^\+91[6-9]\d{9}$/.test(String(e164 ?? ''))) return String(e164).slice(3);
  if (E164.test(String(e164 ?? ''))) return String(e164);
  return `person:${Number(personId)}`;
};

/** A phone from users.phone as a person may see it about themselves: placeholders are no number. */
export const ownPhone = (phone) => (/^person:|^deleted:/.test(String(phone ?? '')) ? '' : String(phone ?? ''));

/** users.phone masked for someone else to recognise (the team list): +91 ••••• •3210, or empty for no number. */
export function maskedAccountPhone(phone) {
  const value = String(phone ?? '');
  if (/^[6-9]\d{9}$/.test(value)) return maskPhone(`+91${value}`);
  if (E164.test(value)) return maskPhone(value);
  return '';
}

/** A placeholder in password_hash: no password ever matches it (checkPassword wants scrypt$...). */
export const NO_PASSWORD = '!';
