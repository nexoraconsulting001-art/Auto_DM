// money-8 (the same cause, the other rule the quote kept for itself): what checkout offers comes from one rule set with
// payments.settings.checkout. That includes the plan: online payment is the store.payments feature, so a store without it
// is offered neither prepaid nor part-advance, and an order is never placed to be paid in a way payments.start refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, payments, place, placeBody, product, quote, storeApp } from '../../p4/checkout/support.js';

const modeOf = (res, mode) => res.json.paymentModes.find((m) => m.mode === mode);
const featureOff = (app, feature) => app.db.platform.query(
  `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, false, NULL) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = false`,
  [app.tenant.id, feature],
);

test('money-8: a store without online payments on its plan is offered neither prepaid nor part-advance, and such an order is refused', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
    const lamp = await product(app, { pricePaise: 99900, stock: 5 });
    const lines = [{ productId: lamp.id, variantId: null, qty: 1 }];
    let seen = await quote(app, { lines, address: { ...ADDRESS }, paymentMode: 'prepaid' });
    assert.equal(modeOf(seen, 'prepaid').available, true, 'with the feature, online payment is offered');

    await featureOff(app, 'store.payments');
    const payments2 = await app.db.platform.query('SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1', [app.tenant.id]);
    seen = await quote(app, { lines, address: { ...ADDRESS }, paymentMode: 'prepaid' });
    assert.equal(modeOf(seen, 'prepaid').available, false, 'online payment is not on the plan');
    assert.equal(modeOf(seen, 'part_advance').available, false, 'nor is an advance paid online');
    assert.equal(modeOf(seen, 'cod').available, true, 'cash on delivery still is');
    for (const paymentMode of ['prepaid', 'part_advance']) {
      const res = await place(app, placeBody(lamp.id, { paymentMode }));
      assert.equal(res.status, 409, `${paymentMode}: ${res.text}`);
    }
    const orders = await app.db.platform.query('SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(orders[0].n, 0, 'no order is left waiting for a payment that can never be taken');
    assert.equal((await app.db.platform.query('SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1', [app.tenant.id]))[0].n, payments2[0].n);
    // Cash on delivery goes on to its next step (placed, or the phone code first): it is not refused.
    const cod = await place(app, placeBody(lamp.id, { paymentMode: 'cod' }));
    assert.ok([200, 201].includes(cod.status), cod.text);
  } finally {
    app.close();
  }
});
