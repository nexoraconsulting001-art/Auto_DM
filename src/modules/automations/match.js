const WORD = /[\p{L}\p{N}\p{M}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Joiners and emoji style selectors: invisible, and typed inconsistently, so they never decide a match.
const INVISIBLE = /[‌‍︎️]/g;

/** NFC, then case-insensitive the way Unicode folding is: ß matches SS, and final sigma matches sigma. */
export const fold = (s) => String(s).normalize('NFC').replace(INVISIBLE, '').toUpperCase().toLowerCase().normalize('NFC');

function matchesOne(text, keyword) {
  const words = fold(keyword).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const phrase = words.map(escapeRegex).join('\\s+');
  // An emoji has no word characters and matches anywhere. A word must stand alone, so a matra is never a word break.
  const before = WORD.test([...words[0]][0]) ? '(?<![\\p{L}\\p{N}\\p{M}])' : '';
  const after = WORD.test([...words.at(-1)].at(-1)) ? '(?![\\p{L}\\p{N}\\p{M}])' : '';
  return new RegExp(`${before}${phrase}${after}`, 'u').test(text);
}

/**
 * The one keyword matcher (PRD 6.2), for comments, story replies and DMs. Pure: true when `text` holds any of `keywords`.
 * Owned by the automations track; every other track imports it from here.
 */
export function matchesKeywords(text, keywords) {
  const folded = fold(text);
  return keywords.some((keyword) => matchesOne(folded, keyword));
}

/** The builder's "Indian price words" preset (PRD 6.2). */
export const INDIAN_PRICE_WORDS = Object.freeze(['price', 'rate', 'kitna', 'kitne', 'daam', 'दाम', 'कीमत', 'भाव']);

/** False for text that is only emoji, punctuation or nothing at all. */
export const hasWords = (text) => LETTER_OR_NUMBER.test(fold(text));

/** Emoji-only, or under 2 characters: such a comment never triggers unless an emoji keyword matched (PRD 4.8). */
export function isTooShort(text) {
  return [...fold(text).replace(/\s+/g, '')].length < 2 || !hasWords(text);
}
