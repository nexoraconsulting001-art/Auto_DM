import { AI_LIMITS, sourceId, unknownSources } from '../../contracts/addons.js';
import { linksIn } from '../compliance/content.js';
import { hasNegativeIntent, wantsHuman } from '../compliance/words.js';

/**
 * The pure rules of AI replies (PRD 6.11): what is never answered, which of a business's FAQ entries and products go to the
 * provider, and whether a draft may be sent. No database, no clock, no provider: everything here is decided in code, so a
 * shopper's message, whatever it says, cannot change it.
 */

// ---- Never answered (A-59) ----------------------------------------------------------------------------------------------

/**
 * Refunds, cancellations, returns of something bought, damage, a wrong or missing item, a late or lost parcel, and anything
 * about the shopper's own order or payment. None of these is a question an FAQ can settle; a person answers them.
 */
const ORDER_PROBLEMS = [
  /\brefund/i,
  /\bcharge ?back/i,
  /\bmoney back\b/i,
  /\bcancel(?:l?ed|l?ing|lation|s)?\b/i,
  /\b(?:damaged?|broken|defective|faulty|torn|leaking|stained|spoil[te]d?|tampered)\b/i,
  /\b(?:wrong|incorrect|different)\s+(?:item|product|size|colou?r|order|parcel|piece|thing|address)\b/i,
  /\b(?:missing|lost|stolen)\b/i,
  /\b(?:delay(?:ed)?|late|stuck)\b/i,
  /\bnot\s+(?:yet\s+)?(?:arrived|received|delivered|shipped|dispatched|come|reached|working)\b/i,
  /\b(?:hasn'?t|has not|haven'?t|have not|didn'?t|did not|never)\s+(?:yet\s+)?(?:arrived|received|got|gotten|come|reached|delivered|shipped)\b/i,
  /\b(?:where(?:'s| is)|status of|track(?:ing)?|awb)\b[\s\S]*\b(?:order|parcel|package|shipment|courier)\b/i,
  /\b(?:my|our)\s+(?:order|parcel|package|shipment|payment|money|courier)\b/i,
  /\border\s*(?:id|no\.?|number|#)/i,
  /#\s?\d{3,}/,
  /\b(?:return|exchange|replace(?:ment)?)\b[\s\S]*\b(?:it|this|my|order|item|product|these|them)\b/i,
  /\b(?:it|this|my|order|item|product)\b[\s\S]*\b(?:return|exchange|replace(?:ment)?)\b/i,
  /\b(?:complain|complaint|angry|upset|disappointed|unhappy|not happy)\b/i,
  /\b(?:kharab|toota|tuta|tuti|galat|wapas|vapas|wapis|abhi tak)\b/i,
];

/**
 * True when the message must go to a person and the provider is not asked at all: the platform's and the seller's own
 * negative and handoff words (PRD 4.8, 6.4), and every refund, complaint or order problem.
 */
export function neverAnswer(text, { negative = [], handoff = [] } = {}) {
  const value = String(text ?? '');
  if (hasNegativeIntent(value, negative) || wantsHuman(value, handoff)) return true;
  return ORDER_PROBLEMS.some((pattern) => pattern.test(value));
}

// ---- What of the shopper goes to the provider ----------------------------------------------------------------------------

/** A phone number, an email address or an @handle the shopper typed. None of it is needed to answer an FAQ question. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const PHONE = /(?:\+?\d[\s().-]{0,2}){9,}\d/gu;
const HANDLE = /(^|[^\p{L}\p{N}_])@[\p{L}\p{N}._]{2,30}/gu;
export const REMOVED = '[removed]';

/** The question as the provider sees it: the shopper's words without their phone number, email or handle. */
export function withoutContacts(text) {
  return String(text ?? '').replace(EMAIL, REMOVED).replace(PHONE, REMOVED).replace(HANDLE, `$1${REMOVED}`);
}

// ---- Which sources go to the provider ----------------------------------------------------------------------------------

const STOP = new Set(('the and for you your are was were with this that what when where which who how can could would should does did '
  + 'have has had any there their them they our out from about into just please pls plz kya hai hain kab kaise kitna kitne mein '
  + 'aap mujhe hello thanks thank want need know tell').split(' '));

const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase();
const stem = (word) => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/** The words of a text that say what it is about. */
export function termsOf(text) {
  return new Set((fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));
}

const overlap = (terms, text) => [...termsOf(text)].filter((t) => terms.has(t)).length;

/** How many products go when few or none share a word with the question: enough for "what do you sell?". */
const PRODUCT_FILL = 10;

/**
 * This business's FAQ entries and products, the ones that relate to the question first. FAQ entries are the seller's own
 * answers and all of them may go (up to the contract's limit); products that share no word with the question only fill a
 * short list. Both lists come in already scoped to one business.
 */
export function pickSources(question, { faq = [], products = [] } = {}) {
  const terms = termsOf(question);
  const ranked = (items, textOf) => items
    .map((item, index) => ({ item, index, score: overlap(terms, textOf(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const faqRanked = ranked(faq, (f) => `${f.question} ${f.answer}`).slice(0, AI_LIMITS.faqEntries).map((r) => r.item);
  const productRanked = ranked(products, (p) => `${p.name} ${(p.sizes ?? []).join(' ')}`);
  const related = productRanked.filter((r) => r.score > 0).slice(0, AI_LIMITS.products);
  const fill = productRanked.filter((r) => r.score === 0).slice(0, Math.max(0, PRODUCT_FILL - related.length));
  return { faq: faqRanked, products: [...related, ...fill].map((r) => r.item) };
}

// ---- Is the draft grounded? (A-57) --------------------------------------------------------------------------------------

export const rupees = (paise) => `₹${(paise / 100).toFixed(paise % 100 ? 2 : 0)}`;

const URL = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const BARE_LINK = /\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|co|io|shop|store|link|ly|me|app|xyz|biz|info|online|site|example|test|dev|ai|gl|to|cc|tk)\b(?:\/\S*)?/iu;
const MONEY = /(?:₹|\brs\.?|\binr\b)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/-|rupees?\b|rs\b\.?|inr\b)/giu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;
const NUMBER_WORDS = Object.freeze({
  // "one" is left out: "this one" is not a number. A stock level such as "only one left" is a claim below.
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000,
});

/** Claims the draft may make only when the sources it cites make them too: offers, stock levels, delivery times and dates, policies. */
const CLAIMS = [
  // offers and discounts
  /\bdiscount\w*/iu, /\bsales?\b/iu, /\boffers?\b/iu, /\bcoupons?\b/iu, /\bpromo\w*/iu, /\bcodes?\b/iu, /\bcash ?back\b/iu, /\bdeals?\b/iu,
  /\bvouchers?\b/iu, /\bfree\b/iu, /\bflat\b/iu, /\bbogo\b/iu, /%|\bper ?cent\b/iu,
  // stock
  /\bin stock\b/iu, /\bout of stock\b|\bsold out\b|\bunavailable\b/iu, /\b(?:left|remaining)\b/iu, /\blimited\b/iu, /\bselling fast\b/iu,
  /\brunning out\b/iu, /\blast (?:one|piece|few|pair|pieces)\b/iu, /\bhurry\b/iu,
  // delivery times and dates
  /\btoday\b/iu, /\btomorrow\b/iu, /\btonight\b/iu, /\byesterday\b/iu, /\bweekends?\b/iu, /\bweeks?\b/iu, /\bmonths?\b/iu, /\bhours?\b|\bhrs?\b/iu,
  /\bovernight\b/iu, /\bexpress\b/iu, /\bsame[- ]day\b/iu, /\bnext[- ]day\b/iu, /\bminutes?\b|\bmins?\b/iu,
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/iu,
  /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\bmay \d/iu,
  /\b\d{1,2}(?:st|nd|rd|th)\b/iu,
  // policies
  /\brefund\w*/iu, /\breturn\w*/iu, /\bexchang\w*/iu, /\breplac\w*/iu, /\bwarrant\w*/iu, /\bguarant\w*/iu, /\bcod\b|\bcash on delivery\b/iu,
  /\bcancel\w*/iu, /\bship(?:s|ped|ping|ment)?\b/iu, /\bcharge[sd]?\b/iu, /\bfees?\b/iu, /\bemi\b/iu, /\bpolic(?:y|ies)\b/iu, /\bgst\b/iu,
  /\btax(?:es)?\b/iu, /\binvoice\w*/iu, /\bprepaid\b/iu, /\binsur\w*/iu,
];

/** Names an answer to a shopper never carries: the platform, and model providers or models (unless the seller's own sources use the word). */
const PLATFORM = /\bbhava\b/iu;
const PROVIDERS = /\b(?:openai|open ai|anthropic|claude|chat ?gpt|gpt(?:-?\d[\w.]*)?|gemini|llama|mistral|copilot|bard|large language model|language model|llm|as an ai|ai model|ai assistant|artificial intelligence|chatbot)\b/giu;
/** A draft that talks about its own instructions has been steered by the message it answers. */
const INSTRUCTION = /\b(?:ignore|disregard|forget)\b[\s\S]{0,40}\b(?:rules|instructions|above|previous|prompt)\b|\bsystem prompt\b|\b(?:my|your|the|these) instructions\b|\bprompt\b|\bjailbreak\b/iu;
/** This many words of the shopper's message in a row, not in the sources, is the draft repeating what it was told. */
const ECHO_WORDS = 6;

const trimLink = (url) => url.replace(/[)\].,!?;:'"]+$/u, '');
const words = (text) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const numberKey = (raw) => String(Number(raw.replace(/,/g, '')));
const moneyOf = (text) => [...fold(text).matchAll(MONEY)].map((m) => Math.round(Number((m[1] ?? m[2]).replace(/,/g, '')) * 100));

/** Every number a text states: digits outside links and amounts, and number words. */
function numbersOf(text) {
  const plain = fold(text).replace(URL, ' ').replace(MONEY, ' ');
  const found = new Set((plain.match(NUMBER) ?? []).map(numberKey));
  for (const word of words(plain)) if (Object.hasOwn(NUMBER_WORDS, word)) found.add(String(NUMBER_WORDS[word]));
  return found;
}

/** The text of what the answer cites, the only text its facts may come from. */
function corpusOf(cited, { faq, products }) {
  const parts = [];
  for (const f of faq) if (cited.has(sourceId('faq', f.id))) parts.push(f.question, f.answer);
  for (const p of products) {
    if (!cited.has(sourceId('product', p.id))) continue;
    parts.push(p.name, rupees(p.pricePaise), p.inStock ? 'in stock' : 'out of stock', ...(p.sizes ?? []));
  }
  return parts.join('\n');
}

/**
 * Whether a draft may go to a shopper: { ok: true } or { ok: false, why }. `why` names the rule (for tests and plain logs; it
 * never holds the text). The draft may state a price, a discount, a number, a stock level, a delivery time or date, or a
 * policy only when the sources it cites state it; may cite only sources it was given; may carry no link but a cited
 * product's own; may not name the platform or a model provider; and may not repeat or act on the shopper's instructions.
 */
export function checkDraft(answer, { faq = [], products = [], question = '', models = [] } = {}) {
  const draft = String(answer?.draft ?? '');
  if (!draft.trim()) return { ok: false, why: 'empty' };
  if (draft.length > AI_LIMITS.draftChars) return { ok: false, why: 'length' };
  if (unknownSources(answer, { faq, products }).length) return { ok: false, why: 'source' };

  const cited = new Set(answer.sources);
  const corpus = corpusOf(cited, { faq, products });
  const corpusFolded = fold(corpus);

  // Links: only a cited product's own, exactly as given.
  const allowed = new Set(products.filter((p) => cited.has(sourceId('product', p.id)) && p.url).map((p) => p.url));
  let rest = draft;
  for (const raw of draft.match(URL) ?? []) {
    const link = trimLink(raw);
    if (!allowed.has(link)) return { ok: false, why: 'link' };
    rest = rest.replace(raw, ' ');
  }
  // linksIn is what the send path reads as a link (any host a buyer's app makes tappable, whatever its ending); BARE_LINK adds
  // the hosts after an @ that it leaves to the email rules.
  if (BARE_LINK.test(rest) || linksIn(rest).length) return { ok: false, why: 'link' };

  // Names, outside the one link it may carry (a seller's own product page can sit on the platform's domain).
  if (PLATFORM.test(rest)) return { ok: false, why: 'name' };
  for (const m of rest.matchAll(PROVIDERS)) if (!corpusFolded.includes(fold(m[0]))) return { ok: false, why: 'name' };
  for (const model of models) if (model && fold(rest).includes(fold(model))) return { ok: false, why: 'name' };

  // Instructions and echoes of the shopper's message.
  if (INSTRUCTION.test(draft)) return { ok: false, why: 'instruction' };
  const asked = words(question);
  const said = words(draft).join(' ');
  const known = words(corpus).join(' ');
  for (let i = 0; i + ECHO_WORDS <= asked.length; i++) {
    const run = asked.slice(i, i + ECHO_WORDS).join(' ');
    if (` ${said} `.includes(` ${run} `) && !` ${known} `.includes(` ${run} `)) return { ok: false, why: 'echo' };
  }

  // Facts: amounts, numbers, codes and claims.
  const amounts = new Set([...products.filter((p) => cited.has(sourceId('product', p.id))).map((p) => p.pricePaise), ...moneyOf(corpus)]);
  if (moneyOf(rest).some((paise) => !amounts.has(paise))) return { ok: false, why: 'money' };
  const numbers = numbersOf(corpus);
  for (const n of numbersOf(rest)) if (!numbers.has(n)) return { ok: false, why: 'number' };
  const corpusWords = new Set(words(corpus));
  for (const token of words(rest)) if (/\p{L}/u.test(token) && /\d/u.test(token) && !corpusWords.has(token)) return { ok: false, why: 'code' };
  for (const claim of CLAIMS) if (claim.test(rest) && !claim.test(corpus)) return { ok: false, why: 'claim' };
  return { ok: true };
}
