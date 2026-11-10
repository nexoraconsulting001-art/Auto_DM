const WORD = /[\p{L}\p{N}\p{M}]/u;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** NFC, then case-insensitive the way Unicode folding is: ß matches SS, and final sigma matches sigma. */
const fold = (s) => String(s).normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

function matchesOne(text, keyword) {
  const words = fold(keyword).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const phrase = words.map(escapeRegex).join('\\s+');
  // An emoji has no word characters and matches anywhere. A word must stand alone, so a matra is never a word break.
  const source = WORD.test(words.join('')) ? `(?<![\\p{L}\\p{N}\\p{M}])${phrase}(?![\\p{L}\\p{N}\\p{M}])` : phrase;
  return new RegExp(source, 'u').test(text);
}

/**
 * The one keyword matcher (PRD 6.2), for comments, story replies and DMs. Pure: true when `text` holds any of `keywords`.
 * Owned by the automations track; every other track imports it from here.
 */
export function matchesKeywords(text, keywords) {
  const folded = fold(text);
  return keywords.some((keyword) => matchesOne(folded, keyword));
}
