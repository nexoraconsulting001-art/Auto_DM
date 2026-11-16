// money-8: the balance of a part-advance order is collected at the door, so the store's door limits (the order cap, the COD
// PIN codes, the RTO block) hold for part-advance exactly as for cash on delivery, in the quote and when placing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, markPaid, orderByNumber, payments, place, placeBody, product, q, quote, storeApp } from '../../p4/checkout/support.js';

const modeOf = (res, mode) => res.json.paymentModes.find((m) => m.mode === mode);

test('money-8: part-advance is refused above the COD cap, with the reason, and placing it that way is refused', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, codMaxPaise: 200000, partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
    const tv = await product(app, { pricePaise: 250000, stock: 3 });
    const seen = await quote(app, { lines: [{ productId: tv.id, variantId: null, qty: 1 }], address: { ...ADDRESS }, paymentMode: 'part_advance' });
    assert.equal(modeOf(seen, 'part_advance').available, false);
    assert.match(modeOf(seen, 'part_advance').reason, /up to ₹2,000/);
    assert.equal(modeOf(seen, 'prepaid').available, true);
    const res = await place(app, placeBody(tv.id, { paymentMode: 'part_advance' }));
    assert.equal(res.status, 409, res.text);
  } finally {
    app.close();
  }
});

test('money-8: part-advance is refused at a PIN code where the door collects nothing, and for a number with repeated RTOs', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
    await q(app, `UPDATE payment_settings SET cod_pincodes = ARRAY['560001']::text[] WHERE tenant_id = $1`, [app.tenant.id]);
    const lamp = await product(app, { pricePaise: 99900, stock: 5 });
    const lines = [{ productId: lamp.id, variantId: null, qty: 1 }];
    let seen = await quote(app, { lines, address: { ...ADDRESS }, paymentMode: 'part_advance' });
    assert.equal(modeOf(seen, 'part_advance').available, false, 'Pune is not a COD PIN for this store');
    assert.match(modeOf(seen, 'part_advance').reason, /PIN code/);
    assert.equal((await place(app, placeBody(lamp.id, { paymentMode: 'part_advance' }))).status, 409);

    // Every PIN again; this number has had two parcels sent back (one still on its way back).
    await q(app, `UPDATE payment_settings SET cod_pincodes = '{}'::text[], cod_block_rto_count = 2 WHERE tenant_id = $1`, [app.tenant.id]);
    const first = await place(app, placeBody(lamp.id, { paymentMode: 'prepaid' }));
    const second = await place(app, placeBody(lamp.id, { paymentMode: 'prepaid' }));
    assert.equal(first.status, 201, first.text);
    const walk = async (number, steps) => {
      await markPaid(app, (await orderByNumber(app, number)).id);
      for (const to of steps) await q(app, `UPDATE orders SET fulfilment_status = $3 WHERE tenant_id = $1 AND order_number = $2`, [app.tenant.id, number, to]);
    };
    await walk(first.json.orderNumber, ['shipped', 'rto_initiated', 'rto_delivered']);
    await walk(second.json.orderNumber, ['shipped', 'rto_initiated']);
    seen = await quote(app, { lines, address: { ...ADDRESS }, paymentMode: 'part_advance' });
    assert.equal(modeOf(seen, 'cod').available, false, 'COD is blocked for this number');
    assert.equal(modeOf(seen, 'part_advance').available, false, 'and so is a balance at the door');
    assert.equal((await place(app, placeBody(lamp.id, { paymentMode: 'part_advance' }))).status, 409);
  } finally {
    app.close();
  }
});
