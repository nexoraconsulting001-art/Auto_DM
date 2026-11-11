import express from 'express';
import { PRICE_BANDS } from '../../util.js';
import { SORTS } from '../../repos/products.js';
import { buyerSettings } from '../brand/index.js';
import { log } from '../../platform/log.js';
import {
  HOME_PAGE_SIZE, aboutPage, homePage, notFoundPage, productForClient, productPage, reelForClient, reelStorePage, reelsFeedPage, shopPage,
} from '../../views/store.js';

/**
 * The Phase 0 store pages, moved here from src/routes/store.js with their behaviour unchanged, so the storefront track owns
 * them and replaces them page by page (PRD 9.1). Checkout and the order page went to src/modules/checkout/legacy.js, sign-in
 * and "My account" to src/modules/shoppers/legacy.js.
 */
const MEDIA_REFRESH_MS = 6 * 60 * 60 * 1000;

// Instagram CDN links (thumbnails and videos) expire; refresh in the background, at most every 6 hours per reel.
function mediaRefresher({ repos, ig }) {
  const refreshing = new Set();
  return (reel) => {
    if (!ig?.getMedia || refreshing.has(reel.ig_media_id)) return;
    if (Date.now() - new Date(reel.media_checked_at).getTime() < MEDIA_REFRESH_MS) return;
    refreshing.add(reel.ig_media_id);
    repos.igAccounts.current()
      .then((account) => (account ? ig.getMedia(account, reel.ig_media_id) : null))
      .then((m) =>
        m && repos.reels.updateMediaInfo(reel.ig_media_id, {
          thumbnail_url: m.thumbnail_url || m.media_url,
          permalink: m.permalink,
          video_url: m.media_type === 'VIDEO' ? m.media_url : '',
        }),
      )
      .catch((err) => log.warn('reel.media_refresh_failed', { media: reel.ig_media_id, status: err.status, code: err.code }))
      .finally(() => refreshing.delete(reel.ig_media_id));
  };
}

const page = (res, view, status = 200) => res.status(status).type('html').send(String(view));

/** Every browsing page, then the store's own 404 for whatever nothing answered. Mounted last (the storefront module's lastRoutes). */
export function legacyStorePages({ repos, ig }) {
  const refreshMedia = mediaRefresher({ repos, ig });
  const r = express.Router();
  const notFound = async (req, res, message) =>
    page(res, notFoundPage({ settings: await buyerSettings(repos), user: req.user, message }), 404);

  r.get('/', async (req, res) => {
    const [settings, categories, feed, featured] = await Promise.all([
      buyerSettings(repos), repos.categories.list({ visibleOnly: true }), repos.reels.feed({ limit: 10 }), repos.products.featured(8),
    ]);
    // No featured products yet: show the biggest discounts instead.
    const deals = featured.length >= 4 ? featured : (await repos.products.listActive({ sort: 'discount', limit: 8 })).products;
    feed.reels.forEach(refreshMedia);
    page(res, homePage({ settings, user: req.user, categories: categories.filter((c) => c.product_count > 0), reels: feed.reels, deals }));
  });

  async function shop(req, res, category) {
    const q = String(req.query.q || '').slice(0, 80);
    const price = PRICE_BANDS.some((b) => b.key === req.query.price) ? req.query.price : '';
    // Only a sort this store defines: a name every object inherits ("constructor") is not one.
    const sort = typeof req.query.sort === 'string' && Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'popular';
    const shown = Math.min(Math.max(Number(req.query.show) || HOME_PAGE_SIZE, HOME_PAGE_SIZE), 480);
    const [settings, categories, { products, total }] = await Promise.all([
      buyerSettings(repos),
      repos.categories.list({ visibleOnly: true }),
      repos.products.listActive({ search: q, category: category?.slug || '', band: price, sort, limit: shown }),
    ]);
    page(res, shopPage({
      settings, user: req.user, category, products, total, shown: products.length,
      categories: categories.filter((c) => c.product_count > 0),
      filters: { q, price, sort, show: req.query.show ? String(shown) : '' },
    }));
  }

  r.get('/shop', (req, res) => shop(req, res, null));

  r.get('/c/:slug', async (req, res) => {
    const category = await repos.categories.getBySlug(req.params.slug);
    if (!category) return notFound(req, res, 'This category isn’t available.');
    await shop(req, res, category);
  });

  r.get('/p/:productSlug', async (req, res) => {
    const product = await repos.products.getActiveBySlug(req.params.productSlug);
    if (!product) return notFound(req, res, 'This product isn’t available.');
    const [settings, categories, related] = await Promise.all([
      buyerSettings(repos), repos.products.categoriesOf(product.id), repos.products.related(product, 4),
    ]);
    page(res, productPage({ settings, user: req.user, reel: null, product, categories: categories.filter((c) => c.visible), related }));
  });

  r.get('/reels', async (req, res) => {
    const [settings, feed] = await Promise.all([buyerSettings(repos), repos.reels.feed({ limit: 8 })]);
    feed.reels.forEach(refreshMedia);
    page(res, reelsFeedPage({ settings, user: req.user, feed }));
  });

  r.get('/r/:slug', async (req, res) => {
    const reel = await repos.reels.getStore(req.params.slug);
    if (!reel || !reel.active) return notFound(req, res, 'This reel’s store isn’t open right now.');
    // Admin previews (?preview=1) and the owner's own visits don't count.
    if (!req.query.preview && !['owner', 'staff'].includes(req.user?.role)) await repos.reels.recordVisit(reel.ig_media_id, req.query.src || '');
    refreshMedia(reel);
    const [settings, feed] = await Promise.all([buyerSettings(repos), repos.reels.feed({ limit: 7 })]);
    const moreReels = feed.reels.filter((x) => x.ig_media_id !== reel.ig_media_id).slice(0, 6);
    page(res, reelStorePage({ settings, user: req.user, reel, moreReels }));
  });

  r.get('/r/:slug/p/:productSlug', async (req, res) => {
    const reel = await repos.reels.getStore(req.params.slug);
    const product = reel?.active && reel.products.find((p) => p.slug === req.params.productSlug);
    if (!product) return notFound(req, res, 'This product isn’t available.');
    // "You may also like" stays inside the reel: the other pieces from the same video.
    const related = reel.products.filter((p) => p.id !== product.id).slice(0, 4);
    page(res, productPage({ settings: await buyerSettings(repos), user: req.user, reel, product, categories: [], related }));
  });

  r.get('/about', async (req, res) => page(res, aboutPage({ settings: await buyerSettings(repos), user: req.user })));

  r.use(async (req, res) => notFound(req, res, 'This page doesn’t exist.'));

  return r;
}

/** JSON the store's own pages call, under /api. */
export function legacyStoreApi({ repos }) {
  const r = express.Router();

  // Used when the bag moves to another browser (e.g. Instagram → Chrome): fills in names, prices and photos.
  r.get('/products', async (req, res) => {
    const ids = String(req.query.ids || '').split(',');
    const products = await repos.products.getActiveByIds(ids);
    res.json({ products: products.map((p) => productForClient(p, '')) });
  });

  // The reels tab loads the next batch as the shopper scrolls.
  r.get('/reels', async (req, res) => {
    const feed = await repos.reels.feed({ cursor: String(req.query.cursor || '').replace(/\D/g, ''), limit: 8 });
    res.json({ reels: feed.reels.map(reelForClient), nextCursor: feed.nextCursor });
  });

  return r;
}
