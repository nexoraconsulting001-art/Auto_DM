// Shopify and WhatsApp webhooks worked by two processes at once (R4-WH-3, R4-WH-4): the web app works a delivery as it
// arrives and the worker works whatever is left, from the same table. Each delivery must be applied once, in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { shopifyFor } from '../../../src/modules/shopify-sync/index.js';
import { cleanProduct } from '../../../src/modules/shopify-sync/products.js';
import { createShopifyWebhook } from '../../../src/modules/shopify-sync/webhook.js';
import { orderAlertsFor } from '../../../src/modules/order-alerts/index.js';
import { createWhatsappWebhook } from '../../../src/modules/order-alerts/webhook.js';
import { alertsApp, q } from './support.js';

/** Records each call of `obj[name]` as a start and an end, while the test runs. */
function spy(obj, name, label, calls) {
  const real = obj[name];
  obj[name] = async (...args) => {
    calls.push(`start:${label(...args)}`);
    try {
      return await real.apply(obj, args);
    } finally {
      calls.push('end');
    }
  };
  return () => { obj[name] = real; };
}

test('two drainers at once (the web app and the worker) apply each Shopify delivery once, one business’s deliveries one after the other', async () => {
  const app = await alertsApp({ whatsapp: false });
  let restore = () => {};
  try {
    const pid = 7_900_100;
    const vid = pid * 10 + 1;
    await app.shopify.post('/products', { id: pid, title: 'Snake plant', handle: `snake-plant-${pid}`, status: 'active', options: [{ name: 'Title', values: ['Default Title'] }], variants: [{ id: vid, product_id: pid, title: 'Default Title', price: '499.00', sku: `SP-${pid}`, inventory_item_id: vid + 4, inventory_quantity: 7 }] });
    const domain = `neel-${crypto.randomInt(1e5, 9e5)}.myshopify.com`;
    assert.equal((await app.api('PUT', '/shopify', { shopDomain: domain, accessToken: 'sim-shopify-token', webhookSecret: 'shpss_race', mode: 'source' })).status, 200);
    const sync = shopifyFor(app.ctx);
    await withTenant(app.tenant, () => sync.reconcile({ full: true }));
    await sync.webhook.settle();
    const [link] = await q(app, `SELECT local_id FROM shopify_links WHERE tenant_id = $1 AND kind = 'product' AND shopify_id = $2`, [app.tenant.id, String(pid)]);

    // Stored and not yet worked through: two price changes, the second the newer.
    const update = (price, at) => cleanProduct({ id: pid, title: 'Snake plant', updated_at: at.toISOString(), variants: [{ id: vid, product_id: pid, price, inventory_item_id: vid + 4, inventory_quantity: 7 }] });
    for (const [price, at] of [['549.00', new Date(Date.now() + 1000)], ['599.00', new Date(Date.now() + 2000)]]) {
      await app.db.platform.query(
        `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload, tenant_id) VALUES ('shopify', $1, $2, 'products/update', $3::jsonb, $4)`,
        [`tenant:${app.tenant.id}`, `race-${price}`, JSON.stringify({ product: update(price, at) }), app.tenant.id],
      );
    }

    const calls = [];
    restore = spy(sync.products, 'applyProduct', (product) => product.variants?.[0]?.pricePaise ?? product.variants?.[0]?.price, calls);
    const worker = createShopifyWebhook(app.ctx, { products: sync.products, connection: sync.connection });
    await Promise.all([sync.webhook.drain(), worker.drain(), sync.webhook.drain(), worker.drain()]);
    await sync.webhook.settle();

    assert.equal(calls.length, 4, `each delivery applied once: ${calls.join(' ')}`);
    assert.deepEqual(calls.filter((c, i) => i % 2 === 1), ['end', 'end'], 'one after the other');
    const rows = await app.db.platform.query(`SELECT event_id, status, attempts FROM provider_webhook_events WHERE provider = 'shopify' AND event_id LIKE 'race-%' ORDER BY id`);
    assert.deepEqual(rows.map((r) => [r.event_id, r.status, r.attempts]), [['race-549.00', 'processed', 1], ['race-599.00', 'processed', 1]]);
    const [row] = await q(app, 'SELECT price_paise FROM products WHERE tenant_id = $1 AND id = $2', [app.tenant.id, link.local_id]);
    assert.equal(Number(row.price_paise), 59900, 'the newer price stands');
  } finally {
    restore();
    await app.close();
  }
});

test('two drainers at once (the web app and the worker) record a WhatsApp STOP once', async () => {
  const app = await alertsApp();
  let restore = () => {};
  try {
    const [{ phone_number_id: phoneNumberId }] = await q(app, 'SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    const webhook = orderAlertsFor(app.ctx).webhook;
    await webhook.settle();
    const phone = '+919811100077';
    await withTenant(app.tenant, () => app.ctx.platform.consent.record({ subject: { phone }, choices: [{ purpose: 'marketing', channel: 'whatsapp', granted: true }], noticeVersion: 1, source: 'account' }));
    await app.db.platform.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('whatsapp', 'managed', 'race-stop', 'messages', $1::jsonb)`,
      [JSON.stringify({ statuses: [], stops: [{ phoneNumberId, from: app.ctx.platform.secrets.encrypt(phone) }] })],
    );

    const calls = [];
    restore = spy(app.ctx.platform.consent, 'revoke', (input) => input.purpose, calls);
    const worker = createWhatsappWebhook(app.ctx);
    await Promise.all([webhook.drain(), worker.drain(), webhook.drain(), worker.drain()]);
    await webhook.settle();

    assert.deepEqual(calls, ['start:marketing', 'end'], 'the STOP is recorded once');
    const [row] = await app.db.platform.query(`SELECT status, attempts FROM provider_webhook_events WHERE provider = 'whatsapp' AND event_id = 'race-stop'`);
    assert.deepEqual([row.status, row.attempts], ['processed', 1]);
    const answer = await withTenant(app.tenant, () => app.ctx.platform.consent.allows({ purpose: 'marketing', channel: 'whatsapp', phone }));
    assert.equal(answer.granted, false);
  } finally {
    restore();
    await app.close();
  }
});
