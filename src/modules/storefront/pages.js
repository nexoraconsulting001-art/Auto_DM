import express from 'express';
import { BUYER_ROUTES } from '../../contracts/buyer-pages.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { PRICE_BANDS } from '../../util.js';
import { hero, priceText, safeHref, section, ticker, trustRow } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';
import { tenantId } from '../../tenancy.js';
import { BAG_JS, SERVICE_WORKER_JS, manifestFor } from './assets.js';
import { SORTS, bandOf, searchTerms, sortOf, storeCatalog } from './catalog.js';
import { shopperFrom, storeCall, storeOn } from './http.js';
import { BAG_SCRIPT, baseOf, sendStoreNotFound, sendStorePage } from './shell.js';

/**
 * The store's browsing pages (PRD 9.1) for a business with the Phase 4 store: home, shop (price filter, sort, paging),
 * category, product, search and about, the home-screen app's manifest, worker and offline page, and the bag's script. Each
 * renders in the seller's brand only. A business without the store falls through to the Phase 0 pages (legacy.js).
 * Category pages and the Reels tab are the categories module's when the plan has category sequences; the category page here
 * answers otherwise, and a hidden category is the store's 404 (S-03).
 */
const shown = (p) => priceText(p.price);

export function productTile(p) {
  const price = shown(p);
  const image = safeHref(p.image);
  return html`<a class="tile" href="/p/${encodeURIComponent(p.slug)}">${image ? html`<img src="${image}" alt="" width="200" height="250" loading="lazy" decoding="async">` : html`<span class="ph"></span>`}
<b>${p.name}</b><span class="row"><span class="price">${price.now}</span>${price.was ? html`<span class="mrp muted small"><s>${price.was}</s></span>` : ''}${price.off ? html`<span class="off">${price.off}</span>` : ''}</span>
${price.soldOut ? html`<span class="muted small">Sold out</span>` : ''}</a>`;
}
const grid = (products) => html`<div class="grid">${products.map(productTile)}</div>`;

/** A link to this list with one setting changed, keeping the others. */
function listHref(path, current, change) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...change })) if (v !== '' && v !== null && v !== undefined && !(k === 'page' && Number(v) === 1)) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function listControls(path, current) {
  const bands = [{ key: '', label: 'Any price' }, ...PRICE_BANDS];
  return html`<nav class="opts" aria-label="Price">${bands.map((b) => html`<a class="chip" href="${listHref(path, current, { price: b.key, page: 1 })}"${current.price === b.key ? raw(' aria-current="page"') : ''}>${b.label}</a>`)}</nav>
<nav class="opts" aria-label="Sort">${Object.entries(SORTS).map(([key, s]) => html`<a class="chip" href="${listHref(path, current, { sort: key, page: 1 })}"${current.sort === key ? raw(' aria-current="page"') : ''}>${s.label}</a>`)}</nav>`;
}

function pager(path, current, { page, pages }) {
  if (pages <= 1) return '';
  return html`<nav class="pager" aria-label="Pages">
${page > 1 ? html`<a class="chip" href="${listHref(path, current, { page: page - 1 })}" rel="prev">Previous</a>` : html`<span></span>`}
<span class="muted small">Page ${page} of ${pages}</span>
${page < pages ? html`<a class="chip" href="${listHref(path, current, { page: page + 1 })}" rel="next">Next</a>` : html`<span></span>`}
</nav>`;
}

const listQuery = (req) => ({
  price: bandOf(req.query.price)?.key ?? '',
  sort: sortOf(req.query.sort),
  page: Math.max(1, Math.min(50, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)),
});

function productForm(product) {
  const sold = product.price.soldOut;
  const variants = product.variants;
  const options = variants.length
    ? html`<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="small">${product.options.map((o) => o.name).join(' / ') || 'Option'}</legend>
<div class="opts" role="radiogroup">${variants.map((v) => html`<label${v.in_stock ? '' : raw(' class="sold"')}><input type="radio" name="variant" value="${v.id}"${v.in_stock ? '' : raw(' disabled')}><span>${v.option_values.join(' / ')}${v.in_stock ? '' : ' · Sold out'}</span></label>`)}</div>
<p class="error" data-option-error hidden>Choose an option first.</p></fieldset>`
    : '';
  if (product.legacyOptions) return html`<p class="notice-box">This item can’t be ordered online yet. Please message us to order it.</p>`;
  return html`<form class="panel" data-add-form data-product="${product.id}">
${options}
<label>Quantity <select name="qty">${Array.from({ length: STORE_LIMITS.maxQtyPerLine }, (_, i) => html`<option value="${i + 1}">${i + 1}</option>`)}</select></label>
<button class="btn wide" type="submit"${sold ? raw(' disabled') : ''}>${sold ? 'Sold out' : 'Add to bag'}</button>
<p class="notice-box" data-added hidden role="status"><span data-added-text>Added to your bag.</span> <a href="/cart">View bag</a></p>
</form>`;
}

export function storePages(ctx) {
  const { repos, db } = ctx;
  const catalog = storeCatalog(db);
  const r = express.Router();
  const page = (handler) => async (req, res, next) => {
    try {
      if (!(await storeOn(repos))) return next();
      await shopperFrom(req, db);
      return await handler(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
  const send = (req, res, opts) => sendStorePage(ctx, req, res, opts);

  r.get(STORE_ROUTES.home.path, page(async (req, res) => {
    const [featured, categories] = await Promise.all([catalog.featured(8), catalog.categories()]);
    const cover = featured.find((p) => p.image)?.image ?? '';
    return send(req, res, {
      kind: 'store', ref: 'home', title: '',
      main: ({ theme, settings }) => html`${hero({ theme, eyebrow: settings.hero_kicker, title: settings.hero_title, media: { imageUrl: cover, alt: '' } })}
${ticker(theme)}
${categories.length ? html`<nav class="opts" style="padding:0 20px" aria-label="Categories">${categories.map((c) => html`<a class="chip" href="/c/${encodeURIComponent(c.slug)}">${c.name}</a>`)}</nav>` : ''}
${section({ theme, id: 'featured-h', kicker: 'Shop', title: 'Our picks', body: featured.length ? html`${grid(featured)}<a class="btn wide" href="/shop">See everything</a>` : html`<p class="muted">New things are on the way. Check back soon.</p>` })}
${trustRow(String(settings.trust_points ?? '').split('\n').map((label, i) => ({ label: label.trim(), icon: ['truck', 'shield', 'chat'][i] ?? 'star' })))}`,
    });
  }));

  async function listPage(req, res, { path, category = null, title, kicker }) {
    const current = listQuery(req);
    const found = await catalog.list({ band: bandOf(current.price), categoryId: category?.id ?? null, sort: current.sort, page: current.page });
    return send(req, res, {
      kind: category ? 'category' : 'store', ref: category?.slug ?? 'shop', title,
      main: ({ theme }) => section({ theme, id: 'list-h', kicker, title, body: html`${category?.description ? html`<p>${category.description}</p>` : ''}
${listControls(path, current)}
${found.products.length ? grid(found.products) : html`<p class="muted">Nothing here at this price. Try another.</p>`}
${pager(path, current, found)}` }),
    });
  }

  r.get(STORE_ROUTES.shop.path, page((req, res) => listPage(req, res, { path: '/shop', title: 'Shop', kicker: 'Everything' })));

  r.get(BUYER_ROUTES.category.path, page(async (req, res) => {
    const category = await catalog.category(req.params.slug);
    if (!category) return sendStoreNotFound(ctx, req, res, 'This category isn’t available.');
    return listPage(req, res, { path: `/c/${encodeURIComponent(category.slug)}`, category, title: category.name, kicker: 'Category' });
  }));

  r.get(STORE_ROUTES.search.path, page(async (req, res) => {
    const q = searchTerms(req.query.q).join(' ');
    const found = q ? await catalog.list({ search: q, page: 1, limit: 48 }) : { products: [], total: 0 };
    return send(req, res, {
      kind: 'store', ref: 'search', title: q ? `Search: ${q}` : 'Search',
      main: ({ theme }) => section({ theme, id: 'search-h', kicker: 'Search', title: 'Find something', body: html`<form class="row" role="search" action="/search" method="get">
<label style="flex:1">Search <input type="search" name="q" value="${q}" maxlength="${STORE_LIMITS.searchQueryChars}" autocomplete="off"></label><button class="btn" type="submit">Search</button></form>
${q ? html`<p class="muted small">${found.total} found</p>${found.products.length ? grid(found.products) : html`<p>Nothing matches “${q}”. Try another word.</p>`}` : ''}` }),
    });
  }));

  r.get(STORE_ROUTES.product.path, page((req, res) => productPage(req, res, null)));
  // A product inside a landing page: the pages module has checked the page may show it; it is drawn here, as the store's product page.
  r.get(BUYER_ROUTES.landingProduct.path, page(async (req, res) => {
    const [inPage] = await db.query(
      `SELECT 1 FROM reels r JOIN reel_products rp ON rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
       WHERE r.tenant_id = $1 AND r.slug = $2 AND r.active AND p.slug = $3`,
      [tenantId(), String(req.params.slug).slice(0, 120), String(req.params.productSlug).slice(0, 120)],
    );
    if (!inPage) return sendStoreNotFound(ctx, req, res, 'This product isn’t available.');
    return productPage(req, res, String(req.params.slug));
  }));

  async function productPage(req, res, fromPage) {
    const product = await catalog.bySlug(req.params.productSlug);
    if (!product) return sendStoreNotFound(ctx, req, res, 'This product isn’t available.');
    const related = await catalog.related(product, 4);
    const price = shown(product);
    const images = (Array.isArray(product.images) ? product.images : []).map(safeHref).filter(Boolean).slice(0, 6);
    const base = baseOf(req);
    return send(req, res, {
      kind: 'product', ref: product.slug, title: product.name, description: String(product.description ?? '').slice(0, 160),
      url: `${base}/p/${encodeURIComponent(product.slug)}`,
      image: images[0] ? { url: images[0].startsWith('/') ? `${base}${images[0]}` : images[0], alt: product.name } : null,
      main: ({ theme }) => html`<section class="section" aria-labelledby="product-h">
${fromPage ? html`<a class="chip" href="/r/${encodeURIComponent(fromPage)}">Back to the reel</a>` : ''}
${images.length ? html`<div class="gallery">${images.map((src, i) => html`<img src="${src}" alt="${i === 0 ? product.name : ''}" width="400" height="500"${i ? raw(' loading="lazy"') : raw(' fetchpriority="high"')}>`)}</div>` : ''}
<h1 id="product-h" style="font-family:var(--display);font-size:30px">${product.name}</h1>
<div class="row"><span class="price">${price.now}</span>${price.was ? html`<span class="muted"><s>${price.was}</s></span>` : ''}${price.off ? html`<span class="off">${price.off}</span>` : ''}</div>
${productForm(product)}
${product.description ? html`<div class="stack"><h2 style="font-size:20px">Details</h2><p style="white-space:pre-line">${product.description}</p></div>` : ''}
</section>
${related.length ? section({ theme, id: 'related-h', kicker: 'More', title: 'You may also like', body: grid(related) }) : ''}`,
    });
  }

  r.get(STORE_ROUTES.about.path, page(async (req, res) => send(req, res, {
    kind: 'other', ref: 'about', title: 'About',
    main: ({ theme, business, settings }) => section({ theme, id: 'about-h', kicker: 'About', title: business.name, body: html`<p style="white-space:pre-line">${settings.about_text || settings.tagline}</p>` }),
  })));

  r.get(STORE_ROUTES.offline.path, page(async (req, res) => send(req, res, {
    kind: 'other', ref: 'offline', title: 'Offline',
    main: html`<section class="notice section"><h1>You’re offline</h1><p>Check your connection and try again. Your bag is saved on this phone.</p><a class="btn" href="/">Try again</a></section>`,
  })));

  return r;
}

/** The manifest, the worker and the bag's script: on this business's own address, only when it has the store. */
export function storeAssets(ctx) {
  const r = express.Router();
  const gated = (handler) => async (req, res, next) => {
    try {
      if (!(await storeOn(ctx.repos))) return next();
      return await handler(req, res);
    } catch (err) {
      return next(err);
    }
  };
  r.get(STORE_ROUTES.manifest.path, gated(async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json').send(JSON.stringify(await manifestFor(ctx.repos)));
  }));
  r.get(STORE_ROUTES.serviceWorker.path, gated(async (_req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.type('text/javascript').send(SERVICE_WORKER_JS);
  }));
  r.get(BAG_SCRIPT, gated(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/javascript').send(BAG_JS);
  }));
  return r;
}

/** GET /api/store/products?ids=1,2: names, prices and photos again for a bag that moved browsers, inactive ones flagged (9.2). */
export function productsLookup(ctx) {
  const catalog = storeCatalog(ctx.db);
  return storeCall(ctx, async (req) => {
    const ids = String(req.query.ids ?? '').slice(0, 600).split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647);
    return { body: { products: await catalog.lookup(ids) } };
  });
}
