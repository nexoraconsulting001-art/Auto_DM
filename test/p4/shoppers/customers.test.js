// The seller's customer list and its download (PRD 9.17): this business's own buyers only, and only the owner takes it away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from '../../helpers.js';
import { browser, placeOrder, signInWithCode, world } from './support.js';

async function tokenFor(w, who = OWNER) {
  const res = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) });
  assert.equal(res.status, 201);
  return (await res.json()).token;
}
const apiAs = (w, token) => (method, path, json) => fetch(`${w.app.base}${path.startsWith('/shopper-files') ? '' : '/api/v1'}${path}`, {
  method, headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
});

test('the customer list: one line per signed-in shopper and per guest number, with order count, spend and this store’s marketing consent', async () => {
  const w = await world({ google: false });
  try {
    const b = browser(w.app);
    const { csrf } = await signInWithCode(w, b, '9876543210');
    await b.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, marketing: { email: true } } }, headers: { 'x-shopper-csrf': csrf } });
    const [shopper] = await w.app.db.platform.query('SELECT id FROM shoppers');
    const paid = await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-1', totalPaise: 60000 });
    await w.app.db.platform.query(`UPDATE orders SET payment_status = 'paid', fulfilment_status = 'new' WHERE id = $1`, [paid.id]);
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: shopper.id, number: 'A-2', totalPaise: 9900 }); // still unpaid: counted, not spent
    const guest = await placeOrder(w.app.db, w.app.tenant.id, { number: 'A-3', phone: '+919811111111', name: 'Ravi Guest', totalPaise: 30000 });
    await w.app.db.platform.query(`UPDATE orders SET payment_status = 'paid', fulfilment_status = 'new' WHERE id = $1`, [guest.id]);

    const api = apiAs(w, await tokenFor(w));
    const list = await (await api('GET', '/shoppers')).json();
    assert.equal(list.items.length, 2);
    const ravi = list.items.find((c) => !c.signedIn);
    const asha = list.items.find((c) => c.signedIn);
    assert.deepEqual([ravi.id, ravi.name, ravi.phone, ravi.orders, ravi.spentPaise], [null, 'Ravi Guest', '+919811111111', 1, 30000]);
    assert.deepEqual([asha.id, asha.orders, asha.spentPaise, asha.marketing], [shopper.id, 2, 60000, { whatsapp: false, email: true }]);
    assert.equal(list.items[0].name, 'Ravi Guest', 'newest order first');

    assert.deepEqual((await (await api('GET', '/shoppers?search=ravi')).json()).items.map((c) => c.name), ['Ravi Guest']);
    assert.deepEqual((await (await api('GET', '/shoppers?search=981111')).json()).items.map((c) => c.name), ['Ravi Guest']);
    assert.deepEqual((await (await api('GET', '/shoppers?search=%25')).json()).items, [], 'a wildcard is searched for, not obeyed');
    const first = await (await api('GET', '/shoppers?limit=1')).json();
    assert.equal(first.items.length, 1);
    const second = await (await api('GET', `/shoppers?limit=1&cursor=${first.nextCursor}`)).json();
    assert.equal(second.items[0].signedIn, true);
    assert.equal(second.nextCursor, null);
    assert.equal((await api('GET', `/shoppers/${shopper.id}`)).status, 200);
    assert.equal((await api('GET', '/shoppers/987654')).status, 404);
  } finally {
    await w.close();
  }
});

test('only the owner downloads the customer list, and every download is in the audit log', async () => {
  const w = await world({ google: false });
  try {
    await placeOrder(w.app.db, w.app.tenant.id, { number: 'A-1', phone: '+919811111111', name: '=HYPERLINK("http://x")' });
    const owner = apiAs(w, await tokenFor(w));
    const made = await owner('POST', '/shopper-downloads', { format: 'csv' });
    assert.equal(made.status, 201);
    const download = await made.json();
    assert.deepEqual([download.format, download.status, download.rowCount], ['csv', 'ready', 1]);
    assert.match(download.fileUrl, /^\/shopper-files\/\d+$/);
    const file = await owner('GET', download.fileUrl);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = await file.text();
    assert.match(csv, /Name,Phone,Email/);
    assert.match(csv, /'=HYPERLINK/, 'text a spreadsheet would run is made inert');
    assert.match(csv, /\+919811111111/);
    const xlsx = await (await owner('POST', '/shopper-downloads', { format: 'xlsx' })).json();
    const book = await owner('GET', xlsx.fileUrl);
    assert.equal(book.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal((await owner('GET', '/shopper-downloads')).status, 200);
    assert.equal((await (await owner('GET', '/shopper-downloads')).json()).items.length, 2);
    const audit = await w.app.db.platform.query(`SELECT actor, details FROM audit_log WHERE action = 'shoppers.download' ORDER BY id`);
    assert.equal(audit.length, 2);
    assert.ok(!JSON.stringify(audit).includes('9811111111'), 'the audit row holds no customer data');

    // A manager and a shopper are refused, and the file itself is the owner's only.
    const manager = await w.app.repos.users.create({ name: 'Mo', phone: '9000000002', password: 'manager-pass' });
    await w.app.db.platform.query(`UPDATE users SET role = 'manager' WHERE id = $1`, [manager.id]);
    const asManager = apiAs(w, await tokenFor(w, { phone: '9000000002', password: 'manager-pass' }));
    assert.equal((await asManager('POST', '/shopper-downloads', { format: 'csv' })).status, 403);
    assert.equal((await asManager('GET', download.fileUrl)).status, 403);
    assert.equal((await fetch(`${w.app.base}${download.fileUrl}`)).status, 401);
  } finally {
    await w.close();
  }
});
