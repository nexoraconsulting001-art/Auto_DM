// Shopify sync (PRD 9.11): each business connects its own app; products, prices and stock come from Shopify and a newer
// change is never undone by an older one (S-36); orders placed here appear in Shopify once and take its stock down once,
// whatever fails on the way (S-37); a webhook is verified by the shop's own HMAC and deduped by its id (S-38); two-way mode
// sends the owner's prices back and keeps every clash; stock never oversells; one business never touches another's products.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { shopifyFor } from '../../../src/modules/shopify-sync/index.js';
import { PLATFORM, alertsApp, hit, inTenant, otherBusiness, paidOrder, q, shopifyHook } from './support.js';

const SECRET = 'shpss_test_secret_a';
let serial = 0;

/** An Admin product in the simulator: one plain variant, or sizes. Returns its ids. */
async function seedProduct(app, { title = 'Snake plant', price = '499.00', qty = 7, sizes = null, status = 'active', updatedAt } = {}) {
  const pid = 7_200_000 + ++serial * 100;
  const variants = sizes
    ? sizes.map((s, i) => ({ id: pid * 10 + i + 1, product_id: pid, title: s.size, option1: s.size, price: s.price, sku: `SZ-${pid}-${s.size}`, inventory_item_id: pid * 10 + i + 50, inventory_quantity: s.qty }))
    : [{ id: pid * 10 + 1, product_id: pid, title: 'Default Title', price, sku: `SP-${pid}`, inventory_item_id: pid * 10 + 5, inventory_quantity: qty }];
  await app.shopify.post('/products', { id: pid, title, handle: `${title.toLowerCase().replace(/\W+/g, '-')}-${pid}`, status, options: sizes ? [{ name: 'Size', values: sizes.map((s) => s.size) }] : [{ name: 'Title', values: ['Default Title'] }], variants, ...(updatedAt ? { updated_at: updatedAt } : {}) });
  return { pid, vid: variants[0].id, variants };
}

async function connect(app, { domain = `neel-${crypto.randomInt(1e5, 9e5)}.myshopify.com`, secret = SECRET, mode = 'source', api = app.api } = {}) {
  const res = await api('PUT', '/shopify', { shopDomain: domain, accessToken: 'sim-shopify-token', webhookSecret: secret, mode });
  assert.equal(res.status, 200, res.text);
  return { domain, secret, view: res.json };
}

const reconcile = (app, tenant = app.tenant) => withTenant(tenant, () => shopifyFor(app.ctx).reconcile({ full: true }));
const linkOf = async (app, kind, shopifyId, tenant = app.tenant) => (await q(app, 'SELECT * FROM shopify_links WHERE tenant_id = $1 AND kind = $2 AND shopify_id = $3', [tenant.id, kind, String(shopifyId)], tenant))[0];
const productRow = async (app, id, tenant = app.tenant) => (await q(app, 'SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [tenant.id, id], tenant))[0];
const adminVariant = async (app, vid) => (await app.shopify.get('/admin/state')).products.flatMap((p) => p.variants ?? []).find((v) => v.id === vid);
const shopifyOrdersFor = async (app, vid) => (await app.shopify.get('/admin/state')).orders.filter((o) => o.line_items?.some((l) => l.variant_id === vid));
const settle = (app) => shopifyFor(app.ctx).webhook.settle();
const update = (pid, vid, price, { qty = 7, at = new Date() } = {}) => ({ id: pid, title: 'Snake plant', updated_at: at.toISOString(), variants: [{ id: vid, product_id: pid, price, inventory_item_id: vid + 4, inventory_quantity: qty }] });

test('a business connects its own Shopify app: the token is checked, secrets never come back, and one shop is one business', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    assert.deepEqual((await app.api('GET', '/shopify')).json, { connected: false, shopDomain: '', mode: 'source', status: 'none', lastReconciledAt: null, pendingOrders: 0, failedOrders: 0, webhookUrl: 'https://shop.test/webhooks/shopify' });
    const bad = await app.api('PUT', '/shopify', { shopDomain: 'neel.myshopify.com', accessToken: 'wrong', webhookSecret: SECRET });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await app.api('PUT', '/shopify', { shopDomain: 'neel.example.com', accessToken: 'sim-shopify-token', webhookSecret: SECRET })).status, 400, 'a myshopify.com address only');
    const { domain, view } = await connect(app, { domain: 'Neel-Studio.myshopify.com' });
    assert.equal(domain.toLowerCase(), view.shopDomain);
    assert.deepEqual([view.connected, view.mode, view.status], [true, 'source', 'active']);
    assert.ok(!JSON.stringify(view).includes(SECRET) && !JSON.stringify(view).includes('sim-shopify-token'));
    const [row] = await q(app, 'SELECT * FROM shopify_connections WHERE tenant_id = $1', [app.tenant.id]);
    assert.ok(!row.access_token_enc.includes('sim-shopify-token') && !row.webhook_secret_enc.includes(SECRET), 'stored encrypted');
    const hooks = (await app.shopify.get('/admin/state')).webhooks;
    assert.deepEqual(hooks.map((h) => h.topic).sort(), ['app/uninstalled', 'inventory_levels/update', 'products/create', 'products/delete', 'products/update']);
    assert.ok(hooks.every((h) => h.address === 'https://shop.test/webhooks/shopify'));
    const [job] = await app.db.platform.query(`SELECT * FROM jobs WHERE queue = 'shopify-sync.reconcile' AND tenant_id = $1`, [app.tenant.id]);
    assert.ok(job, 'the first sync is queued');

    const other = await otherBusiness(app);
    const taken = await other.api('PUT', '/shopify', { shopDomain: 'neel-studio.myshopify.com', accessToken: 'sim-shopify-token', webhookSecret: 'theirs' });
    assert.equal(taken.status, 409, taken.text);

    assert.equal((await app.api('PATCH', '/shopify', { mode: 'two_way' })).json.mode, 'two_way');
    assert.equal((await app.api('PATCH', '/shopify', { paused: true })).json.status, 'paused');
    assert.equal((await app.api('PATCH', '/shopify', { paused: false })).json.status, 'active');
    const audit = await q(app, `SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'shopify.%' ORDER BY id`, [app.tenant.id]);
    assert.deepEqual(audit.map((a) => a.action), ['shopify.connected', 'shopify.mode_changed', 'shopify.mode_changed', 'shopify.mode_changed']);
    assert.equal((await app.api('POST', '/shopify/reconcile')).status, 202);
    assert.equal((await app.api('DELETE', '/shopify')).status, 204);
    assert.equal((await app.api('GET', '/shopify')).json.connected, false);
    assert.equal((await app.api('POST', '/shopify/reconcile')).status, 409);
  } finally {
    await app.close();
  }
});

test('the reconcile imports and links Shopify’s products with their prices and stock, once, and leaves drafts out', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const plain = await seedProduct(app, { title: 'Snake plant', price: '499.00', qty: 7 });
    const sized = await seedProduct(app, { title: 'Kurta', sizes: [{ size: 'S', price: '899.00', qty: 3 }, { size: 'M', price: '949.00', qty: 0 }] });
    const draft = await seedProduct(app, { title: 'Secret thing', status: 'draft' });
    await connect(app);
    const counts = await reconcile(app);
    assert.equal(counts.created, 2);
    const link = await linkOf(app, 'product', plain.pid);
    const p = await productRow(app, Number(link.local_id));
    assert.deepEqual([p.name, Number(p.price_paise), p.stock, p.source, p.external_url], ['Snake plant', 49900, 7, 'shopify', '']);
    assert.ok(await linkOf(app, 'variant', plain.vid), 'its one variant is the product itself');
    assert.equal(Number((await linkOf(app, 'variant', plain.vid)).local_id), -p.id);
    assert.ok(await linkOf(app, 'inventory_item', plain.vid + 4));

    const kurta = Number((await linkOf(app, 'product', sized.pid)).local_id);
    const variants = await q(app, 'SELECT * FROM product_variants WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [app.tenant.id, kurta]);
    assert.deepEqual(variants.map((v) => [v.option_values[0], Number(v.price_paise), v.stock]), [['S', 89900, 3], ['M', 94900, 0]]);
    assert.equal(Number((await linkOf(app, 'variant', sized.variants[1].id)).local_id), variants[1].id);
    assert.equal(Number((await productRow(app, kurta)).price_paise), 89900, 'the card shows the lowest price');
    assert.equal(await linkOf(app, 'product', draft.pid), undefined);

    const again = await reconcile(app);
    assert.equal(again.created, 0);
    assert.equal((await q(app, `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND source = 'shopify'`, [app.tenant.id]))[0].n, 2);
    assert.ok((await app.api('GET', '/shopify')).json.lastReconciledAt);
  } finally {
    await app.close();
  }
});

test('S-36, S-38: a signed price change shows at once; a repeat, an older one, a junk price or a bad HMAC changes nothing', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app);
    const { domain, secret } = await connect(app);
    await reconcile(app);
    const productId = Number((await linkOf(app, 'product', pid)).local_id);

    const res = await shopifyHook(app, { domain, secret, topic: 'products/update', payload: update(pid, vid, '549.00') });
    assert.equal(res.status, 200, res.text);
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 54900);
    const page = await hit(app, `/p/${(await productRow(app, productId)).slug}`);
    assert.match(page.text, /549/);
    const quote = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId, variantId: null, qty: 1 }] } });
    assert.equal(quote.json.subtotalPaise, 54900, 'checkout charges the new price');

    const webhookId = crypto.randomUUID();
    const newer = update(pid, vid, '599.00', { at: new Date(Date.now() + 1000) });
    for (let i = 0; i < 3; i++) assert.equal((await shopifyHook(app, { domain, secret, topic: 'products/update', payload: newer, webhookId })).status, 200);
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 59900);
    assert.equal((await app.db.platform.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify' AND event_id = $1`, [webhookId]))[0].n, 1);
    await shopifyHook(app, { domain, secret, topic: 'products/update', payload: update(pid, vid, '399.00', { at: new Date(Date.now() - 3_600_000) }) });
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 59900, 'an older update arriving late changes nothing');
    for (const price of ['-1.00', 'abc', '99999999999999.00', '']) {
      assert.equal((await shopifyHook(app, { domain, secret, topic: 'products/update', payload: update(pid, vid, price, { at: new Date(Date.now() + 5000) }) })).status, 200);
    }
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 59900, 'a junk price is refused');
    // A reconcile reading Shopify's product, which carries no newer time, never undoes the webhook's newer price.
    await reconcile(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 59900);

    const before = (await app.db.platform.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify'`))[0].n;
    const payload = update(pid, vid, '1.00', { at: new Date(Date.now() + 9000) });
    const raw = JSON.stringify(payload);
    for (const change of [{ secret: 'not-it' }, { hmac: null }, { hmac: '' }, { hmac: crypto.createHmac('sha256', secret).update(raw).digest('hex') }, { hmac: 'é'.repeat(44) }, { secret: 'sim-shopify-secret' }]) {
      assert.equal((await shopifyHook(app, { domain, secret, topic: 'products/update', payload, ...change })).status, 401, JSON.stringify(change));
    }
    assert.equal((await shopifyHook(app, { domain: 'nobody.myshopify.com', secret, topic: 'products/update', payload })).status, 401);
    assert.equal((await shopifyHook(app, { domain: 'not a domain', secret, topic: 'products/update', payload })).status, 401);
    assert.equal((await app.db.platform.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shopify'`))[0].n, before, 'nothing badly signed is stored');
    assert.equal(Number((await productRow(app, productId)).price_paise), 59900);

    // Archived in Shopify: no longer sold here.
    await shopifyHook(app, { domain, secret, topic: 'products/delete', payload: { id: pid } });
    await settle(app);
    assert.equal((await productRow(app, productId)).active, false);
  } finally {
    await app.close();
  }
});

test('one business’s Shopify webhook only ever touches that business’s products, even for a product both have linked', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app);
    const mine = await connect(app, { domain: 'neel-a.myshopify.com', secret: 'secret-a' });
    await reconcile(app);
    const other = await otherBusiness(app);
    const theirs = await connect(app, { domain: 'haldi-b.myshopify.com', secret: 'secret-b', api: other.api });
    await reconcile(app, other.tenant);
    const minePid = Number((await linkOf(app, 'product', pid)).local_id);
    const theirPid = Number((await linkOf(app, 'product', pid, other.tenant)).local_id);

    await shopifyHook(app, { domain: mine.domain, secret: mine.secret, topic: 'products/update', payload: update(pid, vid, '650.00') });
    await settle(app);
    assert.equal(Number((await productRow(app, minePid)).price_paise), 65000);
    assert.equal(Number((await productRow(app, theirPid, other.tenant)).price_paise), 49900, 'the other business’s copy is untouched');
    // The other shop's secret under this shop's name is refused.
    assert.equal((await shopifyHook(app, { domain: mine.domain, secret: theirs.secret, topic: 'products/update', payload: update(pid, vid, '1.00') })).status, 401);
  } finally {
    await app.close();
  }
});

test('stock: Shopify’s count less what was sold here and not yet pushed; never below what unpaid orders hold, and the owner is told', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app, { qty: 10 });
    const { domain, secret } = await connect(app);
    await reconcile(app);
    const productId = Number((await linkOf(app, 'product', pid)).local_id);
    const level = (available, at = new Date()) => shopifyHook(app, { domain, secret, topic: 'inventory_levels/update', payload: { inventory_item_id: vid + 4, location_id: 1, available, updated_at: at.toISOString() } });

    await level(8);
    await settle(app);
    assert.equal((await productRow(app, productId)).stock, 8);
    await level(2, new Date(Date.now() - 3_600_000));
    await settle(app);
    assert.equal((await productRow(app, productId)).stock, 8, 'an older count changes nothing');

    // Paused: an order is sold here but not pushed yet, so Shopify's next count doesn't know of it.
    await app.api('PATCH', '/shopify', { paused: true });
    await paidOrder(app, { productId, qty: 3, email: '' });
    assert.equal((await productRow(app, productId)).stock, 5);
    await app.api('PATCH', '/shopify', { paused: false });
    await level(8, new Date(Date.now() + 1000));
    await settle(app);
    assert.equal((await productRow(app, productId)).stock, 5, '8 at Shopify, less the 3 sold here that Shopify hasn’t heard of');
    const [movement] = await q(app, `SELECT * FROM stock_movements WHERE tenant_id = $1 AND reason = 'shopify' ORDER BY id DESC LIMIT 1`, [app.tenant.id]);
    assert.ok(movement, 'every change is in the stock movements');

    // An unpaid order holds 2; Shopify then says 1 is left (minus the 3 unpushed): stock stays at what is held, nothing more sells.
    const res = await hit(app, '/api/store/checkout', { method: 'POST', body: { lines: [{ productId, variantId: null, qty: 2 }], address: { name: 'Mira', phone: '+919811100022', line1: '1 Road', city: 'Pune', stateCode: '27', pincode: '411001' }, paymentMode: 'prepaid', idempotencyKey: crypto.randomUUID(), acceptTerms: true, consent: { noticeVersion: 1 } } });
    assert.equal(res.status, 201, res.text);
    await level(1, new Date(Date.now() + 2000));
    await settle(app);
    const row = await productRow(app, productId);
    assert.deepEqual([row.stock, row.reserved], [2, 2]);
    const quote = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId, variantId: null, qty: 1 }] } });
    assert.equal(quote.json.lines[0].state, 'sold_out');
    const [alert] = await q(app, `SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'shopify.stock_short'`, [app.tenant.id]);
    assert.ok(alert);
  } finally {
    await app.close();
  }
});

test('S-37: a paid order appears in Shopify once and takes its stock down once, even when answers are lost or refused for a while', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app, { qty: 7 });
    await connect(app);
    await reconcile(app);
    const productId = Number((await linkOf(app, 'product', pid)).local_id);
    const { pushes } = shopifyFor(app.ctx);

    const order = await paidOrder(app, { productId, qty: 2 });
    const [push] = await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(push.status, 'pushed');
    const orders = await shopifyOrdersFor(app, vid);
    assert.equal(orders.length, 1);
    assert.equal(String(orders[0].id), push.shopify_order_id);
    assert.equal(orders[0].line_items[0].quantity, 2);
    assert.equal(orders[0].financial_status, 'paid');
    assert.equal((await adminVariant(app, vid)).inventory_quantity, 5);
    const [call] = await app.shopify.calls({ method: 'POST', path: '/admin/api/*/orders.json' });
    assert.equal(call.headers['idempotency-key'], `order-${app.tenant.id}-${order.order_number}`);
    assert.doesNotMatch(JSON.stringify(call.body), PLATFORM);
    await inTenant(app, () => pushes.onOrderConfirmed({ orderId: order.id }));
    assert.equal((await shopifyOrdersFor(app, vid)).length, 1, 'the event again is the same push');
    assert.equal((await app.api('GET', '/shopify')).json.pendingOrders, 0);

    // Unpaid: never pushed.
    const res = await hit(app, '/api/store/checkout', { method: 'POST', body: { lines: [{ productId, variantId: null, qty: 1 }], address: { name: 'Mira', phone: '+919811100022', line1: '1 Road', city: 'Pune', stateCode: '27', pincode: '411001' }, paymentMode: 'prepaid', idempotencyKey: crypto.randomUUID(), acceptTerms: true, consent: { noticeVersion: 1 } } });
    await app.ctx.orderEvents.settle();
    assert.equal((await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = (SELECT id FROM orders WHERE tenant_id = $1 AND order_number = $2)', [app.tenant.id, res.json.orderNumber])).length, 0);

    // The first answer is lost after Shopify made the order, then Shopify refuses twice: still one Shopify order.
    await app.shopify.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: '/admin/api/*/orders.json' } });
    await app.shopify.fault({ kind: 'rate_limit', retryAfter: 1, times: 2, match: { method: 'POST', path: '/admin/api/*/orders.json' } });
    const second = await paidOrder(app, { productId, qty: 1 });
    const statusOf = async () => (await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, second.id]))[0];
    assert.equal((await statusOf()).status, 'pending');
    for (let i = 0; i < 5 && (await statusOf()).status !== 'pushed'; i++) {
      await q(app, `UPDATE shopify_order_pushes SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1 AND order_id = $2`, [app.tenant.id, second.id]);
      await pushes.sweep();
    }
    const done = await statusOf();
    assert.equal(done.status, 'pushed');
    assert.equal(done.attempts, 4);
    assert.equal((await shopifyOrdersFor(app, vid)).length, 2, 'one Shopify order per order here');
    assert.equal((await adminVariant(app, vid)).inventory_quantity, 4, 'Shopify’s stock went down once');
  } finally {
    await app.close();
  }
});

test('a push Shopify refuses outright fails and the owner is told; an order cancelled before its push stays out of Shopify', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app, { qty: 7 });
    await connect(app);
    await reconcile(app);
    const productId = Number((await linkOf(app, 'product', pid)).local_id);
    await q(app, `UPDATE shopify_links SET shopify_id = '999999999' WHERE tenant_id = $1 AND kind = 'variant' AND shopify_id = $2`, [app.tenant.id, String(vid)]);
    const order = await paidOrder(app, { productId });
    const [push] = await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(push.status, 'failed');
    assert.match(push.last_error, /^rejected:422/);
    const [alert] = await q(app, `SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'shopify.order_not_pushed'`, [app.tenant.id]);
    assert.ok(alert.message.includes(order.order_number));
    assert.equal((await app.api('GET', '/shopify')).json.failedOrders, 1);

    await app.api('PATCH', '/shopify', { paused: true });
    const later = await paidOrder(app, { productId });
    await inTenant(app, () => shopifyFor(app.ctx).pushes.onOrderCancelled({ orderId: later.id }));
    const [skipped] = await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, later.id]);
    assert.equal(skipped.status, 'skipped');
  } finally {
    await app.close();
  }
});

test('two-way: the owner’s price goes to Shopify; when both sides changed, the later change wins and the clash is listed', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const { pid, vid } = await seedProduct(app, { price: '499.00' });
    const { domain, secret } = await connect(app, { mode: 'two_way' });
    await reconcile(app);
    const productId = Number((await linkOf(app, 'product', pid)).local_id);
    const ownerSets = (paise) => q(app, `UPDATE products SET price_paise = $3, mrp_paise = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, productId, paise]);
    const sync = shopifyFor(app.ctx);

    await ownerSets(65000);
    assert.equal(await inTenant(app, async () => sync.pushes.pushPrices(await sync.connection.active())), 1);
    assert.equal((await adminVariant(app, vid)).price, '650.00');
    assert.equal(await inTenant(app, async () => sync.pushes.pushPrices(await sync.connection.active())), 0, 'nothing new to send');

    // The owner changes it again here; Shopify's change made before that arrives late: the owner's later price wins.
    await ownerSets(70000);
    await shopifyHook(app, { domain, secret, topic: 'products/update', payload: update(pid, vid, '520.00', { at: new Date(Date.now() - 60_000) }) });
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 70000);
    // Then a Shopify change made after the owner's: Shopify wins.
    await ownerSets(71000);
    await shopifyHook(app, { domain, secret, topic: 'products/update', payload: update(pid, vid, '540.00', { at: new Date(Date.now() + 60_000) }) });
    await settle(app);
    assert.equal(Number((await productRow(app, productId)).price_paise), 54000);
    const list = await app.api('GET', '/shopify/conflicts');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.items.map((c) => [c.field, c.localValue, c.remoteValue, c.winner]), [['price', '71000', '54000', 'remote'], ['price', '70000', '52000', 'local']]);
    assert.ok(list.json.items.every((c) => c.localId === productId && c.shopifyId === String(vid)));
  } finally {
    await app.close();
  }
});
