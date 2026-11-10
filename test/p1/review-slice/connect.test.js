import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTAGRAM_SCOPES } from '../../../src/adapters/meta/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { NoTenantError } from '../../../src/tenancy.js';
import { DEFAULT_SCOPES } from '../../../tools/sim/meta/index.mjs';
import { APP_ID, DAY, IG_A, IG_B, REDIRECT, accountRow, addBusiness, auditFor, connected, consent, seedIg, startSlice, subscribedOnMeta } from './support.js';

const FIELDS = ['comments', 'mentions', 'messages', 'messaging_postbacks'];

test('connecting stores the token encrypted, with what was granted and when it ends', async (t) => {
  const slice = await startSlice(t);
  const { business, flow, seeded } = await connected(slice);

  assert.equal(flow.done.status, 303);
  assert.equal(flow.landing.href, `https://${business.host}/admin/settings?instagram=connected`);

  const row = await accountRow(slice, IG_A);
  const { token } = await business.repos.igAccounts.get(IG_A);
  assert.match(token, /^IGAAsim/);
  assert.match(row.access_token_enc, /^v1\./);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(token));
  assert.equal(row.tenant_id, business.tenant.id);
  assert.equal(row.username, seeded.username);
  assert.equal(row.app_scoped_id, seeded.appScopedId);
  assert.equal(row.login_kind, 'instagram');
  assert.equal(row.token_version, 1);
  assert.equal(row.status, 'active');
  assert.deepEqual([...row.granted_scopes].sort(), [...DEFAULT_SCOPES].sort());

  const leftMs = row.token_expires_at.getTime() - Date.now();
  assert.ok(Math.abs(leftMs - 60 * DAY) < 5 * 60_000, 'a long-lived token lasts 60 days');
  const refreshInMs = row.next_refresh_at.getTime() - Date.now();
  assert.ok(Math.abs(refreshInMs - 30 * DAY) < 5 * 60_000, 'it is refreshed with 30 days left');
});

test('connecting subscribes the account to the webhook fields, and the connection says so', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const { token } = await business.repos.igAccounts.get(IG_A);

  assert.deepEqual((await subscribedOnMeta(slice.sim, IG_A, token)).sort(), FIELDS);
  const { status, body } = await business.api('GET', '/instagram/connection');
  assert.equal(status, 200);
  assert.deepEqual(body.missingScopes, []);
  assert.equal(body.status, 'active');
  assert.equal(body.igUserId, IG_A);
  assert.equal(body.loginKind, 'instagram');
  assert.equal(body.insightsGranted, true);
  assert.equal(body.health, 'ok');
  assert.equal(body.webhooksSubscribed, true);
  assert.equal(JSON.stringify(body).includes(token), false, 'the API never returns a token');
});

test('tokens never go in a URL on the way to Meta', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const { token } = await business.repos.igAccounts.get(IG_A);
  const calls = await slice.sim.calls();
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.path.includes(token), false);
    assert.equal(call.query?.access_token, undefined, `${call.method} ${call.path} carries a token in its query`);
  }
});

test('the consent screen asks for the four permissions, never publishing, for the one app and one address', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const { authorizeUrl } = await consent(slice, business, { igUserId: IG_A });

  assert.deepEqual(authorizeUrl.searchParams.get('scope').split(','), [...INSTAGRAM_SCOPES]);
  assert.equal(authorizeUrl.searchParams.get('scope').includes('publish'), false);
  assert.equal(authorizeUrl.searchParams.get('client_id'), APP_ID);
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), REDIRECT);
});

test('the state is random, stored only as a hash, and not guessable from the link', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  const first = new URL((await business.api('POST', '/instagram/connect', {})).body.authorizeUrl).searchParams.get('state');
  const second = new URL((await business.api('POST', '/instagram/connect', {})).body.authorizeUrl).searchParams.get('state');
  assert.notEqual(first, second);
  assert.ok(first.length >= 40);
  const rows = await slice.q('SELECT * FROM oauth_states');
  assert.equal(rows.length, 2);
  assert.equal(JSON.stringify(rows).includes(first), false);
  assert.ok(rows.every((row) => row.tenant_id === business.tenant.id && row.provider === 'instagram'));
});

test('two businesses connect through the same app and the same address, and each gets only its own account', async (t) => {
  const slice = await startSlice(t);
  const one = await connected(slice, IG_A);
  const two = await connected(slice, IG_B);

  assert.equal(one.flow.back.pathname, two.flow.back.pathname);
  assert.equal(one.flow.back.host, two.flow.back.host);
  assert.equal(one.flow.authorizeUrl.searchParams.get('client_id'), two.flow.authorizeUrl.searchParams.get('client_id'));
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, one.business.tenant.id);
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_B)).id, two.business.tenant.id);
  assert.equal(await one.business.repos.igAccounts.get(IG_B), null);
  assert.equal(await two.business.repos.igAccounts.get(IG_A), null);
  assert.notEqual((await one.business.repos.igAccounts.current()).token, (await two.business.repos.igAccounts.current()).token);
  assert.equal((await one.business.api('GET', '/instagram/connection')).body.igUserId, IG_A);
  assert.equal((await two.business.api('GET', '/instagram/connection')).body.igUserId, IG_B);
});

test('a state works once', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const { callback } = await consent(slice, business, { igUserId: IG_A });
  const before = await accountRow(slice, IG_A);

  const again = await callback();
  assert.equal(again.status, 400);
  assert.match(await again.text(), /expired/);
  assert.deepEqual(await accountRow(slice, IG_A), before);
});

test('a state older than 10 minutes, or one nobody issued, does nothing', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const started = await business.api('POST', '/instagram/connect', {});
  const state = new URL(started.body.authorizeUrl).searchParams.get('state');
  const [row] = await slice.q('SELECT created_at, expires_at FROM oauth_states');
  assert.equal(row.expires_at.getTime() - row.created_at.getTime() <= 10 * 60_000 + 1000, true);

  await slice.q(`UPDATE oauth_states SET expires_at = now() - interval '1 second'`);
  const status = async (query) => (await fetch(`${slice.app.base}/oauth/instagram/callback?${query}`, { redirect: 'manual' })).status;
  assert.equal(await status(`code=x&state=${state}`), 400);
  assert.equal(await status('code=x&state=forged'), 400);
  assert.equal(await status('code=x'), 400);
  assert.equal(await status(`code=x&code=y&state=${state}`), 400);
  assert.equal(await accountRow(slice, IG_A), null);
});

test('a seller who says no changes nothing', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const { outcome } = await consent(slice, business, { igUserId: IG_A, deny: true });
  assert.equal(outcome, 'denied');
  assert.equal(await accountRow(slice, IG_A), null);
  assert.equal((await business.api('GET', '/instagram/connection')).body.status, 'not_connected');
});

test('only an owner or manager can start connecting; staff can read the state of it', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  const staffPhone = '9812345670';
  const staff = await business.repos.users.create({ name: 'Staff', phone: staffPhone, password: 'staff-pass', role: 'staff' });
  await business.repos.users.setPermissions(staff.id, ['automations']);
  const staffApi = await business.signIn({ phone: staffPhone, password: 'staff-pass' });

  assert.equal((await business.anonymous('POST', '/instagram/connect', {})).status, 401);
  assert.equal((await staffApi('POST', '/instagram/connect', {})).status, 403);
  assert.equal((await staffApi('DELETE', '/instagram/connection')).status, 403);
  assert.equal((await staffApi('GET', '/instagram/connection')).status, 200);
});

test('someone demoted after starting cannot finish', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  await slice.sim.post('/oauth/next', { igUserId: IG_A });
  const started = await business.api('POST', '/instagram/connect', {});
  const dialog = await fetch(started.body.authorizeUrl, { redirect: 'manual' });
  const back = new URL(dialog.headers.get('location'));
  const owner = await business.repos.users.findByPhone(business.phone);
  await business.repos.users.setRole(owner.id, 'customer');

  const done = await fetch(`${slice.app.base}${back.pathname}${back.search}`, { redirect: 'manual' });
  assert.equal(new URL(done.headers.get('location')).searchParams.get('instagram'), 'forbidden');
  assert.equal(await accountRow(slice, IG_A), null);
});

test('an account on another business stays there, and its token is not touched', async (t) => {
  const slice = await startSlice(t);
  const first = await connected(slice, IG_A);
  const before = await accountRow(slice, IG_A);

  const second = await addBusiness(slice.app);
  const { outcome } = await consent(slice, second, { igUserId: IG_A });
  assert.equal(outcome, 'taken');
  assert.deepEqual(await accountRow(slice, IG_A), before);
  assert.equal((await first.business.repos.igAccounts.current()).igUserId, IG_A);
  assert.equal(await second.repos.igAccounts.current(), null);
  assert.equal((await second.api('GET', '/instagram/connection')).body.status, 'not_connected');
  const [refused] = (await auditFor(slice, second.tenant.id)).filter((row) => row.action === 'instagram.connect_refused');
  assert.equal(refused.target, `instagram:${IG_A}`);
});

test('after a seller disconnects, the same account can go to another business', async (t) => {
  const slice = await startSlice(t);
  const first = await connected(slice, IG_A);
  assert.equal((await first.business.api('DELETE', '/instagram/connection')).status, 204);

  const second = await addBusiness(slice.app);
  const { outcome } = await consent(slice, second, { igUserId: IG_A });
  assert.equal(outcome, 'connected');
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, second.tenant.id);
});

test('a token lost to a refusal keeps the account with its business until that business reconnects', async (t) => {
  const slice = await startSlice(t);
  const first = await connected(slice, IG_A);
  await first.business.repos.igAccounts.loseToken(IG_A, 'token.rejected');
  const second = await addBusiness(slice.app);
  assert.equal((await consent(slice, second, { igUserId: IG_A })).outcome, 'taken');
});

test('connecting a different account ends the old one', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice, IG_A);
  const oldToken = (await business.repos.igAccounts.get(IG_A)).token;
  await seedIg(slice.sim, IG_B);
  assert.equal((await consent(slice, business, { igUserId: IG_B })).outcome, 'connected');

  assert.equal((await business.repos.igAccounts.current()).igUserId, IG_B);
  assert.equal((await business.repos.igAccounts.get(IG_A)).token, '');
  assert.equal((await business.api('GET', '/instagram/connection')).body.igUserId, IG_B);
  assert.deepEqual(await subscribedOnMeta(slice.sim, IG_A, oldToken), [], 'the old account no longer delivers here');
});

test('a Meta failure at the exchange leaves things as they were', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  await slice.sim.post('/faults', { kind: 'server_error', match: { method: 'POST', path: '/oauth/access_token' } });
  assert.equal((await consent(slice, business, { igUserId: IG_A })).outcome, 'failed');
  assert.equal(await accountRow(slice, IG_A), null);
});

test('if the webhook subscription fails, the connection stands and the hourly job fixes it', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  await slice.sim.post('/faults', { kind: 'server_error', match: { method: 'POST', path: `/v23.0/${IG_A}/subscribed_apps` } });
  assert.equal((await consent(slice, business, { igUserId: IG_A })).outcome, 'connected');
  let view = (await business.api('GET', '/instagram/connection')).body;
  assert.deepEqual([view.status, view.webhooksSubscribed], ['active', false]);

  await slice.maintain();
  view = (await business.api('GET', '/instagram/connection')).body;
  assert.equal(view.webhooksSubscribed, true);
});

test('nothing secret or personal reaches the logs during a connect', async (t) => {
  const slice = await startSlice(t);
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
  const { business, seeded, flow } = await connected(slice);
  const { token } = await business.repos.igAccounts.get(IG_A);
  const all = lines.join('\n');
  assert.equal(all.includes(token), false);
  assert.equal(all.includes(seeded.username), false);
  assert.equal(all.includes(flow.back.searchParams.get('code')), false);
  assert.equal(all.includes(flow.back.searchParams.get('state')), false);
});

test('connect refuses plainly when the server has no app id or no encryption key', async (t) => {
  const noApp = await startSlice(t, { overrides: { igAppId: '' } });
  const a = await addBusiness(noApp.app);
  assert.equal((await a.api('POST', '/instagram/connect', {})).status, 409);

  const noKey = await startSlice(t, { overrides: { dataKey: '' } });
  const b = await addBusiness(noKey.app);
  assert.equal((await b.api('POST', '/instagram/connect', {})).status, 409);
});

test('a return address must be a page of this site', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  assert.equal((await business.api('POST', '/instagram/connect', { returnTo: 'https://evil.test/x' })).status, 400);
  assert.equal((await business.api('POST', '/instagram/connect', { returnTo: '//evil.test/x' })).status, 400);
  await seedIg(slice.sim, IG_A);
  const { landing } = await consent(slice, business, { igUserId: IG_A, returnTo: '/\\evil.test/x' });
  assert.equal(landing.host, business.host, 'a slash trick falls back to a page of the business');
});

test('Unified Login connects through the same flow, with Instagram names for its scopes', async (t) => {
  const slice = await startSlice(t, {
    overrides: { metaLogin: 'unified', fbAppId: 'fb-app', fbAppSecret: 'fb-secret' },
    simOptions: { facebookApp: { id: 'fb-app', secret: 'fb-secret', redirectUris: [REDIRECT] } },
  });
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  await slice.sim.post('/pages', { pageId: 'page-1', igUserId: IG_A, scopes: ['pages_manage_metadata'] });

  const started = await business.api('POST', '/instagram/connect', {});
  const dialog = await fetch(started.body.authorizeUrl, { redirect: 'manual' });
  const back = new URL(dialog.headers.get('location'));
  const done = await fetch(`${slice.app.base}${back.pathname}${back.search}`, { redirect: 'manual' });
  assert.equal(new URL(done.headers.get('location')).searchParams.get('instagram'), 'connected');

  const row = await accountRow(slice, IG_A);
  assert.equal(row.login_kind, 'unified');
  assert.equal(row.page_id, 'page-1');
  assert.equal(row.token_expires_at, null);
  assert.equal(row.next_refresh_at, null);
  assert.deepEqual([...row.granted_scopes].sort(), [...INSTAGRAM_SCOPES].sort());
  assert.ok(row.subscribed_at, 'the Page was subscribed');
  assert.equal((await business.repos.igAccounts.get(IG_A)).loginKind, 'unified');
});

test('an account read from the repo is still just its id, username and token', async (t) => {
  const slice = await startSlice(t);
  const { business, seeded } = await connected(slice);
  const account = await business.repos.igAccounts.get(IG_A);
  assert.deepEqual(account, { igUserId: IG_A, username: seeded.username, token: account.token });
});

test('every Instagram route of the API contract is answered here, and building the answers needs nothing yet', async () => {
  const { igConnect } = await import('../../../src/modules/ig-connect/index.js');
  const { instagramRoutes } = await import('../../../src/contracts/api/instagram.js');
  assert.deepEqual(Object.keys(igConnect.api({ repos: {}, config: {}, ig: {}, auth: {} })).sort(), Object.keys(instagramRoutes).sort());
});

test('a server with no Meta app schedules no Instagram work', async () => {
  const { igConnect } = await import('../../../src/modules/ig-connect/index.js');
  const queue = { work() { throw new Error('should not register'); } };
  assert.equal(igConnect.jobs({ config: {}, platform: { queue } }), undefined);
});

test('no repo method works without a business', async (t) => {
  const { app } = await startSlice(t);
  const repo = app.platform.igAccounts;
  const calls = [
    () => repo.get('x'), () => repo.current(), () => repo.detail('x'), () => repo.primary(), () => repo.setToken('x', 'y'),
    () => repo.disconnect('x', { actor: 'a' }), () => repo.eraseAccount('x'), () => repo.loseToken('x', 'token.rejected'),
    () => app.platform.igConnect.recentDecisions(),
  ];
  for (const call of calls) await assert.rejects(call, NoTenantError);
});
