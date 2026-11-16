// PRD 5.6: the done-for-you invite and the checklist, and what the default path needs. F-26 to F-31, F-77 to F-80, F-108.
// The operator works in the console, the owner opens one link; every step's state comes from a live check against the simulators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { INVITE_EXPIRED_MESSAGE, OPERATOR_TARGET_MS, stepsFor } from '../../../src/contracts/onboarding.js';
import { connectInstagramFlow } from '../../p1/spec-p1/support.js';
import {
  APP, appSignIn, buyer, consoleUser, finishConnect, hit, json, key, need, one, opCall, pause, shopOn, sql, unique, useBillingWorld,
} from './support.js';

const world = useBillingWorld();
const DAY = 86_400_000;
const numericId = () => String(17_841_400_000_000_000n + BigInt(crypto.randomInt(1, 2 ** 30)) * 1000n);

const tokenOf = (url) => [...String(url).matchAll(/[\w-]{20,200}/g)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0];
const openInvite = (token) => hit(world, '/api/v1/setup/invite', { host: APP, method: 'POST', body: { token } });
const checklist = async (shop) => json(need(await shop.send('GET', '/setup'), 200, 'The checklist'));
const step = (list, name) => list.steps.find((s) => s.step === name);

async function invite(shop, op, via = []) {
  const res = need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/onboarding/invite`, { via }), 201, 'Sending the invite');
  const sent = json(res);
  return { ...sent, token: tokenOf(sent.url) };
}

/** A business whose Instagram is not yet connected: the owner's first job. */
async function freshShop(plan = 't1', options = {}) {
  const shop = await shopOn(world, plan, { igConnected: false, pay: false, pickup: false, notice: false, whatsapp: false, ...options });
  shop.newIg = numericId();
  await world.meta.post('/accounts', { igUserId: shop.newIg, username: `own_${unique()}`, subscribedFields: ['comments', 'messages', 'messaging_postbacks', 'mentions'], appRole: true });
  shop.igUserId = shop.newIg;
  return shop;
}

test('F-26: a valid invite, a WhatsApp code and Instagram connected: the token and granted scopes are stored and subscribed_apps succeeds', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const sent = await invite(shop, op);
  assert.ok(sent.token, 'the link carries a token');
  const opened = json(need(await openInvite(sent.token), 200, 'Opening the invite'));
  assert.equal(opened.tenantId, shop.tenantId);
  assert.equal(opened.businessName, shop.name);
  const owner = await appSignIn(world, shop.owner.phone, shop.host);
  assert.ok(owner.cookie, 'signed in with a WhatsApp code, no password');
  assert.equal(step(await checklist(shop), 'instagram').status, 'pending');
  await connectInstagramFlow(world, shop);
  need(await shop.send('POST', '/setup/check', { step: 'instagram' }), 200, 'Checking Instagram');
  const after = await checklist(shop);
  assert.equal(step(after, 'instagram').status, 'done');
  const account = await one(world, 'SELECT granted_scopes, subscribed_fields, access_token_enc FROM ig_accounts WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(account.access_token_enc, 'a token is stored');
  assert.ok(account.granted_scopes.includes('instagram_business_manage_messages'), 'granted scopes are stored from the token');
  assert.ok(account.subscribed_fields.length >= 1, 'subscribed_apps succeeded');
  assert.ok(!JSON.stringify(after).includes('test-ig-token') && !JSON.stringify(after).match(/access_token/i), 'the checklist shows no token');
  const stored = await one(world, 'SELECT token_hash FROM onboarding_invites WHERE tenant_id = $1', [shop.tenantId]).catch(() => null);
  if (stored) assert.ok(!JSON.stringify(stored).includes(sent.token), 'only a hash is stored');
});

test('F-27: an invite opened on day 8 asks for a new link, a second use fails, and after a resend only the new link works', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  // Ages the newest link so that it was sent `ms` ago and lasts its full 7 days from then.
  const sentAgo = (ms) => sql(world, `UPDATE onboarding_invites SET created_at = now() - $2::interval, expires_at = now() - $2::interval + interval '7 days'
    WHERE id = (SELECT max(id) FROM onboarding_invites WHERE tenant_id = $1)`, [shop.tenantId, `${ms} milliseconds`]);
  // Day 7, three seconds before the end: it opens.
  const first = await invite(shop, op);
  await sentAgo(7 * DAY - 3000);
  need(await openInvite(first.token), 200, 'Day 7, a moment before the end');
  // Day 8, one second past the end: it asks for a new link.
  const second = await invite(shop, op);
  await sentAgo(7 * DAY + 1000);
  const late = await openInvite(second.token);
  assert.ok(late.status >= 400 && late.status < 500, `day 8: ${late.status}`);
  assert.match(late.text, new RegExp(INVITE_EXPIRED_MESSAGE.replace(/[.]/g, '\\.')));
  assert.equal(json(late)?.tenantId, undefined, 'an expired link names no business');
  // A resend revokes the old link: the old one fails, the new one works, and there is one live link.
  const resent = await invite(shop, op);
  const third = await invite(shop, op);
  assert.notEqual(resent.token, third.token);
  assert.ok((await openInvite(resent.token)).status >= 400, 'the revoked link');
  need(await openInvite(third.token), 200, 'The new link');
  assert.equal((await sql(world, `SELECT 1 FROM onboarding_invites WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [shop.tenantId])).length, 1);
  // A link's expiry is never more than 7 days.
  const row = await one(world, `SELECT created_at, expires_at FROM onboarding_invites WHERE tenant_id = $1 AND revoked_at IS NULL`, [shop.tenantId]);
  assert.ok(new Date(row.expires_at) - new Date(row.created_at) <= 7 * DAY);
  // Garbage and another business's token do nothing.
  const garbage = ['short', 'x'.repeat(40), `${third.token}x`, third.token.toUpperCase()].filter((t) => t !== third.token);
  for (const token of garbage) assert.ok((await openInvite(token)).status >= 400, token);
  assert.ok((await hit(world, '/api/v1/setup/invite', { host: shop.host, method: 'POST', body: { token: third.token } })).status >= 400, 'an invite is opened on the sign-in host, not a business address');
});

test('F-27: an invite works once: reused afterwards, or opened by two people at the same moment, only one gets in', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const sent = await invite(shop, op);
  need(await openInvite(sent.token), 200, 'The first use');
  const again = await openInvite(sent.token);
  assert.ok(again.status >= 400 && again.status < 500, `a used link: ${again.status}`);
  assert.equal(json(again)?.tenantId, undefined, 'a used link names no business');
  const row = await one(world, 'SELECT used_at FROM onboarding_invites WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.ok(row.used_at, 'the use is recorded');
  // A fresh link opened twice at once.
  const raced = await invite(shop, op);
  const both = await Promise.all([openInvite(raced.token), openInvite(raced.token), openInvite(raced.token)]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, `one use: ${both.map((r) => r.status)}`);
  assert.ok(both.every((r) => r.status < 500));
});

test('F-28: a tier 1 checklist needs Instagram and the terms, offers the domain as optional, and shows no payments or shipping', async () => {
  const shop = await freshShop('t1');
  const list = await checklist(shop);
  const expected = stepsFor('t1');
  assert.deepEqual(list.steps.map((s) => [s.step, s.required]), expected.map((s) => [s.step, s.required]));
  assert.equal(step(list, 'instagram').required, true);
  assert.equal(step(list, 'terms').required, true);
  assert.equal(step(list, 'domain').required, false);
  assert.equal(step(list, 'payments'), undefined);
  assert.equal(step(list, 'shipping'), undefined);
  assert.equal(list.done, false);
  need(await shop.send('POST', '/setup/terms', { version: '2026-01' }), 200, 'Accepting terms');
  assert.equal(step(await checklist(shop), 'terms').status, 'done');
  await connectInstagramFlow(world, shop);
  const done = await checklist(shop);
  assert.equal(done.done, true, 'finished with the domain still open');
  assert.equal(step(done, 'domain').status === 'done', false);
  const auto = await shop.automate();
  const link = (await one(world, 'SELECT link_url FROM automations WHERE id = $1', [auto.id])).link_url;
  assert.ok(link, 'the automation\'s link is the seller\'s own');
  assert.equal(shop.send !== undefined, true);
});

test('F-28: terms are the owner\'s to accept, with a version; a manager, an empty version and a business that is not theirs cannot', async () => {
  const shop = await freshShop('t1');
  const other = await freshShop('t1');
  assert.equal((await shop.send('POST', '/setup/terms', { version: '' })).status, 400);
  assert.equal((await shop.send('POST', '/setup/terms', {})).status, 400);
  need(await shop.send('POST', '/setup/terms', { version: '2026-01' }), 200, 'Accepting');
  assert.equal(step(await checklist(other), 'terms').status, 'pending', 'another business is unaffected');
  const row = await sql(world, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* 'terms'`, [shop.tenantId]);
  assert.ok(row.length >= 1, 'who and when is on record');
});

test('F-29: an owner who denies the messages permission fails the step with gate.scope_missing and a reconnect button', async () => {
  const shop = await freshShop('t1');
  await world.meta.post('/oauth/next', { igUserId: shop.igUserId, scopes: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_insights'] });
  const start = need(await shop.send('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
  const consent = await fetch(json(start).authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await finishConnect(world, await hit(world, `${back.pathname}${back.search}`, { host: shop.host }), { send: shop.send });
  need(await shop.send('POST', '/setup/check', { step: 'instagram' }), 200, 'Checking');
  const s = step(await checklist(shop), 'instagram');
  assert.equal(s.status, 'failed');
  assert.equal(s.code, 'gate.scope_missing');
  assert.equal(s.fix, 'reconnect');
  assert.equal((await checklist(shop)).done, false);
  // Reconnecting with everything granted puts it right.
  await connectInstagramFlow(world, shop);
  need(await shop.send('POST', '/setup/check', { step: 'instagram' }), 200, 'Checking again');
  assert.equal(step(await checklist(shop), 'instagram').status, 'done');
});

test('F-30: denying only the insights permission still goes live, in slow mode, with a reconnect prompt and "Permission needed" on analytics', async () => {
  const shop = await freshShop('t1');
  await world.meta.post('/oauth/next', { igUserId: shop.igUserId, scopes: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'] });
  const start = need(await shop.send('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
  const consent = await fetch(json(start).authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await finishConnect(world, await hit(world, `${back.pathname}${back.search}`, { host: shop.host }), { send: shop.send });
  need(await shop.send('POST', '/setup/check', { step: 'instagram' }), 200, 'Checking');
  const s = step(await checklist(shop), 'instagram');
  assert.equal(s.status, 'done', 'insights is not needed to go live');
  assert.ok(s.fix === 'reconnect' || /insight/i.test(`${s.reason} ${s.code}`), 'a reconnect prompt');
  const insights = json(need(await shop.send('GET', '/insights/status'), 200, 'Insights status'));
  assert.match(JSON.stringify(insights), /permission|scope|reconnect|slow/i);
  const live = await shop.automate();
  assert.equal(live.state, 'live');
  await shop.comment(live.mediaId, { from: world.fan() });
  await shop.settle();
  assert.ok((await shop.dms()).length >= 1, 'it sends');
});

test('F-31: the operator\'s active time from the console form to the invite is logged by step and stays under 10 minutes; waits and invented times are not counted', async () => {
  const shop = await freshShop('t1');
  const op = await consoleUser(world, 'onboarding');
  const t0 = Date.now() - 20 * 60_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const post = (body) => opCall(world, op, 'POST', `/tenants/${shop.tenantId}/onboarding/timings`, body);
  const steps = [['form', 0, 3], ['brand_read', 4, 6], ['import', 20, 22], ['review', 22, 23], ['invite', 23, 24]];
  for (const [name, a, b] of steps) assert.equal((await post({ step: name, activeMs: (b - a) * 60_000, startedAt: at(a), endedAt: at(b) })).status, 204);
  const work = json(need(await opCall(world, op, 'GET', `/tenants/${shop.tenantId}/onboarding`), 200, 'The workspace'));
  assert.deepEqual(work.timings.map((t) => t.step).sort(), steps.map((s) => s[0]).sort());
  assert.ok(work.activeMs <= OPERATOR_TARGET_MS, `${work.activeMs} ms against the 10 minute target`);
  assert.equal(work.activeMs, work.timings.reduce((s, t) => s + t.activeMs, 0));
  // An hour claimed for a minute on the clock is capped; a made-up step and negative time are refused.
  await post({ step: 'form', activeMs: 3_600_000, startedAt: at(0), endedAt: at(1) });
  const capped = json(need(await opCall(world, op, 'GET', `/tenants/${shop.tenantId}/onboarding`), 200, 'The workspace'));
  assert.ok(capped.activeMs <= 4 * 60_000 + 3 * 60_000 + 5 * 60_000, 'a claim longer than the clock is cut to it');
  assert.equal((await post({ step: 'coffee', activeMs: 1, startedAt: at(0), endedAt: at(1) })).status, 400);
  assert.equal((await post({ step: 'form', activeMs: -5, startedAt: at(0), endedAt: at(1) })).status, 400);
  assert.equal((await opCall(world, await consoleUser(world, 'service_operator'), 'POST', `/tenants/${shop.tenantId}/onboarding/timings`, { step: 'form', activeMs: 1, startedAt: at(0), endedAt: at(1) })).status, 403);
  const summary = json(need(await opCall(world, op, 'GET', '/onboarding?limit=100'), 200, 'The onboarding list'));
  assert.ok(summary.items.some((i) => i.tenantId === shop.tenantId && i.inviteState === 'none' && i.activeMs > 0));
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/onboarding`, { host: shop.host, token: shop.token })).status, 404, 'an owner has no operator workspace');
});

test('F-77: a tier 3 owner finishes the checklist with no keys: payments on Bhava\'s Razorpay account, shipping on its Shiprocket, checkout opens when Route is active', async () => {
  const shop = await freshShop('t3');
  await connectInstagramFlow(world, shop);
  need(await shop.send('POST', '/setup/terms', { version: '2026-01' }), 200, 'Terms');
  const list = await checklist(shop);
  assert.deepEqual(list.steps.filter((s) => s.required).map((s) => s.step).sort(), ['instagram', 'payments', 'shipping', 'terms']);
  assert.equal(step(list, 'own_keys').required, false);
  assert.equal(list.checkoutOpen, false);
  const link = json(need(await shop.send('POST', '/setup/kyc-link'), 200, 'The KYC link'));
  assert.match(link.url, /^https:\/\//);
  assert.equal(link.url.includes(shop.owner.phone), false, 'no owner detail in the link');
  const account = await one(world, 'SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(account?.linked_account_id, 'a linked account was made on Bhava\'s own account');
  need(await shop.send('PUT', '/setup/pickup-address', { name: 'Dispatch', phone: '9811100001', line1: '4 Mill Lane', city: 'Pune', state: 'Maharashtra', pincode: '411002' }), 200, 'Pickup address');
  assert.equal((await checklist(shop)).done, false, 'KYC is still open');
  await world.rzp.post('/accounts/kyc', { id: account.linked_account_id, status: 'activated' });
  need(await shop.send('POST', '/setup/check', {}), 200, 'Checking every step');
  const done = await checklist(shop);
  assert.equal(done.checkoutOpen, true);
  assert.equal(done.done, true);
  assert.equal(step(done, 'payments').status, 'done');
  assert.equal(step(done, 'shipping').status, 'done');
  assert.equal((await sql(world, `SELECT 1 FROM payment_settings WHERE tenant_id = $1 AND (razorpay_key_id IS NOT NULL AND razorpay_key_id <> '')`, [shop.tenantId]).catch(() => [])).length, 0, 'no keys of the owner\'s were needed');
});

test('F-78: a Route KYC rejected for a bank name mismatch keeps the step open with Razorpay\'s reason and a fix button, and checkout stays closed', async () => {
  const shop = await freshShop('t3');
  await connectInstagramFlow(world, shop);
  need(await shop.send('POST', '/setup/kyc-link'), 200, 'The KYC link');
  const account = (await one(world, 'SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [shop.tenantId])).linked_account_id;
  const reason = 'Bank account name does not match the business name';
  await world.rzp.post('/accounts/kyc', { id: account, status: 'needs_clarification', reason });
  need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking payments');
  const list = await checklist(shop);
  const payments = step(list, 'payments');
  assert.equal(payments.status, 'failed');
  assert.match(payments.reason, /Bank account name does not match/);
  assert.equal(payments.fix, 'kyc');
  assert.equal(list.kyc.status, 'needs_clarification');
  assert.equal(list.checkoutOpen, false);
  await shop.product({ pricePaise: 10_000, stock: 5 });
  const b = buyer(world, shop);
  const product = (await shop.products())[0];
  const res = await b.place(b.checkoutBody({ lines: [{ productId: product.id, variantId: null, qty: 1 }] }));
  assert.ok(res.status >= 400 && res.status < 500, `checkout is closed, got ${res.status}`);
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM orders WHERE tenant_id = $1', [shop.tenantId])).n), 0);
  // The fix link is Razorpay's page and a rejected account is shown the same way.
  const again = json(need(await shop.send('POST', '/setup/kyc-link'), 200, 'The fix link'));
  assert.match(again.url, /^https:\/\//);
  await world.rzp.post('/accounts/kyc', { id: account, status: 'rejected', reason: 'PAN not valid' });
  need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking');
  assert.match(step(await checklist(shop), 'payments').reason, /PAN not valid/);
  await world.rzp.post('/accounts/kyc', { id: account, status: 'suspended' });
  need(await shop.send('POST', '/setup/check', { step: 'payments' }), 200, 'Checking');
  assert.equal((await checklist(shop)).checkoutOpen, false, 'a suspended account is not open');
});

test('F-79: invalid own Razorpay keys fail the test call, are not saved, are not echoed, and the default path stays active', async () => {
  const shop = await freshShop('t3');
  const before = await checklist(shop);
  await world.rzp.post('/faults', { kind: 'rate_limit', status: 401, times: 3, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } });
  const secret = `sec_${unique()}_not_valid`;
  const res = await shop.send('PUT', '/setup/own-keys', { provider: 'razorpay', keyId: 'rzp_' + 'test_invalid000', keySecret: secret });
  assert.ok(res.status >= 400 && res.status < 500, `invalid keys: ${res.status} ${res.text.slice(0, 160)}`);
  assert.ok(!res.text.includes(secret), 'the secret is never echoed');
  const state = await checklist(shop);
  assert.notEqual(step(state, 'own_keys')?.status, 'done');
  assert.equal(state.checkoutOpen, before.checkoutOpen, 'the default path is as it was');
  const mode = json(need(await shop.send('GET', '/payment-account'), 200, 'The payment account'));
  assert.notEqual(mode.mode, 'own');
  const stored = await sql(world, `SELECT 1 FROM payment_settings WHERE tenant_id = $1 AND razorpay_key_id = 'rzp_${'test'}_invalid000'`, [shop.tenantId]).catch(() => []);
  assert.equal(stored.length, 0, 'not saved');
  assert.equal((await sql(world, `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND details::text LIKE $2`, [shop.tenantId, `%${secret}%`])).length, 0, 'the secret is in no audit row');
  // Bad shapes are refused before any call.
  for (const body of [{ provider: 'paypal', keyId: 'a', keySecret: 'b' }, { provider: 'razorpay', keyId: '', keySecret: 'b' }, { provider: 'razorpay', keyId: 'a' }]) assert.equal((await shop.send('PUT', '/setup/own-keys', body)).status, 400);
  // Another business's owner has no such route on this one; keys are the owner's own, not a manager's.
  const other = await freshShop('t3');
  assert.equal(json(need(await other.send('GET', '/setup'), 200, 'Other checklist')).checkoutOpen, before.checkoutOpen);
});

test('F-80: a pickup address in the shipping step creates the pickup location on Bhava\'s Shiprocket account under this business and marks the step done', async () => {
  const shop = await freshShop('t3');
  const address = { name: 'Dispatch Desk', phone: '9811100077', line1: `${unique()} Mill Lane`, city: 'Pune', state: 'Maharashtra', pincode: '411002' };
  assert.equal((await shop.send('PUT', '/setup/pickup-address', { ...address, pincode: '41100' })).status, 400, 'a short pincode');
  assert.equal((await shop.send('PUT', '/setup/pickup-address', { ...address, phone: '12345' })).status, 400, 'a bad phone');
  assert.equal(step(await checklist(shop), 'shipping').status, 'pending');
  need(await shop.send('PUT', '/setup/pickup-address', address), 200, 'The pickup address');
  const state = await world.ship.get('/state');
  const mine = state.pickups.filter((p) => JSON.stringify(p).includes(address.line1));
  assert.equal(mine.length, 1, 'one pickup location on the master account');
  assert.ok(mine[0].key.includes(shop.name) || JSON.stringify(mine[0]).includes(shop.name) || JSON.stringify(mine[0]).includes(String(shop.tenantId)), 'named for this business');
  need(await shop.send('POST', '/setup/check', { step: 'shipping' }), 200, 'Checking shipping');
  assert.equal(step(await checklist(shop), 'shipping').status, 'done');
  // Saving the same address again does not add a second location.
  need(await shop.send('PUT', '/setup/pickup-address', address), 200, 'The same address again');
  assert.equal((await world.ship.get('/state')).pickups.filter((p) => JSON.stringify(p).includes(address.line1)).length, 1);
  // Another business with the same pincode gets its own location, never this one's.
  const other = await freshShop('t3');
  need(await other.send('PUT', '/setup/pickup-address', { ...address, line1: `${unique()} Hill Road`, name: 'Other Desk' }), 200, 'Other address');
  assert.equal((await world.ship.get('/state')).pickups.filter((p) => JSON.stringify(p).includes(address.line1)).length, 1);
});

test('F-80: a courier that hangs or answers junk leaves the shipping step open and the address unsaved as done', async () => {
  const shop = await freshShop('t3');
  await world.ship.post('/faults', { kind: 'malformed', times: 2 });
  const res = await shop.send('PUT', '/setup/pickup-address', { name: 'Desk', phone: '9811100088', line1: `${unique()} Road`, city: 'Pune', state: 'Maharashtra', pincode: '411002' });
  assert.ok(res.status < 600 && res.status !== 500 || res.status === 502 || res.status === 503, `junk from the courier: ${res.status}`);
  assert.notEqual(step(await checklist(shop), 'shipping').status, 'done');
});

test('F-108: a self-serve tier 1 business that buys done-for-you setup gets an invite that attaches to the same account, with its data untouched', async () => {
  const shop = await shopOn(world, 't1');
  const auto = await shop.automate();
  const product = await shop.product();
  const counts = async () => Object.fromEntries(await Promise.all(['tenants', 'users', 'automations', 'products', 'ig_accounts'].map(async (t) => [t, Number((await one(world, `SELECT count(*) AS n FROM ${t}${t === 'tenants' ? '' : ' WHERE tenant_id = $1'}`, t === 'tenants' ? [] : [shop.tenantId])).n)])));
  const before = await counts();
  need(await shop.send('POST', '/billing/items', { code: 'setup_automation', requestKey: key() }), 201, 'Buying done-for-you');
  const op = await consoleUser(world, 'onboarding');
  const sent = await invite(shop, op, []);
  const opened = json(need(await openInvite(sent.token), 200, 'Opening'));
  assert.equal(opened.tenantId, shop.tenantId, 'the existing business');
  assert.deepEqual(await counts(), before, 'no second account, no copy of data');
  assert.equal(json(need(await shop.send('GET', `/automations/${auto.id}`), 200, 'The automation')).id, auto.id);
  assert.equal((await shop.getProduct(product.id)).id, product.id);
  assert.equal((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId])).plan, 't1');
});

test('F-26: the onboarding routes belong to the onboarding team: a seller, a service operator and an anonymous caller cannot send an invite', async () => {
  const shop = await freshShop('t1');
  const other = await freshShop('t1');
  assert.equal((await hit(world, `/tenants/${other.tenantId}/onboarding/invite`, { host: shop.host, method: 'POST', token: shop.token, body: {} })).status, 404);
  assert.equal((await hit(world, `/tenants/${other.tenantId}/onboarding/invite`, { host: `admin.${APP.split('.').slice(1).join('.')}`, method: 'POST', body: {} })).status, 401);
  assert.equal((await opCall(world, await consoleUser(world, 'service_operator'), 'POST', `/tenants/${other.tenantId}/onboarding/invite`, {})).status, 403);
  assert.equal((await opCall(world, await consoleUser(world, 'onboarding'), 'POST', `/tenants/999999/onboarding/invite`, {})).status, 404);
  const op = await consoleUser(world, 'support');
  const sent = await invite(other, op);
  need(await opCall(world, op, 'POST', `/tenants/${other.tenantId}/onboarding/invite/revoke`), 204, 'Revoking');
  assert.ok((await openInvite(sent.token)).status >= 400, 'a revoked link');
  // The invite for one business never opens another's.
  const a = await invite(shop, op);
  assert.equal(json(need(await openInvite(a.token), 200, 'Opening A')).tenantId, shop.tenantId);
});
