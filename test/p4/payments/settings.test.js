// Payment settings (PRD 9.6): the ways to pay the owner turns on, cash on delivery's rules, part-advance, and who may change
// what. checkout() is what the checkout track's quote shows the shopper, with the reason for anything hidden (S-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { advanceSplit } from '../../../src/modules/payments/settings.js';
import { openWorld } from './support.js';

const modes = (quote) => Object.fromEntries(quote.paymentModes.map((m) => [m.mode, m.available ? 'yes' : m.reason]));

test('options are saved, checked and audited; managers may change them but only the owner connects an account', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const first = (await shop.api('GET', '/payment-settings')).json;
  assert.deepEqual([first.upi, first.card, first.netbanking, first.wallet, first.cod, first.partAdvance], [true, true, true, true, false, false]);
  const saved = await shop.api('PATCH', '/payment-settings', { cod: true, codFeePaise: 4900, codMaxOrderPaise: 500000, codPincodes: ['411001', '411001', '560001'], wallet: false });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.codPincodes, ['411001', '560001']);
  assert.equal(saved.json.wallet, false);
  assert.equal((await shop.api('PATCH', '/payment-settings', { codPincodes: ['011001'] })).status, 400, 'S-12: a PIN starting with 0');
  assert.equal((await shop.api('PATCH', '/payment-settings', { partAdvance: true, advanceKind: 'percent', advanceValue: 9950 })).status, 400);
  assert.equal((await shop.api('PATCH', '/payment-settings', { partAdvance: true, advanceKind: 'fixed', advanceValue: 50 })).status, 400);
  assert.equal((await shop.api('PATCH', '/payment-settings', { codFeePaise: -1 })).status, 400);
  const audit = await shop.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'payment_settings.change'`, [shop.tenant.id]);
  assert.equal(audit.length, 1);

  const manager = await shop.member('manager', '9000000006');
  assert.equal((await shop.api('PATCH', '/payment-settings', { upi: false }, { as: manager.token })).status, 200);
  assert.equal((await shop.api('POST', '/payment-account/linked', { legalName: 'X Traders', contactName: 'X', email: 'x@seller.example', phone: '+919811100000', businessType: 'other' }, { as: manager.token })).status, 403);
  assert.equal((await shop.api('PUT', '/payment-account/mode', { mode: 'own' }, { as: manager.token })).status, 403);
  const staff = await shop.member('staff', '9000000007');
  assert.equal((await shop.api('GET', '/payment-settings', undefined, { as: staff.token })).status, 403);
  // Own mode needs an account first.
  assert.equal((await shop.api('PUT', '/payment-account/mode', { mode: 'own' })).status, 409);
});

test('a business whose plan has no online payments cannot start them', async (t) => {
  const world = await openWorld(t, { plan: 't2' });
  const { shop } = world;
  const res = await shop.api('POST', '/payment-account/linked', { legalName: 'X Traders', contactName: 'X', email: 'x@seller.example', phone: '+919811100000', businessType: 'other' });
  assert.equal(res.status, 403);
  assert.equal((await shop.api('POST', '/payment-account/connect')).status, 403);
});

test('S-21, S-22: cash on delivery is hidden above the cap with the reason; part-advance splits the advance and the balance', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  await shop.api('PATCH', '/payment-settings', { cod: true, codMaxOrderPaise: 200000, codFeePaise: 4900, partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  const quote = (orderPaise, extra = {}) => shop.run((p) => p.settings.checkout({ orderPaise, pincode: '411001', ...extra }));

  const small = await quote(99900);
  assert.deepEqual(modes(small), { prepaid: 'yes', cod: 'yes', part_advance: 'yes' });
  assert.deepEqual(small.advance, { advancePaise: 10000, balancePaise: 89900 }, 'S-21: ₹100 now, ₹899 at the door');
  assert.equal(small.codFeePaise, 4900);

  const big = await quote(250000);
  assert.equal(modes(big).prepaid, 'yes');
  assert.equal(modes(big).cod, 'Cash on delivery is available on orders up to ₹2,000.');
  assert.equal(modes(big).part_advance, 'Cash on delivery is available on orders up to ₹2,000.', 'the balance is cash at the door too');
  assert.equal(big.advance, null);

  await shop.api('PATCH', '/payment-settings', { codPincodes: ['560001'] });
  assert.equal(modes(await quote(50000)).cod, 'Cash on delivery isn’t available at this PIN code.');
  await shop.api('PATCH', '/payment-settings', { codPincodes: [], advanceKind: 'percent', advanceValue: 2500 });
  assert.deepEqual((await quote(80000)).advance, { advancePaise: 20000, balancePaise: 60000 });
  assert.equal(advanceSplit({ advanceKind: 'fixed', advanceValue: 10000 }, 10000), null, 'nothing would be left for the door');
});

test('cash on delivery is refused to a number with repeated returns to origin, as a reason only', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.api('PATCH', '/payment-settings', { cod: true, codBlockRtoCount: 2 });
  const phone = '+919811122233';
  for (let i = 0; i < 2; i++) {
    const order = await shop.placeOrder({ mode: 'cod', phone });
    await shop.inTenant(() => world.db.tx(async (tx) => {
      await changeOrder(tx, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper' });
      await changeOrder(tx, order.id, { fulfilment: 'shipped', actor: 'user:1' });
      await changeOrder(tx, order.id, { fulfilment: 'rto_initiated', actor: 'webhook:courier' });
    }));
  }
  const blocked = await shop.run((p) => p.settings.checkout({ orderPaise: 50000, pincode: '411001', phone }));
  assert.equal(modes(blocked).cod, 'Cash on delivery isn’t available for this order. Please pay online.');
  assert.equal(modes(await shop.run((p) => p.settings.checkout({ orderPaise: 50000, pincode: '411001', phone: '+919811100099' }))).cod, 'yes');
});

test('cash on delivery cancelled or returned leaves nothing to collect', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ mode: 'cod', totalPaise: 40000 });
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper' })));
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', cancelReason: 'shopper', actor: 'shopper' })));
  await world.settle();
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'voided');
  assert.equal((await shop.payments(order.id)).length, 0);
  assert.equal((await shop.refunds(order.id)).length, 0);
});
