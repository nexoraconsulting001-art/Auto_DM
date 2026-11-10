// PRD 7.12: custom funnels and cohorts, counted from the events, and shown as counts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { NOW, api, beacon, newVisitor, secondBusiness, staffToken, startTraffic } from './support.js';

const minute = 60_000;

async function insertEvents(world, rows, tenant = world.tenant) {
  await withTenant(tenant, () => world.db.query(
    `INSERT INTO traffic_events (tenant_id, session_id, visitor_id, at, name, page_kind, page_ref, path)
     SELECT $1, s::uuid, v::uuid, a::timestamptz, n, k, r, p FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS x(s, v, a, n, k, r, p)`,
    [tenant.id, rows.map((r) => r.session), rows.map((r) => r.visitor ?? null), rows.map((r) => new Date(r.at).toISOString()), rows.map((r) => r.name), rows.map((r) => r.kind ?? 'other'), rows.map((r) => r.ref ?? ''), rows.map((r) => r.path ?? '')],
  ));
}

const STEPS = [{ kind: 'landing_view' }, { kind: 'product_tap' }, { kind: 'add_to_cart' }, { kind: 'payment_success' }];
const create = (world, body = {}, token) => api(world, '/funnels', { method: 'POST', body: { name: 'Buyers', steps: STEPS, windowMinutes: 1440, ...body }, token });
const results = (world, id, query = '') => api(world, `/funnels/${id}/results${query}`);

test('N-56: a four-step funnel shows counts, step rates and drop-off', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const session = crypto.randomUUID();
    const at = NOW - 3 * 3_600_000 + i;
    rows.push({ session, at, name: 'landing_view' });
    if (i < 90) rows.push({ session, at: at + minute, name: 'product_tap' });
    if (i < 30) rows.push({ session, at: at + 2 * minute, name: 'add_to_cart' });
    if (i < 12) rows.push({ session, at: at + 3 * minute, name: 'payment_success' });
  }
  await insertEvents(world, rows);
  const funnel = (await create(world)).body;
  const { status, body } = await results(world, funnel.id, '?range=7');
  assert.equal(status, 200);
  assert.deepEqual(body.steps.map((s) => s.count), [200, 90, 30, 12]);
  assert.deepEqual(body.steps.map((s) => s.stepRate), [null, 0.45, 0.3333, 0.4]);
  assert.deepEqual(body.steps.map((s) => s.dropOff), [null, 110, 60, 18]);
  assert.equal(body.source, 'bhava');
});

test('N-57: a step taken before the earlier step doesn\'t count past step 1', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const session = crypto.randomUUID();
  await insertEvents(world, [{ session, at: NOW - 10 * minute, name: 'add_to_cart' }, { session, at: NOW - 5 * minute, name: 'landing_view' }]);
  const funnel = (await create(world, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] })).body;
  assert.deepEqual((await results(world, funnel.id)).body.steps.map((s) => s.count), [1, 0]);
});

test('steps must fall inside the window, counted from the first step', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const inTime = crypto.randomUUID();
  const late = crypto.randomUUID();
  await insertEvents(world, [
    { session: inTime, at: NOW - 40 * minute, name: 'landing_view' }, { session: inTime, at: NOW - 15 * minute, name: 'product_tap' },
    { session: late, at: NOW - 40 * minute, name: 'landing_view' }, { session: late, at: NOW - minute, name: 'product_tap' },
  ]);
  const funnel = (await create(world, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }], windowMinutes: 30 })).body;
  assert.deepEqual((await results(world, funnel.id)).body.steps.map((s) => s.count), [2, 1]);
});

test('N-58: a tier 2 business gets the cart step as unavailable, Needs tier 3, and the other steps still count', async (t) => {
  const world = await startTraffic({ plan: 't2' });
  t.after(world.close);
  const session = crypto.randomUUID();
  await insertEvents(world, [{ session, at: NOW - 10 * minute, name: 'landing_view' }, { session, at: NOW - 5 * minute, name: 'product_tap' }, { session, at: NOW - minute, name: 'add_to_cart' }]);
  const created = await create(world, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }, { kind: 'product_tap' }] });
  assert.equal(created.status, 201);
  const { body } = await results(world, created.body.id);
  assert.deepEqual(body.steps.map((s) => [s.kind, s.count, s.unavailable, s.message]), [['landing_view', 1, false, null], ['add_to_cart', 0, true, 'Needs tier 3'], ['product_tap', 1, false, null]]);
});

test('per visitor counts one person across sessions; a person with no cookie still counts by session', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = crypto.randomUUID();
  await world.db.platform.query(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, last_seen_at) VALUES ($1, $2, now(), now())`, [world.tenant.id, visitor]);
  const [a, b, loose] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await insertEvents(world, [
    { session: a, visitor, at: NOW - 100 * minute, name: 'landing_view' },
    { session: b, visitor, at: NOW - 50 * minute, name: 'landing_view' },
    { session: b, visitor, at: NOW - 49 * minute, name: 'product_tap' },
    { session: loose, at: NOW - 40 * minute, name: 'landing_view' },
  ]);
  const funnel = (await create(world, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }], countBy: 'visitor' })).body;
  const { body } = await results(world, funnel.id);
  assert.equal(body.countBy, 'visitor');
  assert.deepEqual(body.steps.map((s) => s.count), [2, 1]);
});

test('a page-view step matches the chosen page, breakdowns come from the first step, and a period compare sits beside it', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const steps = [{ kind: 'page_view', page: '/r/brunch' }, { kind: 'product_tap' }];
  const funnel = (await create(world, { steps })).body;
  const hit = (fields, visitor, more) => beacon(world, { path: '/r/brunch', pageKind: 'landing', pageRef: 'brunch', ...fields }, { visitor, ...more });
  const [v1, v2] = [newVisitor(), newVisitor()];
  await hit({ name: 'page_view', utm: { source: 'instagram', medium: 'dm' } }, v1);
  await hit({ name: 'product_tap', pageKind: 'product', pageRef: 'kurta' }, v1);
  await hit({ name: 'page_view', src: 'bio' }, v2);
  await hit({ name: 'page_view', path: '/elsewhere', pageRef: 'elsewhere' }, newVisitor());
  world.clock.now += 8 * 86_400_000;
  const { body } = await results(world, funnel.id, '?range=7&breakdown=source&compare=previous');
  assert.deepEqual(body.steps.map((s) => s.count), [0, 0]);
  assert.deepEqual(body.steps.map((s) => s.previous), [2, 1]);
  world.clock.now -= 8 * 86_400_000;
  const now = (await results(world, funnel.id, '?range=7&breakdown=source')).body;
  assert.deepEqual(now.steps.map((s) => s.count), [2, 1]);
  assert.deepEqual(now.breakdown.sort((a, b) => a.key.localeCompare(b.key)), [{ key: 'bio_link', counts: [1, 0] }, { key: 'instagram_comment_dm', counts: [1, 1] }]);
});

test('only managers can change funnels, staff can read them, and another business\'s funnel is not found', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  const staff = await staffToken(world, { permissions: ['analytics'] });
  assert.equal((await create(world, {}, staff)).status, 403);
  const funnel = (await create(world)).body;
  assert.equal((await api(world, `/funnels/${funnel.id}`, { token: staff })).status, 200);
  assert.equal((await api(world, '/funnels', { token: staff })).body.items.length, 1);
  const elsewhere = { token: other.token, host: other.host };
  assert.equal((await api(world, `/funnels/${funnel.id}`, elsewhere)).status, 404);
  assert.equal((await api(world, `/funnels/${funnel.id}/results`, elsewhere)).status, 404);
  assert.equal((await api(world, `/funnels/${funnel.id}`, { ...elsewhere, method: 'DELETE' })).status, 404);
  assert.equal((await api(world, `/funnels/${funnel.id}`, { method: 'PATCH', body: { name: 'Better' } })).body.name, 'Better');
  assert.equal((await create(world, { steps: [{ kind: 'landing_view' }] })).status, 400, 'at least two steps');
  assert.equal((await create(world, { windowMinutes: 10 })).status, 400, 'at least 30 minutes');
});

async function cohortOf(world, n, { firstSeen, source = 'direct', returnAt = null } = {}) {
  const visitors = Array.from({ length: n }, () => crypto.randomUUID());
  for (const visitor of visitors) {
    await world.db.platform.query(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, first_source, last_seen_at) VALUES ($1, $2, $3::timestamptz, $4, $3::timestamptz)`, [world.tenant.id, visitor, new Date(firstSeen), source]);
  }
  await insertEvents(world, visitors.map((visitor) => ({ session: crypto.randomUUID(), visitor, at: firstSeen, name: 'page_view' })));
  return visitors;
}

test('N-59: a cohort of 14 shows low volume and no return rate; one of 20 shows it', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const week = (days) => NOW - days * 86_400_000;
  await cohortOf(world, 14, { firstSeen: week(21) });
  const big = await cohortOf(world, 20, { firstSeen: week(14) });
  await insertEvents(world, big.slice(0, 5).map((visitor) => ({ session: crypto.randomUUID(), visitor, at: week(7), name: 'page_view' })));
  const { status, body } = await api(world, '/cohorts?range=28&groupBy=first_week');
  assert.equal(status, 200);
  const [low, full] = body.cohorts;
  assert.equal(low.size, 14);
  assert.equal(low.lowVolume, true);
  assert.ok(low.rates.every((r) => r === null));
  assert.equal(full.size, 20);
  assert.equal(full.lowVolume, false);
  assert.equal(full.rates[0], 0.25);
  assert.ok(!JSON.stringify(body).match(/[0-9a-f]{8}-[0-9a-f]{4}/), 'no visitor id anywhere');
});

test('N-60: a shopper with cookies blocked is in no cohort; grouping by first source works', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: null });
  await beacon(world, { name: 'page_view', path: '/shop' }, { visitor: null });
  assert.deepEqual((await api(world, '/cohorts?range=7')).body.cohorts, []);
  await beacon(world, { name: 'page_view', path: '/', src: 'bio' }, { visitor: newVisitor() });
  const bySource = (await api(world, '/cohorts?range=7&groupBy=first_source')).body;
  assert.deepEqual(bySource.cohorts.map((c) => [c.key, c.size]), [['bio_link', 1]]);
});

test('buyer cohorts need tier 3 and show repeat rate and revenue per buyer', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const insertOrder = (phone, number, total) => world.db.platform.query(
    `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise, status, created_at) VALUES ($1, $2, $3, 'A', $4, 'x', 'y', 'z', '411001', $5, 0, $5, 'paid', '2026-11-01T06:00:00Z')`,
    [world.tenant.id, number, crypto.randomUUID(), phone, total],
  );
  for (let i = 0; i < 20; i += 1) await insertOrder(`90000000${String(i).padStart(2, '0')}`, `A-${i}`, 1000);
  await insertOrder('9000000000', 'B-1', 3000);
  const { body } = await api(world, '/cohorts?range=28&kind=buyers&groupBy=first_month');
  assert.equal(body.cohorts[0].key, '2026-11');
  assert.equal(body.cohorts[0].size, 20);
  assert.equal(body.cohorts[0].repeatOrderRate, 0.05);
  assert.equal(body.cohorts[0].revenuePerBuyerPaise, 1150);
  const lower = await startTraffic({ plan: 't2' });
  t.after(lower.close);
  const refused = await api(lower, '/cohorts?kind=buyers');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'Needs tier 3');
});
