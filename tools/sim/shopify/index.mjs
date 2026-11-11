/**
 * Shopify, two faces:
 *
 * Admin REST, for sync (PRD 9.11): the app token exchange, the shop, products (paged by Link header), one product, inventory
 * levels and setting one, a variant's price, creating an order (which takes stock down, and with an Idempotency-Key is the
 * same order when repeated), listing orders and registering webhooks. POST /__sim/products and POST /__sim/orders seed them.
 * Admin calls are limited to 2 a second per shop when POST /__sim/admin/limit { on: true } is set: the third is a 429
 * with Retry-After, lifting on the controlled clock.
 *
 * Webhooks, signed as Shopify signs them (base64 HMAC of the bytes with the app's client secret, in X-Shopify-Hmac-Sha256,
 * with X-Shopify-Webhook-Id, X-Shopify-Topic and X-Shopify-Shop-Domain):
 *   POST /__sim/admin/products/update { id, title?, variants?: [{ id, price?, inventory_quantity? }], webhook?, ...delivery }
 *       changes an Admin product and sends products/update (S-36)
 *   POST /__sim/admin/inventory { inventoryItemId, available, ...delivery }     sends inventory_levels/update
 *   POST /__sim/webhooks/send { topic, payload, ...delivery }                   any topic by hand
 *   POST /__sim/webhooks/url { url }   POST /__sim/webhooks/flush { order? }   POST /__sim/webhooks/redeliver { id, times? }   GET /__sim/webhooks
 * Delivery options: duplicates (the same webhook id again), hold (keep back, then flush in another order), signature
 * 'good' | 'bad' | 'none' (S-38).
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
import crypto from 'node:crypto';
import { SimError, createSim, reply } from '../base.mjs';
import { createWebhooks, webhookControls } from '../webhooks.mjs';
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

export function createShopify({ token = 'sim-shopify-token', clientId = 'sim-shopify-client', clientSecret = 'sim-shopify-secret', shopDomain = 'sim-shop.myshopify.com', webhookUrl = null } = {}) {
  let products;
  let orders;
  let seq;
  let storefront;
  let orderKeys;
  let registered;
  let limited;
  let recent;
  const clear = () => {
    products = [];
    orders = [];
    orderKeys = new Map();
    registered = [];
    limited = false;
    recent = [];
    seq = 0;
    storefront = { name: 'Green Leaf Plants', themeColor: '#1F4D2B', headingFont: 'Playfair Display', bodyFont: 'Inter', feedStatus: 200, products: [] };
  };
  clear();

  let sim = null;
  const hooks = createWebhooks({
    clock: { now: () => sim.clock.now() },
    url: webhookUrl,
    sign: (raw, payload, { bad }) => ({
      'x-shopify-hmac-sha256': crypto.createHmac('sha256', bad ? `${clientSecret}-wrong` : clientSecret).update(raw).digest('base64'),
      'x-shopify-webhook-id': payload?.__webhookId ?? '',
      'x-shopify-topic': payload?.__topic ?? '',
      'x-shopify-shop-domain': shopDomain,
    }),
  });
  /** One webhook: its own id and topic travel in headers, never in the signed bytes. */
  function sendWebhook(topic, payload, { duplicates, hold, signature, webhookId } = {}) {
    const raw = JSON.stringify(payload);
    const marked = { ...payload };
    const id = webhookId ?? crypto.randomUUID();
    Object.defineProperties(marked, { __webhookId: { value: id, enumerable: false }, __topic: { value: topic, enumerable: false } });
    return hooks.send(marked, { raw, duplicates, hold, signature }).then((sent) => ({ ...sent, webhookId: id, topic }));
  }

  function requireToken(req) {
    if (req.headers['x-shopify-access-token'] !== token) throw shopifyError(401, '[API] Invalid API key or access token (unrecognized login or wrong password)');
    if (limited) {
      const now = sim.clock.now();
      recent = recent.filter((at) => now - at < 1000);
      if (recent.length >= 2) throw new SimError(429, { errors: 'Exceeded 2 calls per second for api client. Reduce request rates to resume uninterrupted service.' }, { 'retry-after': '1.0' });
      recent.push(now);
    }
  }
  const adminVariant = (variantId) => {
    for (const product of products) {
      const variant = (product.variants ?? []).find((v) => String(v.id) === String(variantId));
      if (variant) return { product, variant };
    }
    return null;
  };
  const byInventoryItem = (itemId) => products.flatMap((p) => p.variants ?? []).find((v) => String(v.inventory_item_id ?? v.id) === String(itemId));

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

  sim = createSim({
    name: 'shopify',
    anyHost: true,
    errorBody: ({ kind }) => ({ errors: `Simulated ${kind}.` }),
    reset: () => {
      clear();
      hooks.reset();
    },
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
        // Paged the way Shopify pages: a page_info cursor in the Link header. With no limit given, everything at once, as before.
        if (!req.query.limit && !req.query.page_info) return { products };
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 250);
        const offset = Math.max(Number(Buffer.from(String(req.query.page_info ?? ''), 'base64url').toString() || 0) || 0, 0);
        const since = req.query.updated_at_min && !req.query.page_info ? Date.parse(req.query.updated_at_min) : null;
        const all = since ? products.filter((p) => !p.updated_at || Date.parse(p.updated_at) >= since) : products;
        const next = offset + limit < all.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
        const link = next ? { link: `<https://${shopDomain}/admin/api/${req.params.version}/products.json?limit=${limit}&page_info=${next}>; rel="next"` } : {};
        return reply(200, { products: all.slice(offset, offset + limit) }, link);
      });
      on('GET', '/admin/api/:version/products/:id.json', (req) => {
        requireToken(req);
        const product = products.find((p) => String(p.id) === req.params.id);
        if (!product) throw shopifyError(404, 'Not Found');
        return { product };
      });
      on('GET', '/admin/api/:version/inventory_levels.json', (req) => {
        requireToken(req);
        const ids = String(req.query.inventory_item_ids ?? '').split(',').filter(Boolean);
        return { inventory_levels: ids.map(byInventoryItem).filter(Boolean).map((v) => ({ inventory_item_id: v.inventory_item_id ?? v.id, location_id: 1, available: v.inventory_quantity ?? 0 })) };
      });
      on('POST', '/admin/api/:version/inventory_levels/set.json', (req) => {
        requireToken(req);
        const variant = byInventoryItem(req.body?.inventory_item_id);
        if (!variant) throw shopifyError(404, 'Not Found');
        if (!Number.isInteger(req.body?.available)) throw shopifyError(422, { available: ['is not a number'] });
        variant.inventory_quantity = req.body.available;
        return { inventory_level: { inventory_item_id: variant.inventory_item_id ?? variant.id, location_id: 1, available: variant.inventory_quantity } };
      });
      on('PUT', '/admin/api/:version/variants/:id.json', (req) => {
        requireToken(req);
        const found = adminVariant(req.params.id);
        if (!found) throw shopifyError(404, 'Not Found');
        const change = req.body?.variant ?? {};
        if (change.price !== undefined) found.variant.price = String(change.price);
        if (change.compare_at_price !== undefined) found.variant.compare_at_price = change.compare_at_price === null ? null : String(change.compare_at_price);
        found.product.updated_at = new Date(sim.clock.now()).toISOString();
        return { variant: found.variant };
      });
      on('GET', '/admin/api/:version/orders.json', (req) => {
        requireToken(req);
        return { orders };
      });
      on('POST', '/admin/api/:version/orders.json', (req) => {
        requireToken(req);
        const key = req.headers['idempotency-key'];
        if (key && orderKeys.has(key)) return reply(201, { order: orders.find((o) => o.id === orderKeys.get(key)) });
        const input = req.body?.order;
        if (!Array.isArray(input?.line_items) || !input.line_items.length) throw shopifyError(422, { line_items: ['must have at least one line item'] });
        for (const line of input.line_items) {
          const found = adminVariant(line.variant_id);
          if (!found) throw shopifyError(422, { line_items: ['variant is invalid'] });
          if (!Number.isInteger(line.quantity) || line.quantity < 1) throw shopifyError(422, { line_items: ['quantity must be greater than 0'] });
        }
        // Stock goes down in Shopify, as it does for an order made there (S-37).
        for (const line of input.line_items) {
          const { variant } = adminVariant(line.variant_id);
          if (Number.isInteger(variant.inventory_quantity)) variant.inventory_quantity -= line.quantity;
        }
        const order = { id: ++seq, name: `#${1000 + seq}`, financial_status: input.financial_status ?? 'pending', line_items: input.line_items, note: input.note ?? '', tags: input.tags ?? '', email: input.email ?? '', created_at: new Date(sim.clock.now()).toISOString() };
        orders.push(order);
        if (key) orderKeys.set(key, order.id);
        return reply(201, { order });
      });
      on('POST', '/admin/api/:version/webhooks.json', (req) => {
        requireToken(req);
        const { topic, address } = req.body?.webhook ?? {};
        if (!topic || !address) throw shopifyError(422, { webhook: ['topic and address are required'] });
        const webhook = { id: ++seq, topic, address, format: 'json' };
        registered.push(webhook);
        return reply(201, { webhook });
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
      webhookControls(on, hooks);
      on('POST', '/webhooks/send', ({ body }) => sendWebhook(body.topic, body.payload ?? {}, body));
      on('POST', '/admin/limit', ({ body }) => {
        limited = body.on !== false;
        recent = [];
        return { limited };
      });
      on('POST', '/admin/products/update', async ({ body }) => {
        const product = products.find((p) => String(p.id) === String(body.id));
        if (!product) throw new SimError(404, { error: 'No such product.' });
        if (body.title !== undefined) product.title = body.title;
        for (const change of body.variants ?? []) {
          const variant = (product.variants ?? []).find((v) => String(v.id) === String(change.id));
          if (!variant) throw new SimError(404, { error: `No variant ${change.id}.` });
          Object.assign(variant, change);
        }
        product.updated_at = new Date(sim.clock.now()).toISOString();
        return { product, webhook: body.webhook === false ? null : await sendWebhook('products/update', product, body) };
      });
      on('POST', '/admin/inventory', async ({ body }) => {
        const variant = byInventoryItem(body.inventoryItemId);
        if (!variant) throw new SimError(404, { error: 'No such inventory item.' });
        variant.inventory_quantity = body.available;
        return { webhook: await sendWebhook('inventory_levels/update', { inventory_item_id: variant.inventory_item_id ?? variant.id, location_id: 1, available: body.available, updated_at: new Date(sim.clock.now()).toISOString() }, body) };
      });
      on('GET', '/admin/state', () => ({ products, orders, webhooks: registered }));
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

  return Object.assign(sim, { webhooks: hooks, shopDomain, clientSecret });
}
