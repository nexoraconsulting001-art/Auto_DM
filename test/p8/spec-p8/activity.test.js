// Q-03: thirty simulated days fill every screen, and the same random seed gives the same data. The short version (three days)
// runs in the normal suite; the full thirty days run with P8_FULL=1. Data must arrive through the simulators, the compliance
// engine and the order state machine: the tests look at what the simulators received, not only at rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedShowcase } from '../../../scripts/showcase.js';
import { PEOPLE_RULES, SHOWCASE, problemsWithPerson } from '../../../src/contracts/seed.js';
import { ACTIVITY_KINDS, createClock, createRng, digestOf, run as runActivity } from '../../../tools/sim/activity/index.mjs';
import { openShowcaseWorld } from '../../../tools/sim/activity/world.mjs';
import { openTestDb } from '../../helpers.js';
import { FULL, ctxOf, showcase, sql, strangers, tenantTables } from './support.js';

const START = '2026-10-16T04:00:00.000Z';
const DAYS = FULL ? SHOWCASE.days : 3;

async function openSeeded(t, { seed = SHOWCASE.randomSeed, days = DAYS } = {}) {
  // The world the activity runs in is the showcase world (the app, its worker and the four simulators), made on a fresh database: run() refuses any other.
  const db = await openTestDb();
  const world = await openShowcaseWorld({ db });
  t.after(async () => {
    await world.close();
    await db.close?.();
  });
  const businesses = await seedShowcase({ world, businesses: showcase() });
  const clock = createClock(START);
  const outcome = await runActivity({ businesses, days, seed, clock, world });
  return { world: { rawDb: db, meta: world.sims.meta, showcase: world }, businesses, outcome, clock };
}

const rowsOf = (world, text, params = []) => world.rawDb.platform.query(text, params);
const tableExists = async (world, name) => (await rowsOf(world, `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name])).length > 0;
const countFor = async (world, table, tenantId) => (await rowsOf(world, `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`, [tenantId]))[0].n;

test(`Q-03: ${DAYS} simulated days leave comments, DMs, visits, orders, payments and shipments in every screen of each business`, { timeout: FULL ? 3_000_000 : 900_000 }, async (t) => {
  const { world, businesses, outcome } = await openSeeded(t);
  assert.equal(outcome.days, DAYS);
  assert.equal(outcome.seed, SHOWCASE.randomSeed);
  assert.ok(outcome.events > 0);
  assert.match(outcome.digest, /^[0-9a-f]{64}$/);
  for (const { key, tenantId } of businesses) {
    const counts = outcome.counts[key];
    assert.ok(counts, `${key}: counted`);
    for (const kind of Object.keys(counts)) assert.ok(ACTIVITY_KINDS.includes(kind), `${kind} is a kind of activity`);
    for (const kind of ['comment', 'dm', 'visit', 'cart', 'checkout', 'payment']) assert.ok(counts[kind] > 0, `${key}: ${kind} events happened (${JSON.stringify(counts)})`);
    const needed = ['inbound_events', 'outbound_jobs', 'traffic_events', 'orders', 'payments'];
    const later = FULL ? ['shipments', 'invoices', 'refunds', 'returns', 'reviews', 'order_status_history'] : ['order_status_history'];
    for (const table of [...needed, ...later]) {
      if (!(await tableExists(world, table))) {
        assert.ok(!needed.includes(table), `${table} exists`);
        continue;
      }
      assert.ok((await countFor(world, table, tenantId)) > 0, `${key}: ${table} is empty, so a screen is empty`);
    }
    if (FULL) {
      for (const kind of ACTIVITY_KINDS) assert.ok(counts[kind] > 0, `${key}: no ${kind} in thirty days`);
      const insightTables = (await rowsOf(world, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%insight%'`)).map((r) => r.table_name);
      assert.ok(insightTables.length > 0, 'an insights table exists');
      let any = 0;
      for (const table of insightTables) any += await countFor(world, table, tenantId).catch(() => 0);
      assert.ok(any > 0, `${key}: insights are filled`);
    }
  }
});

test('Q-03: the days are spread across the window, and the businesses\' orders are their own', { timeout: FULL ? 3_000_000 : 900_000 }, async (t) => {
  const { world, businesses } = await openSeeded(t);
  for (const { key, tenantId } of businesses) {
    const days = await rowsOf(world, `SELECT count(DISTINCT created_at::date)::int AS n FROM orders WHERE tenant_id = $1`, [tenantId]);
    assert.ok(days[0].n >= Math.min(DAYS - 1, 2), `${key}: orders fall on ${days[0].n} different days of ${DAYS}`);
    const foreign = await rowsOf(world, `SELECT count(*)::int AS n FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.tenant_id = $1 AND p.tenant_id <> oi.tenant_id`, [tenantId]);
    assert.equal(foreign[0].n, 0, `${key}: an order holds another business's product`);
    const [money] = await rowsOf(world, `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND (total_paise IS NULL OR total_paise <= 0)`, [tenantId]);
    assert.equal(money.n, 0, `${key}: every order has a total in paise`);
  }
  const first = (await rowsOf(world, 'SELECT min(created_at) AS at FROM orders'))[0].at;
  // The generator's clock is virtual: the app reads the real time, so travel() moves every stored time back and the last slot is "now"
  // (tools/sim/activity/world.mjs). The window ends now and starts DAYS days before it.
  const age = Date.now() - new Date(first).getTime();
  assert.ok(age > 0, 'the data is in the past of the window\'s end (now)');
  assert.ok(age < (DAYS + 1) * 86_400_000, `the first order is inside the ${DAYS}-day window (${(age / 86_400_000).toFixed(1)} days old)`);
});

test('Q-03: everything arrived through the doors: messages reached the simulator, orders moved through their states, nothing is marked sent that was not', { timeout: FULL ? 3_000_000 : 900_000 }, async (t) => {
  const { world, businesses } = await openSeeded(t);
  const { sent } = await world.meta.get('/sent');
  assert.ok(sent.length > 0, 'the Meta simulator received messages');
  const text = JSON.stringify(sent);
  assert.doesNotMatch(text, /bhava/i, 'no platform name in what a shopper was sent');
  const recipients = new Set(sent.map((m) => String(m.recipient?.id ?? m.to ?? m.recipientId ?? '')).filter(Boolean));
  for (const id of recipients) assert.match(id, PEOPLE_RULES.instagram.id, 'every recipient is an invented Instagram id');
  for (const { tenantId, key } of businesses) {
    const [sentRows] = await rowsOf(world, `SELECT count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1 AND status = 'sent'`, [tenantId]);
    assert.ok(sentRows.n > 0, `${key}: some message went out`);
    if (await tableExists(world, 'compliance_events')) {
      const [events] = await rowsOf(world, `SELECT count(*)::int AS n FROM compliance_events WHERE tenant_id = $1`, [tenantId]);
      assert.ok(events.n >= sentRows.n, `${key}: ${sentRows.n} sends but only ${events.n} compliance decisions: something skipped the gate`);
    }
  }
  const { sent: all } = await world.meta.get('/sent');
  const jobsSent = (await rowsOf(world, `SELECT count(*)::int AS n FROM outbound_jobs WHERE status = 'sent'`))[0].n;
  assert.ok(all.length >= jobsSent, `rows say ${jobsSent} sent, the simulator received ${all.length}`);
  if (await tableExists(world, 'order_status_history')) {
    const columns = (await rowsOf(world, `SELECT column_name FROM information_schema.columns WHERE table_name = 'order_status_history'`)).map((r) => r.column_name);
    const col = ['to_status', 'status'].find((c) => columns.includes(c));
    if (col && columns.includes('order_id')) {
      const orphans = await rowsOf(world, `SELECT count(*)::int AS n FROM orders o WHERE o.status NOT IN ('awaiting_payment', 'cod_pending') AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id)`);
      assert.equal(orphans[0].n, 0, 'an order past its first state has no history: it was written, not moved');
    }
  }
});

test('Q-03: every shopper the generator made is invented, in every table of both businesses', { timeout: FULL ? 3_000_000 : 900_000 }, async (t) => {
  const { world, businesses } = await openSeeded(t);
  const ids = businesses.map((b) => b.tenantId);
  const bad = [];
  for (const table of await tenantTables({ db: world.rawDb })) {
    const rows = await rowsOf(world, `SELECT t::text AS text FROM "${table}" t WHERE t.tenant_id = ANY($1)`, [ids]);
    for (const row of rows) for (const found of strangers(row.text)) bad.push(`${table}:${found.split(':')[0]}`);
  }
  assert.deepEqual([...new Set(bad)], []);
  const names = await rowsOf(world, `SELECT DISTINCT customer_name AS v FROM orders WHERE tenant_id = ANY($1)`, [ids]);
  assert.ok(names.length > 0);
  for (const { v } of names) assert.deepEqual(problemsWithPerson({ name: v, phone: PEOPLE_RULES.phone.first }), [], 'a customer name outside the lists');
  const phones = await rowsOf(world, `SELECT DISTINCT phone AS v FROM orders WHERE tenant_id = ANY($1)`, [ids]);
  for (const { v } of phones) assert.match(`+91${String(v).replace(/\D/g, '').slice(-10)}`, PEOPLE_RULES.phone.pattern, 'a customer phone outside the reserved block');
  const emails = await rowsOf(world, `SELECT DISTINCT email AS v FROM orders WHERE tenant_id = ANY($1) AND email <> ''`, [ids]);
  for (const { v } of emails) assert.deepEqual(problemsWithPerson({ name: 'Aarohi Ambekar', phone: PEOPLE_RULES.phone.first, email: v }), [], 'a customer email off the example domains');
});

test('Q-03: the same random seed gives the same data twice, and another seed gives different data', { timeout: FULL ? 6_000_000 : 1_500_000 }, async (t) => {
  const days = FULL ? 7 : 2;
  const one = await openSeeded(t, { days });
  const two = await openSeeded(t, { days });
  const other = await openSeeded(t, { days, seed: SHOWCASE.randomSeed + 1 });
  assert.equal(two.outcome.digest, one.outcome.digest, 'the same seed, the same digest');
  assert.deepEqual(two.outcome.counts, one.outcome.counts);
  assert.equal(two.outcome.events, one.outcome.events);
  assert.notEqual(other.outcome.digest, one.outcome.digest, 'another seed, another story');
  const totals = async (w, tenantIds) => (await rowsOf(w, `SELECT tenant_id, count(*)::int AS orders, COALESCE(sum(total_paise), 0)::bigint AS paise FROM orders WHERE tenant_id = ANY($1) GROUP BY 1 ORDER BY 1`, [tenantIds])).map((r) => [r.orders, String(r.paise)]);
  const ids = (x) => x.businesses.map((b) => b.tenantId);
  assert.deepEqual(await totals(two.world, ids(two)), await totals(one.world, ids(one)), 'the same orders for the same money, business by business');
  const shape = async (w, tenantIds) => (await rowsOf(w, `SELECT status, count(*)::int AS n FROM outbound_jobs WHERE tenant_id = ANY($1) GROUP BY 1 ORDER BY 1`, [tenantIds])).map((r) => `${r.status}:${r.n}`);
  assert.deepEqual(await shape(two.world, ids(two)), await shape(one.world, ids(one)), 'and the same sends');
});

test('Q-03: the generator refuses what would make it unfair or unsafe: no businesses, a bad seed, no clock, too many days', async () => {
  const clock = createClock(START);
  const base = { businesses: [{ key: 'x' }], days: 1, seed: 1, clock, world: {} };
  await assert.rejects(runActivity({ ...base, businesses: [] }), /businesses/i);
  await assert.rejects(runActivity({ ...base, days: 0 }), /days/i);
  await assert.rejects(runActivity({ ...base, days: 400 }), /days/i);
  await assert.rejects(runActivity({ ...base, clock: undefined }), /clock/i);
  assert.throws(() => createRng(-1));
  assert.throws(() => createRng(1.5));
  const a = createRng(7);
  const b = createRng(7);
  assert.deepEqual([a.next(), a.int(1, 9), a.chance(0.5)], [b.next(), b.int(1, 9), b.chance(0.5)]);
  assert.notEqual(createRng(7).fork('one').next(), createRng(7).fork('two').next());
  assert.equal(digestOf([[1, 'k', 'comment', 0]]), digestOf([[1, 'k', 'comment', 0]]));
  assert.throws(() => digestOf([[1, 'k', 'not-a-kind', 0]]));
  assert.ok(sql);
});
