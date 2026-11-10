import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCOPES, SCOPES } from '../../../tools/sim/meta/index.mjs';
import { IG_A, accountRow, addBusiness, alertsFor, connected, consent, decisions, seedIg, startSlice, subscribedOnMeta } from './support.js';

const gateLog = async (slice, business) => (await decisions(slice, business.tenant.id)).filter((d) => d.kind === 'gate').map((d) => d.decision);
const settings = async ({ q }, business) => (await q('SELECT * FROM compliance_settings WHERE tenant_id = $1', [business.tenant.id]))[0];
const grant = ({ q }, business) => q(`UPDATE compliance_settings SET access_level = 'advanced' WHERE tenant_id = $1`, [business.tenant.id]);

test('C-52: Standard Access, with no app role, stops at gate.access_level', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  assert.deepEqual(await gateLog(slice, business), ['gate.access_level']);
  assert.equal((await settings(slice, business)).gate_passed_at, null);
});

test('with Advanced Access and everything else in place, the gate passes once', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await grant(slice, business);
  await slice.maintain();
  await slice.maintain();
  assert.deepEqual(await gateLog(slice, business), ['gate.access_level', 'gate.passed'], 'logged when it changes, not every hour');
  const row = await settings(slice, business);
  assert.ok(row.gate_passed_at && row.privacy_url_ok_at && row.deletion_callback_ok_at);
});

test('an app role is enough under Standard Access', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.q('UPDATE compliance_settings SET app_role_ok = true WHERE tenant_id = $1', [business.tenant.id]);
  await slice.maintain();
  assert.ok((await settings(slice, business)).gate_passed_at);
});

test('C-53: without the messages permission, gate.scope_missing and the seller is told to reconnect', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const scopes = DEFAULT_SCOPES.filter((s) => s !== SCOPES.messages);
  const { outcome } = await consent(slice, business, { igUserId: IG_A, scopes });
  assert.equal(outcome, 'missing_scopes');

  const view = (await business.api('GET', '/instagram/connection')).body;
  assert.deepEqual(view.missingScopes, [SCOPES.messages]);
  assert.equal(view.webhooksSubscribed, false);
  assert.ok((await gateLog(slice, business)).includes('gate.scope_missing'));
  const { token } = await business.repos.igAccounts.get(IG_A);
  assert.deepEqual((await subscribedOnMeta(slice.sim, IG_A, token)).sort(), ['comments', 'mentions'], 'only the fields this token may have');
  await grant(slice, business);
  await slice.maintain();
  assert.equal((await settings(slice, business)).gate_passed_at, null);
});

test('C-54: denying insights still goes live, in slow mode, with a prompt to reconnect', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const { outcome } = await consent(slice, business, { igUserId: IG_A, scopes: DEFAULT_SCOPES.filter((s) => s !== SCOPES.insights) });
  assert.equal(outcome, 'connected');
  const view = (await business.api('GET', '/instagram/connection')).body;
  assert.equal(view.insightsGranted, false);
  assert.equal(view.status, 'active');
  assert.deepEqual(view.missingScopes, [SCOPES.insights]);

  const [state] = await slice.q('SELECT * FROM account_rate_state WHERE tenant_id = $1 AND account_id = $2', [business.tenant.id, IG_A]);
  assert.equal(state.slow_mode_trigger, 'insights_denied');
  assert.equal(state.slow_mode_until, null);
  const [alert] = (await alertsFor(slice, business.tenant.id)).filter((a) => a.kind === 'instagram.permission_needed');
  assert.match(alert.message, /Permission needed/);
  await grant(slice, business);
  await slice.maintain();
  assert.ok((await settings(slice, business)).gate_passed_at, 'insights is not one of the gates');
});

test('reconnecting with insights ends that slow mode, and leaves a reach-drop slow mode alone', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  const lessScopes = DEFAULT_SCOPES.filter((s) => s !== SCOPES.insights);
  await consent(slice, business, { igUserId: IG_A, scopes: lessScopes });
  await consent(slice, business, { igUserId: IG_A });
  let [state] = await slice.q('SELECT * FROM account_rate_state WHERE account_id = $1', [IG_A]);
  assert.ok(state.slow_mode_until, 'the restore can begin');

  await slice.q(`UPDATE account_rate_state SET slow_mode_trigger = 'reach_drop', slow_mode_until = now() + interval '1 day' WHERE account_id = $1`, [IG_A]);
  await consent(slice, business, { igUserId: IG_A, scopes: lessScopes });
  [state] = await slice.q('SELECT * FROM account_rate_state WHERE account_id = $1', [IG_A]);
  assert.equal(state.slow_mode_trigger, 'reach_drop');
});

test('a privacy page or deletion callback that cannot be reached holds the gate', async (t) => {
  const failing = () => Promise.reject(new Error('unreachable'));
  const slice = await startSlice(t, { moduleOptions: { fetchImpl: failing } });
  const { business } = await connected(slice);
  await grant(slice, business);
  await slice.maintain();
  const log = await gateLog(slice, business);
  assert.ok(log.includes('gate.privacy_url'));
  assert.ok(log.includes('gate.deletion_callback'));
  assert.equal((await settings(slice, business)).gate_passed_at, null);
});

test('a privacy page that no longer explains deletion does not count', async (t) => {
  const page = () => Promise.resolve(new Response('Welcome to our site', { status: 200 }));
  const slice = await startSlice(t, { moduleOptions: { fetchImpl: page } });
  const { business } = await connected(slice);
  assert.ok((await gateLog(slice, business)).includes('gate.privacy_url'));
});

test('a deauthorize takes the gate back down', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await grant(slice, business);
  await slice.maintain();
  assert.ok((await settings(slice, business)).gate_passed_at);
  await slice.sim.post('/deauthorize', { igUserId: IG_A });
  assert.equal((await settings(slice, business)).gate_passed_at, null);
  assert.equal((await accountRow(slice, IG_A)).status, 'deauthorized');
});

test('the health check leaves no deletion request behind', async (t) => {
  const slice = await startSlice(t);
  await connected(slice);
  assert.deepEqual(await slice.q('SELECT * FROM data_deletion_requests'), []);
});
