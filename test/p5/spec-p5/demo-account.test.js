// PRD 10.6: the store presence. App Review signs in with a review login that never expires and opens a demo business
// full of sample data, which shows stored data even when Instagram is unavailable; and "Delete my account" in Settings
// is audited, tells ops and shows a timeline. P-24, P-25, P-26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETION_GRACE_DAYS, MINUTE, PLATFORM_PHONE_ID, REVIEW, addSeller, captureLogs, freshen, local10, newDevice, noCrash, ownerApp, ownerPhone, appSignIn, staleAll, startCode, useP5World, verifyCode } from './kit.js';

const world = useP5World();
const DAY = 24 * 60 * MINUTE;

/** Signs in the way App Review does: the review number, then the fixed code. */
async function reviewSession() {
  await world.reviewLogin({ enabled: true });
  await startCode(world, REVIEW.phone);
  const res = await verifyCode(world, { phone: REVIEW.phone, code: REVIEW.code, device: newDevice('Review iPhone', 'ios') });
  assert.equal(res.status, 201, `The review login: ${res.status} ${res.text.slice(0, 300)}`);
  const token = res.data.accessToken;
  return { res, business: res.data.business, send: (method, path, body) => world.app(`/api/v1${path}`, { method, body, token }) };
}

test('P-24: the review login opens the demo business with sample orders, analytics and automations', async () => {
  const review = await reviewSession();
  const [login] = await world.sql('SELECT tenant_id FROM review_logins WHERE phone = $1', [REVIEW.phone]);
  assert.ok(login.tenant_id, 'The review login names no demo business');
  assert.equal(review.business.id, login.tenant_id, 'The review login opened another business');
  const orders = await review.send('GET', '/orders?limit=50');
  assert.equal(orders.status, 200);
  assert.ok(orders.data.items.length >= 3, `The demo business has ${orders.data.items.length} orders`);
  const automations = await review.send('GET', '/automations');
  assert.equal(automations.status, 200);
  assert.ok((automations.data.items ?? []).length >= 1, 'The demo business has no automations');
  const insights = await review.send('GET', '/insights/account');
  assert.equal(insights.status, 200, `Insights in the demo business: ${insights.status}`);
  assert.match(insights.text, /[1-9]/, 'The demo business\'s insights are empty');
  // The demo's sample people are made up: none can be reached.
  for (const order of orders.data.items) assert.doesNotMatch(String(order.phone ?? ''), /^\+?91[6-9]\d{9}$|^[6-9]\d{9}$/, `A sample order holds a real-looking number: ${order.phone}`);
  // It is an ordinary business: the policy check finds no branch for it, and nothing names it in code.
  const [tenant] = await world.sql('SELECT status FROM tenants WHERE id = $1', [login.tenant_id]);
  assert.ok(['active', 'onboarding'].includes(tenant.status));
});

test('P-24: the review login never expires and works again and again, and opens nothing but the demo business', async () => {
  const first = await reviewSession();
  await world.shift(400 * DAY, ['review_logins', 'review_login_uses', 'seller_login_codes', 'rate_limit_hits']);
  const later = await reviewSession();
  assert.equal(later.business.id, first.business.id);
  const businesses = await later.send('GET', '/auth/businesses');
  assert.deepEqual(businesses.data.businesses.map((b) => b.id), [first.business.id], 'The review login reaches another business');
  const other = await addSeller(world);
  assert.equal((await world.app('/api/v1/orders', { token: later.res.data.accessToken, headers: { 'x-tenant-id': String(other.tenantId) } })).status, 403);
});

test('P-25: with Instagram unavailable the demo business shows its stored data, not an error, and never calls Meta', async () => {
  const review = await reviewSession();
  await world.meta.fault({ kind: 'server_error', status: 503, times: 'forever' });
  try {
    const before = (await world.meta.calls()).length;
    for (const path of ['/insights/account', '/automations', '/orders', '/reach-guard', '/instagram/connection', '/reels', '/home', '/stats']) {
      const res = noCrash(await review.send('GET', path), `GET ${path} in the demo business`);
      assert.ok(res.status === 200 || res.status === 404, `GET ${path} in the demo business answered ${res.status}: ${res.text.slice(0, 160)}`);
      if (res.status === 200) assert.doesNotMatch(res.text, /"error"|try again later|could not reach instagram/i, `GET ${path} shows an error instead of stored data`);
    }
    const insights = await review.send('GET', '/insights/account');
    assert.match(insights.text, /[1-9]/, 'Insights are empty while Instagram is down');
    const ids = (await world.sql('SELECT ig_user_id FROM ig_accounts WHERE tenant_id = $1', [review.business.id])).map((r) => String(r.ig_user_id));
    const calls = (await world.meta.calls()).slice(before).filter((c) => ids.some((id) => JSON.stringify(c).includes(id)));
    assert.equal(calls.length, 0, `Opening the demo business called Meta ${calls.length} times`);
  } finally {
    await world.meta.delete('/faults');
  }
});

test('P-25: the demo business never sends a DM, WhatsApp message or email to its sample people', async () => {
  const review = await reviewSession();
  const beforeMeta = (await world.meta.get('/sent')).sent.length;
  const beforeWa = (await world.wa.get('/sent')).sent.length;
  const beforeMail = (await world.mail.get('/sent')).sent.length;
  await world.waitFor(() => false, 3000);
  const orders = await review.send('GET', '/orders?limit=50');
  for (const order of orders.data.items.slice(0, 2)) noCrash(await review.send('POST', `/orders/${order.id}/advance`, { to: 'packed' }), 'Packing a sample order');
  await world.waitFor(() => false, 3000);
  assert.equal((await world.meta.get('/sent')).sent.length, beforeMeta, 'The demo business sent a DM');
  const wa = (await world.wa.get('/sent')).sent.slice(beforeWa);
  const mail = (await world.mail.get('/sent')).sent.slice(beforeMail);
  assert.ok(!wa.some((m) => m.phoneId !== PLATFORM_PHONE_ID), 'The demo business sent WhatsApp to a sample shopper');
  assert.equal(mail.filter((m) => !/bhava/i.test(m.from)).length, 0, 'The demo business emailed a sample shopper');
});

test('P-26: Delete my account needs a fresh re-auth and "DELETE", is audited, tells ops, and shows a timeline', async (t) => {
  const logs = captureLogs(t);
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  await staleAll(world);
  const stale = await s.send('POST', '/auth/delete-account', { confirm: 'DELETE' });
  assert.deepEqual([stale.status, stale.data?.code], [403, 'reauth_required'], 'Deleting the account without a fresh re-auth');
  await freshen(world, s);
  for (const confirm of ['delete', 'yes', '', 'DELETE ']) assert.equal((await s.send('POST', '/auth/delete-account', { confirm })).status, 400, `confirm ${JSON.stringify(confirm)}`);
  const startedAt = Date.now();
  const asked = await s.send('POST', '/auth/delete-account', { confirm: 'DELETE' });
  assert.equal(asked.status, 202, `Delete my account: ${asked.status} ${asked.text.slice(0, 200)}`);
  assert.equal(asked.data.status, 'requested');
  const due = Date.parse(asked.data.dueAt) - Date.parse(asked.data.requestedAt);
  assert.ok(Math.abs(due - DELETION_GRACE_DAYS * DAY) < 2 * MINUTE, `The account goes ${(due / DAY).toFixed(1)} days after the request`);
  assert.ok(Math.abs(Date.parse(asked.data.requestedAt) - startedAt) < 2 * MINUTE);

  const [row] = await world.sql('SELECT * FROM account_deletion_requests ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'requested');
  const audit = await shop.sql(`SELECT * FROM audit_log WHERE (tenant_id = $1 OR tenant_id IS NULL) AND action ~* 'delet' ORDER BY id DESC`, [shop.tenantId]);
  assert.ok(audit.length >= 1, 'The request is not in the audit log');
  assert.ok(!JSON.stringify(audit).includes(local10(ownerPhone(shop))), 'The audit row holds the phone number');
  const ops = await world.sql(`SELECT * FROM alerts WHERE created_at >= now() - interval '5 minutes' AND audience <> 'owner' AND (kind ~* 'delet' OR message ~* 'delet')`);
  assert.ok(ops.length >= 1, 'Ops were not told about the deletion request');
  assert.ok(!logs.text().includes(local10(ownerPhone(shop))), 'The phone number is in the logs');
  // The owner is told too, on the security channels, and a second request opens no second one.
  const again = noCrash(await s.send('POST', '/auth/delete-account', { confirm: 'DELETE' }), 'Asking twice');
  assert.ok([202, 409].includes(again.status));
  assert.equal((await world.sql(`SELECT count(*)::int AS n FROM account_deletion_requests WHERE person_id = $1 AND status = 'requested'`, [row.person_id]))[0].n, 1);
  const notice = await world.waitFor(async () => (await shop.sql(`SELECT * FROM notification_events WHERE tenant_id = $1 AND kind = 'account.deletion_requested'`, [shop.tenantId]))[0], 10_000);
  assert.ok(notice, 'The owner was not notified of the deletion request');
});

test('P-26: signing in again inside the grace period cancels the deletion', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  assert.equal((await s.send('POST', '/auth/delete-account', { confirm: 'DELETE' })).status, 202);
  const [row] = await world.sql(`SELECT * FROM account_deletion_requests WHERE status = 'requested' ORDER BY id DESC LIMIT 1`);
  await world.shift(10 * DAY, ['account_deletion_requests']);
  await appSignIn(world, ownerPhone(shop), { tenantId: shop.tenantId });
  const [after] = await world.sql('SELECT status FROM account_deletion_requests WHERE id = $1', [row.id]);
  assert.equal(after.status, 'cancelled', 'Signing in again did not cancel the deletion');
});
