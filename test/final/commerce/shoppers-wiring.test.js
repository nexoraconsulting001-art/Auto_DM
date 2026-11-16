// D-1 (final review): checkout reaches the shoppers module through ctx.shoppers (PRD 9.3, 9.4, 9.5). Nothing here stubs it:
// the real service must be wired in by the shoppers module's own setup, in the web app and in the worker alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shoppers as shoppersModule } from '../../../src/modules/shoppers/index.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { ADDRESS, inTenant, orderByNumber, payments, place, placeBody, product, q, setPlan, shopper } from '../../p4/checkout/support.js';
import { world } from '../../p4/shoppers/support.js';

async function storeWorld() {
  const w = await world({ google: false });
  await setPlan(w.app, w.app.tenant.id, 't3');
  await inTenant(w.app, () => w.app.platform.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: 'Neel Studio' }));
  return w;
}

const post = (w, path, json) => fetch(`${w.app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });

test('D-1: the shoppers module publishes its service on ctx in setup, so the web app and the worker both have it', async () => {
  const w = await storeWorld();
  try {
    assert.equal(typeof w.app.ctx.shoppers?.otps?.codVerified, 'function', 'The web app has no ctx.shoppers.otps.codVerified');
    assert.equal(typeof w.app.ctx.shoppers?.addresses?.create, 'function', 'The web app has no ctx.shoppers.addresses.create');
    // The worker builds its own context and runs the same setup (src/worker.js registerJobs).
    const { shoppers: _ignored, orderEvents: _bus, ...rest } = w.app.ctx;
    const jobContext = { ...rest };
    shoppersModule.setup(jobContext);
    assert.equal(typeof jobContext.shoppers?.otps?.codVerified, 'function', 'A worker context has no ctx.shoppers after setup');
  } finally {
    await w.close();
  }
});

test('D-1 / S-94: a guest cash-on-delivery order is placed after the real COD code, with nothing stubbed', async () => {
  const w = await storeWorld();
  try {
    await payments(w.app, { cod: true });
    const lamp = await product(w.app, { stock: 3 });
    const body = placeBody(lamp.id, { paymentMode: 'cod' });
    const first = await place(w.app, body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.next, 'verify_phone');
    const sent = await post(w, '/api/store/otp/send', { phone: ADDRESS.phone, purpose: 'cod', checkoutKey: body.idempotencyKey });
    assert.equal(sent.status, 200, await sent.text());
    const code = await w.lastCode(ADDRESS.phone);
    assert.ok(code, 'No COD code reached the WhatsApp simulator');
    const verified = await post(w, '/api/store/otp/verify', { phone: ADDRESS.phone, purpose: 'cod', code, checkoutKey: body.idempotencyKey });
    assert.equal(verified.status, 200, await verified.text());
    const second = await place(w.app, body);
    assert.equal(second.status, 201, second.text);
    assert.equal(second.json.next, 'done', 'A guest who entered the right COD code was asked to verify again');
    const order = await orderByNumber(w.app, second.json.orderNumber);
    assert.deepEqual([order.payment_mode, order.payment_status], ['cod', 'cod_due']);
  } finally {
    await w.close();
  }
});

test('D-1: "save my details" at checkout saves the address to the signed-in shopper', async () => {
  const w = await storeWorld();
  try {
    await payments(w.app);
    const lamp = await product(w.app, { stock: 3 });
    const asha = await shopper(w.app);
    // A signed-in shopper's checkout carries the page's CSRF token, as the checkout page sends it.
    const signedIn = { cookie: asha.cookie, headers: { 'x-shopper-csrf': csrfFor(w.app.config, asha.cookie.split('=')[1]) } };
    const before = await q(w.app, 'SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [w.app.tenant.id, asha.id]);
    assert.equal(before[0].n, 0);
    const res = await place(w.app, placeBody(lamp.id, { saveDetails: true, address: { ...ADDRESS, line1: '7 Temple Street' } }), signedIn);
    assert.equal(res.status, 201, res.text);
    const rows = await q(w.app, 'SELECT line1, pincode FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [w.app.tenant.id, asha.id]);
    assert.deepEqual(rows.map((r) => [r.line1, r.pincode]), [['7 Temple Street', ADDRESS.pincode]], 'The address the shopper asked to save was not saved');
    // Without the tick nothing is saved.
    const plain = await place(w.app, placeBody(lamp.id, { address: { ...ADDRESS, line1: '9 Other Road' } }), signedIn);
    assert.equal(plain.status, 201, plain.text);
    const after = await q(w.app, 'SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [w.app.tenant.id, asha.id]);
    assert.equal(after[0].n, 1);
  } finally {
    await w.close();
  }
});
