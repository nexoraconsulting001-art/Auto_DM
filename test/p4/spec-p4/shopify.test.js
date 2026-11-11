// PRD 9.11: Shopify sync, mode (a) where Shopify is the source. S-36 to S-38.
// Each business connects its own Shopify app with its own webhook secret. The Admin simulator is shared; each test gives
// its shop its own myshopify.com address and signs that shop's webhooks as Shopify would, with that shop's secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SIGNATURE_HEADERS, STORE_PROVIDER_PATHS, addP4Shop, buyer, hit, need, noCrash, textOf, unique, useP4World } from './kit.js';

const world = useP4World();
let serial = 0;

function shopifyHook(world_, { domain, secret, topic, payload, webhookId = crypto.randomUUID(), hmac }) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = hmac === undefined ? crypto.createHmac('sha256', secret).update(raw).digest('base64') : hmac;
  return hit(world_, STORE_PROVIDER_PATHS.shopify.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.shopifyTopic]: topic, [SIGNATURE_HEADERS.shopifyShop]: domain, [SIGNATURE_HEADERS.shopifyWebhookId]: webhookId, ...(sig === null ? {} : { [SIGNATURE_HEADERS.shopify]: sig }) },
    body: raw,
  });
}

/** A shop connected to Shopify in source mode, with one Admin product it has imported and linked. */
async function connected() {
  const shop = await addP4Shop(world);
  const n = ++serial;
  const domain = `spec-${unique()}-${n}.myshopify.com`.toLowerCase();
  const secret = `shpss_${crypto.randomBytes(12).toString('hex')}`;
  const pid = 7_100_000 + n * 1000 + crypto.randomInt(0, 999);
  const vid = pid * 10 + 1;
  await world.shopifyAdmin.post('/products', { id: pid, title: `Snake plant ${n}`, handle: `snake-plant-${pid}`, status: 'active', variants: [{ id: vid, product_id: pid, title: 'Default', price: '499.00', sku: `SP-${pid}`, inventory_item_id: vid + 5, inventory_quantity: 7 }] });
  const conn = need(await shop.send('PUT', '/shopify', { shopDomain: domain, accessToken: 'sim-shopify-token', webhookSecret: secret, mode: 'source' }), 200, 'Connecting Shopify').json();
  assert.equal(conn.connected, true);
  assert.equal(conn.mode, 'source');
  assert.ok(!JSON.stringify(conn).includes(secret) && !JSON.stringify(conn).includes('sim-shopify-token'), 'The connection answer gives back a secret');
  need(await shop.send('POST', '/shopify/reconcile'), 202, 'Running the first sync');
  const link = await world.until(async () => (await shop.sql(`SELECT * FROM shopify_links WHERE tenant_id = $1 AND kind = 'product' AND shopify_id = $2`, [shop.tenantId, String(pid)]))[0], 20_000);
  assert.ok(link, 'The Shopify product was not imported and linked');
  const product = await shop.one('SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, Number(link.local_id)]);
  return { shop, domain, secret, pid, vid, product };
}

const adminVariant = async (vid) => (await world.shopifyAdmin.get('/admin/state')).products.flatMap((p) => p.variants ?? []).find((v) => v.id === vid);
const productUpdate = (pid, vid, price, qty = 7) => ({ id: pid, title: 'Snake plant', updated_at: new Date().toISOString(), variants: [{ id: vid, product_id: pid, price, inventory_item_id: vid + 5, inventory_quantity: qty }] });

test('S-36: a price changed in Shopify shows in the store within a minute', async () => {
  const { shop, domain, secret, pid, vid, product } = await connected();
  assert.equal(Number(product.price_paise), 49900);
  const res = await shopifyHook(world, { domain, secret, topic: 'products/update', payload: productUpdate(pid, vid, '549.00') });
  assert.ok(res.status >= 200 && res.status < 300, `Shopify’s webhook answered ${res.status}`);
  const started = Date.now();
  const row = await world.until(async () => {
    const r = await shop.one('SELECT price_paise, slug FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id]);
    return Number(r.price_paise) === 54900 ? r : null;
  }, 60_000);
  assert.ok(row, 'The new price did not arrive within a minute');
  assert.ok(Date.now() - started < 60_000);
  const page = need(await shop.open(`/p/${row.slug}`), 200, 'The product page');
  assert.match(textOf(page.text), /549/, 'The product page does not show the new price');
  assert.doesNotMatch(textOf(page.text), /₹\s?499\b/);
  const q = (await buyer(world, shop).quote({ lines: [{ productId: product.id, variantId: null, qty: 1 }] }));
  if (q.status === 200) assert.equal(q.data.subtotalPaise, 54900, 'Checkout still charges the old price');
});

test('S-36: a repeated or older Shopify update never undoes a newer price', async () => {
  const { shop, domain, secret, pid, vid, product } = await connected();
  const webhookId = crypto.randomUUID();
  const newer = { ...productUpdate(pid, vid, '599.00'), updated_at: new Date(Date.now() + 1000).toISOString() };
  const older = { ...productUpdate(pid, vid, '399.00'), updated_at: new Date(Date.now() - 3_600_000).toISOString() };
  for (let i = 0; i < 3; i++) noCrash(await shopifyHook(world, { domain, secret, topic: 'products/update', payload: newer, webhookId }), 'The same update again');
  await world.until(async () => Number((await shop.one('SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id])).price_paise) === 59900, 20_000);
  noCrash(await shopifyHook(world, { domain, secret, topic: 'products/update', payload: older }), 'An older update arriving late');
  await world.quiet(2000);
  assert.equal(Number((await shop.one('SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id])).price_paise), 59900, 'An older update undid a newer price');
  const [{ n }] = await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify' AND event_id = $1`, [webhookId]);
  assert.equal(n, 1, 'One Shopify webhook id was stored more than once');
  for (const price of ['-1.00', 'abc', '99999999999999.00', '']) {
    noCrash(await shopifyHook(world, { domain, secret, topic: 'products/update', payload: { ...productUpdate(pid, vid, price), updated_at: new Date(Date.now() + 5000).toISOString() } }), `A price of ${JSON.stringify(price)}`);
  }
  await world.quiet(1500);
  const after = Number((await shop.one('SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id])).price_paise);
  assert.ok(after > 0 && after < 100_000_000_000, `A junk price from Shopify became ${after}`);
});

test('S-37: an order placed here appears in Shopify once, and Shopify’s stock goes down', async () => {
  const { shop, vid, product } = await connected();
  const b = buyer(world, shop);
  const unpaid = await buyer(world, shop).order({ lines: [{ productId: product.id, variantId: null, qty: 1 }] });
  const row = await b.buy({ lines: [{ productId: product.id, variantId: null, qty: 2 }] });
  const pushed = await world.until(async () => (await shop.sql(`SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2 AND status = 'pushed'`, [shop.tenantId, row.id]))[0], 20_000);
  assert.ok(pushed, 'The order was not pushed to Shopify');
  const orders = (await world.shopifyAdmin.get('/admin/state')).orders.filter((o) => o.line_items?.some((l) => l.variant_id === vid));
  assert.equal(orders.length, 1, `${orders.length} Shopify orders for one paid order`);
  assert.equal(orders[0].line_items.find((l) => l.variant_id === vid).quantity, 2);
  assert.equal(String(pushed.shopify_order_id), String(orders[0].id));
  assert.equal((await adminVariant(vid)).inventory_quantity, 5, 'Shopify’s stock did not go down');
  const call = (await world.shopifyAdmin.calls({ method: 'POST', path: '/admin/api/*/orders.json' })).find((c) => c.body?.order?.line_items?.some((l) => l.variant_id === vid));
  assert.ok(call, 'No push call carried this order’s line');
  assert.ok(call.headers['idempotency-key'], 'The push carries no idempotency key, so a retry could make a second order');
  assert.ok(!JSON.stringify(call.body).match(/bhava/i), 'The order sent to Shopify names the platform');
  assert.equal((await shop.sql(`SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2`, [shop.tenantId, (await shop.order(unpaid.orderNumber)).id])).filter((p) => p.status === 'pushed').length, 0, 'An unpaid order was pushed to Shopify');
});

test('S-37: a push whose answer is lost, or that Shopify refuses for a while, still makes one Shopify order', async () => {
  const { shop, vid, product } = await connected();
  await world.shopifyAdmin.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: '/admin/api/*/orders.json' } });
  await world.shopifyAdmin.fault({ kind: 'rate_limit', retryAfter: 1, times: 2, match: { method: 'POST', path: '/admin/api/*/orders.json' } });
  const row = await buyer(world, shop).buy({ lines: [{ productId: product.id, variantId: null, qty: 1 }] });
  for (let i = 0; i < 6; i++) {
    await world.age(5 * 60_000);
    const [p] = await shop.sql('SELECT status FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [shop.tenantId, row.id]);
    if (p?.status === 'pushed') break;
    await world.quiet(1500);
  }
  await world.shopifyAdmin.delete('/faults');
  await world.until(async () => (await shop.sql(`SELECT 1 FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2 AND status = 'pushed'`, [shop.tenantId, row.id])).length, 20_000);
  const orders = (await world.shopifyAdmin.get('/admin/state')).orders.filter((o) => o.line_items?.some((l) => l.variant_id === vid));
  assert.equal(orders.length, 1, `${orders.length} Shopify orders after a lost answer and retries`);
  assert.equal((await adminVariant(vid)).inventory_quantity, 6, 'Shopify’s stock went down more than once');
});

test('S-38: a webhook with a bad HMAC is refused and changes nothing', async () => {
  const { shop, domain, secret, pid, vid, product } = await connected();
  const other = await connected();
  const payload = productUpdate(pid, vid, '1.00');
  const raw = JSON.stringify(payload);
  const before = (await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify'`))[0].n;
  const attempts = {
    'a wrong secret': { secret: 'not-the-secret' },
    'no HMAC': { hmac: null },
    'an empty HMAC': { hmac: '' },
    'the HMAC in hex instead of base64': { hmac: crypto.createHmac('sha256', secret).update(raw).digest('hex') },
    'the HMAC of other bytes': { hmac: crypto.createHmac('sha256', secret).update(`${raw} `).digest('base64') },
    'another shop’s secret under this shop’s name': { secret: other.secret },
    'the platform simulator’s app secret': { secret: 'sim-shopify-secret' },
  };
  for (const [what, change] of Object.entries(attempts)) {
    const res = await shopifyHook(world, { domain, secret, topic: 'products/update', payload, ...change });
    assert.equal(res.status, 401, `${what}: answered ${res.status}`);
  }
  const unknown = await shopifyHook(world, { domain: 'nobody-here.myshopify.com', secret, topic: 'products/update', payload });
  assert.ok([401, 404].includes(unknown.status), `A shop nobody connected answered ${unknown.status}`);
  // This shop's genuine webhook naming another shop's product changes neither.
  noCrash(await shopifyHook(world, { domain, secret, topic: 'products/update', payload: productUpdate(other.pid, other.vid, '2.00') }), 'A signed update about a product linked elsewhere');
  await world.quiet(1500);
  assert.equal(Number((await shop.one('SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id])).price_paise), 49900, 'A badly signed webhook changed the price');
  assert.equal(Number((await other.shop.one('SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [other.shop.tenantId, other.product.id])).price_paise), 49900, 'One shop’s webhook changed another shop’s product');
  const after = (await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify'`))[0].n;
  assert.ok(after - before <= 1, 'Badly signed webhooks were stored');
  const conn = need(await shop.send('GET', '/shopify'), 200, 'The connection').json();
  assert.ok(!JSON.stringify(conn).includes(secret));
  need(await other.shop.send('PUT', '/shopify', { shopDomain: domain, accessToken: 'sim-shopify-token', webhookSecret: 'mine-now', mode: 'source' }), [400, 409], 'Another business connecting a shop that is already connected');
});
