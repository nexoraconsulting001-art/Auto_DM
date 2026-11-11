import { DEFAULT_TIMEOUT_MS, ProviderHostBlockedError, createHttp, hmac, sameBytes } from '../http.js';
import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';

/**
 * Shopify Admin API, for sync (PRD 9.11). Each business connects its own Shopify app, so every call names the shop:
 * ctx.providers.shopify.forShop({ shopDomain, accessToken }), both from shopify_connections (the token decrypted by the caller).
 * Reading a store's public pages for the first import is not this: that is safeFetch (8.3).
 *
 *   shop()                                             -> { id, name, domain, currency }
 *   products({ since?, pageInfo?, limit? })            -> { items: [product], nextPageInfo }      product as Shopify sends it
 *   product(id)                                        -> product | null
 *   inventoryLevels({ inventoryItemIds })              -> [{ inventoryItemId, locationId, available }]
 *   setInventory({ inventoryItemId, locationId, available })      (two-way mode)
 *   updateVariant(id, { pricePaise?, compareAtPricePaise? })      (two-way mode)
 *   createOrder({ orderNumber, lines: [{ variantId, qty, pricePaise }], shipTo, email, totalPaise, paid, idempotencyKey }) -> { id, name }
 *       Pushes an order placed here; Shopify takes the stock down itself (S-37). Repeating it with the same key is the same order.
 *   orders({ since?, pageInfo? })                      -> { items, nextPageInfo }
 *   registerWebhooks({ address, topics })              -> [{ id, topic }]
 *
 * Shopify allows two calls a second per shop (to confirm): a 429 is ProviderError kind 'throttled', retryable, and reads retry
 * with backoff. Every call has a 10 s timeout. The shop's address must be <name>.myshopify.com; SHOPIFY_BASE_URL sends every
 * shop to tools/sim/shopify instead, and is refused when NODE_ENV=production.
 *
 * verifyWebhook(rawBody, hmacHeader, webhookSecret): X-Shopify-Hmac-Sha256 is the base64 HMAC of the exact bytes (S-38).
 * False on anything missing or malformed; never throws. Dedupe by X-Shopify-Webhook-Id.
 */
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
export const SHOPIFY_API_VERSION = '2025-01';
const money = (paise) => (paise / 100).toFixed(2);

export function verifyWebhook(rawBody, hmacHeader, webhookSecret) {
  if (!webhookSecret || !Buffer.isBuffer(rawBody) || typeof hmacHeader !== 'string') return false;
  return sameBytes(hmacHeader, hmac(webhookSecret, rawBody, 'base64'));
}

/** The `page_info` of rel="next" in a Link header, or null. */
function nextPage(link) {
  const match = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

export function createShopify(config = {}, { env = process.env } = {}) {
  const override = String(config.shopifyBaseUrl || '').trim().replace(/\/+$/, '');
  if (override) {
    refuseSimulatorUrl(override, { env, name: 'SHOPIFY_BASE_URL' });
    if (!isSimulatorUrl(override)) throw new ProviderHostBlockedError('SHOPIFY_BASE_URL');
  }
  const version = config.shopifyApiVersion || SHOPIFY_API_VERSION;
  const timeoutMs = config.providerTimeoutMs || DEFAULT_TIMEOUT_MS;

  function forShop({ shopDomain, accessToken }) {
    const domain = String(shopDomain ?? '').toLowerCase();
    if (!SHOP_DOMAIN.test(domain)) throw new ProviderHostBlockedError('The Shopify store address');
    if (!accessToken) throw new Error('Shopify needs the store’s access token');
    const request = createHttp({ provider: 'shopify', baseUrl: `${override || `https://${domain}`}/admin/api/${version}`, timeoutMs, codeOf: (body) => (typeof body?.errors === 'string' ? body.errors.slice(0, 60) : '') });
    const headers = { 'x-shopify-access-token': accessToken };
    const list = async (path, key, query) => {
      const { body, headers: answered } = await request('GET', path, { headers, query, retries: 2 });
      return { items: body?.[key] ?? [], nextPageInfo: nextPage(answered.get('link')) };
    };

    return {
      async shop() {
        const { body } = await request('GET', '/shop.json', { headers, retries: 2 });
        return { id: String(body.shop.id), name: body.shop.name, domain: body.shop.myshopify_domain ?? domain, currency: body.shop.currency };
      },
      products: ({ since, pageInfo, limit = 250 } = {}) => list('/products.json', 'products', pageInfo ? { page_info: pageInfo, limit } : { updated_at_min: since ? new Date(since).toISOString() : undefined, limit }),
      async product(id) {
        try {
          const { body } = await request('GET', `/products/${encodeURIComponent(id)}.json`, { headers, retries: 2 });
          return body.product;
        } catch (err) {
          if (err.status === 404) return null;
          throw err;
        }
      },
      async inventoryLevels({ inventoryItemIds }) {
        const { body } = await request('GET', '/inventory_levels.json', { headers, query: { inventory_item_ids: inventoryItemIds.join(','), limit: 250 }, retries: 2 });
        return (body?.inventory_levels ?? []).map((l) => ({ inventoryItemId: String(l.inventory_item_id), locationId: String(l.location_id), available: l.available }));
      },
      async setInventory({ inventoryItemId, locationId, available }) {
        await request('POST', '/inventory_levels/set.json', { headers, json: { inventory_item_id: inventoryItemId, location_id: locationId, available }, retries: 2 });
      },
      async updateVariant(id, { pricePaise, compareAtPricePaise }) {
        const variant = { id, ...(pricePaise !== undefined ? { price: money(pricePaise) } : {}), ...(compareAtPricePaise !== undefined ? { compare_at_price: compareAtPricePaise === null ? null : money(compareAtPricePaise) } : {}) };
        await request('PUT', `/variants/${encodeURIComponent(id)}.json`, { headers, json: { variant }, retries: 2 });
      },
      async createOrder({ orderNumber, lines, shipTo, email = '', totalPaise, paid, idempotencyKey }) {
        const order = {
          line_items: lines.map((l) => ({ variant_id: l.variantId, quantity: l.qty, price: money(l.pricePaise) })),
          email: email || undefined,
          financial_status: paid ? 'paid' : 'pending',
          inventory_behaviour: 'decrement_obeying_policy',
          source_name: 'store',
          note: `Order ${orderNumber}`,
          tags: 'store-order',
          shipping_address: shipTo ? { name: shipTo.name, address1: shipTo.line1, address2: shipTo.line2 ?? '', city: shipTo.city, province: shipTo.state, zip: shipTo.pincode, country: 'IN', phone: shipTo.phone } : undefined,
          transactions: paid ? [{ kind: 'sale', status: 'success', amount: money(totalPaise) }] : undefined,
        };
        const { body } = await request('POST', '/orders.json', { headers: { ...headers, 'idempotency-key': idempotencyKey }, json: { order } });
        return { id: String(body.order.id), name: body.order.name ?? '' };
      },
      orders: ({ since, pageInfo, limit = 250 } = {}) => list('/orders.json', 'orders', pageInfo ? { page_info: pageInfo, limit } : { updated_at_min: since ? new Date(since).toISOString() : undefined, status: 'any', limit }),
      async registerWebhooks({ address, topics }) {
        const made = [];
        for (const topic of topics) {
          const { body } = await request('POST', '/webhooks.json', { headers, json: { webhook: { topic, address, format: 'json' } } });
          made.push({ id: String(body.webhook.id), topic });
        }
        return made;
      },
    };
  }

  return { forShop, verifyWebhook };
}
