// The seller API and the Platform Console route, over HTTP, on the whole app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { createReachGuard } from '../../../src/modules/reach-guard/service.js';
import { withTenant } from '../../../src/tenancy.js';
import { IG_ACCOUNT, OWNER, fakeIg, startApp } from '../../helpers.js';
import { ALL_SCOPES, DAY, HOUR, START, addAnalyticsAccount, connectAccount, noonSettling, normalMedia, seedDays, seedMedia } from './support.js';

const ACCOUNT = IG_ACCOUNT.igUserId;
const MANAGER = { phone: '9111111111', password: 'manager-pass-1' };
const STAFF = { phone: '9222222222', password: 'staff-pass-12' };

const signIn = async (base, who = OWNER) => (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })).json()).token;

async function app({ at = START } = {}) {
  const clock = { t: at };
  const ig = fakeIg();
  const a = await startApp({ ig, overrides: { complianceNow: () => clock.t, complianceInline: false } });
  await a.db.platform.query('UPDATE ig_accounts SET granted_scopes = $2 WHERE ig_user_id = $1', [ACCOUNT, ALL_SCOPES]);
  const ref = await addAnalyticsAccount(a.db, a.tenant, ACCOUNT);
  const token = await signIn(a.base);
  const call = (path, init = {}, bearer = token) => fetch(`${a.base}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...init.headers } });
  const get = async (path, bearer) => {
    const res = await call(path, {}, bearer);
    assert.equal(res.status, 200, path);
    return res.json();
  };
  return { ...a, ig, clock, ref, token, call, get };
}

async function trip(a) {
  await seedDays(a.db, a.tenant, a.ref, '2026-11-08', [...Array(28).fill(10_000), 5500, 5200, 5800]);
  await seedMedia(a.db, a.tenant, a.ref, normalMedia(6));
  a.clock.t = noonSettling('2026-11-08');
  return a.get('/reach-guard');
}

const addUser = async (a, who, role, permissions) => {
  const user = await a.repos.users.create({ name: role, role, ...who });
  if (permissions) await a.repos.users.setPermissions(user.id, permissions);
  return signIn(a.base, who);
};

test('the status of a tripped account, in the contract\'s shape and the PRD\'s words', async () => {
  const a = await app();
  try {
    const s = await trip(a);
    assert.equal(s.state, 'tripped');
    assert.match(s.message, /^Reach is down 45% vs your usual\. Possible normal causes: /);
    assert.deepEqual([s.settledDays, s.mediaCounted, s.baselineReach], [28, 6, 10_000]);
    assert.deepEqual(s.thresholds, { reachDropPercent: 60, mediaDropPercent: 50, clearPercent: 80 });
    assert.deepEqual([s.trip.trigger, s.trip.dropPercent, s.trip.baseline, s.trip.clearedAt, s.trip.overriddenAt], ['reach_days', 45, 10_000, null, null]);
    assert.deepEqual([s.slowMode.active, s.slowMode.trigger, s.slowMode.canOverride, s.slowMode.restoring], [true, 'reach_drop', true, false]);
    assert.ok(s.lastEvaluatedAt);
    assert.doesNotMatch(JSON.stringify(s), /shadow\s?ban|\bsafe/i);
    assert.equal(a.ig.calls.length, 0, 'a screen never calls Meta');
  } finally {
    a.close();
  }
});

test('with nothing connected and no analytics yet, the screens have an answer', async () => {
  const a = await app();
  try {
    await a.db.platform.query('DELETE FROM analytics_accounts WHERE tenant_id = $1', [a.tenant.id]);
    await a.db.platform.query(`UPDATE ig_accounts SET access_token_enc = '' WHERE ig_user_id = $1`, [ACCOUNT]);
    const s = await a.get('/reach-guard');
    assert.deepEqual([s.state, s.trip, s.baselineReach, s.lastEvaluatedAt], ['learning', null, null, null]);
    assert.match(s.message, /once an account is connected/);
    assert.deepEqual(await a.get('/account-health'), { score: null, band: null, deductions: [], computedAt: null });
    assert.equal((await a.call('/reach-guard/thresholds', { method: 'PATCH', body: JSON.stringify({ clearPercent: 90 }) })).status, 409);
  } finally {
    a.close();
  }
});

test('N-27: a manager trying to override is told Owner only, and nothing changes', async () => {
  const a = await app();
  try {
    await trip(a);
    const manager = await addUser(a, MANAGER, 'manager');
    const res = await a.call('/compliance/slow-mode/override', { method: 'POST', body: JSON.stringify({ confirmation: 'override' }) }, manager);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Owner only.');
    assert.equal((await a.get('/reach-guard')).slowMode.active, true);
    assert.equal((await a.db.platform.query(`SELECT 1 FROM audit_log WHERE action = 'compliance.slow_mode_override'`)).length, 0);
  } finally {
    a.close();
  }
});

test('N-28: slow mode caused by 80002 can\'t be overridden, and the screen doesn\'t offer it', async () => {
  const a = await app();
  try {
    await a.db.platform.query(
      `INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger, slow_mode_holds)
       VALUES ($1, 'instagram', $2, $3::timestamptz, $4::timestamptz, 'buc_80002', jsonb_build_object('buc_80002', $4::timestamptz))`,
      [a.tenant.id, ACCOUNT, new Date(a.clock.t), new Date(a.clock.t + HOUR)],
    );
    const s = await a.get('/reach-guard');
    assert.deepEqual([s.state, s.slowMode.canOverride], ['watch', false]);
    const res = await a.call('/compliance/slow-mode/override', { method: 'POST', body: JSON.stringify({ confirmation: 'override' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /drop in reach/);
    assert.equal((await a.get('/reach-guard')).slowMode.active, true);
  } finally {
    a.close();
  }
});

test('the owner\'s override needs the typed confirmation, is audited, and is on the trip', async () => {
  const a = await app();
  try {
    await trip(a);
    assert.equal((await a.call('/compliance/slow-mode/override', { method: 'POST', body: JSON.stringify({ confirmation: 'yes please' }) })).status, 400);
    assert.equal((await a.get('/reach-guard')).slowMode.active, true);

    assert.equal((await a.call('/compliance/slow-mode/override', { method: 'POST', body: JSON.stringify({ confirmation: 'override' }) })).status, 200);
    const [audit] = await a.db.platform.query(`SELECT actor FROM audit_log WHERE tenant_id = $1 AND action = 'compliance.slow_mode_override'`, [a.tenant.id]);
    assert.match(audit.actor, /^user:\d+$/);

    let s = await a.get('/reach-guard');
    assert.deepEqual([s.state, s.slowMode.active], ['tripped', false]);
    assert.ok(s.trip.overriddenAt);
    assert.match(s.message, /turned slow mode off/);

    a.clock.t += HOUR; // the next look writes it on the trip
    s = await a.get('/reach-guard');
    const [row] = await a.db.platform.query('SELECT override_at, override_by FROM reach_guard_trips WHERE tenant_id = $1', [a.tenant.id]);
    assert.ok(row.override_at);
    assert.equal(`user:${row.override_by}`, audit.actor);
    assert.equal((await a.get('/reach-guard/trips')).items[0].overriddenAt !== null, true);
  } finally {
    a.close();
  }
});

test('thresholds: owner only, within limits, audited, and the clear level stays above the drop level', async () => {
  const a = await app();
  try {
    await a.get('/reach-guard');
    const patch = (body, bearer) => a.call('/reach-guard/thresholds', { method: 'PATCH', body: JSON.stringify(body) }, bearer);

    const manager = await addUser(a, MANAGER, 'manager');
    const refused = await patch({ reachDropPercent: 70 }, manager);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'Owner only.');

    assert.equal((await patch({ reachDropPercent: 39 })).status, 400);
    assert.equal((await patch({ reachDropPercent: 81 })).status, 400);
    assert.equal((await patch({ mediaDropPercent: 71 })).status, 400);
    assert.equal((await patch({ clearPercent: 96 })).status, 400);
    assert.equal((await patch({ reachDropPercent: 60.5 })).status, 400);

    const crossed = await patch({ reachDropPercent: 80, clearPercent: 70 });
    assert.equal(crossed.status, 400);
    assert.ok((await crossed.json()).fields.clearPercent);

    const ok = await patch({ reachDropPercent: 70 });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).thresholds, { reachDropPercent: 70, mediaDropPercent: 50, clearPercent: 80 });
    const [audit] = await a.db.platform.query(`SELECT actor, details FROM audit_log WHERE tenant_id = $1 AND action = 'reach_guard.thresholds_changed'`, [a.tenant.id]);
    assert.match(audit.actor, /^user:/);
    assert.deepEqual([audit.details.before.reachDropPercent, audit.details.after.reachDropPercent], [60, 70]);

    assert.equal((await patch({})).status, 200, 'nothing to change is not an error');
    assert.equal((await a.db.platform.query(`SELECT 1 FROM audit_log WHERE action = 'reach_guard.thresholds_changed'`)).length, 1);
  } finally {
    a.close();
  }
});

test('a threshold change takes effect at once', async () => {
  const a = await app();
  try {
    await seedDays(a.db, a.tenant, a.ref, '2026-11-08', [...Array(28).fill(10_000), 7000, 7000, 7000]);
    await seedMedia(a.db, a.tenant, a.ref, normalMedia(6));
    assert.equal((await a.get('/reach-guard')).state, 'normal');
    const res = await a.call('/reach-guard/thresholds', { method: 'PATCH', body: JSON.stringify({ reachDropPercent: 75 }) });
    assert.equal((await res.json()).state, 'tripped');
  } finally {
    a.close();
  }
});

test('trips are listed newest first and paged', async () => {
  const a = await app();
  try {
    for (let i = 0; i < 3; i++) {
      await a.db.platform.query(`INSERT INTO reach_guard_trips (tenant_id, account_ref, trigger, started_at, cleared_at, baseline, drop_percent) VALUES ($1, $2, 'reach_days', $3::timestamptz, $3::timestamptz, 100, 40)`, [a.tenant.id, a.ref, new Date(START - i * DAY)]);
    }
    const first = await a.get('/reach-guard/trips?limit=2');
    assert.equal(first.items.length, 2);
    assert.ok(first.items[0].id > first.items[1].id);
    assert.ok(first.nextCursor);
    const second = await a.get(`/reach-guard/trips?limit=2&cursor=${first.nextCursor}`);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal((await a.call('/reach-guard/trips?cursor=not-a-real-cursor')).status, 400);
  } finally {
    a.close();
  }
});

test('Account Health and its history over the API; the score explains itself', async () => {
  const a = await app();
  try {
    await a.db.platform.query('UPDATE ig_accounts SET token_expires_at = $2::timestamptz WHERE ig_user_id = $1', [ACCOUNT, new Date(a.clock.t + 10 * DAY)]);
    const h = await a.get('/account-health');
    assert.deepEqual([h.score, h.band], [90, 'good']);
    assert.deepEqual(Object.keys(h.deductions[0]).sort(), ['code', 'fix', 'message', 'points']);
    assert.equal(h.deductions[0].points, -10);

    const seven = await a.get('/account-health/history?range=7');
    assert.equal(seven.days.length, 7);
    const today = seven.days.at(-1);
    assert.deepEqual([today.value, today.state, today.band, today.mayChange], [90, 'ok', 'good', false]);
    assert.equal(today.deductions[0].code, 'token_14d');
    assert.deepEqual([seven.days[0].value, seven.days[0].state, seven.days[0].band], [null, 'no_data', null]);

    const custom = await a.get('/account-health/history?range=custom&from=2025-01-01&to=2026-11-10');
    assert.equal(custom.days.length, 90, 'nothing older than 90 days is kept');
    assert.equal((await a.call('/account-health/history?range=custom&from=2026-11-10&to=2026-11-01')).status, 400);
  } finally {
    a.close();
  }
});

test('staff need the analytics permission to read, and shoppers and strangers get nothing', async () => {
  const a = await app();
  try {
    const plain = await addUser(a, STAFF, 'staff');
    assert.equal((await a.call('/reach-guard', {}, plain)).status, 403);
    assert.equal((await a.call('/account-health', {}, plain)).status, 403);
    assert.equal((await fetch(`${a.base}/api/v1/reach-guard`)).status, 401);
    const allowed = await addUser(a, { phone: '9333333333', password: 'staff-pass-13' }, 'staff', ['analytics']);
    assert.equal((await a.call('/reach-guard', {}, allowed)).status, 200);
    assert.equal((await a.call('/account-health', {}, allowed)).status, 200);
    assert.equal((await a.call('/reach-guard/thresholds', { method: 'PATCH', body: '{"clearPercent":90}' }, allowed)).status, 403);
  } finally {
    a.close();
  }
});

test('the 5.9 console lists every business worst first, and pages', async () => {
  const a = await app();
  try {
    const add = async (slug, igUserId, fields) => {
      const tenant = await a.platform.tenants.create({ slug, name: slug });
      await connectAccount(a.db, a.platform, tenant, igUserId);
      await addAnalyticsAccount(a.db, tenant, igUserId);
      if (fields) await a.db.platform.query('UPDATE ig_accounts SET token_expires_at = $2::timestamptz, status = $3 WHERE ig_user_id = $1', [igUserId, new Date(a.clock.t + fields.days * DAY), fields.status ?? 'active']);
    };
    await add('mid-shop', 'IG-M', { days: 2 });
    await add('bad-shop', 'IG-X', { days: 50, status: 'reconnect_needed' });
    const compliance = createCompliance({ db: a.db, repos: a.platform, ig: {}, config: { complianceNow: () => a.clock.t }, platform: {} });
    await createReachGuard({ db: a.db, repos: a.platform, compliance }).sweep();

    const email = 'ops@bhava.example';
    await a.platform.platformUsers.create({ email, password: 'platform-pass', role: 'support' });
    const onConsole = (path, init = {}) => fetch(`${a.base}${path}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-host': 'admin.bhava.test', ...init.headers } });
    const login = await onConsole('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'platform-pass' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const list = async (query = '') => (await onConsole(`/account-health${query}`, { headers: { cookie } })).json();

    const all = await list();
    assert.deepEqual(all.items.map((i) => i.tenantName), ['bad-shop', 'mid-shop', 'Test store']);
    assert.deepEqual(all.items.map((i) => i.score), [0, 80, 100]);
    assert.equal(all.items[0].deductions[0].code, 'token_rejected');
    assert.ok(all.items[0].computedAt);

    const first = await list('?limit=1');
    assert.equal(first.items.length, 1);
    const second = await list(`?limit=5&cursor=${first.nextCursor}`);
    assert.deepEqual(second.items.map((i) => i.tenantName), ['mid-shop', 'Test store']);
    assert.equal((await onConsole('/account-health?cursor=bm90LWEtY3Vyc29y', { headers: { cookie } })).status, 400, 'a cursor this list did not write');

    assert.equal((await onConsole('/account-health')).status, 401, 'no sign-in, no list');
  } finally {
    a.close();
  }
});

test('a score of one business doesn\'t appear in another\'s answer', async () => {
  const a = await app();
  try {
    await a.db.platform.query('UPDATE ig_accounts SET token_expires_at = $2::timestamptz WHERE ig_user_id = $1', [ACCOUNT, new Date(a.clock.t + DAY)]);
    await a.get('/account-health');
    const other = await a.platform.tenants.create({ slug: 'nosy-shop', name: 'Nosy' });
    const rows = await withTenant(other, () => a.db.query('SELECT 1 FROM account_health'));
    assert.equal(rows.length, 0);
  } finally {
    a.close();
  }
});
