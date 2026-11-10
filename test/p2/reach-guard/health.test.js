// Account Health against the real database, and what onMetaCall records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachGuard } from '../../../src/modules/reach-guard/index.js';
import { dayOf } from '../../../src/modules/reach-guard/rules.js';
import { withTenant } from '../../../src/tenancy.js';
import { DAY, HOUR, IG, START, world } from './support.js';

const codes = (r) => r.deductions.map((d) => d.code);
const setToken = (w, fields) => w.db.platform.query(
  `UPDATE ig_accounts SET token_expires_at = $2::timestamptz, status = COALESCE($3, status), refresh_failures = COALESCE($4, refresh_failures) WHERE ig_user_id = $1`,
  [IG, fields.expiresAt ?? null, fields.status ?? null, fields.refreshFailures ?? null],
);

const record = (w, calls) => w.inside(async () => {
  for (const call of calls) await w.guard.recordCall({ method: 'GET', pathname: 'x/insights', channel: 'instagram', accountId: IG, status: 200, ...call });
});
const fail = (n, more = {}) => Array(n).fill({ status: 400, code: 100, kind: 'validation', ...more });
const pass = (n, more = {}) => Array(n).fill({ status: 200, ...more });

test('a healthy account scores 100 with nothing listed', async () => {
  const w = await world();
  const r = await w.health();
  assert.deepEqual([r.score, r.band, r.deductions], [100, 'good', []]);
});

test('N-29: token 10 days from expiry', async () => {
  const w = await world();
  await setToken(w, { expiresAt: new Date(w.clock.t + 10 * DAY) });
  const r = await w.health();
  assert.equal(r.score, 90);
  assert.deepEqual(codes(r), ['token_14d']);
  assert.match(r.deductions[0].message, /Refresh pending/);
});

test('N-30: token 2 days from expiry', async () => {
  const w = await world();
  await setToken(w, { expiresAt: new Date(w.clock.t + 2 * DAY) });
  const r = await w.health();
  assert.equal(r.score, 80);
  assert.deepEqual(codes(r), ['token_3d']);
  assert.match(r.deductions[0].message, /^Red: /);
});

test('N-31: a rejected token is score 0, shows Reconnect Instagram, and a deauthorized or expired one is the same', async () => {
  for (const fields of [{ status: 'reconnect_needed' }, { status: 'deauthorized' }, { expiresAt: new Date(START - 1) }]) {
    const w = await world();
    await setToken(w, fields);
    const r = await w.health();
    assert.equal(r.score, 0, JSON.stringify(fields));
    assert.equal(r.band, 'at_risk');
    assert.match(r.deductions[0].fix, /Reconnect Instagram/);
  }
});

test('a failed refresh is -30', async () => {
  const w = await world();
  await setToken(w, { refreshFailures: 2 });
  const r = await w.health();
  assert.equal(r.score, 70);
  assert.deepEqual(codes(r), ['token_refresh_failed']);
});

test('N-32: 30 of 100 calls failing', async () => {
  const w = await world();
  await record(w, [...fail(30), ...pass(70)]);
  const r = await w.health();
  assert.equal(r.score, 70);
  assert.match(r.deductions[0].message, /API errors 30%/);
  const [row] = await w.db.platform.query('SELECT calls, errors, excluded FROM meta_call_stats WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([row.calls, row.errors, row.excluded], [100, 30, 0]);
});

test('N-33 and N-11: only story error 10 responses take nothing off', async () => {
  const w = await world();
  await record(w, Array(40).fill({ status: 400, code: 10, kind: 'not_enough_viewers', pathname: 'story1/insights' }));
  const r = await w.health();
  assert.deepEqual([r.score, r.deductions], [100, []]);
  const [row] = await w.db.platform.query('SELECT calls, errors, excluded FROM meta_call_stats WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([row.calls, row.errors, row.excluded], [40, 0, 40]);
});

test('an insights answer of "gone" or "expired" is not a failure; a timeout, a network failure or a 500 is', async () => {
  const w = await world();
  await record(w, [
    { status: 400, code: 100, subcode: 33, kind: 'not_found', pathname: 'm1/insights' },
    { status: 400, code: 100, kind: 'insights_expired', pathname: 'm2/insights' },
    { status: 0, kind: 'timeout' },
    { status: 0, kind: 'network' },
    { status: 500, kind: 'server_error' },
    { status: 200, kind: 'malformed' },
    ...pass(4),
  ]);
  const [row] = await w.db.platform.query('SELECT calls, errors, excluded FROM meta_call_stats WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([row.calls, row.errors, row.excluded], [10, 4, 2]);
});

test('errors older than 24h no longer count', async () => {
  const w = await world();
  await record(w, fail(10));
  assert.deepEqual(codes(await w.health()), ['api_errors_20']);
  w.clock.t += 25 * HOUR;
  assert.deepEqual(codes(await w.health()), []);
});

test('usage header at 75% or more is -10, and error 80002 in 24h is -25', async () => {
  const w = await world();
  await record(w, pass(2, { usage: { percent: 74 } }));
  assert.deepEqual(codes(await w.health()), []);
  await record(w, pass(1, { usage: { percent: 75.4 } }));
  assert.deepEqual(codes(await w.health()), ['usage_75']);
  await record(w, [{ status: 400, code: 80002, kind: 'buc_throttled', usage: { percent: 100, regainMinutes: 30 } }, ...pass(99)]);
  const r = await w.health();
  assert.deepEqual(codes(r), ['buc_80002', 'usage_75']);
  assert.equal(r.score, 65);
});

test('an 80002 the insights guard saw is counted even with no call stats', async () => {
  const w = await world();
  await w.inside(() => w.compliance.insightsGuard('instagram', IG).observe({ kind: 'buc_throttled', usage: { percent: 100, regainMinutes: 10 } }));
  const r = await w.health();
  assert.ok(codes(r).includes('buc_80002'));
  assert.ok(codes(r).includes('usage_75'));
});

test('a messy usage figure is clamped so the column holds it', async () => {
  const w = await world();
  await record(w, pass(1, { usage: { percent: 9e15 } }));
  const [row] = await w.db.platform.query('SELECT max_usage_percent FROM meta_call_stats WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(row.max_usage_percent, 2_147_483_647);
});

test('a call with no business or no account is not recorded', async () => {
  const w = await world();
  await w.guard.recordCall({ method: 'GET', pathname: 'x', channel: 'instagram', accountId: IG, status: 200 });
  await w.inside(() => w.guard.recordCall({ method: 'GET', pathname: 'x', status: 200 }));
  assert.equal((await w.db.platform.query('SELECT 1 FROM meta_call_stats')).length, 0);
});

test('calls go in one row per hour', async () => {
  const w = await world();
  await record(w, pass(3));
  w.clock.t += HOUR;
  await record(w, pass(2));
  const rows = await w.db.platform.query('SELECT calls FROM meta_call_stats WHERE tenant_id = $1 ORDER BY hour', [w.tenant.id]);
  assert.deepEqual(rows.map((r) => r.calls), [3, 2]);
});

test('N-34: an insights scope revoked later is -30 and says Permission needed', async () => {
  const w = await world();
  await w.db.platform.query('UPDATE ig_accounts SET granted_scopes = $2 WHERE ig_user_id = $1', [IG, ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments']]);
  const r = await w.health();
  assert.equal(r.score, 70);
  assert.deepEqual(codes(r), ['scope_missing']);
  assert.match(r.deductions[0].message, /Permission needed/);
});

test('any other missing scope is -30 too, and no scopes on record proves nothing', async () => {
  const w = await world();
  await w.db.platform.query('UPDATE ig_accounts SET granted_scopes = $2 WHERE ig_user_id = $1', [IG, ['instagram_business_basic', 'instagram_business_manage_insights']]);
  assert.deepEqual(codes(await w.health()), ['scope_missing']);
  await w.db.platform.query(`UPDATE ig_accounts SET granted_scopes = '{}' WHERE ig_user_id = $1`, [IG]);
  assert.deepEqual(codes(await w.health()), []);
});

const addComments = (w, day) => w.db.platform.query(`INSERT INTO insight_daily (tenant_id, account_ref, day, metric, value) VALUES ($1, $2, $3::date, 'comments', 4)`, [w.tenant.id, w.ref, day]);
const addEvent = (w, at) => w.db.platform.query(`INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id, received_at) VALUES ($1, 'instagram', $2, 'comments', $3, $4::timestamptz)`, [w.tenant.id, IG, `c${at}`, new Date(at)]);

test('no webhook for 72h while media got comments is -15', async () => {
  const w = await world();
  await addComments(w, dayOf(w.clock.t - DAY));
  await addEvent(w, w.clock.t - 80 * HOUR);
  const r = await w.health();
  assert.deepEqual(codes(r), ['no_webhooks_72h']);
  assert.equal(r.score, 85);
});

test('a recent webhook, or no comments, or a new connection is no deduction', async () => {
  const fresh = await world();
  await addComments(fresh, dayOf(fresh.clock.t - DAY));
  await addEvent(fresh, fresh.clock.t - 2 * HOUR);
  assert.deepEqual(codes(await fresh.health()), []);

  const quiet = await world();
  await addEvent(quiet, quiet.clock.t - 200 * HOUR);
  assert.deepEqual(codes(await quiet.health()), []);

  const fresher = await world();
  await addComments(fresher, dayOf(fresher.clock.t - DAY));
  await fresher.db.platform.query('UPDATE ig_accounts SET connected_at = $2::timestamptz WHERE ig_user_id = $1', [IG, new Date(fresher.clock.t - HOUR)]);
  assert.deepEqual(codes(await fresher.health()), []);
});

test('a rising comment count on a post counts as media getting comments', async () => {
  const w = await world();
  const [m] = await w.db.platform.query(`INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, posted_at) VALUES ($1, $2, 'mx', 'reel', $3::timestamptz) RETURNING id`, [w.tenant.id, w.ref, new Date(w.clock.t - 5 * DAY)]);
  const snap = (hoursAgo, comments) => w.db.platform.query(`INSERT INTO insight_snapshots (tenant_id, media_ref, slot, captured_at, age_minutes, metrics) VALUES ($1, $2, $3::timestamptz, $3::timestamptz, 60, $4::jsonb)`, [w.tenant.id, m.id, new Date(w.clock.t - hoursAgo * HOUR), JSON.stringify({ comments })]);
  await snap(100, 5);
  await snap(10, 5);
  assert.deepEqual(codes(await w.health()), [], 'no new comments');
  await snap(5, 8);
  assert.deepEqual(codes(await w.health()), ['no_webhooks_72h']);
});

test('messaging policy refusals in 24h are -30', async () => {
  const w = await world();
  await w.inside(() => w.platform.compliance.record({ channel: 'instagram', kind: 'dm', decision: 'failed', reason: 'send.error', details: { errorClass: 'policy', metaCode: 200 }, at: new Date(w.clock.t - HOUR) }));
  const r = await w.health();
  assert.deepEqual(codes(r), ['messaging_policy']);
  assert.equal(r.score, 70);
  await w.inside(() => w.platform.compliance.record({ channel: 'facebook', kind: 'dm', decision: 'failed', reason: 'send.error', details: { errorClass: 'policy' }, at: new Date(w.clock.t - HOUR) }));
  w.clock.t += 25 * HOUR;
  assert.deepEqual(codes(await w.health()), []);
});

test('a score is one row now and one row per day, and the day\'s row is the latest', async () => {
  const w = await world();
  await w.health();
  await setToken(w, { expiresAt: new Date(w.clock.t + 10 * DAY) });
  w.clock.t += HOUR;
  await w.health();
  w.clock.t += DAY;
  await w.health();
  const rows = await w.db.platform.query('SELECT score FROM account_health_history WHERE tenant_id = $1 ORDER BY day', [w.tenant.id]);
  assert.deepEqual(rows.map((r) => r.score), [90, 90]);
  assert.equal((await w.db.platform.query('SELECT 1 FROM account_health WHERE tenant_id = $1', [w.tenant.id])).length, 1);
});

test('history stops at 90 days and old call stats are purged', async () => {
  const w = await world();
  const old = (days) => dayOf(w.clock.t - days * DAY);
  for (const days of [120, 90, 89, 1]) {
    await w.db.platform.query(`INSERT INTO account_health_history (tenant_id, account_ref, day, score, band) VALUES ($1, $2, $3::date, 50, 'watch')`, [w.tenant.id, w.ref, old(days)]);
  }
  await w.db.platform.query(`INSERT INTO meta_call_stats (tenant_id, channel, account_id, hour, calls) VALUES ($1, 'instagram', $2, $3::timestamptz, 1)`, [w.tenant.id, IG, new Date(w.clock.t - 8 * DAY)]);
  await w.guard.sweep();
  const rows = await w.db.platform.query(`SELECT to_char(day, 'YYYY-MM-DD') AS d FROM account_health_history WHERE tenant_id = $1 ORDER BY day`, [w.tenant.id]);
  assert.deepEqual(rows.map((r) => r.d), [old(89), old(1), old(0)]);
  assert.equal((await w.db.platform.query('SELECT 1 FROM meta_call_stats')).length, 0);
});

test('a score is reused for 10 minutes, then worked out again', async () => {
  const w = await world();
  await w.inside(() => w.guard.health());
  await setToken(w, { expiresAt: new Date(w.clock.t + 10 * DAY) });
  assert.equal((await w.inside(() => w.guard.health())).score, 100);
  w.clock.t += 10 * 60_000;
  assert.equal((await w.inside(() => w.guard.health())).score, 90);
});

test('a connected account with no analytics row yet still gets its checks, with nothing stored', async () => {
  const w = await world();
  await w.db.platform.query('DELETE FROM analytics_accounts WHERE id = $1', [w.ref]);
  await setToken(w, { expiresAt: new Date(w.clock.t + 10 * DAY) });
  const r = await w.inside(() => w.guard.health());
  assert.equal(r.score, 90);
  assert.equal((await w.db.platform.query('SELECT 1 FROM account_health')).length, 0);
  assert.equal((await w.status()).state, 'learning');
});

test('a business with nothing connected has no score, and a seller-ended connection has none either', async () => {
  const w = await world();
  await w.inside(() => w.guard.health());
  await w.inside(() => w.platform.igAccounts.disconnect(IG, { actor: 'user:1' }));
  w.clock.t += 11 * 60_000;
  assert.deepEqual(await w.inside(() => w.guard.health()), { score: null, band: null, deductions: [], computedAt: null });
  assert.equal((await w.db.platform.query('SELECT 1 FROM account_health')).length, 0);
});

test('the module hears every call through onMetaCall, inside the business', async () => {
  const w = await world();
  const ctx = { db: w.db, repos: w.platform, compliance: w.compliance };
  await withTenant(w.tenant, () => reachGuard.onMetaCall({ method: 'GET', pathname: 'a/insights', channel: 'instagram', accountId: IG, status: 500, kind: 'server_error' }, ctx));
  const [row] = await w.db.platform.query('SELECT calls, errors FROM meta_call_stats WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([row.calls, row.errors], [1, 1]);
});
