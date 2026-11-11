// Shared shopper sign-in across stores (PRD 9.22) and the platform's own consent screen (9.18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopperServices } from '../../../src/modules/shoppers/index.js';
import { PLATFORM_HOST, browser, follow, placeOrder, signInWithCode, world } from './support.js';

const PHONE = '9876543210';
const STORE_A = 'default.bhava.test';
const home = { name: 'Asha K', phone: PHONE, line1: '12 MG Road', city: 'Pune', stateCode: '27', pincode: '411001' };

/** A shopper verified at store A who saved their details for other stores, and store B. */
async function sharedAtA() {
  const w = await world({ google: false });
  const leaf = await w.addStore('leaf', 'Leaf and Clay');
  await leaf.repos.settings.update({ store_name: 'Leaf and Clay' });
  // Store A on its own address: saved details are only ever offered on a store's own address.
  const b = browser(w.app, { host: STORE_A });
  const { csrf } = await signInWithCode(w, b, PHONE);
  const call = (method, path, json) => b.request(path, { method, json, headers: { 'x-shopper-csrf': csrf } });
  await call('POST', '/api/store/addresses', home);
  const notice = await shopperServices(w.app.ctx).shared.notice();
  const saved = await call('POST', '/api/store/shared-profile', { noticeVersion: notice.version, agree: true });
  assert.equal(saved.status, 201);
  const { redirect } = await saved.json();
  const hop = new URL(redirect);
  assert.equal(hop.hostname, PLATFORM_HOST, 'the browser is remembered on the platform’s own host');
  const back = await b.request(`${hop.pathname}${hop.search}`, { onHost: PLATFORM_HOST });
  assert.equal(back.status, 303);
  assert.ok(b.cookies(PLATFORM_HOST).get('_shp'), 'remembered there, never on a store');
  return { w, leaf, b, call };
}

/** Store B's way in for a browser with saved details: through the platform host and back, then Continue. */
async function continueAtB(b, leaf, next = '/checkout') {
  const start = await b.request(`/auth/shared?next=${encodeURIComponent(next)}`, { onHost: leaf.host });
  assert.equal(start.status, 302);
  return follow(b, start, { from: leaf.host });
}

test('S-97: the shared-profile consent screen names the platform as data fiduciary, with its grievance contact and a way to withdraw, and the box is unticked', async () => {
  const w = await world({ google: false });
  try {
    const b = browser(w.app);
    await signInWithCode(w, b, PHONE);
    const res = await b.request('/account/shared-profile');
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /Bhava is the data fiduciary for this shared profile under India’s Digital Personal Data Protection Act, 2023/);
    assert.match(page, /Grievance contact/);
    assert.match(page, /privacy@bhava\.test/);
    assert.match(page, /How to withdraw/);
    assert.match(page, /Your verified phone number or Google account/);
    assert.match(page, /<input type="checkbox" id="sp-agree">/, 'unticked by default');
    assert.doesNotMatch(page, /id="sp-agree" checked/);
    assert.match(page, /lang="hi"/, 'the full notice is bilingual');
    // Without ticking, nothing is saved.
    const notice = await shopperServices(w.app.ctx).shared.notice();
    const csrf = /data-shopper-csrf="([^"]+)"/.exec(page)[1];
    const refused = await b.request('/api/store/shared-profile', { method: 'POST', json: { noticeVersion: notice.version, agree: false }, headers: { 'x-shopper-csrf': csrf } });
    assert.equal(refused.status, 400);
    assert.deepEqual(await w.app.db.platform.query('SELECT id FROM shared_profiles'), []);
  } finally {
    await w.close();
  }
});

test('S-98: a shopper verified at A, with shared consent, checks out at B with the verified number and saved addresses, and no sign-up or code', async () => {
  const { w, leaf, b } = await sharedAtA();
  try {
    const codesBefore = await w.sentCount();
    const confirm = await continueAtB(b, leaf);
    assert.equal(confirm.status, 200);
    const page = await confirm.text();
    assert.match(page, /Continue as <strong>\+91 ••••• ••210<\/strong>/);
    assert.match(page, /Leaf and Clay/);
    assert.doesNotMatch(page, /bhava|Test store/i, 'B’s page names B only: not the platform, not store A');
    assert.deepEqual(await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]), [], 'nothing reaches B before Continue');

    assert.doesNotMatch(page, /ticket/i, 'the page’s address and markup carry no ticket');
    assert.deepEqual(confirm.trail.at(-1), { host: leaf.host, path: '/auth/shared/continue?next=%2Fcheckout' });
    const done = await follow(b, await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/checkout' } }), { from: leaf.host });
    assert.deepEqual(done.trail.slice(0, 2).map((t) => t.host), [PLATFORM_HOST, leaf.host], 'once through the platform host, to be remembered for the next store');
    assert.equal(done.trail[1].path, '/checkout', 'and back to B’s checkout');
    assert.ok(b.cookies(leaf.host).get('_sid'), 'signed in at B');
    assert.equal(await w.sentCount(), codesBefore, 'no code was sent');

    const addresses = await (await b.request('/api/store/addresses', { onHost: leaf.host })).json();
    assert.equal(addresses.items.length, 1);
    assert.deepEqual([addresses.items[0].line1, addresses.items[0].shared], ['12 MG Road', true], 'the saved address is offered at B');
    const [atB] = await w.app.db.platform.query('SELECT phone, phone_verified_at FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);
    assert.equal(atB.phone, '+919876543210');
    assert.ok(atB.phone_verified_at);
    const [session] = await w.app.db.platform.query('SELECT method FROM shopper_sessions WHERE tenant_id = $1', [leaf.tenant.id]);
    assert.equal(session.method, 'shared');

    // The ticket worked once; another browser can't use it, nor can this one again.
    const account = await (await b.request('/account', { onHost: leaf.host })).text();
    const csrf = /data-shopper-csrf="([^"]+)"/.exec(account)[1];
    assert.equal((await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/checkout' } })).status, 403, 'a signed-in browser needs its CSRF token');
    const replay = await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/checkout', _shopper_csrf: csrf } });
    assert.equal(replay.status, 400, 'and the ticket is spent');
    assert.equal((await w.app.db.platform.query('SELECT count(*)::int AS n FROM shopper_sessions WHERE tenant_id = $1', [leaf.tenant.id]))[0].n, 1);
  } finally {
    await w.close();
  }
});

test('S-99: one business never sees another’s customers or orders, through any API call', async () => {
  const { w, leaf, b } = await sharedAtA();
  try {
    const [aShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    const aOrder = await placeOrder(w.app.db, w.app.tenant.id, { shopperId: aShopper.id, number: 'A-8001' });
    await continueAtB(b, leaf);
    await leaf.repos.users.ensureOwner({ phone: '9000000009', password: 'leaf-owner' });
    const login = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': leaf.host }, body: JSON.stringify({ phone: '9000000009', password: 'leaf-owner' }) });
    const token = (await login.json()).token;
    const api = (path, init = {}) => fetch(`${w.app.base}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    assert.equal((await api(`/shoppers/${aShopper.id}`)).status, 404);
    assert.equal((await api(`/orders/${aOrder.id}`)).status, 404);
    assert.deepEqual((await (await api('/shoppers')).json()).items, []);
    assert.deepEqual((await (await api('/shoppers?search=Asha')).json()).items, []);
    assert.deepEqual((await (await api('/data-requests')).json()).items, []);
    assert.equal((await api('/data-requests', { method: 'POST', body: JSON.stringify({ shopperId: aShopper.id, kind: 'access' }) })).status, 404);
    const download = await (await api('/shopper-downloads', { method: 'POST', body: JSON.stringify({ format: 'csv' }) })).json();
    assert.equal(download.rowCount, 0);
    const file = await fetch(`${w.app.base}${download.fileUrl}`, { headers: { authorization: `Bearer ${token}` } });
    assert.doesNotMatch(await file.text(), /Asha|A-8001/);
  } finally {
    await w.close();
  }
});

test('S-100: B’s customer list after the shopper’s first order at B shows B’s order only', async () => {
  const { w, leaf, b } = await sharedAtA();
  try {
    const [aShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    for (const n of ['A-1', 'A-2']) await placeOrder(w.app.db, w.app.tenant.id, { shopperId: aShopper.id, number: n, totalPaise: 100000 });
    await continueAtB(b, leaf);
    await follow(b, await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/' } }), { from: leaf.host });
    const [bShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);

    await leaf.repos.users.ensureOwner({ phone: '9000000009', password: 'leaf-owner' });
    const login = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': leaf.host }, body: JSON.stringify({ phone: '9000000009', password: 'leaf-owner' }) });
    const token = (await login.json()).token;
    const api = (path) => fetch(`${w.app.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await (await api('/shoppers')).json()).items, [], 'signed in at B is not a customer of B');

    const order = await placeOrder(w.app.db, leaf.tenant.id, { shopperId: bShopper.id, number: 'B-1', totalPaise: 25000 });
    await w.app.db.platform.query(`UPDATE orders SET payment_status = 'paid', fulfilment_status = 'new' WHERE id = $1`, [order.id]);
    const list = await (await api('/shoppers')).json();
    assert.equal(list.items.length, 1);
    const [c] = list.items;
    assert.deepEqual([c.id, c.signedIn, c.orders, c.spentPaise, c.phone], [bShopper.id, true, 1, 25000, '+919876543210']);
    assert.deepEqual(c.marketing, { whatsapp: false, email: false }, 'no marketing yes at B');
    const one = await (await api(`/shoppers/${bShopper.id}`)).json();
    assert.equal(one.orders, 1);
    assert.doesNotMatch(JSON.stringify(list), /A-1|A-2|100000/);
  } finally {
    await w.close();
  }
});

test('S-101: of the shopper’s pages and messages, only the shared-profile consent screen names the platform', async () => {
  const { w, leaf, b, call } = await sharedAtA();
  try {
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-9001' });
    await call('POST', '/api/store/consent', { choices: { noticeVersion: 1, marketing: { whatsapp: true } } });
    const pages = ['/account', '/account/orders', '/account/orders/A-9001', '/policies/privacy', '/policies/terms', '/policies/refund', '/policies/shipping', '/unsubscribe/not-a-token'];
    for (const path of pages) {
      const res = await b.request(path);
      assert.ok([200, 404].includes(res.status), `${path} ${res.status}`);
      assert.doesNotMatch(await res.text(), /bhava/i, path);
    }
    for (const path of ['/login', '/policies/privacy']) assert.doesNotMatch(await (await browser(w.app).request(path)).text(), /bhava/i, `${path} signed out`);
    const confirm = await continueAtB(b, leaf);
    assert.doesNotMatch(await confirm.text(), /bhava/i, 'B’s Continue page');
    assert.match(await (await b.request('/account/shared-profile')).text(), /Bhava/, 'the one place it may appear');
    const { sent } = await w.wa.get('/sent');
    assert.ok(sent.length > 0);
    assert.doesNotMatch(JSON.stringify(sent.map((m) => m.body)), /bhava/i, 'the login code message names the store only');
  } finally {
    await w.close();
  }
});

test('S-102: withdrawing shared consent removes the profile, B asks for sign-in again, and A and B keep their own orders', async () => {
  const { w, leaf, b, call } = await sharedAtA();
  try {
    await continueAtB(b, leaf);
    await follow(b, await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/' } }), { from: leaf.host });
    const [aShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    const [bShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: aShopper.id, number: 'A-1' });
    await placeOrder(w.app.db, leaf.tenant.id, { shopperId: bShopper.id, number: 'B-1' });
    assert.equal((await b.request('/account', { onHost: leaf.host })).status, 200);

    const off = await call('DELETE', '/api/store/shared-profile');
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { on: false, removed: true });
    for (const table of ['shared_profiles', 'shared_addresses', 'shared_profile_links', 'shared_cod_signals']) {
      assert.deepEqual(await w.app.db.platform.query(`SELECT 1 FROM ${table}`), [], `${table} is empty`);
    }
    const log = await w.app.db.platform.query('SELECT granted FROM shared_consent_log ORDER BY id');
    assert.deepEqual(log.map((l) => l.granted), [true, false], 'that consent was given and taken back is kept, as a hash');

    // B's sign-in that came through the profile has ended; the next checkout at B asks for sign-in.
    assert.equal((await b.request('/account', { onHost: leaf.host })).status, 302);
    const again = await continueAtB(b, leaf);
    assert.equal(again.status, 200);
    assert.deepEqual(again.trail.at(-1), { host: leaf.host, path: '/login?next=%2Fcheckout&shared=none' });
    assert.match(await again.text(), /No saved details were found on this device/, 'back at B’s sign-in page');
    assert.equal((await w.app.db.platform.query(`SELECT count(*)::int AS n FROM orders`))[0].n, 2, 'both stores keep their own orders');
    assert.equal((await b.request('/account')).status, 200, 'A’s own sign-in by code is A’s and stays');
  } finally {
    await w.close();
  }
});

test('S-103: three cash-on-delivery refusals at A show at B as "high" only, with no store, product or count', async () => {
  const { w, leaf, b } = await sharedAtA();
  try {
    const [aShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    for (let i = 0; i < 3; i++) {
      const order = await placeOrder(w.app.db, w.app.tenant.id, { shopperId: aShopper.id, number: `A-C${i}`, paymentMode: 'cod' });
      for (const set of [`payment_status = 'cod_due', fulfilment_status = 'new'`, `fulfilment_status = 'shipped'`, `fulfilment_status = 'rto_initiated'`]) {
        await w.app.db.platform.query(`UPDATE orders SET ${set} WHERE id = $1`, [order.id]);
      }
    }
    await w.app.ctx.orderEvents.settle();
    // Delivered twice over (an event may come again): still counted once.
    await w.app.ctx.orderEvents.settle();

    await continueAtB(b, leaf);
    await follow(b, await b.request('/auth/shared/confirm', { method: 'POST', onHost: leaf.host, form: { next: '/' } }), { from: leaf.host });
    const [bShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);
    const { shared } = shopperServices(w.app.ctx);
    assert.equal(await shared.codRisk(leaf.tenant.id, bShopper.id), 'high');
    const [signals] = await w.app.db.platform.query('SELECT * FROM shared_cod_signals');
    assert.equal(signals.refused, 3);
    assert.deepEqual(Object.keys(signals).sort(), ['delivered', 'month', 'profile_id', 'refused'], 'no business, order or product on the row');
    // A shopper with no profile is no risk at all, and B learns nothing about anyone else.
    assert.equal(await shared.codRisk(leaf.tenant.id, 999999), 'none');
  } finally {
    await w.close();
  }
});

test('shared sign-in refuses a ticket meant for another store or another browser', async () => {
  const { w, leaf, b } = await sharedAtA();
  try {
    const confirm = await continueAtB(b, leaf);
    const ticket = new URLSearchParams(confirm.trail.find((t) => t.path.startsWith('/auth/shared/callback')).path.split('?')[1]).get('ticket');
    // The ticket passed through a browser: the profile inside it is sealed, so no store can learn a cross-store id from it.
    const payload = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString());
    assert.equal('p' in payload, false);
    assert.match(payload.q, /^v1\./);
    // A third store, or a browser without B's nonce cookie, gets nothing from B's ticket.
    const plum = await w.addStore('plum', 'Plum Pots');
    const elsewhere = browser(w.app, { host: plum.host });
    const there = await elsewhere.request(`/auth/shared/callback?ticket=${encodeURIComponent(ticket)}&next=%2F`);
    assert.equal(there.headers.get('location'), '/login?next=%2F&shared=none');
    const stranger = browser(w.app, { host: leaf.host });
    const taken = await stranger.request(`/auth/shared/callback?ticket=${encodeURIComponent(ticket)}&next=%2F`);
    assert.equal(taken.headers.get('location'), '/login?next=%2F&shared=none', 'without B’s cookie from this browser, the ticket is refused');
    stranger.cookies(leaf.host).set('_sht', ticket);
    assert.equal((await stranger.request('/auth/shared/confirm', { method: 'POST', form: { next: '/' } })).status, 400);
    // On an address that only falls back to a store, saved details are never offered.
    const fallback = await browser(w.app).request('/auth/shared?next=%2F');
    assert.equal(fallback.headers.get('location'), '/login?next=%2F');
    assert.doesNotMatch(await (await browser(w.app).request('/login')).text(), /Continue without a code/);
    assert.equal(stranger.cookies(leaf.host).get('_sid'), undefined);
    // A request to the platform host that this server didn't sign is refused.
    assert.equal((await b.request('/shared/recognise?q=forged', { onHost: PLATFORM_HOST })).status, 400);
    assert.equal((await b.request('/shared/remember?t=forged', { onHost: PLATFORM_HOST })).status, 400);
  } finally {
    await w.close();
  }
});
