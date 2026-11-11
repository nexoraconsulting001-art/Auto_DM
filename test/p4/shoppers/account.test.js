// Saved addresses (PRD 9.4) and the shopper's account (9.17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, placeOrder, signInWithCode, world } from './support.js';

const PHONE = '9876543210';
const home = { name: 'Asha K', phone: '98765 43210', line1: '12 MG Road', city: 'Pune', stateCode: '27', pincode: '411001' };

async function signedIn() {
  const w = await world({ google: false });
  const b = browser(w.app);
  const { csrf } = await signInWithCode(w, b, PHONE);
  const call = (method, path, json) => b.request(path, { method, json, headers: { 'x-shopper-csrf': csrf } });
  return { w, b, csrf, call };
}

test('S-12: a PIN code starting with 0 is refused with "Enter a 6-digit PIN code"', async () => {
  const { w, call } = await signedIn();
  try {
    const res = await call('POST', '/api/store/addresses', { ...home, pincode: '012345' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'validation_failed');
    assert.equal(body.fields.pincode, 'Enter a 6-digit PIN code');
    assert.equal(body.error, 'Enter a 6-digit PIN code');
    for (const bad of [{ stateCode: '99' }, { phone: '12' }, { line1: '' }, { price: 100 }]) {
      assert.equal((await call('POST', '/api/store/addresses', { ...home, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('GET', '/api/store/addresses')).status, 200);
    assert.deepEqual((await (await call('GET', '/api/store/addresses')).json()).items, []);
  } finally {
    await w.close();
  }
});

test('S-13: the second saved address marked as default is the one preselected, and only one is ever the default', async () => {
  const { w, call } = await signedIn();
  try {
    const first = (await (await call('POST', '/api/store/addresses', home)).json()).address;
    assert.equal(first.isDefault, true, 'the first address is the default');
    const second = (await (await call('POST', '/api/store/addresses', { ...home, line1: '4 Lake View', kind: 'work', isDefault: true })).json()).address;
    assert.equal(second.isDefault, true);
    const { items } = await (await call('GET', '/api/store/addresses')).json();
    assert.deepEqual(items.map((a) => [a.id, a.isDefault]), [[second.id, true], [first.id, false]], 'the default comes first, for checkout to preselect');
    assert.equal(items[0].phone, '+919876543210', 'the number is stored in international form');
    assert.equal(items[0].state, 'Maharashtra');

    // Removing the default makes the oldest left the default.
    assert.equal((await call('DELETE', `/api/store/addresses/${second.id}`)).status, 204);
    const after = (await (await call('GET', '/api/store/addresses')).json()).items;
    assert.deepEqual(after.map((a) => [a.id, a.isDefault]), [[first.id, true]]);
    assert.equal((await call('DELETE', `/api/store/addresses/${second.id}`)).status, 404);
  } finally {
    await w.close();
  }
});

test('S-14: editing a saved address after an order leaves the order’s address as it was', async () => {
  const { w, b, call } = await signedIn();
  try {
    const saved = (await (await call('POST', '/api/store/addresses', home)).json()).address;
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    // Checkout copies the address into the order (orders.shipping_address).
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-2001', address: { ...saved, phone: saved.phone } });
    const edited = await call('PUT', `/api/store/addresses/${saved.id}`, { ...home, line1: '99 New Street' });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).address.line1, '99 New Street');

    const page = await (await b.request('/account/orders/A-2001')).text();
    assert.match(page, /12 MG Road/);
    assert.doesNotMatch(page, /99 New Street/);
    const [order] = await w.app.db.platform.query(`SELECT shipping_address FROM orders WHERE order_number = 'A-2001'`);
    assert.equal(order.shipping_address.line1, '12 MG Road');
  } finally {
    await w.close();
  }
});

test('one shopper can never see, change or remove another shopper’s address', async () => {
  const { w, call } = await signedIn();
  try {
    const mine = (await (await call('POST', '/api/store/addresses', home)).json()).address;
    const other = browser(w.app);
    const { csrf } = await signInWithCode(w, other, '9811111111');
    const theirs = (path, method, json) => other.request(path, { method, json, headers: { 'x-shopper-csrf': csrf } });
    assert.deepEqual((await (await theirs('/api/store/addresses', 'GET')).json()).items, []);
    assert.equal((await theirs(`/api/store/addresses/${mine.id}`, 'PUT', { ...home, line1: 'Taken over' })).status, 404);
    assert.equal((await theirs(`/api/store/addresses/${mine.id}`, 'DELETE')).status, 404);
    assert.equal((await (await call('GET', '/api/store/addresses')).json()).items[0].line1, '12 MG Road');
    // Signed out, the calls answer 401.
    assert.equal((await browser(w.app).request('/api/store/addresses')).status, 401);
  } finally {
    await w.close();
  }
});

test('the account shows the shopper’s own orders, addresses and message choices, in the seller’s brand only', async () => {
  const { w, b, call } = await signedIn();
  try {
    await call('POST', '/api/store/addresses', home);
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-3001' });
    await placeOrder(w.app.db, w.app.tenant.id, { number: 'A-3002', phone: '+919811111111' });
    const res = await b.request('/account');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const page = await res.text();
    assert.match(page, /A-3001/);
    assert.doesNotMatch(page, /A-3002/, 'another shopper’s order never shows');
    assert.match(page, /12 MG Road/);
    assert.match(page, /Order updates on WhatsApp/);
    assert.match(page, /Download my data/);
    assert.doesNotMatch(page, /bhava/i);
    const detail = await (await b.request('/account/orders/A-3001')).text();
    assert.match(detail, /Brass lamp/);
    assert.match(detail, /Cancel order/, 'an order not yet shipped can be cancelled');
    assert.equal((await b.request('/account/orders/A-3002')).status, 404);
  } finally {
    await w.close();
  }
});

test('Phase 0 password accounts still sign in on the store, and a sign-in form posted as JSON or with no body is not a server fault', async () => {
  const w = await world({ google: false });
  try {
    const b = browser(w.app);
    for (const body of [{ json: { phone: { a: 1 }, password: ['x'] } }, { body: undefined }, { json: [] }]) {
      const res = await b.request('/login', { method: 'POST', ...body });
      assert.equal(res.status, 401, JSON.stringify(body));
    }
    const nul = await b.request('/signup', { method: 'POST', form: { name: 'A\u0000B', phone: '9876543210', password: 'secret1' } });
    assert.equal(nul.status, 400);
    const ok = await b.request('/login', { method: 'POST', form: { phone: '9000000001', password: 'owner-pass' } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/admin');
  } finally {
    await w.close();
  }
});
