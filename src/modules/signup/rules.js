import crypto from 'node:crypto';
import { SIGNUP_STEPS } from '../../contracts/billing.js';
import { slugify } from '../../util.js';
import { RESERVED_LABELS } from '../domains/rules.js';

/** Self-serve sign-up's pure rules (PRD 5.20). No database, no clock. */

const HOUR = 3_600_000;

/**
 * Limits on sign-up, per person and per address (platform.rateLimit, in Postgres, so they hold across processes). A run
 * is a row, so opening the page is limited too, and so is trying invite codes, whose validity the status answer shows.
 */
export const SIGNUP_LIMITS = Object.freeze({
  runsPerAddress: Object.freeze({ scope: 'signup_run_ip', limit: 30, windowMs: HOUR }),
  invitesPerAddress: Object.freeze({ scope: 'signup_invite_ip', limit: 20, windowMs: HOUR }),
  startsPerPerson: Object.freeze({ scope: 'signup_start_person', limit: 5, windowMs: 24 * HOUR }),
  startsPerAddress: Object.freeze({ scope: 'signup_start_ip', limit: 10, windowMs: HOUR }),
});

/** A run's token travels in the page; only its hash is stored. */
export const newRunToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0, O, 1, I or L: read aloud and typed by hand
/** A new invite code, as 'K7M2-P9XW-4RTB' (about 59 bits). It is shown once and stored only as its hash. */
export function newInviteCode() {
  const chars = Array.from(crypto.randomBytes(12), (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
/** The form a code is hashed in: upper case, letters and digits only, so dashes and spaces typed or not are the same code. */
export const normalizeInviteCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const inviteHash = (code) => sha256(`signup-invite:${normalizeInviteCode(code)}`);

/** The address names a new business may try, in order: its name, then the name with a short random tail. Never a reserved one. */
export function slugCandidates(name, tries = 6) {
  const base = slugify(name).slice(0, 30).replace(/-+$/, '');
  const usable = base.length >= 3 && !RESERVED_LABELS.has(base) ? base : '';
  const stem = usable || (base.length >= 3 ? base : 'shop');
  const out = usable ? [usable] : [];
  while (out.length < tries) out.push(`${stem}-${crypto.randomBytes(3).toString('hex')}`);
  return out.filter((slug) => !RESERVED_LABELS.has(slug));
}

/** The business's own address: <slug>.<SIGNUP_HOST_SUFFIX>, or <slug>.<PLATFORM_DOMAIN>. */
export function businessHost(slug, config = {}) {
  const suffix = String(config.signupHostSuffix || config.platformDomain || '').toLowerCase();
  return suffix ? `${slug}.${suffix}` : slug;
}

/** The first step of the sign-up not yet done, or null when all are. */
export const nextStep = (done) => SIGNUP_STEPS.find((step) => !done.has(step)) ?? null;

/** The guided first automation's messages (4.10): no platform name, no link but the seller's own, {first_name} optional. */
export const FIRST_AUTOMATION = Object.freeze({
  body: 'Hi {first_name}, thanks for your comment! Tap below and I’ll send you the link.',
  tapButtonTitle: 'Send me the link',
  linkButtonTitle: 'Open the link',
});

/** Where a refusal of the automations module lands on the sign-up's own three fields. */
export function problemField(field) {
  const name = String(field ?? '');
  if (name === 'linkUrl' || name === 'linkType') return 'link';
  if (name === 'keywords' || name === 'matchMode') return 'keyword';
  if (name.startsWith('triggers')) return 'mediaId';
  if (name.startsWith('variants') || ['linkMessage', 'followupText', 'tapButtonTitle', 'linkButtonTitle'].includes(name)) return 'template';
  return name || 'automation';
}
