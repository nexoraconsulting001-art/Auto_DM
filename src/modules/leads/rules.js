import crypto from 'node:crypto';

/**
 * The lead form's pure rules (PRD 8.15): what a shopper may send and how it is stored. A lead is a first name and a phone number
 * or an email, nothing else. Shared by the form's page, its handler and the tests, so they all decide the same way.
 */

export const CHANNELS = Object.freeze(['whatsapp', 'sms', 'email', 'call']);
const CHANNEL_WORDS = Object.freeze({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'email', call: 'phone call' });
/** The contact each channel needs: the form asks only for what its consent wording covers. */
const NEEDS = Object.freeze({ whatsapp: 'phone', sms: 'phone', call: 'phone', email: 'email' });

/** The channels in the one order every wording, record and file uses. */
export const orderedChannels = (channels) => CHANNELS.filter((c) => (channels ?? []).includes(c));

/** "WhatsApp, SMS or email". */
function wordList(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/** The consent wording (8.15): it names the seller and each way they may make contact. */
export function consentBody(businessName, channels) {
  const name = String(businessName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'this shop';
  return `I agree that ${name} may contact me about offers by ${wordList(orderedChannels(channels).map((c) => CHANNEL_WORDS[c]))}.`;
}

/** Which contact fields a form with these channels shows. */
export function fieldsFor(channels) {
  const list = orderedChannels(channels);
  return { phone: list.some((c) => NEEDS[c] === 'phone'), email: list.some((c) => NEEDS[c] === 'email') };
}

/** The channels a shopper can be reached on with the contact they gave: an email alone never grants WhatsApp. */
export function grantedChannels(channels, { phone, email }) {
  return orderedChannels(channels).filter((c) => (NEEDS[c] === 'phone' ? Boolean(phone) : Boolean(email)));
}

const oneLine = (value, max) => String(value ?? '').normalize('NFC').replace(/[\0-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A phone number in international format, "+<country><number>", or null. A ten-digit Indian mobile number, with or without a
 * leading 0 or 91, becomes +91; anything else must be typed with its country code (+ or 00).
 */
export function normalizePhone(input) {
  const typed = String(input ?? '').trim();
  if (!typed || typed.length > 40 || /[^\d\s+().-]/.test(typed)) return null;
  const plus = typed.startsWith('+');
  let digits = typed.replace(/\D/g, '');
  if (!plus && digits.startsWith('00')) digits = digits.slice(2);
  else if (!plus) {
    if (/^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
    else if (!/^91[6-9]\d{9}$/.test(digits)) return null;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** An email address as stored (lower case), or null when it isn't shaped like one. */
export function normalizeEmail(input) {
  const typed = String(input ?? '').trim().toLowerCase();
  if (!typed || typed.length > 254) return null;
  return /^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(typed) && !typed.includes('..') ? typed : null;
}

/** A first name: letters, marks, spaces and the few signs names carry. A link or markup is not a name. */
export function cleanFirstName(input) {
  const name = oneLine(input, 200);
  if (!name) return { value: '', error: 'Add your first name' };
  if (name.length > 60) return { value: name.slice(0, 60), error: 'Use 60 characters or fewer' };
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u.test(name)) return { value: name, error: 'Use letters only' };
  return { value: name, error: '' };
}

/**
 * Checks what a shopper sent. `channels` are the consent wording's. Answers { lead, errors }: `errors` is { field: message } and
 * empty when the lead may be stored; `lead` has firstName, phone, email (each '' when not given) and the channels it grants.
 */
export function checkLead(input, channels) {
  const errors = {};
  const fields = fieldsFor(channels);
  const name = cleanFirstName(input.firstName);
  if (name.error) errors.firstName = name.error;

  const typedPhone = fields.phone ? String(input.phone ?? '').trim() : '';
  const typedEmail = fields.email ? String(input.email ?? '').trim() : '';
  const phone = typedPhone ? normalizePhone(typedPhone) : '';
  const email = typedEmail ? normalizeEmail(typedEmail) : '';
  if (phone === null) errors.phone = 'Check the phone number. Add the country code if it isn’t an Indian number';
  if (email === null) errors.email = 'Check the email address';
  if (!typedPhone && !typedEmail) {
    errors.contact = fields.phone && fields.email ? 'Add a phone number or email' : fields.phone ? 'Add a phone number' : 'Add an email';
  }
  if (!isTicked(input.consent)) errors.consent = 'Tick the box to agree before sending';

  const lead = { firstName: name.value, phone: phone || '', email: email || '' };
  return { lead: { ...lead, channels: grantedChannels(channels, lead) }, errors, typed: { firstName: oneLine(input.firstName, 60), phone: typedPhone.slice(0, 40), email: typedEmail.slice(0, 254) } };
}

/** A checkbox as a form sends it. Only its own value counts: "0", "false" or an array is not a tick. */
export const isTicked = (value) => value === 'yes' || value === 'on' || value === true;

/** A UTM campaign or a page reference as stored: one short line of plain characters. */
export const cleanTag = (value, max = 200) => (typeof value === 'string' ? oneLine(value, max).replace(/[<>"'`]/g, '') : '');

// ---- the shopper's own link to withdraw or delete (9.18) --------------------------------------------------------------

const mac = (secret, tenant, leadId) => crypto.createHmac('sha256', String(secret)).update(`lead-opt-out:${tenant}:${leadId}`).digest('base64url').slice(0, 32);

/** An opaque token for one lead of one business: its id and a keyed hash. It holds no contact detail. */
export const optOutToken = (secret, tenant, leadId) => `${leadId}.${mac(secret, tenant, leadId)}`;

/** The lead id inside a token made for this business, or null. */
export function readOptOutToken(secret, tenant, token) {
  const match = /^([1-9]\d{0,9})\.([\w-]{32})$/.exec(typeof token === 'string' ? token : '');
  if (!match) return null;
  const expected = Buffer.from(mac(secret, tenant, match[1]));
  const given = Buffer.from(match[2]);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? Number(match[1]) : null;
}

/** The address a hidden "back" field may name: a landing page, the creator page or one of its shelves, on this host. */
export const safeBack = (value) => (typeof value === 'string' && /^\/(r\/)?[a-z0-9-]{1,80}(\/[a-z0-9-]{1,80})?$/.test(value) ? value : '');
