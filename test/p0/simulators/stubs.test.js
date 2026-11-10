import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { createRazorpay } from '../../../tools/sim/razorpay/index.mjs';
import { createShiprocket } from '../../../tools/sim/shiprocket/index.mjs';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { request } from './support.js';

async function start(t, create, options) {
  const sim = await create(options).start();
  t.after(() => sim.close());
  return sim;
}

async function assertShared(sim, path, init) {
  await sim.fault({ kind: 'rate_limit', retryAfter: 9 });
  const limited = await request(`${sim.url}${path}`, init);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '9');
  await sim.fault({ kind: 'server_error', status: 503 });
  assert.equal((await request(`${sim.url}${path}`, init)).status, 503);
  await sim.fault({ kind: 'malformed', mode: 'garbage' });
  assert.equal((await request(`${sim.url}${path}`, init)).body, null);
  await sim.fault({ kind: 'drop' });
  assert.equal((await request(`${sim.url}${path}`, init)).status, null);
  const calls = await sim.calls();
  assert.deepEqual(calls.slice(-4).map((c) => c.fault.kind), ['rate_limit', 'server_error', 'malformed', 'drop']);
  await sim.post('/reset');
  assert.deepEqual(await sim.calls(), []);
}

const WA = { 'content-type': 'application/json', authorization: 'Bearer sim-whatsapp-token' };

test('whatsapp: sends, reads the number, refuses a bad token and shares the base', async (t) => {
  const sim = await start(t, createWhatsApp);
  const sendPath = '/v21.0/123/messages';
  const res = await request(`${sim.url}${sendPath}`, { headers: WA, json: { messaging_product: 'whatsapp', to: '919000000001', type: 'template', template: { name: 'otp' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.messaging_product, 'whatsapp');
  assert.deepEqual(res.body.contacts, [{ input: '919000000001', wa_id: '919000000001' }]);
  assert.ok(res.body.messages[0].id);
  assert.equal((await sim.get('/sent')).sent[0].to, '919000000001');

  assert.equal((await request(`${sim.url}/v21.0/123`, { headers: WA })).body.id, '123');
  const denied = await request(`${sim.url}${sendPath}`, { headers: { ...WA, authorization: 'Bearer nope' }, json: {} });
  assert.deepEqual([denied.status, denied.body.error.code], [401, 190]);
  assert.equal((await request(`${sim.url}${sendPath}`, { headers: WA, json: { to: '919000000001' } })).status, 400);
  assert.equal((await request(`${sim.url}${sendPath}`, { headers: WA, json: { messaging_product: 'whatsapp', to: 'abc' } })).status, 400);
  assert.equal((await request(`${sim.url}${sendPath}`, { headers: WA, json: { messaging_product: 'whatsapp', to: '919000000001', type: 'hologram' } })).status, 400);

  await assertShared(sim, sendPath, { headers: WA, json: { messaging_product: 'whatsapp', to: '919000000001' } });
  assert.deepEqual((await sim.get('/sent')).sent, [], 'reset clears the service data');
});

const RZP = { authorization: `Basic ${Buffer.from('rzp_test_sim:sim-key-secret').toString('base64')}`, 'content-type': 'application/json' };

test('razorpay: orders in integer paise, payment, refund, auth and the shared base', async (t) => {
  const sim = await start(t, createRazorpay);
  const order = await request(`${sim.url}/v1/orders`, { headers: RZP, json: { amount: 49900, currency: 'INR', receipt: 'r1' } });
  assert.equal(order.status, 200);
  assert.match(order.body.id, /^order_/);
  assert.deepEqual([order.body.amount, order.body.amount_due, order.body.status], [49900, 49900, 'created']);
  assert.equal((await request(`${sim.url}/v1/orders/${order.body.id}`, { headers: RZP })).body.receipt, 'r1');

  const { payment, signature } = await sim.post('/pay', { orderId: order.body.id });
  assert.equal(signature, crypto.createHmac('sha256', 'sim-key-secret').update(`${order.body.id}|${payment.id}`).digest('hex'));
  assert.equal((await request(`${sim.url}/v1/orders/${order.body.id}`, { headers: RZP })).body.status, 'paid');
  assert.equal((await request(`${sim.url}/v1/payments/${payment.id}`, { headers: RZP })).body.status, 'captured');
  await assert.rejects(() => sim.post('/pay', { orderId: order.body.id }), /already paid/);

  const refund = await request(`${sim.url}/v1/payments/${payment.id}/refund`, { headers: RZP, json: { amount: 100 } });
  assert.deepEqual([refund.status, refund.body.amount], [200, 100]);
  assert.equal((await request(`${sim.url}/v1/payments/${payment.id}/refund`, { headers: RZP, json: { amount: 49801 } })).status, 400, 'cannot refund more than is left');
  assert.equal((await request(`${sim.url}/v1/payments/${payment.id}/refund`, { headers: RZP, json: {} })).body.amount, 49800, 'no amount refunds the rest');

  for (const amount of [99.5, '49900', 99, -1, 0]) {
    const bad = await request(`${sim.url}/v1/orders`, { headers: RZP, json: { amount } });
    assert.equal(bad.status, 400, String(amount));
    assert.equal(bad.body.error.code, 'BAD_REQUEST_ERROR');
  }
  assert.equal((await request(`${sim.url}/v1/orders`, { headers: { ...RZP, authorization: 'Basic bm9wZTpub3Bl' }, json: { amount: 100 } })).status, 401);
  assert.equal((await request(`${sim.url}/v1/orders`, { headers: { 'content-type': 'application/json' }, json: { amount: 100 } })).status, 401);
  assert.equal((await request(`${sim.url}/v1/orders/order_none`, { headers: RZP })).status, 400);
  assert.equal((await request(`${sim.url}/v1/payments/pay_none`, { headers: RZP })).status, 400);
  await assert.rejects(() => sim.post('/pay', { orderId: 'none' }), /No such order/);

  await assertShared(sim, '/v1/orders', { headers: RZP, json: { amount: 100 } });
});

test('razorpay: a partial fault leaves the order created when the caller saw a failure', async (t) => {
  const sim = await start(t, createRazorpay);
  await sim.fault({ kind: 'partial' });
  assert.equal((await request(`${sim.url}/v1/orders`, { headers: RZP, json: { amount: 500 } })).status, 500);
  const [call] = await sim.calls();
  assert.deepEqual([call.applied, call.handled.status], [true, 200]);
  assert.equal((await request(`${sim.url}/v1/orders/${call.handled.body.id}`, { headers: RZP })).status, 200);
});

test('shiprocket: login, serviceability, create, track and the shared base', async (t) => {
  const sim = await start(t, createShiprocket);
  const login = await request(`${sim.url}/v1/external/auth/login`, { json: { email: 'sim@bhava.test', password: 'sim-shiprocket-password' } });
  assert.equal(login.status, 200);
  const auth = { authorization: `Bearer ${login.body.token}`, 'content-type': 'application/json' };
  assert.equal((await request(`${sim.url}/v1/external/auth/login`, { json: { email: 'x', password: 'y' } })).status, 403);

  const rates = await request(`${sim.url}/v1/external/courier/serviceability/?pickup_postcode=110001&delivery_postcode=560001`, { headers: auth });
  assert.ok(Number.isInteger(rates.body.data.available_courier_companies[0].rate));
  assert.equal((await request(`${sim.url}/v1/external/courier/serviceability/?pickup_postcode=1&delivery_postcode=2`, { headers: auth })).status, 422);

  const created = await request(`${sim.url}/v1/external/orders/create/adhoc`, { headers: auth, json: { order_id: 'B-1', order_items: [{ name: 'x', units: 1 }] } });
  assert.deepEqual([created.status, created.body.channel_order_id, created.body.status], [200, 'B-1', 'NEW']);
  assert.equal((await request(`${sim.url}/v1/external/orders/create/adhoc`, { headers: auth, json: {} })).status, 422);

  await sim.post('/track', { shipmentId: created.body.shipment_id, status: 'DELIVERED' });
  const tracked = await request(`${sim.url}/v1/external/courier/track/shipment/${created.body.shipment_id}`, { headers: auth });
  assert.equal(tracked.body.tracking_data.shipment_track[0].current_status, 'DELIVERED');
  assert.equal((await request(`${sim.url}/v1/external/courier/track/shipment/999`, { headers: auth })).status, 404);
  assert.equal((await request(`${sim.url}/v1/external/courier/track/shipment/1`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  await assert.rejects(() => sim.post('/track', { shipmentId: 999 }), /No such shipment/);

  await assertShared(sim, '/v1/external/auth/login', { json: { email: 'sim@bhava.test', password: 'sim-shiprocket-password' } });
});

test('shopify: token exchange, shop, products, orders, auth and the shared base', async (t) => {
  const sim = await start(t, createShopify);
  const exchange = await request(`${sim.url}/admin/oauth/access_token`, { json: { client_id: 'sim-shopify-client', client_secret: 'sim-shopify-secret', code: 'c' } });
  assert.equal(exchange.body.access_token, 'sim-shopify-token');
  assert.equal((await request(`${sim.url}/admin/oauth/access_token`, { json: { client_id: 'x', client_secret: 'y', code: 'c' } })).status, 400);

  const headers = { 'x-shopify-access-token': 'sim-shopify-token' };
  assert.equal((await request(`${sim.url}/admin/api/2025-01/shop.json`, { headers })).body.shop.currency, 'INR');
  await sim.post('/products', { title: 'Kurta' });
  await sim.post('/orders', { name: '#1001' });
  assert.equal((await request(`${sim.url}/admin/api/2025-01/products.json`, { headers })).body.products[0].title, 'Kurta');
  assert.equal((await request(`${sim.url}/admin/api/2025-01/orders.json`, { headers })).body.orders[0].name, '#1001');
  assert.equal((await request(`${sim.url}/admin/api/2025-01/shop.json`)).status, 401);
  assert.equal((await request(`${sim.url}/admin/api/2025-01/products.json`, { headers: { 'x-shopify-access-token': 'nope' } })).status, 401);

  await assertShared(sim, '/admin/api/2025-01/shop.json', { headers });
});

const CLIENT = { client_id: 'sim-google-client', client_secret: 'sim-google-secret' };
const CALLBACK = 'http://127.0.0.1:3000/auth/google/callback';

function authUrl(sim, query = {}) {
  const url = new URL(`${sim.url}/o/oauth2/v2/auth`);
  for (const [key, value] of Object.entries({ client_id: CLIENT.client_id, redirect_uri: CALLBACK, response_type: 'code', scope: 'openid email', state: 'g1', ...query })) url.searchParams.set(key, value);
  return url;
}

const token = (sim, code, extra = {}) => request(`${sim.url}/token`, { method: 'POST', body: new URLSearchParams({ ...CLIENT, code, grant_type: 'authorization_code', redirect_uri: CALLBACK, ...extra }) });

test('google: discovery, consent, code exchange, userinfo, tokeninfo and the shared base', async (t) => {
  const sim = await start(t, createGoogle);
  const discovery = await request(`${sim.url}/.well-known/openid-configuration`);
  assert.equal(discovery.body.token_endpoint, `${sim.url}/token`);

  await sim.post('/next-user', { sub: 'g-42', email: 'owner@shop.test', name: 'Asha' });
  const consent = await request(authUrl(sim, { nonce: 'n1' }));
  assert.equal(consent.status, 302);
  const location = new URL(consent.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 'g1');
  const res = await token(sim, location.searchParams.get('code'));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.token_type, res.body.expires_in], ['Bearer', 3600]);

  const user = await request(`${sim.url}/oauth2/v3/userinfo`, { headers: { authorization: `Bearer ${res.body.access_token}` } });
  assert.deepEqual([user.body.sub, user.body.email], ['g-42', 'owner@shop.test']);
  const info = await request(`${sim.url}/tokeninfo?id_token=${res.body.id_token}`);
  assert.deepEqual([info.status, info.body.aud, info.body.sub, info.body.nonce], [200, CLIENT.client_id, 'g-42', 'n1']);

  assert.equal((await token(sim, location.searchParams.get('code'))).status, 400, 'a code works once');
  const tampered = `${res.body.id_token.slice(0, -2)}xx`;
  assert.equal((await request(`${sim.url}/tokeninfo?id_token=${tampered}`)).status, 400);
  assert.equal((await request(`${sim.url}/tokeninfo?id_token=abc`)).status, 400);
  await sim.post('/clock', { advanceMs: 3_600_000 });
  assert.equal((await request(`${sim.url}/tokeninfo?id_token=${res.body.id_token}`)).status, 400, 'an expired id_token is refused');

  assert.equal((await request(`${sim.url}/oauth2/v3/userinfo`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await request(authUrl(sim, { client_id: 'other' }))).status, 400);
  assert.equal((await request(authUrl(sim, { redirect_uri: 'https://outside.example/cb' }))).status, 400);
  await sim.post('/next-user', { deny: true });
  assert.equal(new URL((await request(authUrl(sim))).headers.get('location')).searchParams.get('error'), 'access_denied');
  const code = new URL((await request(authUrl(sim))).headers.get('location')).searchParams.get('code');
  assert.equal((await token(sim, code, { client_secret: 'wrong' })).status, 401);
  assert.equal((await token(sim, code, { grant_type: 'refresh_token' })).status, 400);
  assert.equal((await token(sim, code, { redirect_uri: 'http://127.0.0.1:3000/other' })).status, 400);

  await assertShared(sim, '/.well-known/openid-configuration', {});
});

test('credentials can be set per simulator', async (t) => {
  const wa = await start(t, createWhatsApp, { token: 'my-wa-token' });
  const res = await request(`${wa.url}/v21.0/1`, { headers: { authorization: 'Bearer my-wa-token' } });
  assert.equal(res.status, 200);
  const shopify = await start(t, createShopify, { token: 'my-shopify-token' });
  assert.equal((await request(`${shopify.url}/admin/api/2025-01/shop.json`, { headers: { 'x-shopify-access-token': 'my-shopify-token' } })).status, 200);
});
