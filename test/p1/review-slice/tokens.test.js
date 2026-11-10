import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryWarning, healthOf, nextRefreshAt } from '../../../src/modules/ig-connect/rules.js';
import { DAY, HOUR, IG_A, IG_B, accountRow, addJob, alertsFor, connected, decisions, jobStatus, startSlice } from './support.js';

/** The app's clock for the sweep and the simulator's clock, moved together. */
async function startClocked(t, options = {}) {
  const clock = { now: Date.now() };
  const slice = await startSlice(t, { moduleOptions: { now: () => clock.now }, ...options });
  await slice.sim.post('/clock', { freeze: true, now: clock.now });
  // The account startApp links for every test holds a made-up token, which would be swept up too.
  await slice.q(`UPDATE ig_accounts SET next_refresh_at = NULL WHERE ig_user_id = 'ME'`);
  const advance = async (ms) => {
    clock.now += ms;
    await slice.sim.post('/clock', { advanceMs: ms });
  };
  return { ...slice, clock, advance };
}

const expiringKinds = (alerts) => alerts.filter((a) => a.kind === 'token.expiring').map((a) => a.message.match(/ends in (\d+) day/)[1]);

test('a token is left alone until it has 30 days to live, and then refreshed', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  const before = await business.repos.igAccounts.get(IG_A);

  await slice.sweep();
  assert.equal((await accountRow(slice, IG_A)).token_version, 1);
  await slice.advance(29 * DAY);
  await slice.sweep();
  assert.equal((await accountRow(slice, IG_A)).token_version, 1);

  await slice.advance(1.5 * DAY);
  await slice.sweep();
  const row = await accountRow(slice, IG_A);
  assert.equal(row.token_version, 2);
  assert.equal(row.refresh_failures, 0);
  assert.ok(row.last_refresh_at);
  assert.notEqual((await business.repos.igAccounts.get(IG_A)).token, before.token);
  assert.ok((await decisions(slice, business.tenant.id)).some((d) => d.decision === 'token.refreshed'));
  assert.deepEqual(expiringKinds(await alertsFor(slice, business.tenant.id)), [], 'a working token never warns');
});

test('C-05: when refresh keeps failing the owner is warned at 14, 7, 3 and 1 days, once each', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  await slice.sim.post('/faults', { kind: 'server_error', times: 'forever', match: { path: '/refresh_access_token' } });
  await slice.q('UPDATE ig_accounts SET token_expires_at = $1, next_refresh_at = $2 WHERE ig_user_id = $3', [new Date(slice.clock.now + 60 * DAY), new Date(slice.clock.now + 30 * DAY), IG_A]);

  await slice.advance(30 * DAY);
  for (let hours = 0; hours < 30 * 24; hours += 6) {
    await slice.sweep();
    await slice.advance(6 * HOUR);
  }
  const alerts = await alertsFor(slice, business.tenant.id);
  assert.deepEqual(expiringKinds(alerts), ['14', '7', '3', '1']);
  assert.ok(alerts.filter((a) => a.kind === 'token.expiring').every((a) => a.audience === 'owner'));

  await slice.sweep();
  const row = await accountRow(slice, IG_A);
  assert.equal(row.status, 'reconnect_needed', 'at expiry with no refresh, the connection is over');
  assert.equal(row.access_token_enc, '');
  assert.equal((await alertsFor(slice, business.tenant.id)).filter((a) => a.kind === 'token.rejected').length, 1);
});

test('a failed refresh is tried every 6 hours for 3 days, then daily', async (t) => {
  const slice = await startClocked(t);
  await connected(slice);
  await slice.sim.post('/faults', { kind: 'server_error', times: 'forever', match: { path: '/refresh_access_token' } });
  await slice.q('UPDATE ig_accounts SET token_expires_at = $1, next_refresh_at = $2 WHERE ig_user_id = $3', [new Date(slice.clock.now + 40 * DAY), new Date(slice.clock.now), IG_A]);

  const gaps = [];
  for (let i = 0; i < 14; i++) {
    await slice.sweep();
    const row = await accountRow(slice, IG_A);
    gaps.push(Math.round((row.next_refresh_at.getTime() - slice.clock.now) / HOUR));
    assert.equal(row.refresh_failures, i + 1);
    await slice.advance(row.next_refresh_at.getTime() - slice.clock.now);
  }
  assert.deepEqual(gaps.slice(0, 12), Array(12).fill(6));
  assert.deepEqual(gaps.slice(12), [24, 24]);
  assert.equal((await accountRow(slice, IG_A)).status, 'active', 'a failing refresh is not a dead token');
});

test('throttling on refresh is a retry, and the amber shows it', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  await slice.sim.post('/faults', { kind: 'rate_limit', match: { path: '/refresh_access_token' } });
  await slice.advance(30 * DAY + HOUR);
  await slice.sweep();
  const row = await accountRow(slice, IG_A);
  assert.equal(row.status, 'active');
  assert.equal(row.refresh_failures, 1);
  assert.equal((await business.api('GET', '/instagram/connection')).body.health, 'amber');
  assert.ok((await decisions(slice, business.tenant.id)).some((d) => d.decision === 'token.refresh_failed'));
});

test('Meta refusing the token ends the connection at once: token gone, jobs held, owner told', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  const job = await addJob(slice, business.tenant.id, IG_A);
  await slice.sim.post('/tokens/revoke', { igUserId: IG_A });
  await slice.advance(30 * DAY + HOUR);
  await slice.sweep();

  const row = await accountRow(slice, IG_A);
  assert.deepEqual([row.status, row.status_reason, row.access_token_enc], ['reconnect_needed', 'token.rejected', '']);
  assert.deepEqual(await jobStatus(slice, job), { status: 'held', reason: 'paused.reconnect' });
  const [alert] = await alertsFor(slice, business.tenant.id);
  assert.deepEqual([alert.kind, alert.audience, alert.severity], ['token.rejected', 'owner', 'critical']);
  assert.doesNotMatch(alert.message, /IGAA/);
  assert.equal(await business.repos.igAccounts.current(), null);
  const view = (await business.api('GET', '/instagram/connection')).body;
  assert.deepEqual([view.status, view.health], ['reconnect_needed', 'red']);
  assert.equal((await slice.q(`SELECT count(*)::int AS n FROM token_alerts WHERE kind = 'rejected'`))[0].n, 1);
});

test('expiry is caught within one sweep, and only once', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  await slice.q('UPDATE ig_accounts SET token_expires_at = $1, next_refresh_at = NULL WHERE ig_user_id = $2', [new Date(slice.clock.now + 1000), IG_A]);
  await slice.advance(2000);
  await slice.sweep();
  await slice.sweep();
  assert.equal((await accountRow(slice, IG_A)).status, 'reconnect_needed');
  assert.equal((await alertsFor(slice, business.tenant.id)).filter((a) => a.kind === 'token.rejected').length, 1);
  assert.equal((await decisions(slice, business.tenant.id)).filter((d) => d.decision === 'token.rejected').length, 1);
});

test('two sweeps at once refresh once, so a rotating token never gets refused', async (t) => {
  const slice = await startClocked(t, { simApp: { rotateOnRefresh: true } });
  await connected(slice);
  await slice.advance(30 * DAY + HOUR);
  await Promise.all([slice.sweep(), slice.sweep()]);
  const row = await accountRow(slice, IG_A);
  assert.deepEqual([row.status, row.token_version], ['active', 2]);
});

test('a token swap only lands on the version it was read from', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const repo = business.repos.igAccounts;

  assert.equal(await repo.swapToken(IG_A, 7, { token: 'stale' }), null);
  assert.equal(await repo.swapToken(IG_A, 1, { token: 'next-one' }), 2);
  assert.equal((await repo.get(IG_A)).token, 'next-one');
  assert.equal(await repo.swapToken(IG_A, 1, { token: 'stale-again' }), null, 'the same version can only be swapped once');
  assert.equal((await repo.get(IG_A)).token, 'next-one');
});

test('a refusal of an old token cannot end a newer one', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const repo = business.repos.igAccounts;
  await repo.swapToken(IG_A, 1, { token: 'newer' });
  assert.equal(await repo.loseToken(IG_A, 'token.rejected', { expectedVersion: 1 }), false);
  assert.equal((await repo.get(IG_A)).token, 'newer');
  assert.equal(await repo.loseToken(IG_A, 'token.rejected', { expectedVersion: 2 }), true);
  assert.equal((await repo.get(IG_A)).token, '');
});

test('a token that can no longer be decrypted reads as not connected, and is not treated as refused by Meta', async (t) => {
  const slice = await startClocked(t);
  const { business } = await connected(slice);
  await slice.q(`UPDATE ig_accounts SET access_token_enc = 'v1.gone.aa.bb.cc', next_refresh_at = $2 WHERE ig_user_id = $1`, [IG_A, new Date(slice.clock.now)]);

  assert.equal((await business.repos.igAccounts.get(IG_A)).token, '');
  assert.equal(await business.repos.igAccounts.current(), null);
  await slice.sweep();
  const row = await accountRow(slice, IG_A);
  assert.deepEqual([row.status, row.refresh_failures], ['active', 1]);
  assert.equal((await slice.sim.calls()).filter((c) => c.path === '/refresh_access_token').length, 0);
});

test('an account the sweep cannot process does not stop the others', async (t) => {
  const slice = await startClocked(t);
  await connected(slice, IG_A);
  await connected(slice, IG_B);
  await slice.advance(30 * DAY + HOUR);
  await slice.q(`UPDATE ig_accounts SET access_token_enc = 'v1.gone.aa.bb.cc' WHERE ig_user_id = $1`, [IG_A]);
  await slice.sweep();
  assert.equal((await accountRow(slice, IG_B)).token_version, 2, 'the good account was still refreshed');
});

test('the refresh schedule follows the 24 hour and 30 day rules', () => {
  const now = Date.UTC(2026, 10, 1);
  assert.equal(nextRefreshAt(now, new Date(now + 60 * DAY)).getTime(), now + 30 * DAY);
  assert.equal(nextRefreshAt(now, new Date(now + 10 * DAY)).getTime(), now + DAY, 'a short-lived token is still at least 24 hours old first');
  assert.equal(nextRefreshAt(now, null), null);
});

test('the warnings and the colours', () => {
  const now = Date.UTC(2026, 10, 1);
  const inDays = (d) => new Date(now + d * DAY);
  assert.deepEqual([20, 14, 8, 7, 4, 3, 2, 1, 0.5, 0].map((d) => expiryWarning(inDays(d), now)), [null, 14, 14, 7, 7, 3, 3, 1, 1, null]);
  const account = (over) => ({ status: 'active', hasToken: true, tokenExpiresAt: inDays(40), refreshFailures: 0, ...over });
  assert.equal(healthOf(account(), now), 'ok');
  assert.equal(healthOf(account({ tokenExpiresAt: inDays(14) }), now), 'amber');
  assert.equal(healthOf(account({ refreshFailures: 1 }), now), 'amber');
  assert.equal(healthOf(account({ tokenExpiresAt: inDays(3) }), now), 'red');
  assert.equal(healthOf(account({ tokenExpiresAt: null }), now), 'ok');
  assert.equal(healthOf(account({ status: 'reconnect_needed' }), now), 'red');
  assert.equal(healthOf(account({ hasToken: false }), now), 'none');
});
