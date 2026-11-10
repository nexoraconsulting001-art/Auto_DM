import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { REEL_ID, login, seedReel, startApp } from './helpers.js';

const sign = (body, secret = 'secret') => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

// The webhook answers 200 before it does the work, so tests wait for the outcome. A fixed sleep loses this race on a busy machine.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 5000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await pause(20);
}

test('webhook verification and signature checks', async () => {
  const app = await startApp();
  try {
    assert.equal(await (await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`)).text(), '42');
    assert.equal((await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)).status, 403);
    const body = JSON.stringify({ entry: [] });
    const post = (sig) => fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    assert.equal((await post(sign(body, 'wrong'))).status, 401);
    assert.equal((await post(sign(body))).status, 200);
  } finally {
    app.close();
  }
});

test('a signed comment webhook sends the store link', async () => {
  const app = await startApp();
  try {
    await seedReel(app.repos);
    const body = JSON.stringify({ entry: [{ id: 'ME', changes: [{ field: 'comments', value: { id: 'c1', text: 'LINK', media: { id: REEL_ID }, from: { id: 'u1', username: 'bob' } } }] }] });
    await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    await waitFor(() => app.ig.calls.length > 0);
    assert.equal(app.ig.calls[0][3], 'https://shop.test/r/brunch-edit?src=dm');
  } finally {
    app.close();
  }
});

test('comments on reels this store doesn’t use are passed on unchanged; /l/<slug> redirects to the plugin', async () => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, sig: req.headers['x-hub-signature-256'] });
      res.end('ok');
    });
  }).listen(0);
  const forwardWebhookUrl = `http://127.0.0.1:${receiver.address().port}/webhook`;
  const app = await startApp({ overrides: { forwardWebhookUrl, pluginUrl: 'https://plugin.test' } });
  try {
    await seedReel(app.repos);
    const comment = (id, media) => JSON.stringify({ entry: [{ id: 'ME', changes: [{ field: 'comments', value: { id, text: 'LINK', media: { id: media }, from: { id: 'u1', username: 'bob' } } }] }] });
    const send = (body) => fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });

    await send(comment('c1', REEL_ID)); // our reel: DM here, nothing passed on
    const other = comment('c2', '999');
    await send(other); // not our reel: passed on byte for byte with Meta's signature
    await waitFor(() => received.length > 0 && app.ig.calls.length > 0);
    await pause(200); // room for anything that should not have been passed on to arrive
    assert.equal(app.ig.calls.filter((c) => c[0] === 'button').length, 1);
    assert.deepEqual(received, [{ body: other, sig: sign(other) }]);

    const res = await fetch(`${app.base}/l/winter-bulbs?src=dm`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://plugin.test/r/winter-bulbs?src=dm');
  } finally {
    app.close();
    receiver.close();
  }
});

test('admin requires the owner login and a CSRF token', async () => {
  const app = await startApp();
  try {
    const anon = await fetch(`${app.base}/admin`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/login?next=%2Fadmin');
    const wrong = await fetch(`${app.base}/login`, { method: 'POST', body: new URLSearchParams({ phone: '9000000001', password: 'nope' }) });
    assert.equal(wrong.status, 401);

    const { cookie, csrf, location } = await login(app.base, { csrfPage: '/admin/products/new' });
    assert.equal(location, '/admin');
    const form = { name: 'Kurta', price: '999', active: 'on' };
    const noCsrf = await fetch(`${app.base}/admin/products`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(form), redirect: 'manual' });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${app.base}/admin/products`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ ...form, _csrf: csrf }), redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal((await app.repos.products.list())[0].name, 'Kurta');
  } finally {
    app.close();
  }
});

test('shopper flow: store page, place order, pay page with QR', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos);
    const store = await fetch(`${app.base}/r/brunch-edit?src=dm`);
    assert.equal(store.status, 200);
    assert.match(await store.text(), /Product 1/);

    await app.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
    const { cookie, csrf } = await login(app.base, { phone: '9876543210', password: 'secret1', csrfPage: '/checkout' });
    const res = await fetch(`${app.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({
        items: [{ productId: products[0].id, qty: 1 }],
        customer: { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' },
        reelSlug: 'brunch-edit',
        source: 'dm',
      }),
    });
    assert.equal(res.status, 201);
    const { token } = await res.json();
    const pay = await (await fetch(`${app.base}/order/${token}`)).text();
    assert.match(pay, /<svg/);
    assert.match(pay, /₹149/); // ₹100 + ₹49 delivery

    await fetch(`${app.base}/order/${token}/paid`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf }), redirect: 'manual' });
    assert.equal((await app.repos.orders.getByToken(token)).status, 'payment_submitted');

    const bad = await fetch(`${app.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ items: [] }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /bag is empty/);
  } finally {
    app.close();
  }
});

test('paused reel stores are not shown', async () => {
  const app = await startApp();
  try {
    await seedReel(app.repos, { active: '' });
    assert.equal((await fetch(`${app.base}/r/brunch-edit`)).status, 404);
  } finally {
    app.close();
  }
});

test('the shop lists active products only; /p/:slug and /api/products too', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 2 });
    const hidden = await app.repos.products.create({ name: 'Hidden thing', price: '50' }); // not active
    const shop = await (await fetch(`${app.base}/shop`)).text();
    assert.match(shop, /Product 1/);
    assert.match(shop, /Product 2/);
    assert.doesNotMatch(shop, /Hidden thing/);
    assert.match(await (await fetch(`${app.base}/shop?q=product%202`)).text(), /1 product for/);
    assert.equal((await fetch(`${app.base}/`)).status, 200);

    assert.equal((await fetch(`${app.base}/p/${products[0].slug}`)).status, 200);
    assert.equal((await fetch(`${app.base}/p/${hidden.slug}`)).status, 404);

    const api = await (await fetch(`${app.base}/api/products?ids=${products[0].id},${hidden.id},abc`)).json();
    assert.deepEqual(api.products.map((p) => p.id), [products[0].id]);
    assert.equal(api.products[0].price, 10000);
  } finally {
    app.close();
  }
});

test('payment page offers a UPI app link with the order amount', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    const order = await app.repos.orders.create(
      { items: [{ productId: products[0].id, qty: 1 }], customer: { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' } },
      await app.repos.settings.getAll(),
    );
    const pay = await (await fetch(`${app.base}/order/${order.public_token}`)).text();
    assert.match(pay, /href="upi:\/\/pay\?pa=demo%40upi&amp;pn=[^"]*&amp;am=149\.00/);
  } finally {
    app.close();
  }
});
