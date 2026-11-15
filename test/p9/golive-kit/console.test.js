// The go-live checklist in the Platform Console and the sign-up switch beside it (G-15, G-17), on the running app:
// who may read it and change the mode, the refusal of public while a blocking item is open, the forced opening and
// its audit row, two changes at once, the server refusing sign-up whatever a screen shows, and the daily cap holding
// when sign-ups arrive together.
import '../../../tools/net-guard.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GoliveStatus } from '../../../src/contracts/golive.js';
import { CONSOLE_HOST, NEUTRAL, addBusiness, consoleUser, hit, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { world } from '../../p7/signup-plans/support.js';

const put = (app, who, body) => onConsole(app, who, '/signup', { method: 'PUT', body });
const modeOf = async (app, who) => (await onConsole(app, who, '/signup')).json();
const audits = (app) => (app.db.platform ?? app.db).query(`SELECT actor, details FROM audit_log WHERE action = 'signup.mode_set' ORDER BY id`);
const MARKERS = { razorpayKeySecret: 'MARKER-gk-rzp-1q', appSecret: 'MARKER-gk-app-2w', platformWhatsappToken: 'MARKER-gk-wa-3e', razorpayKeyId: 'rzp_test_GoliveKit123' };

test('G-15: the console answers the checklist to a super admin and support only, with live checks on request, and never a value', async (t) => {
  const app = await startWorld(t, { overrides: MARKERS });
  const admin = await consoleUser(app);
  const support = await consoleUser(app, 'support');
  for (const role of ['onboarding']) assert.equal((await onConsole(app, await consoleUser(app, role), '/golive')).status, 403, role);
  assert.equal((await hit(app, '/golive', { host: CONSOLE_HOST })).status, 401);
  const shop = await addBusiness(app, { slug: 'gk-seller', name: 'GK Seller' });
  const owner = await hit(app, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: shop.owner });
  assert.notEqual((await hit(app, '/golive', { host: shop.host, token: owner.json()?.token })).status, 200, 'a seller never sees it');

  const plain = await onConsole(app, admin, '/golive');
  const live = await onConsole(app, support, '/golive?live=1');
  assert.deepEqual([plain.status, live.status], [200, 200]);
  for (const res of [plain, live]) {
    const status = GoliveStatus.parse(res.json());
    assert.equal(status.ready, false);
    assert.equal(res.headers['cache-control'], 'no-store');
    for (const value of Object.values(MARKERS)) assert.equal(res.text.includes(value), false, value);
    assert.equal(res.text.includes('gk-seller'), false);
    assert.notEqual(status.items.find((i) => i.id === 'razorpay.settings').state, 'ready', 'a test-mode key is never ready');
  }
  // Without live checks a probe that would ask a provider is "not checked"; the world's simulators make it missing with them.
  const offlineItem = plain.json().items.find((i) => i.id === 'meta.app_live');
  const liveItem = live.json().items.find((i) => i.id === 'meta.app_live');
  assert.notEqual(offlineItem.state, 'ready');
  assert.notEqual(liveItem.state, 'ready');
});

test('G-17: support, onboarding, a seller and nobody cannot change the mode by any route, and a refusal writes nothing', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const before = (await modeOf(app, admin)).mode;
  for (const role of ['support', 'onboarding']) {
    const who = await consoleUser(app, role);
    for (const body of [{ mode: 'closed', reason: 'tidy up' }, { mode: 'public', reason: 'launch', force: true, forceReason: 'because' }]) assert.equal((await put(app, who, body)).status, 403, role);
    assert.equal((await onConsole(app, who, '/signup', { method: 'PUT', body: { mode: 'closed', reason: 'x' }, headers: { 'x-http-method-override': 'PUT' } })).status, 403);
  }
  const shop = await addBusiness(app, { slug: 'gk-shop', name: 'Shop' });
  const login = await hit(app, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: shop.owner });
  for (const host of [shop.host, `app.${NEUTRAL}`]) {
    assert.notEqual((await hit(app, '/signup', { host, method: 'PUT', token: login.json()?.token, body: { mode: 'public', reason: 'sneaky' } })).status, 200, host);
  }
  // A console session's cookie without its CSRF token is refused too.
  assert.notEqual((await hit(app, '/signup', { host: CONSOLE_HOST, method: 'PUT', cookie: admin.cookie, body: { mode: 'closed', reason: 'no csrf' } })).status, 200);
  assert.equal((await modeOf(app, admin)).mode, before);
  assert.deepEqual(await audits(app), []);
});

test('G-17: public is refused while a blocking item is open, naming it; forcing needs a second reason and is audited as forced', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const refused = await put(app, admin, { mode: 'public', reason: 'launch day' });
  assert.equal(refused.status, 409);
  const ids = String(refused.json().fields?.golive ?? '').split(' ');
  assert.ok(ids.includes('meta.instagram_access'), 'Standard Access holds public sign-up back');
  assert.ok(ids.includes('meta.app_live'));
  for (const body of [{ force: true }, { force: true, forceReason: '' }, { force: true, forceReason: '  ' }]) assert.equal((await put(app, admin, { mode: 'public', reason: 'launch day', ...body })).status, 400);
  assert.equal((await modeOf(app, admin)).mode, 'invite');
  assert.deepEqual(await audits(app), []);
  const forced = await put(app, admin, { mode: 'public', reason: 'launch day', force: true, forceReason: 'founder accepts the open items' });
  assert.equal(forced.status, 200);
  const [row] = await audits(app);
  assert.equal(row.details.forced, true);
  assert.equal(row.details.reason, 'launch day');
  assert.equal(row.details.forceReason, 'founder accepts the open items');
  assert.ok(row.details.missing.includes('meta.instagram_access'));
  assert.match(row.actor, /^platform:\d+$/);
  // Closed and invite never wait for the checklist; force on them is not recorded as forced.
  const back = await put(app, admin, { mode: 'invite', reason: 'pause', force: true, forceReason: 'harmless' });
  assert.equal(back.status, 200);
  assert.equal((await audits(app)).at(-1).details.forced, undefined);
});

test('G-17: two mode changes at once leave one of the two modes and two audit rows', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const [a, b] = [await consoleUser(app), await consoleUser(app)];
  const results = await Promise.all([put(app, a, { mode: 'closed', reason: 'first of two' }), put(app, b, { mode: 'invite', reason: 'second of two', dailyCap: 9 })]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.ok(['closed', 'invite'].includes((await modeOf(app, a)).mode));
  const rows = await audits(app);
  assert.deepEqual(rows.map((r) => r.details.mode).sort(), ['closed', 'invite']);
});

// ---- Sign-up on the server, with signed-in people (the WhatsApp-code sign-in of the accounts module) ----

let w;
before(async () => {
  w = await world({ overrides: { goliveEnforce: true } });
});
after(async () => {
  await w?.close?.();
});
const madeBySignup = async () => Number((await w.sql('SELECT count(*)::int AS n FROM signup_runs WHERE tenant_id IS NOT NULL'))[0].n);

test('G-17: with sign-up closed, or by invite without a working code, the server makes no business whatever the request says', async () => {
  const person = await w.person();
  for (const mode of ['closed', 'invite']) {
    await w.setMode(mode);
    const before = await madeBySignup();
    for (const extra of [{}, { inviteCode: 'NOPE-NOPE-NOPE' }, { inviteCode: '' }, { mode: 'public' }]) {
      const { started } = await w.signUp(person, extra);
      assert.ok([400, 403, 409].includes(started.status), `${mode} ${JSON.stringify(extra)}: ${started.status}`);
    }
    assert.equal(await madeBySignup(), before, `${mode}: no business was made`);
  }
});

test('G-17: the daily cap holds when sign-ups arrive together, and the database refuses a business past it', async () => {
  await w.setMode('public');
  const already = Number((await w.sql(`SELECT count(*)::int AS n FROM signup_runs r JOIN tenants t ON t.id = r.tenant_id
    WHERE t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`))[0].n);
  await w.sql('UPDATE signup_settings SET daily_cap = $1', [already + 2]);
  const people = await Promise.all(Array.from({ length: 6 }, () => w.person()));
  const before = await madeBySignup();
  const results = await Promise.all(people.map((who) => w.signUp(who, { name: `Rush ${crypto.randomBytes(2).toString('hex')}` })));
  const made = results.filter((r) => r.started.status === 201).length;
  assert.equal(made, 2, `statuses ${results.map((r) => r.started.status).join(',')}`);
  assert.equal(await madeBySignup(), before + 2);
  for (const r of results.filter((x) => x.started.status !== 201)) assert.ok([403, 500].includes(r.started.status), String(r.started.status));

  // Past the sign-up module's own check: the trigger of migration 911 refuses to give a run a business beyond the cap.
  const [{ id: tenantId }] = await w.sql(`INSERT INTO tenants (slug, name, plan) VALUES ($1, 'Late', 'free') RETURNING id`, [`late-${crypto.randomBytes(3).toString('hex')}`]);
  const [{ id: runId }] = await w.sql('INSERT INTO signup_runs (token_hash) VALUES ($1) RETURNING id', [crypto.randomBytes(32).toString('hex')]);
  await assert.rejects(w.sql('UPDATE signup_runs SET tenant_id = $2 WHERE id = $1', [runId, tenantId]), /signup\.daily_cap/);
  await w.sql('UPDATE signup_settings SET daily_cap = NULL');
  await w.sql('UPDATE signup_runs SET tenant_id = $2 WHERE id = $1', [runId, tenantId]);
  assert.equal(await madeBySignup(), before + 3, 'with no cap the same change is accepted');
});
