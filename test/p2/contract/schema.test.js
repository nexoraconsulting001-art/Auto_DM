// The Phase 2 tables: fenced per business, linked only within a business, indexed for their keys, and with nowhere to put an IP or a user agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORE_METRICS, ROLLUP_STORES, SOURCE_LABELS } from '../../../src/contracts/analytics.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

const BUSINESS_TABLES = [
  'analytics_accounts', 'insight_daily', 'insight_demographics', 'insight_online_followers', 'insight_media', 'insight_snapshots', 'insight_polls', 'insight_settings',
  'traffic_visitors', 'traffic_sessions', 'traffic_events', 'traffic_previews', 'traffic_daily', 'traffic_items_daily', 'funnel_daily', 'meta_account_daily', 'meta_content_daily',
  'funnel_events', 'destination_connections', 'destination_uploads', 'destination_figures',
  'reach_guard_state', 'reach_guard_baselines', 'reach_guard_trips', 'account_health', 'account_health_history', 'meta_call_stats',
  'saved_views', 'saved_view_pins', 'custom_funnels', 'report_downloads', 'scheduled_reports', 'scheduled_report_recipients', 'report_runs', 'report_deliveries', 'report_preferences', 'reporting_api_keys',
  'tag_settings', 'tag_outbox', 'tag_health_daily',
];

async function twoBusinesses() {
  const world = await setup();
  const a = world.tenant;
  const b = await world.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  await world.platform.tenants.linkIgAccount(a.id, 'IG-A', 'a');
  await world.platform.tenants.linkIgAccount(b.id, 'IG-B', 'b');
  return { ...world, a, b };
}

const account = (db, tenant, ig) => withTenant(tenant, async () => (await db.query(
  `INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, '2026-01-01') RETURNING id`, [tenant.id, ig],
))[0].id);

test('every Phase 2 business table has row-level security and its policy', async () => {
  const { db } = await setup();
  for (const table of BUSINESS_TABLES) {
    const [row] = await db.query(
      `SELECT c.relrowsecurity AS secured, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = $1 AND p.policyname = 'tenant_fence') AS policies,
              (SELECT count(*)::int FROM information_schema.columns i WHERE i.table_name = $1 AND i.column_name = 'tenant_id') AS tenant_column
       FROM pg_class c WHERE c.oid = format('public.%I', $1::text)::regclass`,
      [table],
    );
    assert.deepEqual(row, { secured: true, policies: 1, tenant_column: 1 }, table);
  }
});

test('every foreign key on a Phase 2 table has an index its lookups and cascades can use', async () => {
  const { db } = await setup();
  const foreign = await db.query(
    `SELECT conrelid::regclass::text AS tbl, conname, conkey FROM pg_constraint WHERE contype = 'f' AND conrelid = ANY($1::regclass[])`, [BUSINESS_TABLES],
  );
  const indexes = await db.query(`SELECT indrelid::regclass::text AS tbl, string_to_array(indkey::text, ' ')::int[] AS columns FROM pg_index WHERE indrelid = ANY($1::regclass[]) AND indpred IS NULL`, [BUSINESS_TABLES]);
  assert.ok(foreign.length >= 25, `found ${foreign.length}`);
  for (const fk of foreign) {
    const key = fk.conkey.map(Number);
    if (key.length === 1) continue; // the tenant_id reference, which every table's own key begins with
    const covered = indexes.some((index) => index.tbl === fk.tbl && key.every((column, i) => index.columns[i] !== undefined && key.includes(index.columns[i])) && index.columns.length >= key.length);
    assert.ok(covered, `${fk.tbl} ${fk.conname}`);
  }
});

test('a business sees only its own analytics, even with no WHERE', async () => {
  const { db, a, b } = await twoBusinesses();
  await account(db, a, 'IG-A');
  await account(db, b, 'IG-B');
  const seen = await withTenant(a, () => db.query('SELECT tenant_id FROM analytics_accounts'));
  assert.deepEqual(seen.map((r) => r.tenant_id), [a.id]);
});

test('nothing can link to another business\'s row', async () => {
  const { db, a, b } = await twoBusinesses();
  await assert.rejects(() => account(db, b, 'IG-A'), /foreign key/i, 'another business\'s Instagram account');
  const theirs = await account(db, a, 'IG-A');
  await assert.rejects(() => withTenant(b, () => db.query(
    `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind) VALUES ($1, $2, 'M1', 'reel')`, [b.id, theirs],
  )), /foreign key/i);
  const media = await withTenant(a, async () => (await db.query(`INSERT INTO insight_media (tenant_id, account_ref, media_id, kind) VALUES ($1, $2, 'M1', 'reel') RETURNING id`, [a.id, theirs]))[0].id);
  await assert.rejects(() => withTenant(b, () => db.query(
    `INSERT INTO insight_snapshots (tenant_id, media_ref, slot, age_minutes) VALUES ($1, $2, now(), 1)`, [b.id, media],
  )), /foreign key/i);
});

test('a rerun on the same slot can\'t add a second snapshot (for N-38)', async () => {
  const { db, a } = await twoBusinesses();
  const accountRef = await account(db, a, 'IG-A');
  await withTenant(a, async () => {
    const [{ id }] = await db.query(`INSERT INTO insight_media (tenant_id, account_ref, media_id, kind) VALUES ($1, $2, 'M1', 'reel') RETURNING id`, [a.id, accountRef]);
    const insert = () => db.query(
      `INSERT INTO insight_snapshots (tenant_id, media_ref, slot, age_minutes, metrics) VALUES ($1, $2, '2026-11-01T10:00:00Z', 60, '{"views":1}') ON CONFLICT (tenant_id, media_ref, slot) DO NOTHING RETURNING id`,
      [a.id, id],
    );
    assert.equal((await insert()).length, 1);
    assert.equal((await insert()).length, 0);
  });
});

test('impressions can\'t be stored as a metric (for N-05)', async () => {
  const { db, a } = await twoBusinesses();
  const accountRef = await account(db, a, 'IG-A');
  await assert.rejects(() => withTenant(a, () => db.query(
    `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, value) VALUES ($1, $2, '2026-11-01', 'impressions', 1)`, [a.id, accountRef],
  )), /check constraint/i);
  await assert.rejects(() => withTenant(a, () => db.query(
    `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, latest) VALUES ($1, $2, 'M1', 'reel', '{"impressions":5}')`, [a.id, accountRef],
  )), /check constraint/i);
});

test('no traffic table has a column for an IP, a user agent or a username (for N-50)', async () => {
  const { db } = await setup();
  const rows = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name = ANY($1::text[]) AND column_name ~ '(^ip$|ip_address|user_agent|^ua$|username|phone)'`,
    [['traffic_visitors', 'traffic_sessions', 'traffic_events', 'traffic_previews', 'traffic_daily', 'traffic_items_daily', 'funnel_events', 'funnel_daily']],
  );
  assert.deepEqual(rows, []);
});

test('the rollup tables are exactly what ROLLUP_STORES says', async () => {
  const { db } = await setup();
  for (const [name, store] of Object.entries(ROLLUP_STORES)) {
    const rows = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [name]);
    const columns = new Set(rows.map((r) => r.column_name));
    for (const column of [...store.key, ...store.dimensions, ...store.columns, ...store.extras]) assert.ok(columns.has(column), `${name}.${column}`);
    assert.deepEqual([...columns].filter((c) => !['tenant_id', ...store.key, ...store.dimensions, ...store.columns, ...store.extras].includes(c)), [], name);
    for (const measure of Object.values(store.measures)) if (measure.column) assert.ok(columns.has(measure.column), `${name} measure ${measure.column}`);
  }
});

test('the measurement labels in the database are the ones in the contract', async () => {
  const { db, tenant } = await setup();
  const labels = await withTenant(tenant, () => db.query('SELECT code, label FROM measurement_labels'));
  assert.deepEqual(Object.fromEntries(labels.map((r) => [r.code, r.label])), SOURCE_LABELS);
  const metrics = await withTenant(tenant, () => db.query('SELECT metric, code FROM metric_labels'));
  assert.deepEqual(Object.fromEntries(metrics.map((r) => [r.metric, r.code])), Object.fromEntries(Object.entries(EXPLORE_METRICS).map(([name, m]) => [name, m.source])));
});

test('plans gain the Phase 2 features at the right tiers', async () => {
  const { db } = await setup();
  const rows = await db.query(`SELECT plan_code, feature FROM plan_features WHERE feature IN ('reports.scheduled', 'tags.pixels', 'funnels.commerce')`);
  const has = (plan, feature) => rows.some((r) => r.plan_code === plan && r.feature === feature);
  assert.equal(has('t1', 'tags.pixels'), false);
  assert.equal(has('t2', 'tags.pixels'), true);
  assert.equal(has('t2', 'funnels.commerce'), false);
  assert.equal(has('t3', 'funnels.commerce'), true);
  assert.equal(has('t5', 'reports.scheduled'), true);
});
