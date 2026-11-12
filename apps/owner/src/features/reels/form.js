/**
 * Pure: a reel store's form, its checks and the shape the API wants (the console's reels/form.js), with every message as
 * a string key so the app can say it in English and Hindi. No React, so the server's tests load it too.
 */

export const MAX_REEL_PRODUCTS = 20;
export const MAX_BUTTON_TEXT = 20;
export const MAX_KEYWORDS = 50;

/**
 * A new reel store starts live, with public replies off (PRD 4.9). The words are the shopper's DM, so they name the
 * seller's own store and never the platform; the seller changes them before saving.
 */
export const NEW_REEL = Object.freeze({
  headline: '',
  slug: '',
  keywords: ['LINK'],
  keywordDraft: '',
  dmMessage: 'Hey @{username}! Here’s everything from the reel 👇',
  buttonText: 'Shop now',
  publicReplyOn: false,
  publicReply: '',
  active: true,
  products: [],
});

/** 'reel' or 'post', for the words beside a post the API describes by Instagram's media type. */
export const postKind = (mediaType) => (/reel|video/i.test(mediaType ?? '') ? 'reel' : 'post');

/** Comma-separated words, trimmed, each once. */
export const splitList = (text) => [...new Set(String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean))];

/** Keywords as chips: adds what was typed, ignoring case when checking for one already there. */
export function addKeywords(keywords, typed) {
  const next = [...keywords];
  for (const word of splitList(typed)) {
    if (!next.some((existing) => existing.toLowerCase() === word.toLowerCase())) next.push(word);
  }
  return next;
}

export function reelToForm(reel) {
  return {
    headline: reel.headline,
    slug: reel.slug,
    keywords: reel.keywords,
    keywordDraft: '',
    dmMessage: reel.dmMessage,
    buttonText: reel.buttonText,
    publicReplyOn: reel.publicReply !== '',
    publicReply: reel.publicReply,
    active: reel.active,
    products: reel.products,
  };
}

/** One item moved up (-1) or down (+1), the rest in order. Out of range changes nothing. */
export function moveItem(list, index, by) {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

const chars = (text) => [...String(text ?? '')].length;

/**
 * The form as the API wants it, or `errors` by field as string keys ({ key, values }). Everything found is reported at
 * once. `media` is what Instagram said about the post, kept with the reel.
 */
export function formToReel(form, media = {}) {
  const errors = {};
  const headline = form.headline.trim();
  if (!headline) errors.headline = { key: 'reels.error.headline' };
  const keywords = addKeywords(form.keywords, form.keywordDraft);
  if (!keywords.length) errors.keywords = { key: 'reels.error.keywords' };
  else if (keywords.length > MAX_KEYWORDS) errors.keywords = { key: 'reels.error.tooManyKeywords', values: { max: MAX_KEYWORDS } };
  const buttonText = form.buttonText.trim();
  if (chars(buttonText) > MAX_BUTTON_TEXT) errors.buttonText = { key: 'reels.error.buttonText', values: { max: MAX_BUTTON_TEXT } };
  if (form.publicReplyOn && !form.publicReply.trim()) errors.publicReply = { key: 'reels.error.publicReply' };
  if (form.products.length < 1) errors.products = { key: 'reels.error.noProducts' };
  if (form.products.length > MAX_REEL_PRODUCTS) errors.products = { key: 'reels.error.tooManyProducts', values: { max: MAX_REEL_PRODUCTS } };
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      headline,
      slug: form.slug.trim() || undefined,
      keywords,
      dmMessage: form.dmMessage.trim(),
      buttonText,
      publicReply: form.publicReplyOn ? form.publicReply.trim() : '',
      active: form.active,
      productIds: form.products.map((product) => product.id),
      permalink: media.permalink ?? '',
      thumbnailUrl: media.thumbnailUrl ?? '',
      caption: (media.caption ?? '').slice(0, 500),
      ...(media.videoUrl ? { videoUrl: media.videoUrl } : {}),
    },
  };
}

/** The DM as the commenter will see it, with a stand-in name. */
export const previewMessage = (text) => String(text ?? '').replaceAll('{username}', 'asha');

/**
 * One card per Instagram post, whether or not it has a store yet, then any reels Instagram didn't return (older posts,
 * or Instagram being unreachable, so a reel already set up is never hidden by Instagram being down).
 */
export function mergeReelCards(posts, reels) {
  const configured = new Map(reels.map((reel) => [reel.id, reel]));
  const cards = posts.map((post) => {
    const reel = configured.get(post.id);
    const kind = postKind(post.mediaType);
    configured.delete(post.id);
    return { id: post.id, thumbnailUrl: post.thumbnailUrl || reel?.thumbnailUrl || '', title: reel?.headline || post.caption.slice(0, 70), kind, reel: reel ?? null, post };
  });
  for (const reel of configured.values()) {
    cards.push({ id: reel.id, thumbnailUrl: reel.thumbnailUrl, title: reel.headline || reel.caption.slice(0, 70) || reel.slug, kind: 'reel', reel, post: null });
  }
  return cards;
}

/** A field error from the server (its `fields`), under the form's own names. */
export const RENAME = Object.freeze({ productIds: 'products' });
export function serverFieldErrors(error) {
  const out = {};
  for (const [field, message] of Object.entries(error?.fields ?? {})) {
    if (typeof message === 'string' && message.trim()) out[RENAME[field] ?? field] = { text: message.trim() };
  }
  return out;
}
