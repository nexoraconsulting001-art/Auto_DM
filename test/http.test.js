import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { REEL_ID, login, seedReel, startApp } from './helpers.js';
import { withConsoleApi } from './p0/console-port/support/console-api.js';

const sign = (body, secret = 'secret') => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

// The webhook answers 200 before it does the work, so tests wait for the outcome. A fixed sleep loses this race on a busy machine.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 5000) {
  for (const end = Date.now() + ms; !(await check()) && Date.now() < end; ) await pause(20);
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

test('there is no forwarding to another app and no /l/ redirect, even with the old settings present', async () => {
  const app = await startApp({ overrides: { forwardWebhookUrl: 'http://127.0.0.1:9/webhook', pluginUrl: 'https://plugin.test' } });
  const realFetch = globalThis.fetch;
  const outgoing = [];
  globalThis.fetch = (url, init) => {
    if (!String(url).startsWith(app.base)) outgoing.push(String(url));
    return realFetch(url, init);
  };
  try {
    await seedReel(app.repos);
    const body = JSON.stringify({ entry: [{ id: 'ME', changes: [{ field: 'comments', value: { id: 'c2', text: 'LINK', media: { id: '999' }, from: { id: 'u1', username: 'bob' } } }] }] });
    await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    await waitFor(async () => (await app.repos.activity.count()) > 0);
    await pause(100); // room for a forward, if there were one
    assert.equal(await app.repos.activity.count(), 1);
    assert.deepEqual(outgoing, []);

    const res = await fetch(`${app.base}/l/winter-bulbs?src=dm`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  } finally {
    globalThis.fetch = realFetch;
    app.close();
  }
});

test('admin requires the owner login and a CSRF token', async () => {
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const anon = await fetch(`${app.base}/api/v1/products`, { redirect: 'manual' });
    assert.equal(anon.status, 401);
    const wrong = await fetch(`${app.base}/login`, { method: 'POST', body: new URLSearchParams({ phone: '9000000001', password: 'nope' }) });
    assert.equal(wrong.status, 401);

    const { cookie, csrf, location } = await login(app.base);
    assert.equal(location, '/admin');
    const body = JSON.stringify({ name: 'Kurta', pricePaise: 99900, active: true });
    const headers = { cookie, 'content-type': 'application/json' };
    const noCsrf = await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers, body, redirect: 'manual' });
    assert.equal(noCsrf.status, 403);
    assert.equal((await app.repos.products.list()).length, 0);
    const ok = await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers: { ...headers, 'x-csrf-token': csrf }, body, redirect: 'manual' });
    assert.equal(ok.status, 201);
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
