// The App Review demo business (PRD 10.6: P-24, P-25): made and refreshed by src/modules/demo-tenant, marked only by
// tenants.is_demo, full of invented sample data, and unable to send anything or to count as a customer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SAMPLE_ID_PREFIX, SAMPLE_VERSION, buildSample, sampleDigest } from '../../../src/modules/demo-tenant/index.js';
import { reviewApp, snapshot } from './support.js';

const DAY = '2026-11-01';
let app;
before(async () => {
  app = await reviewApp({ now: () => Date.parse(`${DAY}T06:00:00Z`) });
});
after(() => app?.close());

const count = async (table, tenantId) => Number((await app.db.platform.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]))[0].n);

test('P-24: ensure makes one demo business, marked by its flag, with sample orders, analytics, automations and inbox threads', async () => {
  const made = await app.demo.ensure();
  assert.equal(made.action, 'filled');
  assert.equal(made.anchorDay, DAY);
  assert.equal(made.version, SAMPLE_VERSION);
  const [row] = await app.db.platform.query('SELECT id, is_demo FROM tenants WHERE is_demo');
  assert.equal(row.id, made.tenantId);
  const [other] = await app.db.platform.query('SELECT is_demo FROM tenants WHERE id = $1', [app.tenant.id]);
  assert.equal(other.is_demo, false, 'every other business is not the demo');
  const sample = buildSample({ anchorDay: DAY });
  assert.equal(await count('orders', made.tenantId), sample.orders.length);
  assert.ok(await count('orders', made.tenantId) >= 8);
  assert.equal(await count('automations', made.tenantId), sample.automations.length);
  assert.equal(await count('inbox_threads', made.tenantId), sample.threads.length);
  assert.ok(await count('insight_daily', made.tenantId) > 60 * 10, 'sixty days of account figures');
  assert.ok(await count('insight_media', made.tenantId) >= 3);
  // Orders went through the state machine: their timelines are there, dated in the past.
  const history = await app.db.platform.query('SELECT max(created_at) AS last FROM order_status_history WHERE tenant_id = $1', [made.tenantId]);
  assert.ok(+history[0].last < Date.parse(`${DAY}T00:00:00Z`));
  const [statuses] = await app.db.platform.query(`SELECT array_agg(DISTINCT fulfilment_status) AS f FROM orders WHERE tenant_id = $1`, [made.tenantId]);
  for (const s of ['new', 'packed', 'shipped', 'delivered', 'cancelled']) assert.ok(statuses.f.includes(s), `an order is ${s}`);
  // Money adds up, in whole paise.
  const orders = await app.db.platform.query('SELECT total_paise, subtotal_paise, shipping_paise, cod_fee_paise FROM orders WHERE tenant_id = $1', [made.tenantId]);
  for (const o of orders) assert.equal(Number(o.total_paise), Number(o.subtotal_paise) + Number(o.shipping_paise) + Number(o.cod_fee_paise));
});

test('P-24: nobody real is in the sample: 555 numbers, no email, made-up Instagram ids and usernames Instagram cannot have', async () => {
  const { tenantId } = await app.demo.status();
  const orders = await app.db.platform.query('SELECT phone, email, shipping_address FROM orders WHERE tenant_id = $1', [tenantId]);
  for (const o of orders) {
    assert.match(o.phone, /^555\d{7}$/);
    assert.equal(o.email, '');
    assert.match(o.shipping_address.phone, /^555/);
  }
  const threads = await app.db.platform.query('SELECT recipient_id, username, ig_user_id FROM inbox_threads WHERE tenant_id = $1', [tenantId]);
  for (const t of threads) {
    assert.ok(t.recipient_id.startsWith(SAMPLE_ID_PREFIX));
    assert.ok(t.ig_user_id.startsWith(SAMPLE_ID_PREFIX));
    assert.match(t.username, /-/, 'a hyphen, which no Instagram username has');
  }
  const accounts = await app.db.platform.query('SELECT ig_user_id, access_token_enc, status FROM ig_accounts WHERE tenant_id = $1', [tenantId]);
  assert.deepEqual(accounts.map((a) => [a.ig_user_id.startsWith(SAMPLE_ID_PREFIX), a.access_token_enc, a.status]), [[true, '', 'reconnect_needed']]);
  const media = await app.db.platform.query('SELECT media_id FROM insight_media WHERE tenant_id = $1', [tenantId]);
  for (const m of media) assert.ok(m.media_id.startsWith(SAMPLE_ID_PREFIX));
});

test('P-24: ensure again keeps what is there; reset twice for the same day writes the same data', async () => {
  const first = await app.demo.status();
  const kept = await app.demo.ensure();
  assert.equal(kept.action, 'kept');
  assert.equal(kept.tenantId, first.tenantId);
  const before = await snapshot(app.db, first.tenantId);

  const once = await app.demo.reset({ anchorDay: DAY });
  const twice = await app.demo.reset({ anchorDay: DAY });
  assert.equal(once.digest, twice.digest);
  assert.equal(twice.digest, sampleDigest(buildSample({ anchorDay: DAY, secret: app.config.sessionSecret })));
  const all = await app.db.platform.query('SELECT id FROM tenants WHERE is_demo');
  assert.deepEqual(all.map((r) => r.id), [twice.tenantId], 'still one demo business');
  assert.deepEqual(await snapshot(app.db, twice.tenantId), before);
  assert.deepEqual(await snapshot(app.db, twice.tenantId), await snapshot(app.db, twice.tenantId));
  // A different day moves the dates and nothing else.
  assert.notEqual(sampleDigest(buildSample({ anchorDay: '2026-11-02' })), sampleDigest(buildSample({ anchorDay: DAY })));
});

test('P-24: a reset removes what a reviewer added and leaves no row of the old business behind', async () => {
  const { tenantId } = await app.demo.status();
  await app.db.platform.query(`INSERT INTO products (tenant_id, name, slug, price_paise) VALUES ($1, 'Reviewer test', 'reviewer-test', 100)`, [tenantId]);
  const fresh = await app.demo.reset({ anchorDay: DAY });
  assert.equal(await count('products', tenantId), 0, 'the old business is gone');
  const [added] = await app.db.platform.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND slug = 'reviewer-test'`, [fresh.tenantId]);
  assert.equal(added.n, 0);
  assert.equal(await count('products', fresh.tenantId), buildSample({ anchorDay: DAY }).products.length);
});

test('the demo business is left out of what billing, metering and platform totals count', async () => {
  const { tenantId } = await app.demo.status();
  const counted = await app.db.platform.query('SELECT id FROM counted_tenants ORDER BY id');
  assert.equal(counted.some((r) => r.id === tenantId), false);
  assert.ok(counted.some((r) => r.id === app.tenant.id));
});

test('one demo business at most, and it never takes an address another business has', async () => {
  await assert.rejects(app.db.platform.query(`INSERT INTO tenants (slug, name, is_demo) VALUES ('second-demo', 'Second', true)`), /tenants_one_demo_idx|duplicate/);
  await app.demo.remove();
  await app.db.platform.query(`INSERT INTO tenants (slug, name) VALUES ('demo-boutique', 'Someone else')`);
  await assert.rejects(app.demo.ensure(), /already uses the address name/);
  assert.equal((await app.demo.status()).exists, false);
  await app.db.platform.query(`DELETE FROM tenants WHERE slug = 'demo-boutique'`);
  assert.equal((await app.demo.ensure({ anchorDay: DAY })).action, 'filled');
});

test('the worker refreshes an out-of-date sample only when nobody is in the demo business', async () => {
  const later = await reviewApp({ now: () => Date.parse('2026-11-20T06:00:00Z') });
  try {
    const old = await later.demo.reset({ anchorDay: DAY });
    assert.equal((await later.demo.refreshIfIdle()).action, 'filled');
    const refreshed = await later.demo.status();
    assert.equal(refreshed.anchorDay, '2026-11-20');
    assert.notEqual(refreshed.tenantId, old.tenantId);
    assert.equal((await later.demo.refreshIfIdle()).action, 'kept', 'a fresh sample is kept');
    // Out of date again, but someone signed in a moment ago.
    await later.db.platform.query(`UPDATE demo_samples SET anchor_day = '2026-11-01'`);
    await later.db.platform.query(`INSERT INTO review_login_uses (subject_hash, accepted, reason, created_at) VALUES ('x', true, '', '2026-11-20T05:30:00Z')`);
    assert.equal((await later.demo.refreshIfIdle()).action, 'busy');
  } finally {
    later.close();
  }
});
