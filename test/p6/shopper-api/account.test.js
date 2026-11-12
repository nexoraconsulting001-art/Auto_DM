// The shopper's account in the app (PRD 10.7, 9.18, 9.21, 9.22): deleting it through Phase 4's erasure (P-30), rewards in
// the seller's brand (P-66), and a shared profile at a second brand's app (P-70).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppDeletion, AppMe, AppRewards } from '../../../src/contracts/store-routes.js';
import { shopperServices } from '../../../src/modules/shoppers/index.js';
import { advance } from '../../p4/engagement/support.js';
import { placeOrder } from '../../p4/shoppers/support.js';
import { appWorld, assertBrandOnly, guestApp, json, markPaid, orderByNumber, payments, placeBody, product, q, signedInApp } from './support.js';

const PHONE = '9876543210';
const STORE_A = 'default.bhava.test';
const HOME = { name: 'Asha K', phone: PHONE, line1: '12 MG Road', city: 'Pune', stateCode: '27', pincode: '411001' };

/** Moves an order on through the database's own state machine, as payments and shipping would. */
async function deliver(db, orderId) {
  for (const set of [`payment_status = 'paid', fulfilment_status = 'new'`, `fulfilment_status = 'shipped'`, `fulfilment_status = 'delivered'`]) {
    await db.platform.query(`UPDATE orders SET ${set} WHERE id = $1`, [orderId]);
  }
}

async function invoiceFor(db, order) {
  const buyer = { name: order.customer_name, phone: order.phone, address: '12 MG Road, Pune', stateCode: '27' };
  const [inv] = await db.platform.query(
    `INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, seller, buyer, place_of_supply, lines, taxable_paise, total_paise, file_key)
     VALUES ($1, $2, 'bill_of_supply', 0, 0, '', '{"legalName":"Neel Studio"}', $3, '27', '[{"description":"Brass lamp","qty":1}]', $4, $4, $5) RETURNING *`,
    [order.tenant_id, order.id, JSON.stringify(buyer), order.total_paise, `t/${order.tenant_id}/invoices/${order.id}.pdf`],
  );
  return inv;
}

const meOf = async (a) => AppMe.parse((await json(await a.fetch('/api/store/app/me'))).body);

test('P-30: deleting the account in the app erases personal data, masks tax records and ends every session of it', async () => {
  const w = await appWorld();
  try {
    const tid = w.app.tenant.id;
    const a = await signedInApp(w, { phone: PHONE });
    const other = await signedInApp(w, { phone: PHONE, platform: 'ios' });
    const shopperId = (await meOf(a)).shopper.id;
    const del = (app, body = { confirm: true }) => app.fetch('/api/store/app/account/delete', { method: 'POST', body });

    const guest = await guestApp(w);
    assert.equal((await del(guest)).status, 401, 'a guest has no account to delete');
    assert.equal((await del(a, {})).status, 400, 'it needs the shopper’s confirmation');
    assert.equal((await del(a, { confirm: true, shopperId: shopperId + 1 })).status, 400, 'nothing else is taken');

    // An order still on its way: the erasure waits, and the shopper is told so.
    const open = await placeOrder(w.app.db, tid, { shopperId, phone: `+91${PHONE}`, name: 'Asha K', number: 'N-1001' });
    await w.app.db.platform.query(`UPDATE orders SET payment_status = 'paid', fulfilment_status = 'new' WHERE id = $1`, [open.id]);
    const waiting = await json(await del(a));
    assert.equal(waiting.status, 200, waiting.text);
    assert.deepEqual([AppDeletion.parse(waiting.body).status, waiting.body.signedOut], ['waiting', false]);
    assertBrandOnly(waiting.body, 'the waiting answer');
    assert.equal((await meOf(a)).shopper.id, shopperId, 'still signed in while it waits');

    await deliver(w.app.db, open.id);
    const invoice = await invoiceFor(w.app.db, await orderByNumber(w.app, 'N-1001'));
    const done = await json(await del(a));
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([AppDeletion.parse(done.body).status, done.body.signedOut], ['completed', true]);
    assert.match(done.body.message, /Tax records/);
    assertBrandOnly(done.body, 'the deletion answer');

    // Personal data erased; the order and its invoice stay as tax records, with the buyer masked.
    const order = await orderByNumber(w.app, 'N-1001');
    assert.deepEqual([order.customer_name, order.phone, order.address, order.city, order.pincode], ['', '', '', '', '']);
    assert.ok(order.erased_at, 'marked erased');
    assert.deepEqual([order.order_number, Number(order.total_paise)], ['N-1001', 49900], 'the tax record keeps its number and amount');
    assert.deepEqual(order.shipping_address, { stateCode: '27' }, 'only the place of supply stays');
    const [inv] = await q(w.app, 'SELECT buyer, buyer_masked_at, total_paise, file_key FROM invoices WHERE tenant_id = $1 AND id = $2', [tid, invoice.id]);
    assert.deepEqual([inv.buyer.name, inv.buyer.phone, inv.buyer.address, inv.buyer.stateCode, Number(inv.total_paise), inv.file_key], ['', '', '', '27', 49900, '']);
    assert.ok(inv.buyer_masked_at);
    assert.equal((await q(w.app, 'SELECT count(*)::int AS n FROM shoppers WHERE tenant_id = $1 AND id = $2', [tid, shopperId]))[0].n, 0, 'the shopper row is gone');
    const [request] = await q(w.app, `SELECT status, source FROM data_requests WHERE tenant_id = $1 AND kind = 'erasure' ORDER BY id DESC LIMIT 1`, [tid]);
    assert.deepEqual([request.status, request.source], ['completed', 'account']);

    // Every session of the account ended, on both devices, refresh tokens included.
    assert.equal((await a.fetch('/api/store/app/me')).status, 401);
    assert.equal((await a.refresh()).status, 401);
    assert.equal((await other.fetch('/api/store/app/me')).status, 401, 'the other device too');
    assert.equal((await other.refresh()).status, 401);
    const left = await w.app.db.platform.query(`SELECT count(*)::int AS n FROM token_families WHERE tenant_id = $1 AND shopper_id IS NOT NULL`, [tid]);
    assert.equal(left[0].n, 0);
  } finally {
    await w.close();
  }
});

test('P-66: Rewards shows the points balance and a referral link on the business’s own host, in the seller’s brand', async () => {
  const w = await appWorld();
  try {
    const tid = w.app.tenant.id;
    await payments(w.app);
    await w.app.db.platform.query(
      `INSERT INTO loyalty_settings (tenant_id, enabled, earn_points, earn_per_paise, point_value_paise, referral_enabled, referrer_points, expiry_days)
       VALUES ($1, true, 1, 10000, 100, true, 50, 365)`,
      [tid],
    );
    const lamp = await product(w.app, { pricePaise: 100000, stock: 5 });
    const a = await signedInApp(w, { phone: PHONE, host: STORE_A });
    const boot = await json(await a.fetch('/api/store/app/bootstrap'));
    assert.equal(boot.body.features.loyalty, true, 'the app brings rewards at no extra add-on');

    const placed = await json(await a.fetch('/api/store/checkout', { method: 'POST', body: placeBody(lamp.id) }));
    assert.equal(placed.status, 201, placed.text);
    const order = await orderByNumber(w.app, placed.body.orderNumber);
    await markPaid(w.app, order.id);

    let rewards = await json(await a.fetch('/api/store/app/rewards'));
    assert.equal(rewards.status, 200, rewards.text);
    AppRewards.parse(rewards.body);
    assert.deepEqual([rewards.body.enabled, rewards.body.pointsBalance, rewards.body.pendingPoints, rewards.body.valuePaise], [true, 0, 10, 0]);
    assert.deepEqual([rewards.body.history[0].points, rewards.body.history[0].orderNumber], [10, order.order_number]);
    const { code, url, text } = rewards.body.referral;
    assert.ok(code);
    // The business's own address its app opens links for (app_configs.shop_domain), never a platform one.
    assert.equal(url, `https://shop.test/refer/${encodeURIComponent(code)}`, 'the business’s own host');
    assert.match(text, /Neel Studio/, 'in the seller’s words');
    assertBrandOnly(rewards.text, 'rewards');

    // Delivered and past the return window: the points post, and are worth their value.
    await advance(w.app, order.id, ['packed', 'shipped', 'delivered']);
    await q(w.app, `UPDATE loyalty_ledger SET available_at = now() - interval '1 minute' WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [tid, order.id]);
    await w.app.ctx.loyalty.sweep();
    rewards = await json(await a.fetch('/api/store/app/rewards'));
    assert.deepEqual([rewards.body.pointsBalance, rewards.body.pendingPoints, rewards.body.valuePaise], [10, 0, 1000]);
    assert.equal(rewards.body.expiring.points, 10, 'the points that lapse first');

    const guest = await guestApp(w);
    assert.equal((await guest.fetch('/api/store/app/rewards')).status, 401);
    // A business that has not turned rewards on says so, with nothing to show.
    const haldi = await w.addStore('haldi', 'Haldi House');
    const there = await signedInApp(w, { phone: PHONE, tenantId: haldi.tenant.id, host: haldi.host });
    const off = await json(await there.fetch('/api/store/app/rewards'));
    assert.deepEqual([off.status, off.body.enabled, off.body.referral], [200, false, null]);
  } finally {
    await w.close();
  }
});

test('P-70: a shared-profile shopper signs in at a second brand’s app: saved addresses offered after consent, only that brand’s orders', async () => {
  const w = await appWorld({ google: false });
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    const { shared } = shopperServices(w.app.ctx);
    assert.ok(shared.available, 'the platform can hold shared profiles');

    // At brand A: Asha saves an address and says yes to using her details at other stores. Ravi never does.
    const asha = await signedInApp(w, { phone: PHONE, host: STORE_A });
    const ashaId = (await meOf(asha)).shopper.id;
    assert.equal((await json(await asha.fetch('/api/store/addresses', { method: 'POST', body: HOME }))).status, 201);
    const notice = await shared.notice();
    const yes = await json(await asha.fetch('/api/store/shared-profile', { method: 'POST', body: { noticeVersion: notice.version, agree: true } }));
    assert.equal(yes.status, 201, yes.text);
    const ravi = await signedInApp(w, { phone: '9811111111', host: STORE_A });
    assert.equal((await json(await ravi.fetch('/api/store/addresses', { method: 'POST', body: { ...HOME, name: 'Ravi M', phone: '9811111111', line1: '4 Hill Road' } }))).status, 201);
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: ashaId, phone: `+91${PHONE}`, name: 'Asha K', number: 'A-7001' });

    // At brand B's app: the same WhatsApp-verified phone, no new sign-up. Her saved address is offered; A's order is not hers here.
    const there = await signedInApp(w, { phone: PHONE, tenantId: leaf.tenant.id, host: leaf.host });
    const me = await meOf(there);
    assert.equal((await q(w.app, 'SELECT count(*)::int AS n FROM shoppers WHERE tenant_id = $1 AND id = $2', [leaf.tenant.id, me.shopper.id], leaf.tenant))[0].n, 1, 'a shopper row of B’s own');
    assert.deepEqual(me.sharedProfile, { available: true, linked: true, consented: true });
    const offered = await json(await there.fetch('/api/store/addresses'));
    assert.equal(offered.status, 200, offered.text);
    assert.deepEqual(offered.body.items.map((x) => [x.line1, x.pincode, Boolean(x.shared)]), [['12 MG Road', '411001', true]], 'the saved address is offered at B');
    const orders = await json(await there.fetch('/api/store/app/orders'));
    assert.deepEqual([orders.status, orders.body.items], [200, []], 'no order from brand A');
    assert.equal((await there.fetch('/api/store/app/orders/A-7001')).status, 404);
    assert.equal((await there.fetch('/api/store/app/orders/A-7001/reorder', { method: 'POST' })).status, 404);
    assertBrandOnly(orders.text, 'B’s orders');

    // She orders at B: B's app shows that order only, and A's app still shows only A's.
    await payments(w.app, { tenant: leaf.tenant });
    const pot = await product(w.app, { name: 'Leaf pot', pricePaise: 20000, stock: 5, tenant: leaf.tenant });
    const placed = await json(await there.fetch('/api/store/checkout', { method: 'POST', body: placeBody(pot.id, { address: { ...HOME } }) }));
    assert.equal(placed.status, 201, placed.text);
    assert.deepEqual((await json(await there.fetch('/api/store/app/orders'))).body.items.map((o) => o.orderNumber), [placed.body.orderNumber]);
    assert.deepEqual((await json(await asha.fetch('/api/store/app/orders'))).body.items.map((o) => o.orderNumber), ['A-7001']);

    // Ravi said no at A: at B nothing of his is offered, and nothing is linked.
    const raviThere = await signedInApp(w, { phone: '9811111111', tenantId: leaf.tenant.id, host: leaf.host });
    assert.deepEqual((await json(await raviThere.fetch('/api/store/addresses'))).body.items, []);
    assert.deepEqual((await meOf(raviThere)).sharedProfile, { available: true, linked: false, consented: false });
  } finally {
    await w.close();
  }
});
