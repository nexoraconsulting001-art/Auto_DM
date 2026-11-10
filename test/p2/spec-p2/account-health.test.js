// PRD 7.7: the Account Health score. N-29 to N-34.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, addP2Shop, captureLogs, consoleUser, dayAgo, hit, liveReel, need, onConsole, unique, useP2World } from './support.js';

const world = useP2World();
const NO_INSIGHTS = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];

const setExpiry = (shop, ms) => shop.sql(`UPDATE ig_accounts SET token_expires_at = now() + ($3::bigint * interval '1 millisecond') WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId, Math.round(ms)]);
const code = (health, name) => health.deductions.find((d) => d.code === name);
const text = (deduction) => `${deduction?.message ?? ''} ${deduction?.fix ?? ''}`;
const recompute = async (shop) => {
  await shop.settle({ ms: 2500, roundMs: 250 });
  return shop.health();
};

/** Polling adds real calls to the same hour's counts, which would blur an edge like 21 errors in 100. */
async function quiet(shop) {
  await shop.settle({ ms: 1500, roundMs: 200 });
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() + interval '30 days' WHERE tenant_id = $1`, [shop.tenantId]);
}

async function callStats(shop, { calls = 100, errors = 0, excluded = 0, bucThrottles = 0, maxUsage = 0, agoMs = 0 }) {
  await quiet(shop);
  await shop.sql(
    `INSERT INTO meta_call_stats (tenant_id, channel, account_id, hour, calls, errors, excluded, buc_throttles, max_usage_percent)
     VALUES ($1, 'instagram', $2, date_trunc('hour', now() - ($3::bigint * interval '1 millisecond')), $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, channel, account_id, hour) DO UPDATE SET calls = EXCLUDED.calls, errors = EXCLUDED.errors, excluded = EXCLUDED.excluded, buc_throttles = EXCLUDED.buc_throttles, max_usage_percent = EXCLUDED.max_usage_percent`,
    [shop.tenantId, shop.igUserId, Math.round(agoMs), calls, errors, excluded, bucThrottles, maxUsage],
  );
}

test('N-29: a token 10 days from expiry costs 10 points, with "Refresh pending" shown', async () => {
  const shop = await addP2Shop(world);
  await setExpiry(shop, 10 * DAY);
  const health = await recompute(shop);
  const item = code(health, 'token_14d');
  assert.ok(item, JSON.stringify(health.deductions));
  assert.equal(item.points, -10);
  assert.match(text(item), /Refresh pending/);
  assert.ok(item.fix, 'Each deduction is listed with its fix');
  assert.equal(health.score, 90);
  assert.equal(health.band, 'good');
});

test('N-29: at 14 days or less it counts; with a day more it doesn\'t', async () => {
  const shop = await addP2Shop(world);
  await setExpiry(shop, 14 * DAY - INSIDE_MS * 2);
  assert.ok(code(await recompute(shop), 'token_14d'), 'Just inside 14 days');
  await setExpiry(shop, 14 * DAY + HOUR);
  assert.equal(code(await recompute(shop), 'token_14d'), undefined, 'Just past 14 days');
});

test('N-29: a failed refresh costs 30', async () => {
  const shop = await addP2Shop(world);
  await shop.sql('UPDATE ig_accounts SET refresh_failures = 1 WHERE tenant_id = $1 AND ig_user_id = $2', [shop.tenantId, shop.igUserId]);
  const item = code(await recompute(shop), 'token_refresh_failed');
  assert.equal(item?.points, -30);
});

test('N-29: the score keeps a day-by-day history for 90 days', async () => {
  const shop = await addP2Shop(world);
  await setExpiry(shop, 10 * DAY);
  await recompute(shop);
  const { days } = await shop.get('/account-health/history', { range: '7' }, 'The history');
  const today = days.find((d) => d.value !== null);
  assert.ok(today, 'Today has a score');
  assert.ok(today.deductions.some((d) => d.code === 'token_14d'));
  assert.equal(today.band, 'good');
});

test('N-29: history older than 90 days is removed; the edge day stays', async () => {
  const shop = await addP2Shop(world);
  const ref = await shop.accountRef();
  for (const [offset, score] of [[ANALYTICS_LIMITS.healthHistoryDays, 90], [ANALYTICS_LIMITS.healthHistoryDays + 1, 80]]) {
    await shop.sql(`INSERT INTO account_health_history (tenant_id, account_ref, day, score, band) VALUES ($1, $2, $3, $4, 'good')`, [shop.tenantId, ref, dayAgo(offset), score]);
  }
  await recompute(shop);
  const kept = (await shop.sql(`SELECT day::text FROM account_health_history WHERE tenant_id = $1 AND account_ref = $2 AND day < current_date - 80`, [shop.tenantId, ref])).map((r) => r.day);
  assert.ok(kept.includes(dayAgo(ANALYTICS_LIMITS.healthHistoryDays)), 'Day 90 stays');
  assert.equal(kept.includes(dayAgo(ANALYTICS_LIMITS.healthHistoryDays + 1)), false, 'Day 91 is gone');
});

test('N-30: a token 2 days from expiry costs 20, and the connection shows red', async () => {
  const shop = await addP2Shop(world);
  await setExpiry(shop, 2 * DAY);
  const health = await recompute(shop);
  assert.equal(code(health, 'token_3d')?.points, -20);
  assert.equal(code(health, 'token_14d'), undefined, 'The deductions don\'t stack');
  assert.equal(health.score, 80);
  assert.equal((await shop.get('/instagram/connection')).health, 'red');
});

test('N-30: 3 days or less is the 20-point band and a little over isn\'t', async () => {
  const shop = await addP2Shop(world);
  await setExpiry(shop, 3 * DAY - INSIDE_MS * 2);
  assert.ok(code(await recompute(shop), 'token_3d'), 'Just inside 3 days');
  await setExpiry(shop, 3 * DAY + HOUR);
  const health = await recompute(shop);
  assert.equal(code(health, 'token_3d'), undefined, 'Just past 3 days');
  assert.ok(code(health, 'token_14d'), 'Back to the 10-point band');
});

for (const [score, band, set] of [
  [80, 'good', async (shop) => setExpiry(shop, 2 * DAY)],
  [70, 'watch', async (shop) => { await setExpiry(shop, 2 * DAY); await callStats(shop, { maxUsage: 80 }); }],
  [50, 'watch', async (shop) => { await setExpiry(shop, 2 * DAY); await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: NO_INSIGHTS }); await shop.poll(); }],
  [40, 'at_risk', async (shop) => { await setExpiry(shop, 2 * DAY); await callStats(shop, { errors: 21, maxUsage: 80 }); }],
]) {
  test(`N-30: a score of ${score} is ${band}`, async () => {
    const shop = await addP2Shop(world);
    await shop.accountRef();
    await set(shop);
    const health = await recompute(shop);
    assert.deepEqual([health.score, health.band], [score, band], JSON.stringify(health.deductions));
  });
}

test('N-31: a rejected token sets the score to 0, shows Reconnect Instagram, and jobs are held', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.post('/tokens/revoke', { igUserId: shop.igUserId });
  await shop.poll();
  const health = await recompute(shop);
  assert.equal(health.score, 0);
  assert.equal(health.band, 'at_risk');
  assert.match(text(code(health, 'token_rejected')), /Reconnect Instagram/);
  assert.equal((await shop.get('/compliance/status')).reconnectNeeded, true);
});

test('N-31: with a rejected token a matching comment is held, not sent', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  await world.meta.post('/tokens/revoke', { igUserId: shop.igUserId });
  await shop.poll();
  await shop.settle({ ms: 4000 });
  await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle({ ms: 5000 });
  assert.equal((await shop.sent()).length, 0, 'Nothing is sent');
  assert.ok((await shop.jobs(`status = 'held'`)).length >= 1, 'The job waits');
});

test('N-31: nothing else can raise a rejected score above 0, and an expiry that has passed is the same', async () => {
  const shop = await addP2Shop(world);
  await shop.sql(`UPDATE ig_accounts SET token_expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId]);
  await shop.poll();
  assert.equal((await recompute(shop)).score, 0);
});

test('N-31: a reconnected account gets its score back', async () => {
  const shop = await addP2Shop(world);
  await world.meta.post('/tokens/revoke', { igUserId: shop.igUserId });
  await shop.poll();
  await recompute(shop);
  const { token } = await world.meta.post('/tokens', { igUserId: shop.igUserId });
  await shop.repos.igAccounts.setToken(shop.igUserId, token);
  await shop.sql(`UPDATE ig_accounts SET status = 'active', status_reason = '', token_expires_at = now() + interval '50 days', refresh_failures = 0 WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId]);
  await shop.poll();
  assert.equal((await recompute(shop)).score, 100);
});

test('N-32: 30 of 100 calls failing costs 30, with "API errors 30%"', async () => {
  const shop = await addP2Shop(world);
  await callStats(shop, { calls: 100, errors: 30 });
  const health = await recompute(shop);
  const item = code(health, 'api_errors_20');
  assert.equal(item?.points, -30);
  assert.match(text(item), /API errors 30%/);
  assert.equal(code(health, 'api_errors_5'), undefined, 'Not both');
});

for (const [errors, name, points] of [[5, null, 0], [6, 'api_errors_5', -15], [20, 'api_errors_5', -15], [21, 'api_errors_20', -30]]) {
  test(`N-32: ${errors} errors in 100 calls ${name ? `costs ${-points}` : 'costs nothing: above 5% is the rule'}`, async () => {
    const shop = await addP2Shop(world);
    await callStats(shop, { calls: 100, errors });
    const health = await recompute(shop);
    const found = health.deductions.filter((d) => /api_errors/.test(d.code));
    assert.deepEqual(found.map((d) => [d.code, d.points]), name ? [[name, points]] : []);
  });
}

test('N-32: only the last 24h count: older failures have no effect', async () => {
  const shop = await addP2Shop(world);
  await callStats(shop, { calls: 100, errors: 100, agoMs: 25 * HOUR });
  await callStats(shop, { calls: 100, errors: 0 });
  assert.deepEqual((await recompute(shop)).deductions.filter((d) => /api_errors/.test(d.code)), []);
});

test('N-32: real failed calls to Meta are what the error rate counts', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.fault({ kind: 'server_error', status: 500, times: 'forever', match: { path: '*/insights' } });
  try {
    await shop.poll();
  } finally {
    await world.meta.delete('/faults');
  }
  const [stats] = await shop.sql('SELECT sum(calls)::int AS calls, sum(errors)::int AS errors FROM meta_call_stats WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(stats.errors >= 1, `Errors were counted: ${JSON.stringify(stats)}`);
  assert.ok(stats.calls >= stats.errors);
});

test('N-32: no token, username or message text ever reaches the error counts or logs', async (t) => {
  const logs = captureLogs(t);
  const shop = await addP2Shop(world);
  await world.meta.fault({ kind: 'server_error', status: 500, times: 5, match: { path: '*/insights' } });
  await shop.poll();
  await world.meta.delete('/faults');
  const text_ = logs.text();
  assert.equal(text_.includes(shop.igToken), false, 'The token is in the logs');
  assert.equal(text_.includes(`${shop.slug}_ig`), false, 'The username is in the logs');
  assert.doesNotMatch(JSON.stringify(await shop.sql('SELECT * FROM meta_call_stats WHERE tenant_id = $1', [shop.tenantId])), new RegExp(shop.igToken));
});

test('N-32: the usage header and 80002 have their own deductions, at their edges', async () => {
  const shop = await addP2Shop(world);
  await callStats(shop, { maxUsage: 74 });
  assert.equal(code(await recompute(shop), 'usage_75'), undefined, '74% isn\'t 75%');
  await callStats(shop, { maxUsage: 75 });
  assert.equal(code(await recompute(shop), 'usage_75')?.points, -10);
  await callStats(shop, { bucThrottles: 1 });
  assert.equal(code(await recompute(shop), 'buc_80002')?.points, -25);
});

test('N-32: no webhook for 72h while media got comments costs 15, until one arrives', async () => {
  const shop = await addP2Shop(world);
  await shop.sql(`UPDATE ig_accounts SET connected_at = now() - interval '5 days' WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId]);
  await shop.seedMedia({ mediaId: `c${unique()}`, kind: 'reel', postedAgoMs: 4 * DAY, latest: { comments: 9 }, snapshots: [{ ageMinutes: 1440, metrics: { comments: 1 } }, { ageMinutes: 5000, metrics: { comments: 9 } }] });
  const health = await recompute(shop);
  assert.equal(code(health, 'no_webhooks_72h')?.points, -15);
  await shop.comment(await shop.reel({ id: `w${unique()}` }), { from: world.fan() });
  assert.equal(code(await recompute(shop), 'no_webhooks_72h'), undefined);
});

test('N-32: the console shows the same checks, worst first', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await setExpiry(a, 2 * DAY);
  await recompute(a);
  await recompute(b);
  const operator = await consoleUser(world);
  const list = need(await onConsole(world, operator, '/account-health'), 200, 'The console list').json().items;
  const scores = list.map((i) => i.score);
  assert.deepEqual([...scores].sort((x, y) => x - y), scores, 'Worst first');
  assert.ok(list.some((i) => i.tenantId === a.tenant.id && i.deductions.some((d) => d.code === 'token_3d')));
});

test('N-33: only story error 10 responses cost nothing', async () => {
  const shop = await addP2Shop(world);
  for (let i = 0; i < 3; i++) {
    const id = await shop.story({ id: `low${i}${unique()}` });
    await world.meta.post('/insights', { id, notEnoughViewers: true });
  }
  await shop.poll();
  const health = await recompute(shop);
  assert.deepEqual(health.deductions.filter((d) => /api_errors/.test(d.code)), []);
  assert.equal(health.score, 100);
});

test('N-33: empty data sets are excluded too', async () => {
  const shop = await addP2Shop(world);
  await callStats(shop, { calls: 100, errors: 0, excluded: 95 });
  assert.deepEqual((await recompute(shop)).deductions.filter((d) => /api_errors/.test(d.code)), []);
});

test('N-34: insights revoked later costs 30, Analytics and Reach Guard show Permission needed, and automation continues in slow mode', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  await shop.poll();
  await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: NO_INSIGHTS });
  await shop.poll();
  const health = await recompute(shop);
  assert.equal(code(health, 'scope_missing')?.points, -30);
  assert.match(text(code(health, 'scope_missing')), /Permission needed|permission/i);
  assert.equal((await shop.get('/insights/status')).permission, 'needed');
  assert.equal((await shop.get('/insights/account', { range: '7' })).permission, 'needed');
  const guard = await shop.guard();
  assert.equal(guard.state, 'permission_needed');
  assert.deepEqual([guard.slowMode.active, guard.slowMode.trigger, guard.slowMode.canOverride], [true, 'insights_denied', false]);
  await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle({ ms: 6000 });
  assert.ok((await shop.dms()).length >= 1, 'Automation continues');
});

test('N-34: a denied poll is not an API error, and polling stops asking until the permission is back', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: NO_INSIGHTS });
  await shop.poll();
  const health = await recompute(shop);
  assert.deepEqual(health.deductions.filter((d) => /api_errors/.test(d.code)).map((d) => d.code), []);
  const [row] = await shop.sql('SELECT permission FROM analytics_accounts WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.permission, 'denied');
});

test('N-34: the permission coming back clears the state', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: NO_INSIGHTS });
  await shop.poll();
  await recompute(shop);
  await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: [...NO_INSIGHTS, 'instagram_business_manage_insights'] });
  await shop.sql(`UPDATE ig_accounts SET granted_scopes = $3 WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId, [...NO_INSIGHTS, 'instagram_business_manage_insights']]);
  await world.travel(25 * HOUR, { sim: true });
  await shop.poll();
  await shop.poll();
  const res = await shop.get('/insights/status');
  assert.equal(res.permission, 'ok');
  assert.equal(code(await recompute(shop), 'scope_missing'), undefined);
});

test('N-34: another business\'s revoked permission changes nothing here', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.poll();
  await b.poll();
  await world.meta.post('/tokens/scopes', { igUserId: a.igUserId, scopes: NO_INSIGHTS });
  await a.poll();
  assert.equal((await b.get('/insights/status')).permission, 'ok');
  assert.notEqual((await b.guard()).state, 'permission_needed');
});

test('N-34: an account with no scope at connection time shows Permission needed from the start', async () => {
  const shop = await addP2Shop(world, { scopes: NO_INSIGHTS });
  await shop.poll();
  assert.equal((await shop.get('/insights/status')).permission, 'needed');
});

// ---- who can see it ---------------------------------------------------------------------------------------------------

test('N-29: Account Health is read by staff holding analytics only, and is per business', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await setExpiry(a, 2 * DAY);
  await recompute(a);
  const staff = await a.addStaff(['orders']);
  assert.equal((await a.as(staff.token, '/account-health')).status, 403);
  assert.deepEqual((await recompute(b)).deductions, []);
  const scoped = await hit(world, '/api/v1/account-health', { host: b.host, token: a.token });
  assert.ok([401, 403].includes(scoped.status), `A token of another business, got ${scoped.status}`);
});
