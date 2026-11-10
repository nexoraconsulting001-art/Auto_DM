import { COMPLIANCE_LIMITS as LIMITS } from '../../contracts/compliance.js';

/**
 * The content rules (PRD 4.10), used when a template is saved and again at send. Owned by the compliance track;
 * automations, links and the inbox import these two functions from here. Pure: no database, no clock.
 */

const VARIABLES = Object.freeze({ first_name: 'firstName', url: 'url' });

/** Fills {first_name} and {url}. Anything else stays as written, and checkContent reports it as content.bad_variable. */
export function fillTemplate(template, { firstName = '', url = '' } = {}) {
  const values = { firstName, url };
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(VARIABLES, name) ? values[VARIABLES[name]] : whole));
}

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');
const chars = (s) => [...String(s)].length;

// Lookarounds rather than \b, which only knows ASCII: Devanagari letters and matras are word characters here.
const WORD_START = '(?<![\\p{L}\\p{N}\\p{M}])';
const WORD_END = '(?![\\p{L}\\p{N}\\p{M}])';
const term = (words) => new RegExp(`${WORD_START}(?:${words.join('|')})${WORD_END}`, 'iu');

/** Asking for card, bank or identity details (PRD 4.10, in English, Hindi and Hinglish). "pin code" is a delivery address, not a PIN. */
const FINANCIAL = [
  term(['otp', 'o\\.t\\.p\\.?', 'cvv', 'cvc', 'upi\\s*pin', 'atm\\s*pin', 'm-?pin', 'password', 'passwords', 'passcode', 'net\\s*banking\\s*(?:id|login|details?)']),
  term(['(?:(?:credit|debit|atm)\\s*)?card\\s*(?:number|no\\.?|num|details?)', 'card\\s*ka\\s*(?:number|no\\.?|details?)', '(?:bank\\s*)?(?:account|a\\/c|acct)\\s*(?:number|no\\.?|details?)', 'bank\\s*details?', 'ifsc', 'khata\\s*(?:number|no\\.?)']),
  term(['aadhaar', 'aadhar', 'adhaar', 'adhar\\s*(?:card|number|no\\.?)', 'pan\\s*(?:card|number|no\\.?|details?)']),
  term(['ओटीपी', 'सीवीवी', 'यूपीआई\\s*पिन', 'एटीएम\\s*पिन', 'पासवर्ड', 'आधार\\s*(?:कार्ड|नंबर|संख्या)', 'पैन\\s*(?:कार्ड|नंबर|संख्या)', 'कार्ड\\s*(?:का\\s*)?(?:नंबर|संख्या)', 'खाता\\s*(?:संख्या|नंबर)', 'बैंक\\s*(?:खाता|विवरण|डिटेल)']),
];
// A capital-letter PAN is the tax id; a lowercase "pan" is cookware.
const PAN_ALONE = /(?<![\p{L}\p{N}\p{M}])PAN(?![\p{L}\p{N}\p{M}])/u;

/**
 * Bhava's own name, domains, handles and brand phrases (PRD 4.10). "bhav" and "bhava" as ordinary words are not promotion:
 * this looks for a domain, a handle, or the name right after a word that points at a product.
 */
const PROMO = [
  /(?<![\p{L}\p{N}\p{M}])(?:www\.)?(?:get|use|try)?bhava(?:hq)?\.(?:app|in|co\.in|com|co|net|org|store|shop|link|io|ai|me|to|site)(?![\p{L}\p{N}\p{M}])/iu,
  /(?<![\p{L}\p{N}\p{M}])@(?:get|use|try|join)?[._]?bhava(?:[._]?(?:hq|app|official|india|in))?(?![\p{L}\p{N}\p{M}])/iu,
  /(?<![\p{L}\p{N}\p{M}])(?:on|with|by|via|using|try|join|from|powered\s+by|made\s+with|built\s+with|built\s+on|sell\s+on|shop\s+on|download|install)\s+bhava(?:\s+app)?(?![\p{L}\p{N}\p{M}])/iu,
  /(?<![\p{L}\p{N}\p{M}])bhava\s+(?:app|platform|store\s+builder|hq)(?![\p{L}\p{N}\p{M}])/iu,
];
function promoHost(url) {
  try {
    return /(?:^|\.)(?:get|use|try)?bhava(?:hq)?\.[a-z.]{2,}$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Every {name} in the text that isn't one of the two variables. */
function badVariables(text, filled) {
  const found = [];
  for (const [, inner] of String(text).matchAll(/\{([^{}\n]{1,60})\}/g)) {
    // Once filled there are no variables left, so a surviving {first_name} is as wrong as a {username}.
    if (filled || !Object.hasOwn(VARIABLES, inner)) found.push(inner);
  }
  return found;
}

function isUnder(url, domain) {
  if (!domain) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`);
  } catch {
    return false;
  }
}

const asksForFinancials = (text) => FINANCIAL.some((re) => re.test(text)) || PAN_ALONE.test(text);
const promotes = (text) => PROMO.some((re) => re.test(text));

/**
 * Every rule a message breaks, as [{ reason, message, field }], empty when it is fine.
 * input: { text, buttonTitle?, url?, quickReplies?, filled?, ownDomain? }. filled is true at send, after the variables are filled.
 * buttonTitle '' means no button. A message over a limit is refused, never cut. ownDomain is the neutral domain sellers' pages live on
 * (<slug>.<domain>, PRD 5.4): a link to a seller's own page is theirs, even if that domain ever carries the platform's name.
 */
export function checkContent({ text = '', buttonTitle = '', url = '', quickReplies = [], filled = false, ownDomain = '' } = {}) {
  const problems = [];
  const add = (reason, message, field) => problems.push({ reason, message, field });
  const ownUrl = (u) => isUnder(u, ownDomain);
  const words = [urlsIn(text).reduce((rest, u) => (ownUrl(u) ? rest.replaceAll(u, '') : rest), text), buttonTitle, ...quickReplies.map((q) => q?.title ?? '')].join('\n');

  if (bytes(text) > LIMITS.textBytes) add('content.too_long', `Keep the message to ${LIMITS.textBytes} bytes. Hindi letters count as 3 each.`, 'text');
  if (buttonTitle && chars(text) > LIMITS.buttonTextChars) add('content.too_long', `A message with a button can be at most ${LIMITS.buttonTextChars} characters.`, 'text');
  if (buttonTitle && chars(buttonTitle) > LIMITS.buttonTitleChars) add('content.button_title', `Keep the button text to ${LIMITS.buttonTitleChars} characters.`, 'buttonTitle');
  if (quickReplies.length > LIMITS.quickRepliesMax) add('content.too_long', `Use at most ${LIMITS.quickRepliesMax} quick replies.`, 'quickReplies');
  quickReplies.forEach((reply, i) => {
    if (chars(reply?.title ?? '') > LIMITS.quickReplyTitleChars) add('content.button_title', `Keep each quick reply to ${LIMITS.quickReplyTitleChars} characters.`, `quickReplies.${i}`);
  });
  for (const name of badVariables(text, filled)) add('content.bad_variable', `{${name}} can’t be used here. Use {first_name} or {url}.`, 'text');
  if (asksForFinancials(words)) add('content.financial_request', 'A message can’t ask for card, bank, OTP, password, Aadhaar or PAN details.', 'text');
  if (promotes(words) || (url && !ownUrl(url) && promoHost(url))) add('content.bhava_promo', 'Messages can’t name or link to the platform that sends them.', 'text');
  return problems;
}

/** The neutral note a seller may switch on (PRD 4.10). It names nobody and counts toward the byte limit. */
export const DISCLOSURE_LINE = 'Automated reply';
export const withDisclosure = (text) => `${text}\n\n${DISCLOSURE_LINE}`;

const REPLY_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|net|org|co|io|shop|store|link|ly|me|app)\b/i;
const REPLY_PHONE = /(?:\+?\d[\s-]?){10,}/;
const REPLY_PRICE = /₹|\brs\.?\s*\d|\binr\s*\d|\d\s*\/-/i;

/**
 * Why this public reply can't go, as [{ reason, message }] (PRD 4.9). The brand kit checks the same at save, so this only
 * fires if a variant reached the database some other way. The reason enum has no code for a phone number or a price in a public
 * reply; content.financial_request is the nearest and keeps it out of the send path.
 */
export function checkPublicReply(text) {
  const problems = [];
  if (chars(text) > LIMITS.publicReplyMaxChars) problems.push({ reason: 'content.too_long', message: `Keep a public reply to ${LIMITS.publicReplyMaxChars} characters.` });
  if (REPLY_LINK.test(text)) problems.push({ reason: 'link.not_allowlisted', message: 'A public reply can’t contain a link.' });
  if (REPLY_PHONE.test(text) || REPLY_PRICE.test(text)) problems.push({ reason: 'content.financial_request', message: 'A public reply can’t contain a phone number or a price.' });
  if (promotes(text)) problems.push({ reason: 'content.bhava_promo', message: 'A public reply can’t name the platform.' });
  return problems;
}

/** Every https or http address written in the text, for the link rules. */
export const urlsIn = (text) => [...String(text).matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)].map(([u]) => u.replace(/[),.;!?]+$/, ''));
