// PRD 5.7 and 5.20: a plan change applies at once and in place; a downgrade keeps every row and switches features off
// (automations above the limit pause, newest first; checkout closes; the badge returns on Free); every change is audited
// and the owner told; Free's limits hold on the server, racing included; feature flags by business or percentage.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { flagOn } from '../../../src/contracts/billing.js';
import { withTenant } from '../../../src/tenancy.js';
import { api, automationBody, world } from './support.js';

let w;
let token;
before(async () => {
  w = await world();
  token = await w.ownerToken();
});
after(() => w?.close());

const states = async () => (await w.sql('SELECT id, state, paused_reason FROM automations WHERE tenant_id = $1 ORDER BY id', [w.tenant.id]));
const running = async () => (await states()).filter((a) => ['live', 'test'].includes(a.state)).length;

test('F-34, F-35, F-128: a downgrade pauses the newest automations above the limit and keeps everything; an upgrade resumes them in place; both audited and told', async () => {
  await w.changePlan(w.tenant.id, 't3');
  const ids = [];
  for (let n = 1; n <= 5; n++) {
    const made = await api(w, token, 'POST', '/automations', automationBody(n));
    assert.equal(made.status, 201, JSON.stringify(made.json));
    ids.push(made.json.id);
    assert.equal((await api(w, token, 'POST', `/automations/${made.json.id}/state`, { state: 'live' })).status, 200);
  }
  assert.equal((await api(w, token, 'GET', '/billing/features')).json.features['store.checkout'].on, true);

  await w.changePlan(w.tenant.id, 'free', { source: 'billing', actor: 'billing' });
  const after = await states();
  assert.equal(after.length, 5, 'no automation is removed');
  assert.deepEqual(after.map((a) => a.state), ['live', 'live', 'live', 'paused', 'paused'], 'the newest above the limit pause');
  assert.deepEqual(after.slice(3).map((a) => a.paused_reason), ['plan.limit', 'plan.limit']);
  const features = (await api(w, token, 'GET', '/billing/features')).json;
  assert.equal(features.plan, 'free', 'the next request sees the new plan');
  assert.equal(features.features['store.checkout'], undefined, 'checkout closes');
  assert.equal(features.features['badge.made_with'].on, true, 'the badge returns on Free');
  assert.equal((await api(w, token, 'GET', '/orders')).status, 200, 'orders stay manageable');
  assert.equal((await api(w, token, 'GET', `/automations/${ids[4]}`)).status, 200, 'a paused automation can still be read');

  // F-35 and F-123: switching a fourth on is refused with the limit and the plan that has more.
  const fourth = await api(w, token, 'POST', `/automations/${ids[3]}/state`, { state: 'live' });
  assert.deepEqual([fourth.status, fourth.json.code, fourth.json.limit, fourth.json.used, fourth.json.plan], [403, 'plan.limit_reached', 3, 3, 't1']);
  // F-124: making a fourth through the API leaves no row.
  const made = await api(w, token, 'POST', '/automations', automationBody(6));
  assert.ok(made.status >= 400 && made.status < 500, `refused (${made.status})`);
  assert.equal((await states()).length, 5);
  // F-125: a link flow other than two-tap is refused on Free. User decision 2026-11-26 (plan gating): the plan's refusal,
  // 403 plan.feature_off with the upgrade path, not the 400 this test was written against; the field is still named.
  const oneTap = await api(w, token, 'PATCH', `/automations/${ids[0]}`, { linkMode: 'one_tap' });
  assert.deepEqual([oneTap.status, oneTap.json.code, oneTap.json.feature, oneTap.json.upgradeUrl], [403, 'plan.feature_off', 'links.one_tap', '/admin/billing']);
  assert.ok(oneTap.json.fields?.linkMode);

  const downgrade = await w.sql(`SELECT actor, details FROM audit_log WHERE tenant_id = $1 AND action = 'plan.changed' ORDER BY id DESC LIMIT 1`, [w.tenant.id]);
  assert.deepEqual([downgrade[0].actor, downgrade[0].details.from, downgrade[0].details.to, downgrade[0].details.paused], ['billing', 't3', 'free', 2]);
  const told = await api(w, token, 'GET', '/alerts');
  const alert = told.json.items.find((a) => a.kind === 'plan.changed');
  assert.match(alert.message, /Free/);
  assert.match(alert.message, /2 automation\(s\)/);
  assert.equal(/bhava/i.test(alert.message), false);

  await w.changePlan(w.tenant.id, 't1', { source: 'owner', actor: 'user:1' });
  assert.deepEqual((await states()).map((a) => a.state), ['live', 'live', 'live', 'live', 'live'], 'the upgrade resumes what the plan paused, in place');
  assert.equal((await api(w, token, 'GET', '/billing/features')).json.features['badge.made_with'], undefined, 'the badge goes at once');
  const upgrade = await w.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'plan.changed' ORDER BY id DESC LIMIT 1`, [w.tenant.id]);
  assert.equal(upgrade[0].details.resumed, 2);

  // A direct change of tenants.plan is recorded by its plan_changes row and still pauses.
  await w.sql(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [w.tenant.id]);
  assert.equal(await running(), 3);
  // An automation the owner paused is never switched on by a plan change.
  await api(w, token, 'POST', `/automations/${ids[0]}/state`, { state: 'paused' });
  await w.changePlan(w.tenant.id, 't2');
  const owned = (await states()).find((a) => a.id === ids[0]);
  assert.deepEqual([owned.state, owned.paused_reason], ['paused', 'paused.automation']);
});

test('two switch-ons racing for the last place: the database lets one through', async () => {
  await w.changePlan(w.tenant.id, 'free');
  const list = await states();
  const live = list.filter((a) => a.state === 'live');
  const paused = list.filter((a) => a.state === 'paused');
  // Make room for exactly one.
  for (const a of live.slice(2)) await api(w, token, 'POST', `/automations/${a.id}/state`, { state: 'paused' });
  assert.equal(await running(), 2);
  const candidates = [...paused, ...live.slice(2)].slice(0, 3);
  const answers = await Promise.all(candidates.map((a) => api(w, token, 'POST', `/automations/${a.id}/state`, { state: 'live' })));
  assert.equal(answers.filter((r) => r.status === 200).length, 1, JSON.stringify(answers.map((r) => [r.status, r.json?.code])));
  assert.equal(await running(), 3);
  // Straight at the database too.
  const other = (await states()).find((a) => a.state === 'paused');
  await assert.rejects(() => w.sql(`UPDATE automations SET state = 'live' WHERE id = $1`, [other.id]), /plan\.limit_reached/);
});

test('feature flags: off by default, staged by business or by percentage, the same answer every time for one business', async () => {
  const saved = await w.console('PUT', '/flags', { key: 'new_inbox', description: 'The new inbox', percent: 30, reason: 'Staged rollout' });
  assert.deepEqual([saved.status, saved.json.key, saved.json.percent, saved.json.enabled], [200, 'new_inbox', 30, false]);
  const tenants = (await w.sql('SELECT id FROM tenants ORDER BY id LIMIT 12')).map((r) => r.id);
  for (const id of tenants) {
    const first = (await w.console('GET', `/tenants/${id}/flags`)).json.items.find((i) => i.key === 'new_inbox');
    const second = (await w.console('GET', `/tenants/${id}/flags`)).json.items.find((i) => i.key === 'new_inbox');
    assert.deepEqual(first, second);
    assert.equal(first.on, flagOn({ enabled: false, percent: 30 }, undefined, id));
    assert.equal(await withTenant({ id }, () => w.ctx.repos.flags.on('new_inbox')), first.on, 'business code reads the same answer');
  }
  assert.equal(await withTenant(w.tenant, () => w.ctx.repos.flags.on('no_such_flag')), false);

  const own = await w.console('PUT', `/tenants/${w.tenant.id}/flags`, { key: 'new_inbox', enabled: true, reason: 'Pilot business' });
  assert.deepEqual(own.json.items.find((i) => i.key === 'new_inbox'), { key: 'new_inbox', on: true, own: true });
  assert.equal(await withTenant(w.tenant, () => w.ctx.repos.flags.on('new_inbox')), true);
  const off = await w.console('PUT', `/tenants/${w.tenant.id}/flags`, { key: 'new_inbox', enabled: false, reason: 'Held back' });
  assert.equal(off.json.items.find((i) => i.key === 'new_inbox').on, false);
  const cleared = await w.console('PUT', `/tenants/${w.tenant.id}/flags`, { key: 'new_inbox', enabled: null, reason: 'Back to the rollout' });
  assert.deepEqual(cleared.json.items.find((i) => i.key === 'new_inbox'), { key: 'new_inbox', on: flagOn({ percent: 30 }, undefined, w.tenant.id), own: null });
  assert.equal((await w.console('PUT', `/tenants/${w.tenant.id}/flags`, { key: 'imagined', enabled: true, reason: 'x' })).status, 404);
  assert.equal((await w.console('GET', '/flags')).json.items.find((f) => f.key === 'new_inbox').businesses, 0);
  const audited = await w.sql(`SELECT action FROM audit_log WHERE action IN ('flag.saved', 'flag.tenant_set')`);
  assert.equal(audited.length, 4);
  // A business cannot write a flag.
  await assert.rejects(() => withTenant(w.tenant, () => w.db.query(`INSERT INTO tenant_flags (tenant_id, key, enabled) VALUES ($1, 'new_inbox', true)`, [w.tenant.id])), /permission denied|row-level/);
});
