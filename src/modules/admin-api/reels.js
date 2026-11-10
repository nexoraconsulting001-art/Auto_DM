import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { invalidField, retryOnRace } from './errors.js';
import { mapPage, pageOf } from './paging.js';
import { reelStoreUrl, storeBaseUrl } from './urls.js';

const INSTAGRAM_POSTS_FETCHED = 50;

const toReel = (r, base) => ({
  id: r.ig_media_id,
  slug: r.slug,
  headline: r.headline,
  keywords: r.keywords,
  dmMessage: r.dm_message,
  buttonText: r.button_text,
  publicReply: r.public_reply,
  active: r.active,
  permalink: r.permalink,
  thumbnailUrl: r.thumbnail_url,
  videoUrl: r.video_url,
  caption: r.caption,
  storeUrl: reelStoreUrl(base, r.slug),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toReelSummary = (r, base) => ({ ...toReel(r, base), productCount: r.product_count, dmCount: r.dm_count, visitCount: r.visit_count, orderCount: r.order_count });

const toReelDetail = (r, base) => ({
  ...toReel(r, base),
  products: r.products.map((p) => ({ id: p.id, name: p.name, pricePaise: p.price_paise, images: p.images, active: p.active, position: p.position })),
});

/** These end up in links on the store's pages, so only a real web address gets through. */
function requireWebLink(value, field, pattern = /^https?:\/\//i) {
  if (value && !pattern.test(value)) throw invalidField(field, 'Use a web link starting with http:// or https://');
}

/**
 * The repo keeps keywords as comma-separated text, so a comma inside one would turn it into two.
 * Saving again keeps the store link: links already sent in DMs must keep working.
 */
function reelInput(body, existing) {
  if (body.keywords.some((keyword) => keyword.includes(','))) throw invalidField('keywords', 'A keyword can’t contain a comma');
  requireWebLink(body.permalink, 'permalink');
  requireWebLink(body.thumbnailUrl, 'thumbnailUrl', /^(https?:\/\/|\/media\/)/i);
  return {
    slug: body.slug ?? existing?.slug,
    headline: body.headline,
    keywords: body.keywords.join(','),
    dm_message: body.dmMessage,
    button_text: body.buttonText,
    public_reply: body.publicReply,
    active: body.active ?? existing?.active ?? true,
    productIds: body.productIds,
    permalink: body.permalink,
    thumbnail_url: body.thumbnailUrl,
    video_url: body.videoUrl,
    caption: body.caption,
  };
}

const toInstagramPost = (post, configured) => ({
  id: post.id,
  caption: post.caption ?? '',
  mediaType: post.media_product_type ?? post.media_type ?? '',
  permalink: post.permalink ?? '',
  thumbnailUrl: post.thumbnail_url ?? post.media_url ?? '',
  configured: configured.has(post.id),
});

export function reelsApi({ repos, config }, setup) {
  const base = (req) => storeBaseUrl(req, config);

  return {
    'reels.list': async ({ query, req }) => {
      const rows = await repos.reels.list();
      const address = base(req);
      return mapPage(pageOf(rows, query, (r) => [-new Date(r.updated_at).getTime(), r.ig_media_id]), (r) => toReelSummary(r, address));
    },

    'reels.get': async ({ params, req }) => {
      const reel = await repos.reels.get(params.id);
      return reel && toReelDetail(reel, base(req));
    },

    // Another business's post is "not found" here like any other id of theirs (PRD 11, R-01).
    'reels.save': async ({ params, body, req }) => {
      if (await repos.adminLists.reelHeldElsewhere(params.id)) throw new ApiError('not_found');
      const existing = await repos.reels.get(params.id);
      const saved = await retryOnRace(() => repos.reels.save(params.id, reelInput(body, existing)));
      return toReelDetail(saved, base(req));
    },

    'reels.remove': async ({ params }) => {
      if (!(await repos.reels.get(params.id))) throw new ApiError('not_found');
      await repos.reels.remove(params.id);
    },

    'reels.instagramPosts': async ({ query }) => {
      const client = await setup.igClient();
      if (!client) throw new ApiError('conflict', 'Connect your Instagram account to see your reels here.');
      let posts;
      try {
        posts = (await client.listMedia(INSTAGRAM_POSTS_FETCHED)).data ?? [];
      } catch (err) {
        log.warn('api.instagram_posts_failed', { status: err.status, code: err.code });
        throw new ApiError('conflict', 'We couldn’t load your Instagram posts. Try again in a minute.');
      }
      const configured = new Set((await repos.reels.list()).map((r) => r.ig_media_id));
      return mapPage(pageOf(posts, query), (post) => toInstagramPost(post, configured));
    },
  };
}
