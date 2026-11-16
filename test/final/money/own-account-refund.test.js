// money-12: a refund on the seller's own gateway account goes to the account the payment ran on. When the store has since
// connected a different account, nothing is sent to the new one: the refund is marked for the owner to make at the old
// gateway, and it is not offered as "try again".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { openWorld, raw, refundBody } from '../../p4/payments/support.js';

async function connectOwn(world, shop, accountId) {
  const link = await shop.api('POST', '/payment-account/connect');
  assert.equal(link.status, 200, link.text);
  const url = new URL(link.json.url);
  const { code } = await world.rzp.post('/oauth/code', { accountId });
  const back = await raw(world.port, `${STORE_PROVIDER_PATHS.razorpayOauth.path}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}`, { host: 'payments.bhava.test' });
  assert.equal(back.status, 303, back.text);
  const { key, secret } = await shop.run((p) => p.settings.webhookSecret());
  await world.rzp.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.razorpayOwn.path.replace(':key', key)}`, accountId, secret });
}

test('money-12: after switching to another own account, an older payment is never refunded through the new one', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  await connectOwn(world, shop, 'acc_sellerold0001');
  assert.equal((await shop.api('PUT', '/payment-account/mode', { mode: 'own' })).status, 200);
  const { order } = await shop.paidOrder({ totalPaise: 60000 });
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.account_ref, 'acc_sellerold0001');

  // The seller connects a different Razorpay account.
  await connectOwn(world, shop, 'acc_sellernew0002');
  assert.equal((await shop.one('SELECT own_account_id FROM payment_settings WHERE tenant_id = $1', [shop.tenant.id])).own_account_id, 'acc_sellernew0002');

  const before = (await world.rzp.calls({ method: 'POST', path: '/v1/payments/*/refund' })).length;
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, 'failed');
  assert.equal((await world.rzp.calls({ method: 'POST', path: '/v1/payments/*/refund' })).length, before, 'nothing was sent to the new account');
  const [refund] = await shop.refunds(order.id);
  assert.equal(refund.error_code, 'account_changed');
  const [alert] = await shop.alerts('refund.failed');
  assert.match(alert.message, /payment account/i, 'the owner is told to refund at the old account');
  assert.doesNotMatch(alert.message, /Try it again/);
  const again = await shop.api('POST', `/refunds/${refund.id}/retry`);
  assert.equal(again.status, 409, again.text);
});

test('money-12: own keys replaced by keys of another account are told apart from the keys a payment ran on', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const creds = (await shop.run(async (p) => {
    await shop.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_test_first0001', keySecret: 'secret-one-000000001' }, 'user:1');
    await p.settings.setMode('own', 'user:1');
    return p.settings.credentials('own');
  }));
  assert.equal(creds.accountRef, 'rzp_test_first0001');
  const now = await shop.run(async (p) => {
    await shop.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_test_second002', keySecret: 'secret-two-000000002' }, 'user:1');
    return p.settings.credentials('own');
  });
  assert.equal(now.accountRef, 'rzp_test_second002', 'the label follows the keys in use');
  await assert.rejects(() => shop.run((p) => p.settings.credentials('own', { accountRef: 'rzp_test_first0001' })), (err) => err.name === 'PaymentError' && err.reason === 'account_changed');
});
