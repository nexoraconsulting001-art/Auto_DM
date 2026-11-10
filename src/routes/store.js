import express from 'express';
import QRCode from 'qrcode';
import { PRICE_BANDS, ValidationError } from '../util.js';
import { SORTS } from '../repos/products.js';
import { buyerSettings } from '../modules/brand/index.js';
import { log } from '../platform/log.js';
import {
  HOME_PAGE_SIZE, aboutPage, checkoutPage, homePage, notFoundPage, orderPage, productForClient, productPage,
  reelForClient, reelStorePage, reelsFeedPage, shopPage,
} from '../views/store.js';

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

export function storeRoutes({ repos, ig, auth }) {
  const refreshMedia = mediaRefresher({ repos, ig });
  const r = express.Router();
  const page = (res, view, status = 200) => res.status(status).type('html').send(String(view));
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
    const sort = SORTS[req.query.sort] ? req.query.sort : 'popular';
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

  // Browsing is open to everyone; placing an order needs an account.
  r.get('/checkout', auth.requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    page(res, checkoutPage({ settings: await buyerSettings(repos), user: req.user, csrf: req.csrf }));
  });

  r.get('/order/:token', async (req, res) => {
    const order = await repos.orders.getByToken(req.params.token);
    if (!order) return notFound(req, res, 'We couldn’t find that order.');
    const settings = await buyerSettings(repos);
    let qrSvg = '';
    let upiLink = '';
    if (order.status === 'awaiting_payment') {
      const upi = new URLSearchParams({
        pa: settings.upi_id,
        pn: settings.upi_payee || settings.store_name,
        am: (order.total_paise / 100).toFixed(2),
        cu: 'INR',
        tn: `Order ${order.order_number}`,
      });
      upiLink = `upi://pay?${upi}`;
      qrSvg = await QRCode.toString(upiLink, { type: 'svg', margin: 0, color: { dark: '#1d1b16', light: '#ffffff' } });
    }
    res.set('Cache-Control', 'no-store');
    page(res, orderPage({ settings, user: req.user, csrf: req.csrf, order, qrSvg, upiLink }));
  });

  r.post('/order/:token/paid', async (req, res) => {
    await repos.orders.markPaymentSubmitted(req.params.token);
    res.redirect(303, `/order/${encodeURIComponent(req.params.token)}`);
  });

  r.use(async (req, res) => notFound(req, res, 'This page doesn’t exist.'));

  return r;
}

export function apiRoutes({ repos }) {
  const r = express.Router();
  const hits = new Map();

  // Basic abuse protection: at most 20 order attempts per IP per 10 minutes.
  const limit = (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip) || { n: 0, reset: now + 10 * 60_000 };
    if (now > h.reset) Object.assign(h, { n: 0, reset: now + 10 * 60_000 });
    h.n++;
    hits.set(req.ip, h);
    if (h.n > 20) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };

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

  r.post('/orders', limit, async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Please log in to place your order.', login: '/login?next=/checkout' });
      const { items, customer, reelSlug, source } = req.body || {};
      const settings = await repos.settings.getAll();
      const reel = reelSlug ? await repos.reels.getStore(reelSlug) : null;
      const order = await repos.orders.create(
        { items, customer, reelId: reel?.ig_media_id ?? null, source: source || '', userId: req.user.id },
        settings,
      );
      // Filled in at the shopper's next checkout.
      await repos.users.saveAddress(req.user.id, {
        name: order.customer_name, phone: order.phone, email: order.email, address: order.address,
        city: order.city, state: order.state, pincode: order.pincode,
      });
      res.status(201).json({ token: order.public_token, orderNumber: order.order_number });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  return r;
}

export function mediaRoutes({ repos }) {
  const r = express.Router();
  r.get('/:id', async (req, res) => {
    const m = await repos.media.get(req.params.id);
    if (!m) return res.sendStatus(404);
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.send(m.data);
  });
  return r;
}
