// PRD 5.6, done-for-you onboarding, against the real app and the simulators: the owner's link (single use, 7 days, a hash,
// a resend revokes), the checklist by tier with every state from a live check, payments on Bhava's Route account with KYC
// in the flow, the pickup location on the master courier account, own keys that are never saved when their test call
// fails, and the operator's active time. F-26 to F-31, F-77 to F-80, F-108.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { INVITE_EXPIRED_MESSAGE, stepsFor } from '../../../src/contracts/onboarding.js';
import { connectInstagramFlow } from '../../p1/spec-p1/support.js';
import { APP, buyer, consoleUser, hit, json, need, one, opCall, shopOn, sql, unique, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
const DAY = 86_400_000;
const numericId = () => String(17_841_400_000_000_000n + BigInt(crypto.randomInt(1, 2 ** 30)) * 1000n);
const tokenOf = (url) => [...String(url).matchAll(/[\w-]{20,200}/g)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0];
const openInvite = (token, extra = {}) => hit(world, '/api/v1/setup/invite', { host: APP, method: 'POST', body: { token }, ...extra });
const checklist = async (shop) => json(need(await shop.send('GET', '/setup'), 200, 'The checklist'));
const step = (list, name) => list.steps.find((s) => s.step === name);
const ALL_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights'];

async function invite(shop, op, via = []) {
  const sent = json(need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/onboarding/invite`, { via }), 201, 'Sending the invite'));
  return { ...sent, token: tokenOf(sent.url) };
}

async function freshShop(plan = 't1', options = {}) {
  const shop = await shopOn(world, plan, { igConnected: false, pay: false, pickup: false, notice: false, whatsapp: false, ...options });
  shop.igUserId = numericId();
  await world.meta.post('/accounts', { igUserId: shop.igUserId, username: `own_${unique()}`, subscribedFields: ['comments', 'messages', 'messaging_postbacks', 'mentions'], appRole: true });
  return shop;
}

/** Connects Instagram with only these permissions granted. */
async function connectWith(shop, scopes) {
  await world.meta.post('/oauth/next', { igUserId: shop.igUserId, scopes });
  const start = need(await shop.send('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
  const consent = await fetch(json(start).authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await hit(world, `${back.pathname}${back.search}`, { host: shop.host });
}

test('F-26, F-27: the invite is stored as a hash, opens once on the sign-in host, names its business, and the token is in no log or audit row', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const sent = await invite(shop, op);
  assert.match(sent.url, /#/, 'the token travels after # so no server or proxy logs it');
  assert.ok(sent.token.length >= 40);
  const stored = await one(world, 'SELECT token_hash, expires_at, created_at FROM onboarding_invites WHERE tenant_id = $1', [shop.tenantId]);
  assert.notEqual(stored.token_hash, sent.token);
  assert.equal(stored.token_hash, crypto.createHash('sha256').update(sent.token).digest('base64url'));
  assert.ok(new Date(stored.expires_at) - new Date(stored.created_at) <= 7 * DAY);
  // Not on a business's own address.
  assert.equal((await hit(world, '/api/v1/setup/invite', { host: shop.host, method: 'POST', body: { token: sent.token } })).status, 404);
  const opened = json(need(await openInvite(sent.token), 200, 'Opening the invite'));
  assert.deepEqual([opened.tenantId, opened.businessName], [shop.tenantId, shop.name]);
  const again = await openInvite(sent.token);
  assert.equal(again.status, 409);
  assert.match(again.text, new RegExp(INVITE_EXPIRED_MESSAGE.replace(/[.]/g, '\\.')));
  assert.equal(json(again).tenantId, undefined);
  const audit = await sql(world, `SELECT action, details::text AS d FROM audit_log WHERE tenant_id = $1 AND action LIKE 'onboarding.invite%'`, [shop.tenantId]);
  assert.deepEqual(audit.map((a) => a.action).sort(), ['onboarding.invite_opened', 'onboarding.invite_sent']);
  assert.ok(audit.every((a) => !a.d.includes(sent.token) && !a.d.includes(stored.token_hash)), 'no token or hash in the audit log');
});

test('F-27: day 7 opens, day 8 asks for a new link, a resend revokes the old one, three at once get in once, and junk never opens anything', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const age = (ms) => sql(world, `UPDATE onboarding_invites SET created_at = now() - $2::interval, expires_at = now() - $2::interval + interval '7 days'
    WHERE id = (SELECT max(id) FROM onboarding_invites WHERE tenant_id = $1)`, [shop.tenantId, `${ms} milliseconds`]);
  const first = await invite(shop, op);
  await age(7 * DAY - 5000);
  need(await openInvite(first.token), 200, 'Day 7');
  const second = await invite(shop, op);
  await age(7 * DAY + 1000);
  const late = await openInvite(second.token);
  assert.equal(late.status, 409);
  assert.equal(json(late).error, INVITE_EXPIRED_MESSAGE);
  const old = await invite(shop, op);
  const fresh = await invite(shop, op);
  assert.equal((await openInvite(old.token)).status, 409, 'the revoked link');
  assert.equal(Number((await one(world, `SELECT count(*) AS n FROM onboarding_invites WHERE tenant_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [shop.tenantId])).n), 1, 'one live link');
  const raced = await Promise.all([openInvite(fresh.token), openInvite(fresh.token), openInvite(fresh.token)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409, 409]);
  for (const token of ['short', 'x'.repeat(43), `${fresh.token}x`, fresh.token.toUpperCase(), '../../etc']) assert.ok((await openInvite(token)).status >= 400, token);
  // Revoked from the console: dead at once.
  const third = await invite(shop, op);
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/onboarding/invite/revoke`), 204, 'Revoking');
  assert.equal((await openInvite(third.token)).status, 409);
  // Only the onboarding team sends one; a business that does not exist is 404.
  assert.equal((await opCall(world, await consoleUser(world, 'service_operator'), 'POST', `/tenants/${shop.tenantId}/onboarding/invite`, {})).status, 403);
  assert.equal((await opCall(world, op, 'POST', '/tenants/999999/onboarding/invite', {})).status, 404);
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/onboarding/invite`, { host: shop.host, method: 'POST', token: shop.token, body: {} })).status, 404, 'no console route on a business address');
});

test('F-108: a self-serve business that buys done-for-you gets an invite for the same business: no new business, user or copy of its data', async () => {
  const shop = await shopOn(world, 't1');
  const auto = await shop.automate();
  const counts = async () => Object.fromEntries(await Promise.all(['users', 'automations', 'products', 'ig_accounts'].map(async (t) => [t, Number((await one(world, `SELECT count(*) AS n FROM ${t} WHERE tenant_id = $1`, [shop.tenantId])).n)])));
  const tenants = async () => Number((await one(world, 'SELECT count(*) AS n FROM tenants')).n);
  const [before, tenantsBefore] = [await counts(), await tenants()];
  const op = await consoleUser(world, 'support');
  const opened = json(need(await openInvite((await invite(shop, op)).token), 200, 'Opening'));
  assert.equal(opened.tenantId, shop.tenantId);
  assert.deepEqual(await counts(), before);
  assert.equal(await tenants(), tenantsBefore);
  assert.equal(json(need(await shop.send('GET', `/automations/${auto.id}`), 200, 'The automation')).id, auto.id);
});

test('F-28: a tier 1 checklist is Instagram and terms, with the domain optional; done once both pass, with no tick by hand', async () => {
  const shop = await freshShop('t1');
  const list = await checklist(shop);
  assert.deepEqual(list.steps.map((s) => [s.step, s.required]), stepsFor('t1').map((s) => [s.step, s.required]));
  assert.equal(step(list, 'payments'), undefined);
  assert.equal(step(list, 'instagram').status, 'pending');
  assert.equal(list.done, false);
  // Terms: the owner's, with a version, and on record.
  assert.equal((await shop.send('POST', '/setup/terms', { version: '  ' })).status, 400);
  need(await shop.send('POST', '/setup/terms', { version: '2026-01' }), 200, 'Accepting the terms');
  assert.equal((await sql(world, `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'onboarding.terms_accepted'`, [shop.tenantId])).length, 1);
  await connectInstagramFlow(world, shop, { scopes: ALL_SCOPES });
  const done = await checklist(shop);
  assert.equal(step(done, 'instagram').status, 'done');
  assert.equal(step(done, 'terms').status, 'done');
  assert.notEqual(step(done, 'domain').status, 'done');
  assert.equal(done.done, true, 'finished with the optional domain still open');
  assert.doesNotMatch(JSON.stringify(done), /access_token|test-ig-token/);
  // Another business is not touched by this one's terms.
  assert.equal(step(await checklist(await freshShop('t1')), 'terms').status, 'pending');
});

test('F-29, F-30: a denied messages permission fails the step with gate.scope_missing and a reconnect; a denied insights permission still finishes', async () => {
  const shop = await freshShop('t1');
  await connectWith(shop, ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_insights']);
  need(await shop.send('POST', '/setup/check', { step: 'instagram' }), 200, 'Checking');
  const denied = step(await checklist(shop), 'instagram');
  assert.deepEqual([denied.status, denied.code, denied.fix], ['failed', 'gate.scope_missing', 'reconnect']);
  assert.match(denied.reason, /messages/);
  const other = await freshShop('t1');
  await connectWith(other, ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages']);
  need(await other.send('POST', '/setup/terms', { version: '2026-01' }), 200, 'Terms');
  const slow = await checklist(other);
  const s = step(slow, 'instagram');
  assert.equal(s.status, 'done');
  assert.equal(s.fix, 'reconnect');
  assert.match(`${s.code} ${s.reason}`, /insight/i);
  assert.equal(slow.done, true, 'goes live in slow mode');
});

test('F-77, F-78: payments on Bhava\'s Route account: KYC in the flow, the provider\'s reason on a rejection, checkout closed until active', async () => {
  const shop = await freshShop('t3');
  const list = await checklist(shop);
  assert.deepEqual(list.steps.filter((s) => s.required).map((s) => s.step).sort(), stepsFor('t3').filter((s) => s.required).map((s) => s.step).sort());
  assert.ok(['payments', 'shipping'].every((name) => step(list, name).required));
  assert.equal(step(list, 'own_keys').required, false);
  assert.equal(list.checkoutOpen, false);
  const link = json(need(await shop.send('POST', '/setup/kyc-link'), 200, 'The KYC link'));
  assert.match(link.url, /^https:\/\//);
  assert.equal(link.url.includes(shop.owner.phone), false);
  const { linked_account_id: account } = await one(world, 'SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(account);
  // Asking again keeps the one account.
  need(await shop.send('POST', '/setup/kyc-link'), 200, 'Again');
  assert.equal((await one(world, 'SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [shop.tenantId])).linked_account_id, account);
  const reason = 'Bank account name does not match the business name';
  await world.rzp.post('/accounts/kyc', { id: account, status: 'needs_clarification', reason });
  const failed = json(need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking'));
  assert.deepEqual([step(failed, 'payments').status, step(failed, 'payments').fix], ['failed', 'kyc']);
  assert.match(step(failed, 'payments').reason, /Bank account name does not match/);
  assert.deepEqual(failed.kyc, { status: 'needs_clarification', reason });
  assert.equal(failed.checkoutOpen, false);
  await shop.product({ pricePaise: 10_000, stock: 5 });
  const b = buyer(world, shop);
  const product = (await shop.products())[0];
  const order = await b.place(b.checkoutBody({ lines: [{ productId: product.id, variantId: null, qty: 1 }] }));
  assert.ok(order.status >= 400 && order.status < 500, `checkout is closed: ${order.status}`);
  await world.rzp.post('/accounts/kyc', { id: account, status: 'activated' });
  const open = json(need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking'));
  assert.equal(step(open, 'payments').status, 'done');
  assert.equal(open.checkoutOpen, true);
  await world.rzp.post('/accounts/kyc', { id: account, status: 'suspended' });
  const suspended = json(need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking'));
  assert.equal(suspended.checkoutOpen, false, 'a suspended account closes checkout again');
  assert.equal(step(suspended, 'payments').status, 'failed');
});

test('F-80: the pickup address becomes one location on the master courier account under this business; again adds none; junk leaves it open', async () => {
  const shop = await freshShop('t3');
  const address = { name: 'Dispatch Desk', phone: '9811100077', line1: `${unique()} Mill Lane`, city: 'Pune', state: 'Maharashtra', pincode: '411002' };
  for (const bad of [{ pincode: '41100' }, { phone: '12345' }, { state: 'Narnia' }, { pincode: '011002' }]) assert.equal((await shop.send('PUT', '/setup/pickup-address', { ...address, ...bad })).status, 400, JSON.stringify(bad));
  const saved = json(need(await shop.send('PUT', '/setup/pickup-address', address), 200, 'The pickup address'));
  assert.equal(step(saved, 'shipping').status, 'done');
  const mine = (await world.ship.get('/state')).pickups.filter((p) => JSON.stringify(p).includes(address.line1));
  assert.equal(mine.length, 1);
  assert.ok(JSON.stringify(mine[0]).includes(String(shop.tenantId)), 'named for this business');
  assert.doesNotMatch(`${mine[0].code} ${mine[0].name}`, /bhava/i, 'the label never names the platform');
  need(await shop.send('PUT', '/setup/pickup-address', address), 200, 'Again');
  assert.equal((await world.ship.get('/state')).pickups.filter((p) => JSON.stringify(p).includes(address.line1)).length, 1);
  const junk = await freshShop('t3');
  await world.ship.post('/faults', { kind: 'malformed', times: 2 });
  const res = await junk.send('PUT', '/setup/pickup-address', { ...address, line1: `${unique()} Hill Road` });
  assert.notEqual(res.status, 500);
  assert.notEqual(step(await checklist(junk), 'shipping').status, 'done');
});

test('F-79: own keys that fail their test call are not saved or echoed, and the default path stays; good keys are saved masked', async () => {
  const shop = await freshShop('t3');
  const before = await checklist(shop);
  const secret = `sec_${unique()}_not_valid`;
  const bad = await shop.send('PUT', '/setup/own-keys', { provider: 'razorpay', keyId: 'rzp_' + 'test_invalid000', keySecret: secret });
  assert.equal(bad.status, 400, bad.text.slice(0, 200));
  assert.ok(!bad.text.includes(secret));
  assert.equal((await sql(world, `SELECT 1 FROM gateway_keys WHERE tenant_id = $1`, [shop.tenantId])).length, 0, 'nothing saved');
  assert.equal((await sql(world, `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND details::text LIKE $2`, [shop.tenantId, `%${secret}%`])).length, 0);
  const after = await checklist(shop);
  assert.equal(after.checkoutOpen, before.checkoutOpen);
  assert.notEqual(step(after, 'own_keys').status, 'done');
  assert.notEqual(json(need(await shop.send('GET', '/payment-account'), 200, 'The account')).mode, 'own');
  for (const body of [{ provider: 'paypal', keyId: 'a', keySecret: 'b' }, { provider: 'razorpay', keyId: '', keySecret: 'b' }, { provider: 'razorpay', keyId: 'a' }]) assert.equal((await shop.send('PUT', '/setup/own-keys', body)).status, 400);
  // Keys Razorpay accepts (the simulator knows Bhava's own) pass, are stored encrypted and answered masked.
  const good = { provider: 'razorpay', keyId: 'rzp_test_sim', keySecret: 'sim-key-secret' };
  const res = await shop.send('PUT', '/setup/own-keys', good);
  if (res.status === 200) {
    const saved = json(res);
    assert.doesNotMatch(res.text, /sim-key-secret/);
    assert.equal(step(saved.checklist, 'own_keys').status, 'done');
    const row = await one(world, 'SELECT key_secret_enc FROM gateway_keys WHERE tenant_id = $1', [shop.tenantId]);
    assert.notEqual(row.key_secret_enc, 'sim-key-secret');
    assert.notEqual(json(need(await shop.send('GET', '/payment-account'), 200, 'The account')).mode, 'own', 'saving keys does not switch the mode');
  } else {
    assert.fail(`good keys were refused: ${res.status} ${res.text.slice(0, 200)}`);
  }
});

test('F-31: the operator\'s time is logged by step, capped at the clock, and refused for a made-up step, negative time or the wrong role', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const t0 = Date.now() - 30 * 60_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const post = (body, who = op) => opCall(world, who, 'POST', `/tenants/${shop.tenantId}/onboarding/timings`, body);
  for (const [name, a, b] of [['form', 0, 3], ['brand_read', 4, 6], ['import', 20, 22], ['review', 22, 23], ['invite', 23, 24]]) need(await post({ step: name, activeMs: (b - a) * 60_000, startedAt: at(a), endedAt: at(b) }), 204, name);
  need(await post({ step: 'form', activeMs: 3_600_000, startedAt: at(0), endedAt: at(1) }), 204, 'An hour claimed for a minute');
  const work = json(need(await opCall(world, op, 'GET', `/tenants/${shop.tenantId}/onboarding`), 200, 'The workspace'));
  assert.equal(work.activeMs, 9 * 60_000, 'the same minutes are not counted twice');
  assert.equal(work.activeMs, work.timings.reduce((s, t) => s + t.activeMs, 0));
  assert.equal((await post({ step: 'coffee', activeMs: 1, startedAt: at(0), endedAt: at(1) })).status, 400);
  assert.equal((await post({ step: 'form', activeMs: -5, startedAt: at(0), endedAt: at(1) })).status, 400);
  assert.equal((await post({ step: 'form', activeMs: 5, startedAt: at(2), endedAt: at(1) })).status, 400);
  assert.equal((await post({ step: 'form', activeMs: 1, startedAt: at(0), endedAt: at(1) }, await consoleUser(world, 'service_operator'))).status, 403);
  const listed = json(need(await opCall(world, op, 'GET', '/onboarding?limit=100'), 200, 'The list'));
  const mine = listed.items.find((i) => i.tenantId === shop.tenantId);
  assert.ok(mine && mine.inviteState === 'none' && mine.activeMs === 9 * 60_000 && mine.done === false);
  const checked = json(need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/onboarding/check`), 200, 'Checking from the console'));
  assert.equal(checked.tenantId, shop.tenantId);
  assert.ok(checked.steps.every((s) => s.checkedAt), 'every step was checked');
});
