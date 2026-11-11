// PRD 9.21: referrals. Each shopper has a direct link; a friend's first order through it earns the referrer points once it is
// delivered and its return window closes. Self-referral by the same phone, device or address is kept as blocked with its
// reason and earns nothing (S-90); a loop (A brings B, then B brings A) is refused; a friend is referred once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, accountOf, advance, as, consoleApi, eventually, hit, ledgerOf, loyaltyOn, markPaid, orderByNumber, payments, place, placeBody, product, rows, signedIn, storeApp, textOf, noPlatformName } from './support.js';

const referralsOf = (app) => rows(app, 'SELECT * FROM referrals WHERE tenant_id = $1 ORDER BY id', [app.tenant.id]);
const windowPassed = (app, orderId) => rows(app, `UPDATE loyalty_ledger SET available_at = now() - interval '1 minute' WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [app.tenant.id, orderId]);

async function world() {
  const app = await storeApp();
  await payments(app);
  await loyaltyOn(app, { referralEnabled: true, referrerPoints: 100, friendRewardPaise: 10000 });
  return app;
}

/** The referrer's code, read off their points page as a shopper would copy it. */
async function codeOf(app, who) {
  const page = await hit(app, '/account/points', as(who));
  assert.equal(page.status, 200, page.text);
  const code = /\/refer\/([A-Z0-9]{6,12})/.exec(page.text)?.[1];
  assert.ok(code, 'the points page has no invite link');
  return { code, page };
}

/** Places, pays and (unless `deliver` is false) delivers an order as `who`, sending `cookie` as their browser would. */
async function friendOrder(app, who, productId, { cookie = '', body = {}, deliver = true } = {}) {
  const options = as(who);
  if (cookie) options.cookie = `${options.cookie}; ${cookie}`;
  const res = await place(app, placeBody(productId, body), options);
  assert.equal(res.status, 201, res.text);
  const order = await orderByNumber(app, res.json.orderNumber);
  await markPaid(app, order.id);
  if (deliver) await advance(app, order.id, ['packed', 'shipped', 'delivered']);
  return order;
}

test('a shopper’s link is direct and on the store’s own address; it remembers the friend’s browser; an unknown code goes home', async () => {
  const app = await world();
  try {
    const asha = await signedIn(app);
    const { code, page } = await codeOf(app, asha);
    assert.match(page.text, new RegExp(`https?://[^/"]+/refer/${code}`), 'the link is not a direct link on the store');
    assert.ok(noPlatformName(page.text));
    assert.equal((await codeOf(app, asha)).code, code, 'the code changed');
    assert.match(String(page.headers['set-cookie']), /_refdev=/, 'the referrer’s own browser is not marked');

    const landing = await hit(app, `/refer/${code.toLowerCase()}`);
    assert.equal(landing.status, 200);
    assert.match(String(landing.headers['set-cookie']), new RegExp(`_ref=${code};`));
    assert.match(textOf(landing.text), /A friend invited you/);
    assert.ok(noPlatformName(landing.text));
    for (const bad of ['NOPE1234', 'x', '<script>', '../../etc']) {
      const res = await hit(app, `/refer/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 303, bad);
      assert.equal(res.headers.location, '/');
    }
    const own = await hit(app, `/refer/${code}`, as(asha));
    assert.match(textOf(own.text), /your own invite link/);
    const api = await consoleApi(app);
    await api('PATCH', '/loyalty/settings', { referralEnabled: false });
    assert.equal((await hit(app, `/refer/${code}`)).status, 303, 'a link works after referrals were turned off');
    assert.doesNotMatch((await hit(app, '/account/points', as(asha))).text, /\/refer\//);
  } finally {
    app.close();
  }
});

test('a friend’s first order through the link earns the referrer points once it is delivered and its window closes', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    const { code } = await codeOf(app, asha);
    const ravi = await signedIn(app, { phone: '+919000011111', name: 'Ravi K' });
    const order = await friendOrder(app, ravi, lamp.id, { cookie: `_ref=${code}`, body: { address: { ...ADDRESS, line1: '7 Hill View', pincode: '560001', phone: ravi.phone } } });
    const [ref] = await eventually(async () => (await referralsOf(app)).length && referralsOf(app));
    assert.deepEqual([ref.status, ref.block_reason, ref.referrer_shopper_id, ref.friend_shopper_id, ref.order_id, Number(ref.friend_reward_paise)], ['pending', '', asha.id, ravi.id, order.id, 0]);
    assert.equal(ref.friend_key.length, 64);
    assert.ok(!ref.friend_key.includes('9000011111'), 'the friend’s number is copied');

    const credit = (await ledgerOf(app, asha.id)).find((e) => e.kind === 'referral');
    assert.deepEqual([credit.points, credit.status, credit.order_id], [100, 'pending', order.id]);
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 100 });
    await windowPassed(app, order.id);
    await app.ctx.loyalty.sweep();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 100, pending: 0 });
    assert.equal((await referralsOf(app))[0].status, 'rewarded');
    // The friend earned on their own order too, separately.
    assert.equal((await ledgerOf(app, ravi.id)).find((e) => e.kind === 'earn').points, 10);

    // A friend is referred once: a second order through the link records nothing more.
    await friendOrder(app, ravi, lamp.id, { body: { referralCode: code, address: { ...ADDRESS, line1: '7 Hill View', pincode: '560001', phone: ravi.phone } } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await referralsOf(app)).length, 1);
    const listed = await (await consoleApi(app))('GET', '/loyalty/referrals');
    assert.deepEqual(listed.json.items.map((r) => [r.referrerShopperId, r.status]), [[asha.id, 'rewarded']]);
    assert.doesNotMatch(listed.text, /friend|phone|9000011111/i);
  } finally {
    app.close();
  }
});

test('S-90: a second number at the referrer’s address is blocked, and so are the same phone, the same browser and a returning buyer', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { pricePaise: 100000, stock: 20 });
    const asha = await signedIn(app);
    const added = await hit(app, '/api/store/addresses', { method: 'POST', body: { name: 'Asha Rao', phone: asha.phone, line1: '12 Lake Road', line2: 'Flat 3', city: 'Pune', stateCode: '27', pincode: '411001', isDefault: true }, ...as(asha) });
    assert.ok(added.status < 300, added.text);
    const { code, page } = await codeOf(app, asha);
    const device = /_refdev=([^;]+)/.exec(String(page.headers['set-cookie']))?.[1];

    // The same address, written another way, by another name and number.
    const meera = await signedIn(app, { phone: '+919000022222', name: 'Meera' });
    const q = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], referralCode: code }, ...as(meera) });
    assert.equal(q.json.discountPaise + q.json.loyaltyPaise, 0, 'a reward was given at the quote');
    const sameDoor = await friendOrder(app, meera, lamp.id, { body: { referralCode: code, address: { ...ADDRESS, name: 'Another Name', line1: '12, Lake Road', phone: meera.phone } } });
    // The same phone as the referrer, as a guest.
    const guestRes = await place(app, placeBody(lamp.id, { referralCode: code, address: { ...ADDRESS, line1: '1 Far Away Street', pincode: '110001', stateCode: '07', city: 'Delhi', phone: asha.phone } }));
    assert.equal(guestRes.status, 201, guestRes.text);
    // The referrer's own browser, signed in as someone else.
    const nikhil = await signedIn(app, { phone: '+919000033333', name: 'Nikhil' });
    await friendOrder(app, nikhil, lamp.id, { cookie: `_ref=${code}; _refdev=${device}`, body: { address: { ...ADDRESS, line1: '9 Market Lane', pincode: '400001', stateCode: '27', city: 'Mumbai', phone: nikhil.phone } } });
    // Someone who had ordered here before.
    const old = await signedIn(app, { phone: '+919000044444', name: 'Old Buyer' });
    await friendOrder(app, old, lamp.id, { body: { address: { ...ADDRESS, line1: '3 River Road', pincode: '600001', stateCode: '33', city: 'Chennai', phone: old.phone } } });
    await friendOrder(app, old, lamp.id, { body: { referralCode: code, address: { ...ADDRESS, line1: '3 River Road', pincode: '600001', stateCode: '33', city: 'Chennai', phone: old.phone } } });

    const refs = await eventually(async () => {
      const list = await referralsOf(app);
      return list.length === 4 && list;
    });
    assert.ok(refs, `expected four referrals, got ${(await referralsOf(app)).length}`);
    const byOrder = new Map(refs.map((r) => [r.order_id, r]));
    assert.deepEqual([byOrder.get(sameDoor.id).status, byOrder.get(sameDoor.id).block_reason], ['blocked', 'same_address']);
    assert.deepEqual(refs.map((r) => r.block_reason).sort(), ['not_first_order', 'same_address', 'same_device', 'same_phone']);
    assert.ok(refs.every((r) => r.status === 'blocked' && Number(r.friend_reward_paise) === 0));
    for (const r of refs) await windowPassed(app, r.order_id);
    await app.ctx.loyalty.sweep();
    assert.deepEqual((await ledgerOf(app, asha.id)).filter((e) => e.kind === 'referral'), [], 'the referrer was rewarded for a self-referral');
    assert.equal((await accountOf(app, asha.id))?.balance ?? 0, 0);
  } finally {
    app.close();
  }
});

test('a referral loop is refused, and a friend’s cancelled first order earns its referrer nothing', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { pricePaise: 100000, stock: 20 });
    const asha = await signedIn(app);
    const ravi = await signedIn(app, { phone: '+919000011111', name: 'Ravi' });
    const { code: ashaCode } = await codeOf(app, asha);
    const { code: raviCode } = await codeOf(app, ravi);

    // Asha brings Ravi; then Ravi would bring Asha.
    await friendOrder(app, ravi, lamp.id, { deliver: false, body: { referralCode: ashaCode, address: { ...ADDRESS, line1: '7 Hill View', pincode: '560001', stateCode: '29', city: 'Bengaluru', phone: ravi.phone } } });
    await eventually(async () => (await referralsOf(app)).length === 1);
    await friendOrder(app, asha, lamp.id, { deliver: false, body: { referralCode: raviCode, address: { ...ADDRESS, line1: '5 Sea Face', pincode: '400050', phone: asha.phone } } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refs = await referralsOf(app);
    assert.deepEqual(refs.map((r) => [r.referrer_shopper_id, r.friend_shopper_id, r.status]), [[asha.id, ravi.id, 'pending']], 'the loop was recorded');

    // Ravi's order is cancelled before delivery: the referral is void, and nothing is due to Asha.
    const { changeOrder } = await import('../../../src/modules/orders/state.js');
    const { withTenant } = await import('../../../src/tenancy.js');
    await withTenant(app.tenant, () => app.db.tx((t) => changeOrder(t, refs[0].order_id, { fulfilment: 'cancelled', cancelReason: 'seller', actor: 'user:1' })));
    await app.ctx.orderEvents.settle();
    assert.equal((await referralsOf(app))[0].status, 'void');
    assert.deepEqual((await ledgerOf(app, asha.id)).filter((e) => e.kind === 'referral'), []);
  } finally {
    app.close();
  }
});
