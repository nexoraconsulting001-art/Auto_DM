// The seller's own gateway account (PRD 9.6 bring your own, 9.7 one URL per business): Partner OAuth, a switch that applies to
// new orders only (S-72), webhooks verified with the business's own secret, and refunds with no Route reversal (S-76).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { openWorld, raw, refundBody } from './support.js';

/** Connects the business's own Razorpay account the way the owner does: the connect link, the consent screen, the callback. */
async function connectOwn(world, shop, accountId = 'acc_sellerown0001') {
  const link = await shop.api('POST', '/payment-account/connect');
  assert.equal(link.status, 200, link.text);
  const url = new URL(link.json.url);
  assert.equal(url.searchParams.get('client_id'), world.rzp.partner.clientId);
  const { code } = await world.rzp.post('/oauth/code', { accountId });
  const back = await raw(world.port, `${STORE_PROVIDER_PATHS.razorpayOauth.path}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}`, { host: 'payments.bhava.test' });
  assert.equal(back.status, 303, back.text);
  assert.match(back.headers.location, /\/admin\/settings\?payments=connected$/);
  // Bhava receives the account's webhooks at the business's own address, signed with the secret it keeps.
  const { key, secret } = await shop.run((p) => p.settings.webhookSecret());
  await world.rzp.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.razorpayOwn.path.replace(':key', key)}`, accountId, secret });
  return { accountId, key, secret };
}

test('S-72, S-76: after switching to its own account new orders run there, earlier ones keep settling through Route, and its refunds reverse nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const before = await shop.paidOrder({ totalPaise: 80000 });
  assert.equal(before.order.gateway_mode, 'managed');

  const own = await connectOwn(world, shop);
  let account = (await shop.api('GET', '/payment-account')).json;
  assert.equal(account.ownConnection, 'oauth');
  assert.equal(account.mode, 'managed', 'connecting does not switch by itself');
  const stored = await shop.one('SELECT * FROM payment_settings WHERE tenant_id = $1', [shop.tenant.id]);
  assert.doesNotMatch(JSON.stringify(stored), /rzp_at_|rzp_rt_/, 'tokens are stored encrypted');
  assert.equal((await shop.api('PUT', '/payment-account/mode', { mode: 'own' })).status, 200);
  account = (await shop.api('GET', '/payment-account')).json;
  assert.equal(account.mode, 'own');
  assert.match(account.webhookUrl, new RegExp(`/webhooks/razorpay/${own.key}$`));
  assert.equal((await shop.sql(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'payment_mode.change'`, [shop.tenant.id])).length, 1);

  // A new order is paid on the seller's own account, confirmed by its own webhook.
  const after = await shop.paidOrder({ totalPaise: 60000 });
  assert.equal(after.order.gateway_mode, 'own');
  assert.equal(after.order.payment_status, 'paid');
  assert.match(after.placed.gateway.keyId, /^rzp_test_oauth_/, 'checkout opens with the seller’s own account');
  const [ownPayment] = await shop.payments(after.order.id);
  assert.equal(ownPayment.mode, 'own');
  assert.equal(ownPayment.account_ref, own.accountId);
  const ownEvents = await world.db.platform.query(`SELECT * FROM provider_webhook_events WHERE scope = $1`, [`tenant:${shop.tenant.id}`]);
  assert.ok(ownEvents.some((e) => e.event_type === 'payment.captured' && e.status === 'processed'));
  const { transfers } = await world.rzp.get('/state');
  assert.equal(transfers.some((x) => x.source === ownPayment.gateway_payment_id), false, 'no Route transfer on the seller’s own account');

  // S-76: its refund goes through its own account and reverses nothing.
  const ownRefund = await shop.api('POST', `/orders/${after.order.id}/refunds`, refundBody(10000));
  assert.equal(ownRefund.status, 201, ownRefund.text);
  assert.equal(ownRefund.json.status, 'processed');
  assert.equal(ownRefund.json.reversalStatus, 'none');
  assert.equal(ownRefund.json.reversalPaise, 0);
  assert.equal((await shop.lines(after.order.id)).some((l) => l.kind === 'transfer_reversal'), false);

  // S-72: the earlier order still settles through Route, so its refund takes back part of the seller's transfer.
  const oldRefund = await shop.api('POST', `/orders/${before.order.id}/refunds`, refundBody(5000));
  assert.equal(oldRefund.json.status, 'processed');
  assert.equal(oldRefund.json.reversalStatus, 'reversed');
  assert.equal(oldRefund.json.reversalPaise, 5000);
});

test('own mode: the browser’s return is confirmed by asking the seller’s account; a webhook naming another business’s order is flagged', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const own = await connectOwn(world, shop);
  await shop.api('PUT', '/payment-account/mode', { mode: 'own' });
  const order = await shop.placeOrder({ totalPaise: 40000 });
  const placed = await shop.start(order.id);
  const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false });
  const res = await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: paid.signature });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, 'paid');

  // Another business, in managed mode, with an order of its own.
  const other = await world.secondBusiness();
  await other.payReady();
  const theirs = await other.placeOrder({ totalPaise: 40000 });
  const theirPlaced = await other.start(theirs.id);
  const path = STORE_PROVIDER_PATHS.razorpayOwn.path.replace(':key', own.key);
  const hook = await world.hook('payment.captured', { payment: { entity: { id: 'pay_crossed00001', order_id: theirPlaced.gateway.gatewayOrderId, amount: 40000, currency: 'INR', status: 'captured' } } }, { path, secret: own.secret, accountId: own.accountId });
  assert.equal(hook.status, 200);
  await world.settle();
  const [row] = await world.db.platform.query(`SELECT * FROM provider_webhook_events WHERE event_type = 'payment.captured' AND payload->'payment'->>'id' = 'pay_crossed00001'`);
  assert.equal(row.scope, `tenant:${shop.tenant.id}`);
  assert.equal(row.outcome, 'tenant_mismatch');
  assert.equal(row.security, true);
  assert.equal((await other.order(theirs.id)).payment_status, 'unpaid', 'the other business’s order is untouched');

  // An address no business has, and a delivery signed with another secret, are refused and nothing is stored.
  const count = (await world.webhookRows()).length;
  assert.equal((await world.hook('payment.captured', { payment: { entity: { id: 'pay_1' } } }, { path: STORE_PROVIDER_PATHS.razorpayOwn.path.replace(':key', 'x'.repeat(32)), secret: own.secret })).status, 401);
  assert.equal((await world.hook('payment.captured', { payment: { entity: { id: 'pay_1' } } }, { path, secret: world.rzp.webhookSecret })).status, 401);
  assert.equal((await world.webhookRows()).length, count);
});

test('a Cashfree delivery to the business’s own address is verified with its own key and stored, and not acted on', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const own = await connectOwn(world, shop);
  await shop.inTenant(() => shop.repos.gatewayKeys.save('cashfree', { keyId: 'cf_app_test', keySecret: 'cf-secret-test' }, 'user:1'));
  const path = STORE_PROVIDER_PATHS.cashfreeOwn.path.replace(':key', own.key);
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'cf_1' } } });
  const stamp = String(Date.now());
  const { createHmac } = await import('node:crypto');
  const sign = (secret) => createHmac('sha256', secret).update(stamp + body).digest('base64');
  const send = (signature) => raw(world.port, path, { method: 'POST', body, headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': stamp } });
  assert.equal((await send(sign('wrong-secret'))).status, 401);
  assert.equal((await send(sign('cf-secret-test'))).status, 200);
  assert.equal((await send(sign('cf-secret-test'))).status, 200, 'the same delivery again is answered and stored once');
  await world.settle();
  const rows = await world.db.platform.query(`SELECT * FROM provider_webhook_events WHERE provider = 'cashfree'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, `tenant:${shop.tenant.id}`);
  assert.equal(rows[0].status, 'ignored');
  assert.equal(rows[0].outcome, 'not_handled');
});

test('disconnecting the own account sends new orders back to managed, and a stale OAuth link is refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  await connectOwn(world, shop);
  await shop.api('PUT', '/payment-account/mode', { mode: 'own' });
  assert.equal((await shop.api('DELETE', '/payment-account/own')).status, 204);
  const account = (await shop.api('GET', '/payment-account')).json;
  assert.equal(account.mode, 'managed');
  assert.equal(account.ownConnection, 'none');
  const order = await shop.placeOrder();
  assert.equal((await shop.start(order.id)).gateway.keyId, world.rzp.keyId);
  // A forged or altered state is refused, and nothing is connected.
  const bad = await raw(world.port, `${STORE_PROVIDER_PATHS.razorpayOauth.path}?code=abc&state=eyJ0IjoxfQ.forged`, { host: 'payments.bhava.test' });
  assert.equal(bad.status, 400);
  assert.equal((await shop.api('GET', '/payment-account')).json.ownConnection, 'none');
});
