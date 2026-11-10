import { splitList } from '../../lib/lists.js';

export const MAX_REEL_PRODUCTS = 20;
export const MAX_BUTTON_TEXT = 20;
export const RENAME = { productIds: 'products' };

/** A new reel store starts live, with public replies off (PRD 4.9). No Bhava text: this is what the shopper receives. */
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

export const postKind = (mediaType) => (/reel|video/i.test(mediaType ?? '') ? 'Reel' : 'Post');

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

/** Keywords as chips: adds what was typed, ignoring case when checking for one already there. */
export function addKeywords(keywords, typed) {
  const next = [...keywords];
  for (const word of splitList(typed)) {
    if (!next.some((existing) => existing.toLowerCase() === word.toLowerCase())) next.push(word);
  }
  return next;
}

/** The form as the API wants it, or `errors` by field. `media` is what Instagram told us about the post, kept with the reel. */
export function formToReel(form, media = {}) {
  const errors = {};
  const headline = form.headline.trim();
  if (!headline) errors.headline = 'Add a headline';
  const keywords = addKeywords(form.keywords, form.keywordDraft);
  if (!keywords.length) errors.keywords = 'Add at least one keyword people can comment';
  const buttonText = form.buttonText.trim();
  if (buttonText.length > MAX_BUTTON_TEXT) errors.buttonText = `Button text must be ${MAX_BUTTON_TEXT} characters or fewer`;
  if (form.publicReplyOn && !form.publicReply.trim()) errors.publicReply = 'Write the reply, or turn public replies off';
  if (form.products.length < 1) errors.products = 'Pick at least 1 product for this reel';
  if (form.products.length > MAX_REEL_PRODUCTS) errors.products = `A reel can show at most ${MAX_REEL_PRODUCTS} products`;
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

/** The DM as the commenter will see it. */
export const previewMessage = (text) => String(text ?? '').replaceAll('{username}', 'asha');

/**
 * One card per Instagram post, whether or not it has a store yet, then any reels Instagram didn't return
 * (older posts, or Instagram being unreachable).
 */
export function mergeReelCards(posts, reels) {
  const configured = new Map(reels.map((reel) => [reel.id, reel]));
  const cards = posts.map((post) => {
    const reel = configured.get(post.id);
    const kind = postKind(post.mediaType);
    configured.delete(post.id);
    return { id: post.id, thumbnailUrl: post.thumbnailUrl || reel?.thumbnailUrl || '', title: reel?.headline || post.caption.slice(0, 70) || `${kind} ${post.id}`, kind, reel, post };
  });
  for (const reel of configured.values()) {
    cards.push({ id: reel.id, thumbnailUrl: reel.thumbnailUrl, title: reel.headline || reel.caption.slice(0, 70) || reel.slug, kind: 'Reel', reel, post: null });
  }
  return cards;
}
