// Data requests under the DPDP Act (PRD 9.18): access and erasure, per business.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consent } from '../../../src/modules/consent/index.js';
import { OWNER } from '../../helpers.js';
import { browser, placeOrder, signInWithCode, world } from './support.js';

const PHONE = '9876543210';
const home = { name: 'Asha K', phone: PHONE, line1: '12 MG Road', city: 'Pune', stateCode: '27', pincode: '411001' };

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
     VALUES ($1, $2, 'bill_of_supply', 0, 0, '', '{"legalName":"Test store"}', $3, '27', '[{"description":"Brass lamp","qty":1}]', $4, $4, $5) RETURNING *`,
    [order.tenant_id, order.id, JSON.stringify(buyer), order.total_paise, `t/${order.tenant_id}/invoices/${order.id}.pdf`],
  );
  return inv;
}

async function signedIn(w, b = browser(w.app)) {
  const { csrf } = await signInWithCode(w, b, PHONE);
  const call = (method, path, json) => b.request(path, { method, json, headers: { 'x-shopper-csrf': csrf } });
  return { b, call };
}

test('S-63: a shopper’s deletion request erases their personal data and keeps the tax records, masked', async () => {
  const w = await world({ google: false });
  try {
    const { b, call } = await signedIn(w);
    await call('POST', '/api/store/addresses', home);
    await call('POST', '/api/store/consent', { choices: { noticeVersion: 1, marketing: { whatsapp: true } } });
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    const order = await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-5001', totalPaise: 129900 });
    await deliver(w.app.db, order.id);
    // A guest order with the same verified number is theirs too.
    const guest = await placeOrder(w.app.db, w.app.tenant.id, { number: 'A-5002', phone: '+919876543210', name: 'Asha' });
    await deliver(w.app.db, guest.id);
    const invoice = await invoiceFor(w.app.db, order);
    const storage = w.app.ctx.platform.storage;
    await storage.put(invoice.file_key, Buffer.from('%PDF'), 'application/pdf');
    const [ret] = await w.app.db.platform.query(`INSERT INTO returns (tenant_id, order_id, shopper_id, status, reason) VALUES ($1, $2, $3, 'rejected', 'The lamp arrived with a dent near my house') RETURNING id`, [w.app.tenant.id, order.id, shopper.id]);
    const proofKey = `t/${w.app.tenant.id}/returns/${ret.id}/dent.jpg`;
    await storage.put(proofKey, Buffer.from('jpeg'), 'image/jpeg');
    await w.app.db.platform.query(`INSERT INTO return_proofs (tenant_id, return_id, kind, file_key, content_type, bytes) VALUES ($1, $2, 'photo', $3, 'image/jpeg', 4)`, [w.app.tenant.id, ret.id, proofKey]);
    // Someone else's order with another number stays as it is.
    const other = await placeOrder(w.app.db, w.app.tenant.id, { number: 'A-5003', phone: '+919811111111', name: 'Ravi' });

    assert.equal((await call('POST', '/api/store/data-requests', { kind: 'erasure' })).status, 400, 'deleting needs a confirmation');
    const res = await call('POST', '/api/store/data-requests', { kind: 'erasure', confirm: true });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.request.status, 'completed');
    assert.equal(body.signedOut, true);
    assert.equal(b.cookies().get('_sid'), undefined, 'signed out on this browser');
    assert.equal(body.request.summary.ordersMasked, 2);
    assert.equal(body.request.summary.invoicesMasked, 1);
    assert.equal(body.request.summary.returnProofs, 1);
    assert.ok(Object.values(body.request.summary).every((v) => Number.isInteger(v)), 'the record holds counts only');

    assert.deepEqual(await w.app.db.platform.query('SELECT id FROM shoppers'), [], 'the account is gone');
    for (const table of ['shopper_addresses', 'shopper_sessions', 'shopper_otps']) {
      assert.deepEqual(await w.app.db.platform.query(`SELECT id FROM ${table}`), [], `${table} is empty`);
    }
    assert.deepEqual(await w.app.db.platform.query('SELECT id FROM consent_records WHERE shopper_id IS NOT NULL'), []);

    const orders = await w.app.db.platform.query(`SELECT order_number, customer_name, phone, email, address, pincode, shipping_address, total_paise, erased_at, shopper_id FROM orders ORDER BY id`);
    for (const o of orders.filter((x) => x.order_number !== 'A-5003')) {
      assert.deepEqual([o.customer_name, o.phone, o.email, o.address, o.pincode], ['', '', '', '', ''], o.order_number);
      assert.deepEqual(o.shipping_address, { stateCode: '27' }, 'the state of supply stays for tax');
      assert.ok(o.erased_at);
      assert.equal(o.shopper_id, null);
    }
    assert.equal(orders.find((o) => o.order_number === 'A-5001').total_paise, 129900, 'the amounts stay');
    const kept = orders.find((o) => o.order_number === 'A-5003');
    assert.deepEqual([kept.customer_name, kept.phone, kept.erased_at], ['Ravi', '+919811111111', null], 'another person’s order is untouched');
    void other;

    const [inv] = await w.app.db.platform.query('SELECT number, buyer, buyer_masked_at, total_paise, file_key FROM invoices');
    assert.equal(inv.number, invoice.number, 'the invoice keeps its number');
    assert.deepEqual(inv.buyer, { name: '', phone: '', address: '', stateCode: '27' });
    assert.ok(inv.buyer_masked_at);
    assert.equal(inv.total_paise, 129900);
    assert.equal(inv.file_key, '', 'the old file, which named the buyer, is dropped');
    assert.equal(await storage.get(invoice.file_key), null);
    assert.equal(await storage.get(proofKey), null, 'proof photos are deleted with the shopper’s data');
    assert.deepEqual(await w.app.db.platform.query('SELECT reason FROM returns'), [{ reason: '' }]);

    const [request] = await w.app.db.platform.query('SELECT kind, status, source, shopper_id, completed_at FROM data_requests');
    assert.deepEqual([request.kind, request.status, request.source, request.shopper_id], ['erasure', 'completed', 'account', null]);
    assert.ok(request.completed_at);
    const audit = await w.app.db.platform.query(`SELECT action, details FROM audit_log WHERE action LIKE 'shopper.eras%' ORDER BY id`);
    assert.deepEqual(audit.map((a) => a.action), ['shopper.erasure_requested', 'shopper.erased']);
    assert.ok(!JSON.stringify(audit).includes(PHONE), 'no number in the audit log');

    // Signing in again with the same number starts afresh.
    const again = browser(w.app);
    await signInWithCode(w, again, PHONE);
    assert.doesNotMatch(await (await again.request('/account')).text(), /A-5001/);
  } finally {
    await w.close();
  }
});

test('an erasure waits while an order is on its way, and the worker finishes it once the order is done', async () => {
  const w = await world({ google: false });
  try {
    const { call } = await signedIn(w);
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    const order = await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-6001' });
    await w.app.db.platform.query(`UPDATE orders SET payment_status = 'paid', fulfilment_status = 'new' WHERE id = $1`, [order.id]);
    const res = await call('POST', '/api/store/data-requests', { kind: 'erasure', confirm: true });
    const body = await res.json();
    assert.equal(body.request.status, 'requested');
    assert.equal(body.signedOut, false);
    assert.equal(body.request.summary.waitingOnOrders, 1);
    assert.match(body.message, /as soon as your open orders are complete/);
    assert.equal((await w.app.db.platform.query(`SELECT customer_name FROM orders`))[0].customer_name, 'Asha K', 'the parcel still has its address');

    await w.app.db.platform.query(`UPDATE orders SET fulfilment_status = 'shipped' WHERE id = $1`, [order.id]);
    await w.app.db.platform.query(`UPDATE orders SET fulfilment_status = 'delivered' WHERE id = $1`, [order.id]);
    const schedule = consent.jobs({ ...w.app.ctx });
    await schedule();
    const [request] = await w.app.db.platform.query('SELECT status FROM data_requests');
    assert.equal(request.status, 'completed');
    assert.deepEqual(await w.app.db.platform.query('SELECT id FROM shoppers'), []);
  } finally {
    await w.close();
  }
});

test('a shopper downloads what the store holds about them, and a request at one store touches nothing at another', async () => {
  const w = await world({ google: false });
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    const atB = browser(w.app, { host: leaf.host });
    await signInWithCode(w, atB, PHONE);
    const [bShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);
    await placeOrder(w.app.db, leaf.tenant.id, { shopperId: bShopper.id, number: 'B-1' });

    const { call } = await signedIn(w);
    await call('POST', '/api/store/addresses', home);
    const [aShopper] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    await deliver(w.app.db, (await placeOrder(w.app.db, w.app.tenant.id, { shopperId: aShopper.id, number: 'A-7001' })).id);
    const access = await call('POST', '/api/store/data-requests', { kind: 'access' });
    assert.equal(access.status, 201);
    const { request, data } = await access.json();
    assert.equal(request.status, 'completed');
    assert.equal(data.store, 'Test store');
    assert.equal(data.account.phone, '+919876543210');
    assert.deepEqual(data.orders.map((o) => o.number), ['A-7001'], 'only this store’s orders');
    assert.equal(data.addresses.length, 1);
    assert.ok(data.consent.some((c) => c.purpose === 'fulfilment'));
    assert.doesNotMatch(JSON.stringify(data), /B-1|Leaf and Clay/);

    assert.equal((await (await call('POST', '/api/store/data-requests', { kind: 'erasure', confirm: true })).json()).request.status, 'completed');
    assert.deepEqual((await w.app.db.platform.query('SELECT tenant_id FROM shoppers')).map((s) => s.tenant_id), [leaf.tenant.id], 'the other store’s account stays');
    assert.equal((await w.app.db.platform.query(`SELECT customer_name FROM orders WHERE order_number = 'B-1'`))[0].customer_name, 'Asha K');
    assert.equal((await atB.request('/account')).status, 200, 'still signed in at the other store');
  } finally {
    await w.close();
  }
});

test('the seller acts on a request made another way, and sees only their own business’s requests', async () => {
  const w = await world({ google: false });
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    const b = browser(w.app);
    await signInWithCode(w, b, PHONE);
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    const login = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
    const token = (await login.json()).token;
    const api = (method, path, json, host) => fetch(`${w.app.base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}), ...(host ? { 'x-forwarded-host': host } : {}) }, body: json ? JSON.stringify(json) : undefined });

    const made = await api('POST', '/data-requests', { shopperId: shopper.id, kind: 'erasure' });
    assert.equal(made.status, 201);
    const request = await made.json();
    assert.deepEqual([request.kind, request.source, request.status], ['erasure', 'seller', 'completed']);
    const list = await (await api('GET', '/data-requests?status=completed')).json();
    assert.deepEqual(list.items.map((r) => r.id), [request.id]);
    assert.equal((await api('GET', `/data-requests/${request.id}`)).status, 200);
    assert.equal((await api('POST', '/data-requests', { shopperId: 999999, kind: 'erasure' })).status, 404);

    // Leaf's owner sees none of it.
    await leaf.repos.users.ensureOwner({ phone: '9000000009', password: 'leaf-owner' });
    const leafLogin = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': leaf.host }, body: JSON.stringify({ phone: '9000000009', password: 'leaf-owner' }) });
    const leafToken = (await leafLogin.json()).token;
    const leafApi = (path) => fetch(`${w.app.base}/api/v1${path}`, { headers: { authorization: `Bearer ${leafToken}` } });
    assert.equal((await leafApi(`/data-requests/${request.id}`)).status, 404);
    assert.deepEqual((await (await leafApi('/data-requests')).json()).items, []);
  } finally {
    await w.close();
  }
});
