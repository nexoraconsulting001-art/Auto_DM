/**
 * The traffic of the load test: each route class of budgets.mix as a list of real requests, and the recorder that keeps
 * what came back. Pure of the world except through `world` (the businesses, the simulators' addresses, the secrets).
 *
 *   const rec = createRecorder();
 *   const plan = classPlans({ world, rec, rps, mix, rng, tag })      one { name, rate, make(i) } per class
 *   drive({ client, plan, seconds, onResult: rec.onResult })
 *
 * Every request carries `meta.shop` (the business's index) so the report can separate one business from the rest. A request
 * is failed when it did not get the status the class expects (see EXPECT); a webhook that is not answered 200 is retried
 * the way Meta does (every half second, up to a minute) and counted as failed once, and as accepted when a retry gets 200.
 * Accepted webhooks are kept with their ids: that list is what "lost" and "twice" are checked against afterwards.
 */
import crypto from 'node:crypto';
import { hubSignature } from '../sim/meta/index.mjs';
import { percentile, sleep } from './http.mjs';

/** A small seeded generator, so two runs ask for the same things in the same order. */
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

/** What each class counts as an answer. */
export const EXPECT = Object.freeze({
  buyer_page: (s) => s === 200,
  beacon: (s) => s >= 200 && s < 300,
  webhook: (s) => s === 200,
  store_api: (s) => s >= 200 && s < 300,
  seller_api_read: (s) => s === 200,
  seller_api_write: (s) => s >= 200 && s < 300,
  storm: (s) => s === 200,
});

const ADDRESS = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', kind: 'home', isDefault: false };
const SELLER_READS = ['/products', '/orders', '/stats/dashboard', '/activity', '/automations', '/insights/account', '/traffic/summary', '/customers', '/inbox/threads', '/categories'];

/** A different buyer address for each request (203.0.113.0/24 is the range set aside for documentation); the app reads it from X-Forwarded-For as behind its one proxy. */
const buyerAddress = (rng) => ({ 'x-forwarded-for': `203.0.${rng.int(250)}.${1 + rng.int(250)}` });

export function createRecorder() {
  const results = [];
  const accepted = [];
  const counts = { webhookRetries: 0, paid: 0, paymentErrors: 0 };
  return {
    results,
    accepted,
    counts,
    onResult: (r) => results.push({ name: r.name, status: r.status, ms: r.ms, error: r.error, at: r.at, shop: r.meta?.shop ?? null, route: r.meta?.route ?? null }),
    /** The slowest routes by p95, each as { route, requests, p95 }: where to look when a class is over its limit. */
    slowest(limit = 8, minRequests = 5) {
      const by = new Map();
      for (const r of results) if (r.route) by.set(`${r.name} ${r.route}`, [...(by.get(`${r.name} ${r.route}`) ?? []), r.ms]);
      return [...by].filter(([, ms]) => ms.length >= minRequests).map(([route, ms]) => ({ route, requests: ms.length, p95: round(percentile(ms, 95)) })).sort((a, b) => b.p95 - a.p95).slice(0, limit);
    },
    /** { requests, failed, p50, p95, p99, max } of a class, or of the results `where` keeps. */
    summary(name, where = () => true) {
      const mine = results.filter((r) => r.name === name && where(r));
      const failed = mine.filter((r) => !EXPECT[name](r.status));
      const ms = mine.map((r) => r.ms);
      return { requests: mine.length, failed: failed.length, failedStatuses: [...new Set(failed.map((f) => f.error || f.status))].slice(0, 6), p50: round(percentile(ms, 50)), p95: round(percentile(ms, 95)), p99: round(percentile(ms, 99)), max: round(ms.length ? Math.max(...ms) : null) };
    },
  };
}
const round = (v) => (v === null ? null : Math.round(v * 10) / 10);

function commentBody(shop, { id, fan, text }) {
  return { object: 'instagram', entry: [{ id: shop.igUserId, time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, text, from: { id: fan, username: `fan_${fan.slice(-6)}` }, media: { id: shop.reelId, media_product_type: 'REELS' } } }] }] };
}
function messageBody(shop, { mid, fan, text }) {
  return { object: 'instagram', entry: [{ id: shop.igUserId, time: Date.now(), messaging: [{ sender: { id: fan }, recipient: { id: shop.igUserId }, timestamp: Date.now(), message: { mid, text } }] }] };
}

/**
 * A webhook request for one business. `field` is 'comments' or 'messages'. The request is signed here, with the app's secret,
 * as Meta signs: the signature is over the exact bytes sent.
 */
export function webhookRequest({ world, rec, shop, index, field, tag, name = 'webhook', onWire }) {
  const id = `${field === 'comments' ? 'c' : 'm'}${tag}${String(index).padStart(7, '0')}`;
  const tagNumber = parseInt(crypto.createHash('sha1').update(tag).digest('hex').slice(0, 6), 16) % 1_000_000;
  const fan = `91${String(tagNumber).padStart(6, '0')}${String(index).padStart(8, '0')}`;
  const body = field === 'comments' ? commentBody(shop, { id, fan, text: 'price please' }) : messageBody(shop, { mid: id, fan, text: 'hello there' });
  const raw = JSON.stringify(body);
  const headers = { 'x-hub-signature-256': hubSignature(raw, world.secrets.appSecret), 'content-type': 'application/json' };
  const spec = {
    method: 'POST', path: '/webhook', headers, body: raw, meta: { shop: shop.n - 1, route: `POST /webhook (${field})` },
    // The comment exists at Instagram before its webhook is sent: the gate asks Meta before it replies.
    before: field === 'comments' ? () => world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: shop.reelId, id, from: { id: fan, username: `fan_${fan.slice(-6)}` }, text: 'price please', deliver: false }) : undefined,
    async after(outcome) {
      if (outcome.status === 200) {
        rec.accepted.push({ id, field, name, shop: shop.n - 1, tenantId: shop.tenantId });
        return;
      }
      // Meta redelivers what is not answered 200: try again every half second for a minute, with the same bytes.
      for (let attempt = 0; attempt < 120; attempt++) {
        await sleep(500);
        rec.counts.webhookRetries++;
        const again = await world.client.request({ method: 'POST', path: '/webhook', headers, body: raw });
        if (again.status === 200) {
          rec.accepted.push({ id, field, name, shop: shop.n - 1, tenantId: shop.tenantId, retried: attempt + 1 });
          return;
        }
      }
    },
  };
  onWire?.(spec);
  return { ...spec, name };
}

/** One class of the mix as { name, rate, make(i) }. */
export function classPlans({ world, rec, rps, mix, rng, tag, skipWebhookShop = -1 }) {
  const shops = world.shops;
  const pickShop = () => shops[rng.int(shops.length)];
  const webhookShops = shops.filter((s) => s.n - 1 !== skipWebhookShop);
  let hookIndex = 0;
  const makers = {
    buyer_page: () => {
      const shop = pickShop();
      const path = rng.pick(['/', '/shop', `/p/${rng.pick(shop.productSlugs)}`, '/about', `/p/${rng.pick(shop.productSlugs)}`]);
      return { path, host: shop.host, headers: buyerAddress(rng), meta: { shop: shop.n - 1, route: path.startsWith('/p/') ? 'GET /p/:slug' : `GET ${path}` } };
    },
    beacon: () => {
      const shop = pickShop();
      return { method: 'POST', path: '/_t/e', host: shop.host, headers: buyerAddress(rng), body: { name: 'page_view', path: '/shop', pageKind: 'store', eventId: crypto.randomBytes(8).toString('hex') }, meta: { shop: shop.n - 1, route: 'POST /_t/e' } };
    },
    webhook: () => {
      const shop = rng.pick(webhookShops);
      const field = rng.next() < 0.7 ? 'comments' : 'messages';
      return webhookRequest({ world, rec, shop, index: hookIndex++, field, tag });
    },
    store_api: () => {
      const shop = pickShop();
      const roll = rng.next();
      const lines = [{ productId: rng.pick(shop.productIds), variantId: null, qty: 1 }];
      const common = { host: shop.host, headers: buyerAddress(rng) };
      const meta = (route) => ({ shop: shop.n - 1, route });
      if (roll < 0.55) return { ...common, meta: meta('POST /api/store/checkout/quote'), method: 'POST', path: '/api/store/checkout/quote', body: { lines, address: ADDRESS, paymentMode: 'prepaid' } };
      if (roll < 0.8) return { ...common, meta: meta('GET /api/store/products'), method: 'GET', path: `/api/store/products?ids=${shop.productIds.join(',')}` };
      return {
        ...common, meta: meta('POST /api/store/checkout'), method: 'POST', path: '/api/store/checkout',
        body: { lines, address: ADDRESS, email: '', paymentMode: 'prepaid', idempotencyKey: `k-${crypto.randomBytes(10).toString('hex')}`, acceptTerms: true, consent: { noticeVersion: 1 } },
        async after(outcome) {
          if (outcome.status < 200 || outcome.status >= 300) return;
          try {
            const placed = JSON.parse(outcome.text);
            if (placed.next !== 'pay' || !placed.gateway) return;
            await world.razorpay.post('/pay', { orderId: placed.gateway.gatewayOrderId, method: 'upi' });
            rec.counts.paid++;
          } catch {
            rec.counts.paymentErrors++;
          }
        },
      };
    },
    seller_api_read: () => {
      const shop = pickShop();
      const read = rng.pick(SELLER_READS);
      return { path: `/api/v1${read}`, host: shop.host, headers: { authorization: `Bearer ${shop.token}` }, meta: { shop: shop.n - 1, route: `GET /api/v1${read}` } };
    },
    seller_api_write: () => {
      const shop = pickShop();
      return { method: 'POST', path: '/api/v1/categories', host: shop.host, headers: { authorization: `Bearer ${shop.token}` }, body: { name: `Category ${crypto.randomBytes(5).toString('hex')}` }, meta: { shop: shop.n - 1, route: 'POST /api/v1/categories' } };
    },
  };
  return mix.map(({ class: name, weight }) => ({ name, rate: (rps * weight) / 100, make: makers[name] }));
}

/** The storm: `comments` comments on one business over `seconds`, every one of them a keyword that gets a DM. */
export function stormPlan({ world, rec, shopIndex, comments, seconds, tag }) {
  const shop = world.shops[shopIndex];
  let index = 0;
  return { name: 'storm', rate: comments / seconds, make: () => (index < comments ? webhookRequest({ world, rec, shop, index: 5_000_000 + index++, field: 'comments', tag, name: 'storm' }) : null) };
}
