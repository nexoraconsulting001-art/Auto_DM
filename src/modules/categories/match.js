/**
 * Auto-join rules (PRD 8.13): whether a landing page matches a category's rule. Pure functions, so the job, the "Apply to
 * existing reels" button and the pages module all decide the same way.
 *
 *   caption_keyword  the word or phrase appears in the caption as whole words, any case ("steel" matches "Steel bottle", not "steeler")
 *   hashtag          the caption carries that hashtag, any case, with or without the # in the rule
 *   product_category one of the page's products is in the rule's product category (checked by the caller in SQL)
 */

const WORD = /[\p{L}\p{M}\p{N}_]/u;

/** The text people type, made comparable: lower case, accents kept, spaces squeezed. */
const fold = (value) => String(value ?? '').normalize('NFC').toLocaleLowerCase('en-IN').replace(/\s+/g, ' ').trim();

/** "#Diwali" and "diwali" are the same rule; anything that isn't a word character is dropped. */
export const hashtagOf = (value) => fold(value).replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '');

/** Every hashtag in a caption, lower case and without the #. */
export function hashtagsIn(caption) {
  const tags = new Set();
  for (const match of fold(caption).matchAll(/#([\p{L}\p{M}\p{N}_]{1,100})/gu)) tags.add(match[1]);
  return tags;
}

/** True when `phrase` sits in `text` with no word character touching either end. No regular expression is built from the phrase. */
export function containsWords(text, phrase) {
  const haystack = fold(text);
  const needle = fold(phrase);
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + needle.length] ?? '';
    if (!WORD.test(before) && !WORD.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Whether `page` ({ caption, headline, productCategoryIds }) matches `rule` ({ match, value, product_category_id }).
 * A caption keyword is looked for in the caption and the page's headline, which is how the owner names the reel.
 */
export function matchesRule(rule, page) {
  if (rule.match === 'hashtag') {
    const tag = hashtagOf(rule.value);
    return Boolean(tag) && hashtagsIn(page.caption).has(tag);
  }
  if (rule.match === 'caption_keyword') return containsWords(page.caption, rule.value) || containsWords(page.headline, rule.value);
  if (rule.match === 'product_category') return (page.productCategoryIds ?? []).includes(Number(rule.product_category_id));
  return false;
}
