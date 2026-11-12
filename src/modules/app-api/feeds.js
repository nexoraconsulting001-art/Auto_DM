import { BUYER_BLOCKS } from '../../contracts/buyer-pages.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { APP_ROUTES, AppCatalogQuery, AppPageQuery, AppReelsQuery, POLICY_KINDS } from '../../contracts/store-routes.js';
import { tenantId } from '../../tenancy.js';
import { loadBuyerLayout } from '../../views/buyer/index.js';
import { nowOf } from '../categories/buyer.js';
import { allReels } from '../categories/pages.js';
import { PAGE_COLS } from '../categories/repo.js';
import { POLICY_TITLES, defaultPrivacy } from '../consent/views.js';
import { storeCatalog } from '../storefront/catalog.js';
import { parseBody } from '../storefront/http.js';
import { appCall, categoryCard, cursorNumber, notFound, productCards, reelCards } from './http.js';

/**
 * What the app browses (PRD 10.7, 10.11): home, the catalog, a product, categories with their reels, the Reels tab, a landing
 * page and the policies. The same queries as the web store, so the app and the web always agree: today's prices, only what is
 * live, a category's pinned reels first and then its set order (P-65). Reading a landing page records nothing (P-51).
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
const HOME_BLOCKS = new Set(Object.keys(BUYER_BLOCKS).filter((key) => BUYER_BLOCKS[key].surfaces.includes('store_home')));

/** A page of a list read by page number: the cursor is the next page's number. */
const pageAnswer = (items, { page, pages }) => ({ items, nextCursor: page < pages ? String(page + 1) : null });

const OTHER_POLICY = Object.freeze({
  terms: (store) => `${store} sells the items on this app at the prices shown when you place your order. Write to the store with any question about an order.`,
  refund: (store) => `If something is wrong with your order, write to ${store}. Returns and refunds follow the store's own policy for each item.`,
  shipping: (store) => `${store} ships to the address you give at checkout. You can follow your parcel from your orders.`,
});

export function mountFeedRoutes(app, ctx) {
  const { db, repos, config } = ctx;
  const catalog = storeCatalog(db);
  const sequences = () => repos.categorySequences;
  const slugOf = (value) => {
    const slug = String(value ?? '').toLowerCase();
    return SLUG.test(slug) ? slug : null;
  };

  app.get(APP_ROUTES.appHome.path, appCall(async () => {
    const now = nowOf(config);
    const [layout, categories, shelves, uncategorized, featured] = await Promise.all([
      repos.pageBlocks.layout('store_home'), catalog.categories(), sequences().liveShelves({ now, perCategory: 12 }), sequences().liveUncategorized({ limit: 12 }), catalog.featured(12),
    ]);
    return {
      body: {
        blocks: layout.blocks.filter((b) => b.visible && HOME_BLOCKS.has(b.block)).map((b) => ({ type: b.block, settings: b.settings ?? {} })),
        categories: categories.map(categoryCard),
        reels: await reelCards(db, allReels(shelves, uncategorized).slice(0, 12).map((r) => ({ ...r, pinned: false })), { now }),
        products: await productCards(db, featured),
      },
    };
  }));

  app.get(APP_ROUTES.appCatalog.path, appCall(async (req) => {
    const query = parseBody(AppCatalogQuery, req.query);
    let categoryId = null;
    if (query.category) {
      const category = await catalog.category(query.category);
      if (!category) throw notFound('This category isn’t available.');
      categoryId = category.id;
    }
    const page = Math.max(1, cursorNumber(query.cursor, 1));
    const list = await catalog.list({ search: query.q ?? '', categoryId, sort: query.sort ?? 'popular', page, limit: query.limit });
    return { body: pageAnswer(page > list.page ? [] : await productCards(db, list.products), list) };
  }));

  app.get(APP_ROUTES.appProduct.path, appCall(async (req) => {
    const slug = slugOf(req.params.slug);
    const product = slug ? await catalog.bySlug(slug) : null;
    if (!product) throw notFound('This product isn’t available.');
    const now = nowOf(config);
    const [card] = await productCards(db, [product]);
    const reels = await db.query(
      `SELECT false AS pinned, ${PAGE_COLS} FROM reels r
       WHERE r.tenant_id = $1 AND r.active AND (r.kind <> 'story' OR r.expires_at IS NULL OR r.expires_at > $3)
         AND EXISTS (SELECT 1 FROM reel_products rp WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND rp.product_id = $2)
       ORDER BY COALESCE(r.posted_at, r.created_at) DESC, r.id DESC LIMIT 6`,
      [tenantId(), product.id, now],
    );
    const images = (Array.isArray(product.images) ? product.images : []).map((i) => (typeof i === 'string' ? i : i?.url ?? '')).filter(Boolean);
    return {
      body: {
        ...card,
        description: product.description ?? '',
        images,
        options: product.options.map((o) => ({ name: o.name, values: o.values ?? [] })),
        variants: product.variants.map((v) => ({ id: v.id, option: v.option_values.join(' / '), pricePaise: Number(v.price_paise), inStock: Boolean(v.in_stock), image: '' })),
        maxQty: STORE_LIMITS.maxQtyPerLine,
        reels: await reelCards(db, reels.filter((r) => r.has_products), { now }),
      },
    };
  }));

  app.get(APP_ROUTES.appCategories.path, appCall(async () => ({ body: { items: (await catalog.categories()).map(categoryCard) } })));

  app.get(APP_ROUTES.appCategory.path, appCall(async (req) => {
    const query = parseBody(AppPageQuery, req.query);
    const slug = slugOf(req.params.slug);
    const category = slug ? await repos.categories.getBySlug(slug) : null;
    if (!category) throw notFound('This category isn’t available.');
    const now = nowOf(config);
    const page = Math.max(1, cursorNumber(query.cursor, 1));
    const [reels, list] = await Promise.all([sequences().live(category.id, { now, limit: 60 }), catalog.list({ categoryId: category.id, page, limit: query.limit })]);
    return {
      body: {
        category: categoryCard(category),
        reels: await reelCards(db, reels, { now }),
        products: pageAnswer(page > list.page ? [] : await productCards(db, list.products), list),
      },
    };
  }));

  app.get(APP_ROUTES.appReels.path, appCall(async (req) => {
    const query = parseBody(AppReelsQuery, req.query);
    const now = nowOf(config);
    const [shelves, uncategorized] = await Promise.all([sequences().liveShelves({ now, perCategory: 60 }), sequences().liveUncategorized({ limit: 60 })]);
    let rows;
    if (query.category) {
      const picked = shelves.find((s) => s.category.slug === query.category);
      if (!picked) throw notFound('This category isn’t available.');
      rows = picked.items;
    } else {
      rows = allReels(shelves, uncategorized).map((r) => ({ ...r, pinned: false }));
    }
    const offset = cursorNumber(query.cursor, 0);
    const shown = rows.slice(offset, offset + query.limit);
    return {
      body: {
        chips: shelves.map((s) => categoryCard(s.category)),
        items: await reelCards(db, shown, { now }),
        nextCursor: offset + query.limit < rows.length ? String(offset + query.limit) : null,
      },
    };
  }));

  // A landing page by its slug. Nothing is recorded: no visit, no tap, no click (P-51).
  app.get(APP_ROUTES.appLanding.path, appCall(async (req) => {
    const slug = slugOf(req.params.slug);
    const page = slug ? await repos.landingPages.getBySlug(slug) : null;
    const now = nowOf(config);
    if (!page || !page.active || !page.products.length) throw notFound('This page isn’t available.');
    const expiredStory = page.kind === 'story' && page.expires_at && new Date(page.expires_at) <= now;
    const video = !expiredStory && page.media_type === 'VIDEO';
    const firstProduct = page.products[0]?.image_url ?? '';
    const cover = page.cover_media_id ? `/media/${page.cover_media_id}` : '';
    const poster = expiredStory ? cover || firstProduct : page.thumbnail_url || cover || firstProduct;
    const more = await sequences().moreReelsFor(page.id, { now, limit: 6 });
    const ratings = await productCards(db, page.products.map((p) => ({ id: p.id, slug: p.slug, name: p.name, image: p.image_url ?? '', price: p.shown })));
    return {
      body: {
        slug: page.slug,
        title: String(page.headline || page.caption || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        media: { kind: video ? 'video' : 'image', url: video ? page.video_url || page.media_url || '' : expiredStory ? poster : page.media_url || poster, poster },
        products: ratings,
        moreReels: await reelCards(db, more.map((r) => ({ ...r, pinned: false })), { now }),
      },
    };
  }));

  app.get(APP_ROUTES.appPolicy.path, appCall(async (req) => {
    const kind = String(req.params.kind ?? '');
    if (!POLICY_KINDS.includes(kind)) throw notFound('This page isn’t available.');
    const [[row], layout] = await Promise.all([
      db.query('SELECT body, updated_at FROM policy_pages WHERE tenant_id = $1 AND kind = $2', [tenantId(), kind]),
      loadBuyerLayout(repos),
    ]);
    const store = layout.business.name || 'This store';
    const body = row?.body?.trim() || (kind === 'privacy' ? defaultPrivacy(store) : OTHER_POLICY[kind](store));
    return { body: { kind, title: POLICY_TITLES[kind], body: String(body), updatedAt: row?.updated_at ?? null } };
  }));
}
