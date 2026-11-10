/**
 * Shopify, two faces:
 *
 * Admin REST, base routes only: the app token exchange, the shop, and reading products and orders (PRD 9.11).
 * POST /__sim/products and POST /__sim/orders seed them. Later phases add writes and webhooks.
 *
 * The public storefront a shopper sees, which imports read with no keys (PRD 8.3, 8.5, 8.9). Mount it under a site name with
 * tools/sim/sites (sites.mount('plants.example', shopify)) so safeFetch reaches it through its test transport:
 *   GET /products.json?page=&limit=     the public feed, page by page until an empty page; limit up to 250 (default 30)
 *   GET /products/<handle>.json         one product, as Shopify serves it (tags as one string, no `available`)
 *   GET /products/<handle>.js           the same with `available` per variant and prices as whole paise
 *   GET /products/<handle>              the product page: JSON-LD ProductGroup, Open Graph and product:price tags
 *   GET /                               the home page, with the store's theme colour, fonts and logo
 *   GET /cdn/<file>.png                 product images, real PNGs
 * Controls:
 *   POST /__sim/storefront              { name?, themeColor?, headingFont?, bodyFont?, feedStatus?, products? } changes the storefront
 *   POST /__sim/storefront/generate     { count, variants?, withMrp?, seed? } fills it with that many products, the same every time
 *   PATCH /__sim/storefront/products    { handle, ...changes, variants?: [{ price?, compare_at_price?, available? }] } changes one
 *   DELETE /__sim/storefront/products   { handle } removes one, as if the store took it down
 * feedStatus 404 or 401 makes /products.json answer that (K-17). Storefront products are kept apart from the Admin ones, and
 * their prices are whole paise here (Shopify's JSON shows rupees as text, which is what the feed answers).
 */
import { SimError, createSim, reply } from '../base.mjs';
import { png } from '../sites/png.mjs';

const shopifyError = (status, errors) => new SimError(status, { errors });
const money = (paise) => (paise / 100).toFixed(2);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const PLANT_WORDS = ['Monstera', 'Snake plant', 'Pothos', 'Fiddle leaf fig', 'Peace lily', 'ZZ plant', 'Areca palm', 'Rubber plant', 'Jade', 'Aloe vera', 'Calathea', 'Fern'];
const POTS = ['ceramic pot', 'self-watering pot', 'grow bag', 'hanging basket'];

/** A deterministic catalogue: product i always has the same handle, prices and variants. Prices are paise. */
export function generateStorefrontProducts({ count, variants = 2, withMrp = true, seed = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const i = index + seed - 1;
    const name = `${PLANT_WORDS[i % PLANT_WORDS.length]} in ${POTS[Math.floor(i / PLANT_WORDS.length) % POTS.length]} ${i + 1}`;
    const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const base = 19900 + (i % 40) * 2500;
    const sizes = ['Small', 'Medium', 'Large'].slice(0, Math.max(1, Math.min(3, variants)));
    return {
      id: 7000000 + i,
      title: name,
      handle,
      body_html: `<p>${name}. Healthy and potted.</p>`,
      vendor: 'Green Leaf',
      product_type: i % 2 ? 'Indoor plants' : 'Outdoor plants',
      tags: [i % 2 ? 'indoor' : 'outdoor', i % 3 ? 'easy-care' : 'pet-friendly'],
      options: [{ name: 'Size', position: 1, values: sizes }],
      variants: sizes.map((size, v) => ({
        id: 8000000 + i * 10 + v,
        title: size,
        option1: size,
        option2: null,
        option3: null,
        sku: `GL-${i + 1}-${size[0]}`,
        price: base + v * 5000,
        compare_at_price: withMrp ? base + v * 5000 + 10000 : null,
        available: (i + v) % 7 !== 0,
        position: v + 1,
      })),
      images: [{ id: 9000000 + i, src: `/cdn/${handle}.png`, position: 1, width: 1200, height: 1200 }],
    };
  });
}

export function createShopify({ token = 'sim-shopify-token', clientId = 'sim-shopify-client', clientSecret = 'sim-shopify-secret' } = {}) {
  let products;
  let orders;
  let seq;
  let storefront;
  const clear = () => {
    products = [];
    orders = [];
    seq = 0;
    storefront = { name: 'Green Leaf Plants', themeColor: '#1F4D2B', headingFont: 'Playfair Display', bodyFont: 'Inter', feedStatus: 200, products: [] };
  };
  clear();

  function requireToken(req) {
    if (req.headers['x-shopify-access-token'] !== token) throw shopifyError(401, '[API] Invalid API key or access token (unrecognized login or wrong password)');
  }

  /** Absolute links on whatever name the request came in on, as a real store's are. */
  const origin = (req) => `https://${String(req.headers.host ?? 'shop.example').replace(/:\d+$/, '')}`;
  const findProduct = (handle) => storefront.products.find((p) => p.handle === handle);

  function asJson(p, req, { tagsAsText = false, available = true } = {}) {
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      body_html: p.body_html,
      vendor: p.vendor,
      product_type: p.product_type,
      tags: tagsAsText ? p.tags.join(', ') : p.tags,
      options: p.options,
      variants: p.variants.map((v) => ({
        id: v.id, title: v.title, option1: v.option1, option2: v.option2, option3: v.option3, sku: v.sku,
        price: money(v.price), compare_at_price: v.compare_at_price === null ? null : money(v.compare_at_price), position: v.position,
        ...(available ? { available: v.available } : {}),
      })),
      images: p.images.map((img) => ({ ...img, src: `${origin(req)}${img.src}` })),
    };
  }

  function productPage(p, req) {
    const site = origin(req);
    const lowest = Math.min(...p.variants.map((v) => v.price));
    const group = {
      '@context': 'https://schema.org', '@type': 'ProductGroup', name: p.title, productGroupID: String(p.id), url: `${site}/products/${p.handle}`,
      image: p.images.map((img) => `${site}${img.src}`),
      hasVariant: p.variants.map((v) => ({
        '@type': 'Product', name: `${p.title} - ${v.title}`, sku: v.sku,
        offers: { '@type': 'Offer', price: money(v.price), priceCurrency: 'INR', availability: v.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
      })),
    };
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(p.title)} – ${escapeHtml(storefront.name)}</title>
<meta property="og:site_name" content="${escapeHtml(storefront.name)}"><meta property="og:title" content="${escapeHtml(p.title)}">
<meta property="og:type" content="product"><meta property="og:image" content="${site}${p.images[0]?.src ?? ''}">
<meta property="product:price:amount" content="${money(lowest)}"><meta property="product:price:currency" content="INR">
<script type="application/ld+json">${jsonForScript(group)}</script></head><body><h1>${escapeHtml(p.title)}</h1></body></html>`;
  }

  function homePage(req) {
    const site = origin(req);
    const fonts = [storefront.headingFont, storefront.bodyFont].map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;700`).join('&');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(storefront.name)}</title>
<meta name="theme-color" content="${escapeHtml(storefront.themeColor)}"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=swap">
<style>:root{--color-button:${escapeHtml(storefront.themeColor)};--color-button-text:#FFFFFF;--font-heading-family:"${escapeHtml(storefront.headingFont)}";--font-body-family:"${escapeHtml(storefront.bodyFont)}"}</style>
<meta property="og:site_name" content="${escapeHtml(storefront.name)}"><meta property="og:title" content="${escapeHtml(storefront.name)}"><meta property="og:image" content="${site}/cdn/logo.png">
<script type="application/ld+json">${jsonForScript({ '@context': 'https://schema.org', '@type': 'Organization', name: storefront.name, logo: `${site}/cdn/logo.png`, url: site })}</script>
</head><body><h1>${escapeHtml(storefront.name)}</h1></body></html>`;
  }

  const html = (status, body) => reply(status, body, { 'content-type': 'text/html; charset=utf-8' });

  return createSim({
    name: 'shopify',
    anyHost: true,
    errorBody: ({ kind }) => ({ errors: `Simulated ${kind}.` }),
    reset: clear,
    routes: (on) => {
      on('POST', '/admin/oauth/access_token', (req) => {
        if (req.body?.client_id !== clientId || req.body?.client_secret !== clientSecret || !req.body?.code) throw shopifyError(400, 'invalid_request');
        return { access_token: token, scope: 'read_products,read_orders' };
      });
      on('GET', '/admin/api/:version/shop.json', (req) => {
        requireToken(req);
        return { shop: { id: 1, name: 'Simulated Shop', myshopify_domain: 'sim.myshopify.test', currency: 'INR' } };
      });
      on('GET', '/admin/api/:version/products.json', (req) => {
        requireToken(req);
        return { products };
      });
      on('GET', '/admin/api/:version/orders.json', (req) => {
        requireToken(req);
        return { orders };
      });

      // ---- the public storefront ----
      on('GET', '/products.json', (req) => {
        if (storefront.feedStatus === 404) return html(404, '<!doctype html><title>404 Not Found</title>');
        if (storefront.feedStatus !== 200) return reply(storefront.feedStatus, { errors: 'Unavailable Shop' });
        const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 250);
        const pageNumber = Math.max(Number(req.query.page) || 1, 1);
        const slice = storefront.products.slice((pageNumber - 1) * limit, pageNumber * limit);
        return { products: slice.map((p) => asJson(p, req)) };
      });
      on('GET', '/products/:handle.json', (req) => {
        const p = findProduct(req.params.handle);
        if (!p) throw new SimError(404, { errors: 'Not Found' });
        return { product: asJson(p, req, { tagsAsText: true, available: false }) };
      });
      on('GET', '/products/:handle.js', (req) => {
        const p = findProduct(req.params.handle);
        if (!p) throw new SimError(404, { errors: 'Not Found' });
        const json = asJson(p, req);
        return { ...json, variants: p.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, price: v.price, compare_at_price: v.compare_at_price, available: v.available })) };
      });
      on('GET', '/products/:handle', (req) => {
        const p = findProduct(req.params.handle);
        return p ? html(200, productPage(p, req)) : html(404, '<!doctype html><title>404 Not Found</title>');
      });
      on('GET', '/cdn/:file', (req) => {
        if (!/\.png$/.test(req.params.file)) throw new SimError(404, { errors: 'Not Found' });
        return reply(200, png({ width: 1200, height: 1200, color: req.params.file === 'logo.png' ? storefront.themeColor : '#6B8F5E' }), { 'content-type': 'image/png' });
      });
      on('GET', '/', (req) => html(200, homePage(req)));
    },
    controls: (on) => {
      on('POST', '/products', ({ body }) => {
        const product = { id: ++seq, title: 'Simulated product', variants: [], ...body };
        products.push(product);
        return product;
      });
      on('POST', '/orders', ({ body }) => {
        const order = { id: ++seq, financial_status: 'paid', line_items: [], ...body };
        orders.push(order);
        return order;
      });
      on('POST', '/storefront', ({ body }) => {
        storefront = { ...storefront, ...body, products: Array.isArray(body.products) ? body.products : storefront.products };
        return { ok: true, count: storefront.products.length };
      });
      on('POST', '/storefront/generate', ({ body }) => {
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 0 || count > 5000) throw new SimError(400, { error: 'count must be 0 to 5000' });
        storefront.products = generateStorefrontProducts({ ...body, count });
        return { ok: true, count };
      });
      on('PATCH', '/storefront/products', ({ body }) => {
        const p = findProduct(body.handle);
        if (!p) throw new SimError(404, { error: `No product ${body.handle}` });
        const { handle: _handle, variants, ...changes } = body;
        Object.assign(p, changes);
        if (Array.isArray(variants)) variants.forEach((change, i) => { if (p.variants[i]) Object.assign(p.variants[i], change); });
        return { ok: true };
      });
      on('DELETE', '/storefront/products', ({ body }) => {
        const before = storefront.products.length;
        storefront.products = storefront.products.filter((p) => p.handle !== body.handle);
        if (storefront.products.length === before) throw new SimError(404, { error: `No product ${body.handle}` });
        return { ok: true };
      });
    },
  });
}
