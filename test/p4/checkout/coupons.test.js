// Coupons (PRD 9.14): percentage with a cap, flat and free delivery, limits on dates, minimum, uses, uses per customer,
// scope and first order, checked at checkout and again inside the order, and never past a limit under parallel use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, hit, orderByNumber, otherStore, ownerToken, payments, place, placeBody, product, q, quote, storeApp } from './support.js';

const api = (app, token, path, { method = 'GET', body, host } = {}) => hit(app, `/api/v1${path}`, { method, token, body, host });
const phone = (n) => `98765${String(n).padStart(5, '0')}`;

test('S-45 REEL10 (10%, cap ₹150) on ₹2,000 takes ₹150 off, whatever case it is typed in', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const token = await ownerToken(app);
    const made = await api(app, token, '/coupons', { method: 'POST', body: { code: 'reel10', kind: 'percent', percentBp: 1000, maxDiscountPaise: 15000 } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.code, 'REEL10');
    const kurta = await product(app, { pricePaise: 200000, stock: 5 });
    const seen = await quote(app, { lines: [{ productId: kurta.id, variantId: null, qty: 1 }], couponCode: 'Reel10' });
    assert.deepEqual([seen.json.discountPaise, seen.json.totalPaise, seen.json.coupon.applied], [15000, 185000, true]);
    const check = await hit(app, '/api/store/coupons/check', { method: 'POST', body: { code: 'reel10', lines: [{ productId: kurta.id, variantId: null, qty: 1 }] } });
    assert.deepEqual([check.json.applied, check.json.discountPaise], [true, 15000]);
    const res = await place(app, placeBody(kurta.id, { couponCode: 'REEL10' }));
    assert.equal(res.status, 201, res.text);
    assert.equal(Number((await orderByNumber(app, res.json.orderNumber)).discount_paise), 15000);
    const stats = await api(app, token, `/coupons/${made.json.id}/stats`);
    assert.deepEqual(stats.json, { couponId: made.json.id, orders: 1, discountPaise: 15000, revenuePaise: 185000 });
  } finally {
    app.close();
  }
});

test('S-46 a per-customer limit of 1 holds for a guest by phone: the second use is refused', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, amount_paise, max_uses_per_customer) VALUES ($1, 'FIRST50', 'flat', 5000, 1)`, [app.tenant.id]);
    const lamp = await product(app, { stock: 5 });
    const first = await place(app, placeBody(lamp.id, { couponCode: 'first50' }));
    assert.equal(first.status, 201, first.text);
    const again = await place(app, placeBody(lamp.id, { couponCode: 'FIRST50', address: { ...ADDRESS, phone: '+91 98765 43210' } }));
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already used this code/);
    const someoneElse = await place(app, placeBody(lamp.id, { couponCode: 'FIRST50', address: { ...ADDRESS, phone: '9123456789' } }));
    assert.equal(someoneElse.status, 201, someoneElse.text);
    // A cancelled order's use stops counting.
    const token = await ownerToken(app);
    const order = await orderByNumber(app, first.json.orderNumber);
    assert.equal((await api(app, token, `/orders/${order.id}/cancel`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await place(app, placeBody(lamp.id, { couponCode: 'FIRST50' }))).status, 201);
    const [{ used_count: used }] = await q(app, `SELECT used_count FROM coupons WHERE tenant_id = $1 AND code = 'FIRST50'`, [app.tenant.id]);
    assert.equal(used, 2);
  } finally {
    app.close();
  }
});

test('S-47 a total limit reached during simultaneous checkouts: only the allowed number of orders get the discount', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, percent_bp, max_uses) VALUES ($1, 'FLASH', 'percent', 2000, 2)`, [app.tenant.id]);
    const lamp = await product(app, { stock: null });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => place(app, placeBody(lamp.id, { couponCode: 'FLASH', address: { ...ADDRESS, phone: phone(i) } }))));
    const placed = results.filter((r) => r.status === 201);
    assert.equal(placed.length, 2, results.map((r) => `${r.status} ${r.json?.error ?? ''}`).join(' | '));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && /used up/.test(r.json.error)));
    const discounted = await q(app, `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND coupon_code = 'FLASH'`, [app.tenant.id]);
    assert.equal(discounted[0].n, 2);
    const [{ used_count: used }] = await q(app, `SELECT used_count FROM coupons WHERE tenant_id = $1 AND code = 'FLASH'`, [app.tenant.id]);
    assert.equal(used, 2);
    const overflow = await q(app, `UPDATE coupons SET used_count = 3 WHERE tenant_id = $1 AND code = 'FLASH'`, [app.tenant.id]).then(() => 'allowed', (err) => err.code);
    assert.equal(overflow, '23514', 'the database refuses a count past the limit');
  } finally {
    app.close();
  }
});

test('coupon limits: dates, minimum order, scope, first order only and free delivery', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const { withTenant } = await import('../../../src/tenancy.js');
    await withTenant(app.tenant, () => app.platform.settings.update({ shipping_fee_paise: '4900', free_shipping_above_paise: '0' }));
    const lamp = await product(app, { pricePaise: 50000, stock: null });
    const pot = await product(app, { name: 'Clay pot', pricePaise: 30000, stock: null });
    const token = await ownerToken(app);
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const make = (body) => api(app, token, '/coupons', { method: 'POST', body });
    assert.equal((await make({ code: 'LATER', kind: 'flat', amountPaise: 1000, startsAt: soon })).status, 201);
    assert.equal((await make({ code: 'BIG', kind: 'flat', amountPaise: 1000, minOrderPaise: 100000 })).status, 201);
    assert.equal((await make({ code: 'LAMPS', kind: 'percent', percentBp: 5000, scope: 'products', scopeIds: [lamp.id] })).status, 201);
    assert.equal((await make({ code: 'NEWBIE', kind: 'flat', amountPaise: 2000, firstOrderOnly: true })).status, 201);
    assert.equal((await make({ code: 'SHIPFREE', kind: 'free_shipping' })).status, 201);
    const both = [{ productId: lamp.id, variantId: null, qty: 1 }, { productId: pot.id, variantId: null, qty: 1 }];
    const tryCode = async (code, lines = both, address = ADDRESS) => (await quote(app, { lines, couponCode: code, address })).json;

    assert.match((await tryCode('LATER')).coupon.message, /isn’t active yet/);
    assert.match((await tryCode('BIG')).coupon.message, /Add ₹200 more/);
    assert.match((await tryCode('NOPE')).coupon.message, /isn’t valid/);
    const lamps = await tryCode('LAMPS');
    assert.deepEqual([lamps.discountPaise, lamps.lines.map((l) => l.linePaise)], [25000, [50000, 30000]], 'half off the lamp only');
    assert.match((await tryCode('LAMPS', [both[1]])).coupon.message, /doesn’t apply/);
    const free = await tryCode('SHIPFREE');
    assert.deepEqual([free.shippingPaise, free.discountPaise, free.totalPaise], [0, 0, 80000]);
    assert.equal((await tryCode('')).shippingPaise, 4900);
    assert.equal((await tryCode('NEWBIE')).discountPaise, 2000);
    const first = await place(app, placeBody(lamp.id, { couponCode: 'NEWBIE' }));
    assert.equal(first.status, 201, first.text);
    assert.match((await tryCode('NEWBIE')).coupon.message, /first order only/);
    // A code applied to a quote but refused inside the order is refused, never silently dropped.
    assert.equal((await place(app, placeBody(lamp.id, { couponCode: 'NEWBIE' }))).status, 409);
  } finally {
    app.close();
  }
});

test('the console\'s coupons: unique per business whatever the case, fixed once used, scoped to this business, and turned off rather than removed', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const token = await ownerToken(app);
    const make = (body) => api(app, token, '/coupons', { method: 'POST', body });
    const reel = await make({ code: 'REEL10', kind: 'percent', percentBp: 1000 });
    assert.equal(reel.status, 201, reel.text);
    assert.equal((await make({ code: 'reel10', kind: 'flat', amountPaise: 500 })).status, 409);
    assert.equal((await make({ code: 'X', kind: 'flat', amountPaise: 500 })).status, 400);
    assert.equal((await make({ code: 'BADFLAT', kind: 'flat' })).status, 400);
    assert.equal((await make({ code: 'BADPCT', kind: 'percent', percentBp: 1000, amountPaise: 100 })).status, 400);
    const other = await otherStore(app);
    const theirs = await product(app, { tenant: other.tenant });
    assert.equal((await make({ code: 'THEIRS', kind: 'flat', amountPaise: 500, scope: 'products', scopeIds: [theirs.id] })).status, 400);
    assert.equal((await make({ code: 'NOPAGE', kind: 'flat', amountPaise: 500, pageId: 999999 })).status, 400);

    const lamp = await product(app, { stock: null });
    assert.equal((await place(app, placeBody(lamp.id, { couponCode: 'REEL10' }))).status, 201);
    const rename = await api(app, token, `/coupons/${reel.json.id}`, { method: 'PATCH', body: { code: 'REEL20' } });
    assert.equal(rename.status, 409);
    const off = await api(app, token, `/coupons/${reel.json.id}`, { method: 'PATCH', body: { active: false } });
    assert.deepEqual([off.status, off.json.active, off.json.usedCount], [200, false, 1]);
    assert.equal((await api(app, token, `/coupons/${reel.json.id}`, { method: 'DELETE' })).status, 409);
    const unused = await make({ code: 'SPARE', kind: 'free_shipping' });
    assert.equal((await api(app, token, `/coupons/${unused.json.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(app, token, `/coupons/${unused.json.id}`, { method: 'DELETE' })).status, 404);
    const list = await api(app, token, '/coupons?show=ended');
    assert.deepEqual(list.json.items.map((c) => c.code), ['REEL10']);
    // Another business sees none of them and its own REEL10 is its own.
    const { withTenant } = await import('../../../src/tenancy.js');
    await withTenant(other.tenant, () => app.platform.users.ensureOwner({ phone: '9000000099', password: 'other-pass' }));
    const otherToken = (await hit(app, '/api/v1/auth/login', { method: 'POST', host: other.host, body: { phone: '9000000099', password: 'other-pass' } })).json.token;
    assert.deepEqual((await api(app, otherToken, '/coupons', { host: other.host })).json.items, []);
    assert.equal((await api(app, otherToken, `/coupons/${reel.json.id}`, { host: other.host })).status, 404);
    assert.equal((await api(app, otherToken, '/coupons', { method: 'POST', host: other.host, body: { code: 'REEL10', kind: 'flat', amountPaise: 500 } })).status, 201);
  } finally {
    app.close();
  }
});

test('trying codes from one address is limited, and a business without coupons in its plan has none', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { stock: null });
    const body = { code: 'GUESS', lines: [{ productId: lamp.id, variantId: null, qty: 1 }] };
    for (let i = 0; i < 30; i += 1) assert.equal((await hit(app, '/api/store/coupons/check', { method: 'POST', body })).status, 200);
    assert.equal((await hit(app, '/api/store/coupons/check', { method: 'POST', body })).status, 429);
    const priced = await hit(app, '/api/store/coupons/check', { method: 'POST', body: { ...body, pricePaise: 1 } });
    assert.equal(priced.status, 400);

    const { withTenant } = await import('../../../src/tenancy.js');
    await withTenant(app.tenant, () => app.platform.entitlements.setOverride('store.coupons', { enabled: false }));
    const token = await ownerToken(app);
    const refused = await api(app, token, '/coupons');
    assert.equal(refused.status, 403);
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, amount_paise) VALUES ($1, 'OLD', 'flat', 1000)`, [app.tenant.id]);
    const seen = await quote(app, { lines: body.lines, couponCode: 'OLD' });
    assert.equal(seen.json.discountPaise, 0, 'no discount without coupons in the plan');
  } finally {
    app.close();
  }
});
