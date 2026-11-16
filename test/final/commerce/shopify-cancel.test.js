// commerce-8 (PRD 9.11, S-37): an order already pushed to Shopify and then cancelled here is cancelled in Shopify too, with
// its stock put back there. Shopify's count is the one both sides sell from, so the units are not added here while Shopify
// still counts them against an open order; they come back with Shopify's next count. If Shopify refuses, the owner is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { shopifyFor } from '../../../src/modules/shopify-sync/index.js';
import { alertsApp, inTenant, paidOrder, q, shopifyHook } from '../../p4/alerts-sync/support.js';

let serial = 0;
async function seedProduct(app, qty) {
  const pid = 8_300_000 + ++serial * 100;
  const variant = { id: pid * 10 + 1, product_id: pid, title: 'Default Title', price: '499.00', sku: `SC-${pid}`, inventory_item_id: pid * 10 + 5, inventory_quantity: qty };
  await app.shopify.post('/products', { id: pid, title: 'Snake plant', handle: `snake-plant-${pid}`, status: 'active', options: [{ name: 'Title', values: ['Default Title'] }], variants: [variant] });
  return { pid, vid: variant.id, itemId: variant.inventory_item_id };
}

async function world(app, qty = 7) {
  const seeded = await seedProduct(app, qty);
  const domain = `cancel-${crypto.randomInt(1e5, 9e5)}.myshopify.com`;
  const secret = 'shpss_test_secret_c';
  const res = await app.api('PUT', '/shopify', { shopDomain: domain, accessToken: 'sim-shopify-token', webhookSecret: secret, mode: 'source' });
  assert.equal(res.status, 200, res.text);
  await withTenant(app.tenant, () => shopifyFor(app.ctx).reconcile({ full: true }));
  const [link] = await q(app, `SELECT local_id FROM shopify_links WHERE tenant_id = $1 AND kind = 'product' AND shopify_id = $2`, [app.tenant.id, String(seeded.pid)]);
  return { ...seeded, domain, secret, productId: Number(link.local_id) };
}

const cancel = async (app, orderId) => {
  await inTenant(app, () => app.db.tx((t) => changeOrder(t, orderId, { fulfilment: 'cancelled', cancelReason: 'seller', actor: 'test:owner' })));
  await app.ctx.orderEvents.settle();
};
const pushOf = async (app, orderId) => (await q(app, 'SELECT * FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, orderId]))[0];
const stockOf = async (app, productId) => (await q(app, 'SELECT stock FROM products WHERE tenant_id = $1 AND id = $2', [app.tenant.id, productId]))[0].stock;
const shopifyState = async (app, vid, shopifyOrderId) => {
  const state = await app.shopify.get('/admin/state');
  return {
    qty: state.products.flatMap((p) => p.variants ?? []).find((v) => v.id === vid).inventory_quantity,
    order: state.orders.find((o) => String(o.id) === String(shopifyOrderId)),
  };
};

test('commerce-8: a pushed order cancelled here is cancelled in Shopify with restock; local stock waits for Shopify’s count', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const w = await world(app, 7);
    const order = await paidOrder(app, { productId: w.productId, qty: 2 });
    const push = await pushOf(app, order.id);
    assert.equal(push.status, 'pushed');
    assert.equal((await shopifyState(app, w.vid, push.shopify_order_id)).qty, 5);
    assert.equal(await stockOf(app, w.productId), 5);

    await cancel(app, order.id);
    const after = await pushOf(app, order.id);
    assert.equal(after.cancel_status, 'done');
    const shop = await shopifyState(app, w.vid, push.shopify_order_id);
    assert.ok(shop.order.cancelled_at, 'the Shopify order is cancelled');
    assert.equal(shop.qty, 7, 'Shopify put the stock back');
    const [call] = await app.shopify.calls({ method: 'POST', path: '/admin/api/*/orders/*/cancel.json' });
    assert.equal(call.body.restock, true);
    assert.equal(await stockOf(app, w.productId), 5, 'not added here while Shopify still had them');
    const [held] = await q(app, `SELECT status FROM stock_reservations WHERE tenant_id = $1 AND order_id = $2`, [app.tenant.id, order.id]);
    assert.equal(held.status, 'released');

    // Shopify's count arrives: the units are back here, once.
    await shopifyHook(app, { domain: w.domain, secret: w.secret, topic: 'inventory_levels/update', payload: { inventory_item_id: w.itemId, location_id: 1, available: shop.qty, updated_at: new Date(Date.now() + 1000).toISOString() } });
    await shopifyFor(app.ctx).webhook.settle();
    assert.equal(await stockOf(app, w.productId), 7);

    // The event again changes nothing and calls Shopify no more.
    await inTenant(app, () => shopifyFor(app.ctx).pushes.onOrderCancelled({ orderId: order.id }));
    assert.equal((await app.shopify.calls({ method: 'POST', path: '/admin/api/*/orders/*/cancel.json' })).length, 1);
    const none = await q(app, `SELECT 1 FROM alerts WHERE tenant_id = $1 AND kind = 'shopify.order_not_cancelled'`, [app.tenant.id]);
    assert.equal(none.length, 0);
  } finally {
    await app.close();
  }
});

test('commerce-8: when Shopify refuses the cancel, the owner is told to cancel it there, and the stock is still not added here', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const w = await world(app, 7);
    const order = await paidOrder(app, { productId: w.productId, qty: 1 });
    assert.equal((await pushOf(app, order.id)).status, 'pushed');
    await app.shopify.fault({ kind: 'rate_limit', status: 422, body: { errors: 'Cannot cancel a fulfilled order' }, times: 1, match: { method: 'POST', path: '/admin/api/*/orders/*/cancel.json' } });
    await cancel(app, order.id);
    const after = await pushOf(app, order.id);
    assert.equal(after.cancel_status, 'failed');
    assert.match(after.last_error, /^cancel:rejected:422/);
    const [alert] = await q(app, `SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'shopify.order_not_cancelled'`, [app.tenant.id]);
    assert.ok(alert, 'the owner is told');
    assert.ok(alert.message.includes(order.order_number));
    assert.doesNotMatch(alert.message, /bhava/i);
    assert.equal(await stockOf(app, w.productId), 6, 'Shopify still counts the unit against its open order');
  } finally {
    await app.close();
  }
});
