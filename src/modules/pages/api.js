import { ApiError } from '../../contracts/api/index.js';
import { CATALOG_LIMITS as L, PLAN_REASON, whatsappDigits } from '../../contracts/catalog.js';
import { log } from '../../platform/log.js';
import { ValidationError } from '../../util.js';
import { buyerTheme } from '../../views/buyer/index.js';
import { invalidField } from '../admin-api/errors.js';
import { isRowId, mapPage, pageOf, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { storeBaseUrl } from '../admin-api/urls.js';
import { checkBlocks } from './blocks.js';
import { kindOfMedia, mediaColumns } from './media.js';
import { createSharePreviews, previewTarget, previewVersion } from './share.js';

/**
 * The seller's side of landing pages (PRD 8.10 to 8.12, 5.18): /api/v1/pages, /page-media, /page-settings and /page-blocks.
 * The router has already checked who is calling and validated the input against src/contracts/api/pages.js.
 */

const INSTAGRAM_POSTS_FETCHED = 50;
const MEDIA_PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const actorOf = (user) => `user:${user?.id ?? 0}`;
const isoOrNull = (value) => (value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null);

const pageUrl = (base, slug) => `${base}/r/${encodeURIComponent(slug)}`;

const toSummary = (row, base, productLimit) => ({
  id: row.id,
  kind: row.kind,
  channel: row.channel,
  mediaId: row.ig_media_id,
  slug: row.slug,
  headline: row.headline,
  description: row.description,
  active: row.active,
  permalink: row.permalink,
  thumbnailUrl: row.thumbnail_url,
  mediaType: row.media_type,
  postedAt: row.posted_at,
  expiresAt: row.expires_at,
  coverUrl: row.cover_media_id ? `/media/${row.cover_media_id}` : '',
  leadForm: row.lead_form,
  url: pageUrl(base, row.slug),
  categoryIds: row.category_ids ?? [],
  productLimit,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPage = (row, base, productLimit) => ({
  ...toSummary(row, base, productLimit),
  products: row.products.map((p) => ({ id: p.id, name: p.name, pricePaise: p.price_paise, image: p.image_url ?? '', active: p.active, soldOut: p.shown.soldOut, position: p.position })),
});

export function pagesApi(ctx) {
  const { repos, config, ig } = ctx;
  const previews = createSharePreviews(ctx);
  const base = (req) => storeBaseUrl(req, config);

  /** How many products a page may show on this plan: 1 below tier 2, then 20 (K-41). */
  async function productLimit() {
    return Math.min(await repos.entitlements.limit('reel.products'), L.landingProducts);
  }

  async function checkedProducts(ids) {
    const unique = [...new Set(ids)];
    const limit = await productLimit();
    if (unique.length > limit) {
      const message = limit < L.landingProducts
        ? `Your plan links ${limit} product to each page. Upgrade to show up to ${L.landingProducts}.`
        : `A page can show at most ${L.landingProducts} products`;
      throw new ApiError('forbidden', message, { reason: PLAN_REASON, fields: { productIds: message } });
    }
    const own = await repos.landingPages.ownProducts(unique);
    if (own.length !== unique.length) throw invalidField('productIds', 'One of the picked products no longer exists');
    return unique;
  }

  async function checkedCategories(ids) {
    const unique = [...new Set(ids)];
    const own = await repos.landingPages.ownCategories(unique);
    if (own.length !== unique.length) throw invalidField('categoryIds', 'One of the picked categories no longer exists');
    return unique;
  }

  /** '' clears the cover; anything else must be an image this business uploaded. undefined leaves it alone. */
  async function checkedCover(coverUrl) {
    if (coverUrl === undefined) return undefined;
    if (coverUrl === '') return null;
    const id = MEDIA_PATH.exec(coverUrl)?.[1];
    if (!id || !(await repos.landingPages.ownMedia(id))) throw invalidField('coverUrl', 'Upload the cover image first');
    return id.toLowerCase();
  }

  /** The post as Instagram describes it, read with this business's own token, which also proves the post is theirs. */
  async function lookUpMedia(channel, mediaId) {
    if (channel === 'facebook') {
      if (!config.facebookPages) throw invalidField('channel', 'Facebook isn’t switched on for this business');
      return {};
    }
    const account = await repos.igAccounts.current();
    if (!account?.token || !ig?.getMedia) throw new ApiError('conflict', 'Connect your Instagram account before adding a page.');
    try {
      return (await ig.getMedia(account, mediaId)) ?? {};
    } catch (err) {
      log.warn('page.media_lookup_failed', { status: err?.status, code: err?.code });
      if (err?.kind === 'validation' || err?.kind === 'not_found' || err?.status === 400 || err?.status === 404) throw invalidField('mediaId', 'Pick a post from your account');
      throw new ApiError('conflict', 'We couldn’t reach Instagram. Try again in a minute.');
    }
  }

  /** Draws the share image now if what it shows has changed, so the owner's next share already has it. Never fails the save. */
  async function syncPreview(page) {
    try {
      const theme = buyerTheme(await repos.brandKit.get());
      const current = await repos.sharePreviews.get(previewTarget(page));
      if (current?.version !== previewVersion(page, theme)) await previews.build(page, theme);
    } catch (err) {
      log.warn('page.share_preview_failed', { page: page.id, code: err?.code ?? 'error' });
    }
  }

  const refused = async (write) => {
    try {
      return await write();
    } catch (err) {
      if (err instanceof ValidationError) throw new ApiError('validation_failed', err.message, { fields: { slug: err.message } });
      if (err?.code === '23505' || err?.code === '23503') throw new ApiError('conflict', 'That changed while you were saving. Please try again.');
      throw err;
    }
  };

  return {
    'pages.list': async ({ query, req }) => {
      const beforeId = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const [rows, limit] = await Promise.all([repos.landingPages.list({ kind: query.kind, status: query.status, search: query.search, beforeId, limit: query.limit }), productLimit()]);
      const address = base(req);
      return mapPage(pageOfFetched(rows, query.limit, (r) => [r.id]), (r) => ({ ...toSummary(r, address, limit), productCount: r.product_count, visits: r.visit_count }));
    },

    'pages.get': async ({ params, req }) => {
      const page = await repos.landingPages.get(params.id);
      return page && toPage(page, base(req), await productLimit());
    },

    'pages.create': async ({ body, user, req }) => {
      // Another business's post is "not found" here like any other id of theirs.
      if (await repos.landingPages.heldElsewhere(body.mediaId)) throw new ApiError('not_found');
      if ((await repos.landingPages.idsByMedia([body.mediaId])).size) throw new ApiError('conflict', 'This post already has a page.');
      const productIds = await checkedProducts(body.productIds);
      const categoryIds = await checkedCategories(body.categoryIds ?? []);
      const cover = await checkedCover(body.coverUrl);
      if (body.slug && (await repos.landingPages.slugTaken(body.slug))) throw invalidField('slug', `The link “${body.slug}” is already used by another page`);

      const media = await lookUpMedia(body.channel, body.mediaId);
      const kind = media.media_product_type ? kindOfMedia(media) : body.kind;
      const columns = mediaColumns(media, kind);
      const page = await refused(() => repos.landingPages.create({
        ...columns,
        ig_media_id: body.mediaId,
        kind,
        channel: body.channel,
        slug: body.slug || body.headline || columns.caption.split('\n')[0] || `${kind}-${body.mediaId.slice(-8)}`,
        headline: body.headline ?? '',
        description: body.description ?? '',
        active: body.active ?? true,
        cover_media_id: cover ?? null,
        lead_form: body.leadForm ?? null,
      }, { productIds, categoryIds, actor: actorOf(user) }));
      await syncPreview(page);
      return toPage(page, base(req), await productLimit());
    },

    'pages.update': async ({ params, body, user, req }) => {
      const existing = await repos.landingPages.get(params.id);
      if (!existing) return null;
      const productIds = body.productIds ? await checkedProducts(body.productIds) : undefined;
      if (productIds && !productIds.length) throw invalidField('productIds', 'Pick at least 1 product');
      const categoryIds = body.categoryIds ? await checkedCategories(body.categoryIds) : undefined;
      const cover = await checkedCover(body.coverUrl);
      const fields = {};
      for (const [key, column] of [['slug', 'slug'], ['headline', 'headline'], ['description', 'description'], ['active', 'active']]) {
        if (body[key] !== undefined) fields[column] = body[key];
      }
      if (cover !== undefined) fields.cover_media_id = cover;
      if (body.leadForm !== undefined) fields.lead_form = body.leadForm;
      const page = await refused(() => repos.landingPages.update(params.id, fields, { productIds, categoryIds, actor: actorOf(user) }));
      if (!page) return null;
      await syncPreview(page);
      return toPage(page, base(req), await productLimit());
    },

    'pages.remove': async ({ params, user }) => {
      const removed = await repos.landingPages.remove(params.id, { actor: actorOf(user) });
      if (!removed) throw new ApiError('not_found');
      await previews.forget(removed.previewMediaId).catch(() => {});
    },

    /** Posts, reels and (where the account's client can list them) live stories, for choosing which gets a page. */
    'pages.media': async ({ query }) => {
      const account = await repos.igAccounts.current();
      if (!account?.token || !ig?.listMedia) throw new ApiError('conflict', 'Connect your Instagram account to see your posts here.');
      let posts;
      let stories = [];
      try {
        posts = (await ig.listMedia(account, INSTAGRAM_POSTS_FETCHED)).data ?? [];
        if (typeof ig.listStories === 'function') stories = ((await ig.listStories(account, INSTAGRAM_POSTS_FETCHED)).data ?? []).map((s) => ({ ...s, media_product_type: 'STORY' }));
      } catch (err) {
        log.warn('page.media_list_failed', { status: err?.status, code: err?.code });
        throw new ApiError('conflict', 'We couldn’t load your Instagram posts. Try again in a minute.');
      }
      const all = [...stories, ...posts].filter((m) => /^[\w-]{1,80}$/.test(String(m?.id ?? '')));
      const pageIds = await repos.landingPages.idsByMedia(all.map((m) => String(m.id)));
      const choices = all
        .map((m) => ({
          channel: 'instagram',
          mediaId: String(m.id),
          kind: kindOfMedia(m),
          caption: String(m.caption ?? ''),
          permalink: String(m.permalink ?? ''),
          thumbnailUrl: String(m.thumbnail_url ?? m.media_url ?? ''),
          postedAt: isoOrNull(m.timestamp),
          pageId: pageIds.get(String(m.id)) ?? null,
        }))
        .filter((m) => query.kind === 'all' || m.kind === query.kind);
      return pageOf(choices, query);
    },

    'pageSettings.get': () => settingsView(),

    'pageSettings.update': async ({ body, user }) => {
      if (body.whatsappOrder === true && !(await repos.entitlements.can('whatsapp_order'))) {
        throw new ApiError('forbidden', 'The Order on WhatsApp button isn’t part of your plan.', { reason: PLAN_REASON });
      }
      const patch = {};
      if (body.whatsappOrder !== undefined) patch.whatsapp_order = body.whatsappOrder;
      if (body.whatsappTemplate !== undefined) patch.whatsapp_template = body.whatsappTemplate;
      if (body.landingNoindex !== undefined) patch.landing_noindex = body.landingNoindex;
      if (body.moreReels !== undefined) patch.more_reels = body.moreReels;
      if (Object.keys(patch).length) await repos.pageSettings.save(patch, { actor: actorOf(user) });
      return settingsView();
    },

    'pageBlocks.get': ({ query }) => repos.pageBlocks.layout(query.surface),

    'pageBlocks.save': ({ body, user }) => repos.pageBlocks.save(body.surface, checkBlocks(body.surface, body.blocks), { actor: actorOf(user) }),
  };

  async function settingsView() {
    const [row, settings, allowed] = await Promise.all([repos.pageSettings.get(), repos.settings.getAll(), repos.entitlements.can('whatsapp_order')]);
    const number = whatsappDigits(settings.support_whatsapp);
    return {
      whatsappOrder: row.whatsapp_order,
      whatsappAvailable: Boolean(number) && allowed,
      whatsappNumber: number ?? '',
      whatsappTemplate: row.whatsapp_template,
      landingNoindex: row.landing_noindex,
      moreReels: row.more_reels,
    };
  }
}
