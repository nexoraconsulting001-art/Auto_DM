import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoTenantError } from '../../../src/tenancy.js';
import { bindTenant } from '../../../src/repos/index.js';
import { setup } from '../../helpers.js';

const PLANS = ['free', 't1', 't2', 't3', 't4', 't5'];

async function onPlans() {
  const { db, platform } = await setup();
  const out = {};
  for (const plan of PLANS) {
    out[plan] = bindTenant(platform, await platform.tenants.create({ slug: `biz-${plan}`, name: plan, plan })).entitlements;
  }
  return { db, platform, ...out };
}

test('the plans have the limits in the PRD', async () => {
  const p = await onPlans();
  assert.equal(await p.free.limit('automations'), 3);
  assert.equal(await p.free.limit('dms.monthly'), 500);
  assert.equal(await p.free.limit('insights.days'), 7);
  assert.equal(await p.t1.limit('dms.monthly'), 5000);
  assert.equal(await p.t2.limit('dms.monthly'), 15000);
  assert.equal(await p.t3.limit('dms.monthly'), 50000);
  assert.equal(await p.t1.limit('automations'), Infinity);
  assert.equal(await p.t1.limit('insights.days'), Infinity);
  assert.equal(await p.t1.limit('reel.products'), 1);
  assert.equal(await p.t2.limit('reel.products'), 20);
});

test('features start at the right tier', async () => {
  const p = await onPlans();
  const expected = [
    ['links.two_tap', 0], ['analytics', 0], ['reach_guard', 0], ['owner_app', 0],
    ['links.one_tap', 1], ['facebook', 1],
    ['catalog', 2], ['lead_form', 2],
    ['triggers.story_dm', 3], ['store.checkout', 3], ['shopify.sync', 3],
    ['app.android', 4], ['loyalty', 4],
    ['app.ios', 5],
  ];
  for (const [feature, from] of expected) {
    for (const [rank, plan] of PLANS.entries()) assert.equal(await p[plan].can(feature), rank >= from, `${feature} on ${plan}`);
  }
});

test('only Free carries the made-with mark', async () => {
  const p = await onPlans();
  assert.equal(await p.free.can('badge.made_with'), true);
  for (const plan of PLANS.slice(1)) assert.equal(await p[plan].can('badge.made_with'), false, plan);
});

test('no plan loses a feature of the plan below it', async () => {
  const { db } = await onPlans();
  const rows = await db.query('SELECT plan_code, feature FROM plan_features');
  const of = (plan) => new Set(rows.filter((r) => r.plan_code === plan).map((r) => r.feature));
  for (let i = 1; i < PLANS.length; i++) {
    const missing = [...of(PLANS[i - 1])].filter((f) => !of(PLANS[i]).has(f) && f !== 'badge.made_with');
    assert.deepEqual(missing, [], `${PLANS[i]} is missing part of ${PLANS[i - 1]}`);
  }
});

test('a feature the plan lacks is off, and an unknown name is not included', async () => {
  const p = await onPlans();
  assert.equal(await p.t1.can('store.checkout'), false);
  assert.equal(await p.t1.limit('store.checkout'), 0);
  assert.equal(await p.t5.can('no.such.feature'), false);
  assert.equal(await p.t5.limit('no.such.feature'), 0);
});

test('an override can add a feature, change a limit or switch one off, for one business only', async () => {
  const { t1, free, t3 } = await onPlans();

  await t1.setOverride('triggers.story_dm');
  assert.equal(await t1.can('triggers.story_dm'), true, 'add-on bought');
  assert.equal(await t1.limit('triggers.story_dm'), Infinity);

  await t1.setOverride('dms.monthly', { limit: 15000 });
  assert.equal(await t1.limit('dms.monthly'), 15000, 'an extra DM pack');

  await free.setOverride('automations', { limit: 10 });
  assert.equal(await free.limit('automations'), 10);

  await t3.setOverride('store.checkout', { enabled: false });
  assert.equal(await t3.can('store.checkout'), false);
  assert.equal(await t3.limit('store.checkout'), 0);

  assert.equal(await t3.can('triggers.story_dm'), true);
  await t3.clearOverride('store.checkout');
  assert.equal(await t3.can('store.checkout'), true);

  const { platform, db } = await onPlans();
  const another = bindTenant(platform, await platform.tenants.create({ slug: 'another', name: 'Another', plan: 't1' })).entitlements;
  assert.equal(await another.can('triggers.story_dm'), false);
  assert.equal(await another.limit('dms.monthly'), 5000);
  assert.ok(db);
});

test('a plan change takes effect on the next call', async () => {
  const { db, platform } = await onPlans();
  const tenant = await platform.tenants.getBySlug('biz-t1');
  const e = bindTenant(platform, tenant).entitlements;
  assert.equal(await e.can('store.checkout'), false);
  await db.query(`UPDATE tenants SET plan = 't3' WHERE id = $1`, [tenant.id]);
  assert.equal(await e.can('store.checkout'), true);
  assert.equal(await e.limit('dms.monthly'), 50000);
});

test('entitlements need a current business', async () => {
  const { platform } = await setup();
  await assert.rejects(() => platform.entitlements.can('analytics'), NoTenantError);
  await assert.rejects(() => platform.entitlements.limit('analytics'), NoTenantError);
  await assert.rejects(() => platform.entitlements.setOverride('analytics'), NoTenantError);
});
