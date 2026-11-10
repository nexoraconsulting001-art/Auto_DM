// The Phase 1 tables: fenced per business, linked only within a business, and indexed for what they are used for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROLE } from '../../../src/db/index.js';
import { REASON_CODES, REASON_CODE_FAMILIES } from '../../../src/contracts/compliance.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

const BUSINESS_TABLES = [
  'fb_pages', 'oauth_states', 'token_alerts', 'data_deletion_requests', 'compliance_settings', 'breakers', 'account_rate_state', 'send_budgets', 'inbound_events',
  'automations', 'automation_triggers', 'message_templates', 'template_variants', 'ice_breakers', 'testers', 'tester_codes', 'outbound_jobs', 'opt_outs', 'cap_claims',
  'tenant_words', 'inbox_threads', 'inbox_messages', 'needs_human_items', 'measurement_ids', 'link_taps', 'link_checks', 'fb_post_links', 'alerts',
];

async function twoBusinesses() {
  const world = await setup();
  const a = world.tenant;
  const b = await world.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  await world.platform.tenants.linkIgAccount(a.id, 'IG-A', 'a');
  await world.platform.tenants.linkIgAccount(b.id, 'IG-B', 'b');
  return { ...world, a, b };
}

const automation = (db, tenant, slug = 'first') => withTenant(tenant, async () => (await db.query(
  `INSERT INTO automations (tenant_id, name, slug, trigger_type) VALUES ($1, 'A', $2, 'comment') RETURNING id`,
  [tenant.id, slug],
))[0].id);

const job = (db, tenant, account, key) => withTenant(tenant, () => db.query(
  `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, expires_at) VALUES ($1, 'instagram', $2, 'dm', $3, now() + interval '1 hour') RETURNING id`,
  [tenant.id, account, key],
));

test('every Phase 1 business table has row-level security, its policy and a tenant_id', async () => {
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

test('a business sees only its own automations and jobs, even with no WHERE', async () => {
  const { db, a, b } = await twoBusinesses();
  await automation(db, a);
  await automation(db, b);
  await job(db, a, 'IG-A', 'k1');
  const seen = await withTenant(a, () => db.query('SELECT tenant_id FROM automations'));
  assert.deepEqual(seen.map((r) => r.tenant_id), [a.id]);
  assert.equal((await withTenant(b, () => db.query('SELECT 1 FROM outbound_jobs'))).length, 0);
});

test('nothing can link to another business\'s row', async () => {
  const { db, a, b } = await twoBusinesses();
  const theirs = await automation(db, a);
  await assert.rejects(() => withTenant(b, () => db.query(
    `INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'M1')`,
    [b.id, theirs],
  )), /foreign key/i);
  await assert.rejects(() => job(db, b, 'IG-A', 'steal'), /foreign key/i);
  await assert.rejects(() => withTenant(b, () => db.query(
    `INSERT INTO message_templates (tenant_id, automation_id, role) VALUES ($1, $2, 'first_dm')`,
    [b.id, theirs],
  )), /foreign key/i);
});

test('one business\'s media or idempotency key never affects another\'s', async () => {
  const { db, a, b } = await twoBusinesses();
  const addTrigger = (tenant, id) => withTenant(tenant, () => db.query(
    `INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'SAME')`,
    [tenant.id, id],
  ));
  const [one, two, three] = [await automation(db, a), await automation(db, b), await automation(db, a, 'second')];
  await addTrigger(a, one);
  await addTrigger(b, two);
  await assert.rejects(() => addTrigger(a, three), /unique|duplicate/i, 'one active automation per media within a business');

  await job(db, a, 'IG-A', 'private_reply:1');
  await job(db, b, 'IG-B', 'private_reply:1');
  await assert.rejects(() => job(db, a, 'IG-A', 'private_reply:1'), /unique|duplicate/i);
});

test('an archived automation frees its media', async () => {
  const { db, a } = await twoBusinesses();
  const first = await automation(db, a);
  const second = await automation(db, a, 'second');
  const add = (id) => withTenant(a, () => db.query(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'M')`, [a.id, id]));
  await add(first);
  await withTenant(a, () => db.query('UPDATE automation_triggers SET active = false WHERE automation_id = $1', [first]));
  await add(second);
});

test('a job names exactly one account, on the channel it says', async () => {
  const { db, a } = await twoBusinesses();
  await assert.rejects(() => withTenant(a, () => db.query(
    `INSERT INTO outbound_jobs (tenant_id, channel, fb_page_id, ig_user_id, kind, idempotency_key, expires_at) VALUES ($1, 'instagram', NULL, NULL, 'dm', 'k', now())`,
    [a.id],
  )), /outbound_jobs_one_account/);
});

test('a once-only cap is atomic, and a rolling cap can hold several claims', async () => {
  const { db, a } = await twoBusinesses();
  const claim = (cap, scope) => withTenant(a, () => db.query(`INSERT INTO cap_claims (tenant_id, channel, cap, subject_hash, scope_key) VALUES ($1, 'instagram', $2, 'H', $3)`, [a.id, cap, scope]));
  await claim('cap.per_media', 'M1');
  await assert.rejects(() => claim('cap.per_media', 'M1'), /unique|duplicate/i);
  await claim('cap.per_media', 'M2');
  await claim('cap.per_person_24h', '');
  await claim('cap.per_person_24h', '');
  await assert.rejects(() => claim('cap.made_up', 'x'), /check/i);
});

test('the database holds the same reason codes as the contract', async () => {
  const { db } = await setup();
  const rows = await db.query('SELECT code, family FROM compliance_reason_codes');
  assert.deepEqual(rows.map((r) => r.code).sort(), [...REASON_CODES].sort());
  for (const row of rows) assert.ok(REASON_CODE_FAMILIES[row.family].includes(row.code), row.code);
});

test('the engine\'s log rows are held to the enum', async () => {
  const { db, a } = await twoBusinesses();
  const write = (decision, reason) => withTenant(a, () => db.query(`INSERT INTO compliance_events (tenant_id, channel, kind, decision, reason) VALUES ($1, 'instagram', 'dm', $2, $3)`, [a.id, decision, reason]));
  await write('sent', '');
  await write('skipped', 'cap.per_media');
  await assert.rejects(() => write('sent', 'cap.user'), /reason-code enum/);
  await assert.rejects(() => write('allow', ''), /reason-code enum/);
});

test('a webhook is stored once per object, per business', async () => {
  const { db, a, b } = await twoBusinesses();
  const store = (tenant) => withTenant(tenant, () => db.query(
    `INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id) VALUES ($1, 'instagram', 'X', 'comments', 'c1') ON CONFLICT DO NOTHING RETURNING id`,
    [tenant.id],
  ));
  assert.equal((await store(a)).length, 1);
  assert.equal((await store(a)).length, 0);
  assert.equal((await store(b)).length, 1);
});

test('platform-only tables are out of reach of business code, and shared lists are read-only', async () => {
  const { db, a } = await twoBusinesses();
  for (const table of ['inbound_unrouted', 'raw_exports', 'platform_login_codes']) {
    await assert.rejects(() => withTenant(a, () => db.query(`SELECT 1 FROM ${table}`)), /permission denied/, table);
  }
  assert.ok((await withTenant(a, () => db.query('SELECT host FROM link_blocked_hosts'))).some((r) => r.host === 'bit.ly'));
  assert.equal((await withTenant(a, () => db.query('SELECT engaged FROM platform_switches'))).length, 2);
  await assert.rejects(() => withTenant(a, () => db.query(`UPDATE platform_switches SET engaged = true`)), /permission denied/);
  await assert.rejects(() => withTenant(a, () => db.query(`INSERT INTO link_blocked_hosts (host, category) VALUES ('x.test', 'adult')`)), /permission denied/);
});

test('a business cannot delete its deletion requests or write them', async () => {
  const { db, a } = await twoBusinesses();
  await assert.rejects(() => withTenant(a, () => db.query(`INSERT INTO data_deletion_requests (confirmation_code, tenant_id, account_id) VALUES ('c', $1, 'X')`, [a.id])), /permission denied/);
});

test('every foreign key on a Phase 1 table has an index its lookups and cascades can use', async () => {
  const { db } = await setup();
  const keys = await db.query(
    `SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey,
            (SELECT array_agg(i.indkey::text) FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indpred IS NULL) AS indexes
     FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)`,
    [BUSINESS_TABLES],
  );
  assert.ok(keys.length > 20, `found ${keys.length}`);
  const missing = keys.filter((key) => {
    const wanted = new Set(key.conkey.map(Number));
    return !(key.indexes ?? []).some((list) => {
      const columns = list.split(' ').map(Number);
      return columns.length >= wanted.size && columns.slice(0, wanted.size).every((c) => wanted.has(c));
    });
  }).map((key) => `${key.tbl}.${key.conname}`);
  assert.deepEqual(missing, []);
});

test('the app role owns none of the new tables', async () => {
  const { db } = await setup();
  const owned = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1`, [APP_ROLE]);
  assert.deepEqual(owned, []);
});
