export const MAX_REEL_PRODUCTS = 20;
export const RENAME = { productIds: 'products' };

/**
 * A reel is its landing page (PRD 8.10): headline, link name, products. The DM a comment gets is an automation's, set up
 * in Automations (PRD 6.1, final review D-11); the API refuses the old keyword DM fields here, so the form has none.
 */
export const NEW_REEL = Object.freeze({
  headline: '',
  slug: '',
  active: true,
  products: [],
});

export const postKind = (mediaType) => (/reel|video/i.test(mediaType ?? '') ? 'Reel' : 'Post');

export function reelToForm(reel) {
  return {
    headline: reel.headline,
    slug: reel.slug,
    active: reel.active,
    products: reel.products,
  };
}

/**
 * The keyword DM a Phase 0 reel still sends itself, shown read-only until it is set up as an automation, or null for a
 * reel that is only a store. No Bhava text: this is what the shopper receives.
 */
export function legacyDm(reel) {
  if (!reel?.keywords?.length) return null;
  return { keywords: reel.keywords, dmMessage: reel.dmMessage, buttonText: reel.buttonText, publicReply: reel.publicReply };
}

/** The form as the API wants it, or `errors` by field. `media` is what Instagram told us about the post, kept with the reel. */
export function formToReel(form, media = {}) {
  const errors = {};
  const headline = form.headline.trim();
  if (!headline) errors.headline = 'Add a headline';
  if (form.products.length < 1) errors.products = 'Pick at least 1 product for this reel';
  if (form.products.length > MAX_REEL_PRODUCTS) errors.products = `A reel can show at most ${MAX_REEL_PRODUCTS} products`;
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      headline,
      slug: form.slug.trim() || undefined,
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
