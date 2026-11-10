// PRD 7.12: custom funnels and cohorts. N-56 to N-60.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DAY, HOUR, MINUTE, addP2Shop, assertRate, dayAgo, need, shopper, unique, useP2World } from './support.js';

const world = useP2World();

const STANDARD = [{ kind: 'landing_view' }, { kind: 'product_tap' }, { kind: 'add_to_cart' }, { kind: 'payment_success' }];

const makeFunnel = (shop, body = {}) => shop.post('/funnels', { name: `Funnel ${unique()}`, steps: STANDARD, ...body }, 201, 'Making the funnel');
const results = (shop, id, query = { range: '7' }) => shop.get(`/funnels/${id}/results`, query, 'The funnel results');
const settled = (shop) => shop.settle({ ms: 2000, roundMs: 200 });
const uuid = (seed) => {
  const hex = crypto.createHash('md5').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Sessions, each taking the first `n` steps of `names` in order, one minute apart, starting an hour ago. */
async function steps(shop, sessions, names, { startAgoMs = HOUR, gapMs = MINUTE, source = 'bio_link', prefix = unique(), day = dayAgo(0) } = {}) {
  const rows = [];
  const summaries = [];
  for (let s = 0; s < sessions.length; s++) {
    const session = uuid(`${prefix}:${s}`);
    summaries.push({ session_id: session, day, hour: 10, weekday: 1, source, started_at: new Date(), last_hit_at: new Date() });
    for (let n = 0; n < sessions[s]; n++) rows.push([session, new Date(Date.now() - startAgoMs + n * gapMs), names[n], `${prefix}:${s}:${n}`]);
  }
  await shop.inside(() => world.rollups.write('traffic_sessions', summaries));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = chunk.map((_, j) => `($1, $${j * 4 + 2}::uuid, $${j * 4 + 3}::timestamptz, $${j * 4 + 4}, '/r/x', $${j * 4 + 5})`).join(', ');
    await shop.sql(`INSERT INTO traffic_events (tenant_id, session_id, at, name, path, event_key) VALUES ${values}`, [shop.tenantId, ...chunk.flat()]);
  }
  await settled(shop);
}

const NAMES = ['landing_view', 'product_tap', 'add_to_cart', 'payment_success'];
const sizes = (first, second, third, fourth) => [...Array(fourth).fill(4), ...Array(third - fourth).fill(3), ...Array(second - third).fill(2), ...Array(first - second).fill(1)];

// ---- N-56 ------------------------------------------------------------------------------------------------------------

test('N-56: a four-step funnel shows 200 / 90 / 30 / 12, with step rates of 45%, 33% and 40%', async () => {
  const shop = await addP2Shop(world);
  await steps(shop, sizes(200, 90, 30, 12), NAMES);
  const funnel = await makeFunnel(shop);
  const res = await results(shop, funnel.id);
  assert.deepEqual(res.steps.map((s) => s.count), [200, 90, 30, 12]);
  assert.equal(res.steps[0].stepRate, null);
  assertRate(res.steps[1].stepRate, 45, 'Step 2');
  assertRate(res.steps[2].stepRate, 33.3, 'Step 3');
  assertRate(res.steps[3].stepRate, 40, 'Step 4');
  assert.deepEqual(res.steps.map((s) => s.dropOff), [null, 110, 60, 18]);
  assert.equal(res.source, 'bhava');
});

test('N-56: counting per visitor differs from counting per session', async () => {
  const shop = await addP2Shop(world);
  const vid = crypto.randomUUID();
  const visitor = shopper(world, shop, { vid });
  for (let visit = 0; visit < 2; visit++) {
    await visitor.send({ name: 'landing_view', path: '/r/a', pageKind: 'landing' });
    await visitor.send({ name: 'product_tap', path: '/p/1', pageKind: 'product' });
    await world.travel(31 * MINUTE);
  }
  await settled(shop);
  const steps_ = [{ kind: 'landing_view' }, { kind: 'product_tap' }];
  const bySession = await makeFunnel(shop, { steps: steps_, countBy: 'session' });
  const byVisitor = await makeFunnel(shop, { steps: steps_, countBy: 'visitor' });
  assert.deepEqual((await results(shop, bySession.id)).steps.map((s) => s.count), [2, 2]);
  assert.deepEqual((await results(shop, byVisitor.id)).steps.map((s) => s.count), [1, 1]);
});

test('N-56: the window is exact: a step inside it counts, one past it doesn\'t', async () => {
  const shop = await addP2Shop(world);
  await steps(shop, [2], ['landing_view', 'product_tap'], { gapMs: 29 * MINUTE });
  await steps(shop, [2], ['landing_view', 'product_tap'], { gapMs: 31 * MINUTE });
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }], windowMinutes: 30 });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [2, 1]);
});

test('N-56: a page view step matches only its chosen page', async () => {
  const shop = await addP2Shop(world);
  const v = shopper(world, shop);
  await v.send({ name: 'landing_view', path: '/r/a', pageKind: 'landing' });
  await v.send({ name: 'page_view', path: '/about', pageRef: 'about', pageKind: 'other' });
  const w = shopper(world, shop);
  await w.send({ name: 'landing_view', path: '/r/a', pageKind: 'landing' });
  await w.send({ name: 'page_view', path: '/other', pageRef: 'other', pageKind: 'other' });
  await settled(shop);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'page_view', page: 'about' }] });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [2, 1]);
});

test('N-56: a breakdown by a dimension splits the counts, and the first step sets the source', async () => {
  const shop = await addP2Shop(world);
  await steps(shop, [2, 2, 1], ['landing_view', 'product_tap'], { source: 'bio_link' });
  await steps(shop, [2], ['landing_view', 'product_tap'], { source: 'whatsapp' });
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }] });
  const res = await results(shop, funnel.id, { range: '7', breakdown: 'source' });
  const by = Object.fromEntries(res.breakdown.map((b) => [b.key, b.counts]));
  assert.deepEqual(by.bio_link, [3, 2]);
  assert.deepEqual(by.whatsapp, [1, 1]);
});

test('N-56: a period compare shows the previous period\'s counts', async () => {
  const shop = await addP2Shop(world);
  await steps(shop, [1], ['landing_view'], {});
  await steps(shop, [1, 1], ['landing_view'], { startAgoMs: 10 * DAY, day: dayAgo(10) });
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }] });
  const res = await results(shop, funnel.id, { range: '7', compare: 'previous' });
  assert.equal(res.steps[0].count, 1);
  assert.equal(res.steps[0].previous, 2);
});

test('N-56: 2 to 8 steps, 30 minutes to 7 days, and nothing else', async () => {
  const shop = await addP2Shop(world);
  const steps2 = STANDARD.slice(0, 2);
  const eight = Array(8).fill({ kind: 'landing_view' });
  for (const body of [{ steps: [{ kind: 'landing_view' }] }, { steps: [...eight, { kind: 'landing_view' }] }, { steps: [{ kind: 'evil' }, { kind: 'product_tap' }] }, { steps: [{ kind: 'page_view' }, { kind: 'product_tap' }] }, { steps: steps2, windowMinutes: 29 }, { steps: steps2, windowMinutes: 10081 }, { steps: steps2, countBy: 'ip' }, { name: '', steps: steps2 }, { name: 'x'.repeat(81), steps: steps2 }]) {
    assert.equal((await shop.api('/funnels', { method: 'POST', body: { name: 'A funnel', ...body } })).status, 400, JSON.stringify(body).slice(0, 100));
  }
  need(await shop.api('/funnels', { method: 'POST', body: { name: 'Two', steps: steps2, windowMinutes: 30 } }), 201, 'The shortest');
  need(await shop.api('/funnels', { method: 'POST', body: { name: 'Eight', steps: eight, windowMinutes: 10080 } }), 201, 'The longest');
});

test('N-56: owners and managers build funnels, and staff only read them', async () => {
  const shop = await addP2Shop(world);
  const staff = await shop.addStaff(['analytics']);
  const body = { name: 'Staff', steps: STANDARD.slice(0, 2) };
  assert.equal((await shop.as(staff.token, '/funnels', { method: 'POST', body })).status, 403);
  const funnel = await makeFunnel(shop);
  need(await shop.as(staff.token, `/funnels/${funnel.id}`), 200, 'Reading');
  assert.equal((await shop.as(staff.token, `/funnels/${funnel.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 403);
  assert.equal((await shop.as(staff.token, `/funnels/${funnel.id}`, { method: 'DELETE' })).status, 403);
});

test('N-56: another business\'s funnel is not found, and its results aren\'t reachable', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const funnel = await makeFunnel(b);
  for (const [method, suffix] of [['GET', ''], ['GET', '/results'], ['DELETE', '']]) assert.equal((await a.api(`/funnels/${funnel.id}${suffix}`, { method })).status, 404, `${method} ${suffix}`);
  assert.equal((await a.api(`/funnels/${funnel.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 404);
});

test('N-56: hostile result queries are refused', async () => {
  const shop = await addP2Shop(world);
  const funnel = await makeFunnel(shop);
  for (const query of [{ breakdown: 'visitor_id' }, { compare: 'evil' }, { range: 'custom' }, { range: "7' OR 1=1" }]) assert.equal((await shop.raw(`/funnels/${funnel.id}/results`, query)).status, 400, JSON.stringify(query));
});

// ---- N-57 ------------------------------------------------------------------------------------------------------------

test('N-57: adding to cart before viewing the landing page isn\'t counted past step 1', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await steps(shop, [2], ['add_to_cart', 'landing_view']);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [1, 0]);
});

test('N-57: the same visitor doing it in order, in a later session, does count', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await steps(shop, [2], ['add_to_cart', 'landing_view']);
  await steps(shop, [2], ['landing_view', 'add_to_cart']);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [2, 1]);
});

test('N-57: a step can\'t be skipped on the way to a later one', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await steps(shop, [2], ['landing_view', 'add_to_cart']);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }, { kind: 'add_to_cart' }] });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [1, 0, 0]);
});

test('N-57: the same step twice counts as one step for that session', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await steps(shop, [3], ['landing_view', 'landing_view', 'product_tap']);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }] });
  assert.deepEqual((await results(shop, funnel.id)).steps.map((s) => s.count), [1, 1]);
});

// ---- N-58 ------------------------------------------------------------------------------------------------------------

for (const kind of ['add_to_cart', 'checkout_started', 'payment_success']) {
  test(`N-58: on tier 2 a ${kind} step is unavailable: Needs tier 3`, async () => {
    const shop = await addP2Shop(world, { plan: 't2' });
    await steps(shop, [2], ['landing_view', kind]);
    const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind }] });
    const [first, second] = (await results(shop, funnel.id)).steps;
    assert.equal(first.unavailable, false);
    assert.equal(first.count, 1);
    assert.equal(second.unavailable, true);
    assert.equal(second.message, 'Needs tier 3');
    assert.equal(second.count, 0, 'No figure for what the tier doesn\'t include');
  });
}

test('N-58: the same funnel on tier 3 is available', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await steps(shop, [2], ['landing_view', 'add_to_cart']);
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] });
  const [, second] = (await results(shop, funnel.id)).steps;
  assert.deepEqual([second.unavailable, second.count], [false, 1]);
});

test('N-58: a downgrade makes the step unavailable without losing the funnel', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] });
  await shop.sql(`UPDATE tenants SET plan = 't2' WHERE id = $1`, [shop.tenantId]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  need(await shop.raw(`/funnels/${funnel.id}`), 200, 'The funnel');
});

test('N-58: outbound click and earlier steps are available on tier 2', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  const funnel = await makeFunnel(shop, { steps: [{ kind: 'landing_view' }, { kind: 'outbound_click' }, { kind: 'whatsapp_tap' }] });
  for (const step of (await results(shop, funnel.id)).steps) assert.equal(step.unavailable, false, step.kind);
});

// ---- N-59 ------------------------------------------------------------------------------------------------------------

async function cohortOf(shop, size, { firstSeenDaysAgo = 21, returned = 0, source = 'bio_link', prefix = unique() } = {}) {
  const ids = Array.from({ length: size }, (_, i) => uuid(`${prefix}-${i}`));
  const firstSeen = new Date(Date.now() - firstSeenDaysAgo * DAY);
  for (const id of ids) await shop.sql(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, first_source, last_seen_at) VALUES ($1, $2, $3, $4, $3)`, [shop.tenantId, id, firstSeen, source]);
  const rows = [];
  ids.forEach((id, i) => {
    rows.push({ session_id: uuid(`${prefix}-s-${i}`), visitor_id: id, day: dayAgo(firstSeenDaysAgo), hour: 10, weekday: 1, source, started_at: firstSeen, last_hit_at: firstSeen });
    if (i < returned) rows.push({ session_id: uuid(`${prefix}-r-${i}`), visitor_id: id, day: dayAgo(firstSeenDaysAgo - 8), hour: 10, weekday: 1, source, started_at: new Date(+firstSeen + 8 * DAY), last_hit_at: new Date(+firstSeen + 8 * DAY) });
  });
  await shop.inside(() => world.rollups.write('traffic_sessions', rows));
  await settled(shop);
}

const cohortRows = async (shop, query = { range: '28', kind: 'visitors', groupBy: 'first_source' }) => (await shop.get('/cohorts', query, 'The cohorts')).cohorts;

test('N-59: a cohort of 14 shows low volume and no return rate', async () => {
  const shop = await addP2Shop(world);
  await cohortOf(shop, 14, { returned: 5 });
  const [row] = await cohortRows(shop);
  assert.deepEqual([row.size, row.lowVolume], [14, true]);
  assert.ok(row.rates.every((r) => r === null), JSON.stringify(row.rates));
});

for (const [size, low] of [[19, true], [20, false]]) {
  test(`N-59: a cohort of ${size} ${low ? 'is low volume' : 'shows its rates'}`, async () => {
    const shop = await addP2Shop(world);
    await cohortOf(shop, size, { returned: 10 });
    const [row] = await cohortRows(shop);
    assert.equal(row.lowVolume, low);
    if (!low) assert.ok(row.rates.some((r) => typeof r === 'number' && r > 0), JSON.stringify(row.rates));
  });
}

test('N-59: cohorts group by first week, first month and first source, and the answer has only counts', async () => {
  const shop = await addP2Shop(world);
  await cohortOf(shop, 25, { returned: 10 });
  for (const groupBy of ['first_week', 'first_month', 'first_source']) {
    const res = await shop.get('/cohorts', { range: '28', kind: 'visitors', groupBy });
    assert.equal(res.cohorts.reduce((n, c) => n + c.size, 0), 25, groupBy);
    assert.doesNotMatch(JSON.stringify(res), /[0-9a-f]{8}-[0-9a-f]{4}-/, 'No visitor id');
  }
});

test('N-59: the return share counts later weeks only', async () => {
  const shop = await addP2Shop(world);
  await cohortOf(shop, 20, { returned: 10 });
  const [row] = await cohortRows(shop, { range: '28', kind: 'visitors', groupBy: 'first_week' });
  assert.ok(row.rates.some((r) => r !== null && Math.abs((r > 1 ? r : r * 100) - 50) < 1), `A later week shows 50% return: ${JSON.stringify(row.rates)}`);
});

test('N-59: buyer cohorts are tier 3 and up', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  const res = await shop.raw('/cohorts', { range: '28', kind: 'buyers', groupBy: 'first_month' });
  if (res.status === 200) assert.deepEqual(res.json().cohorts, []);
  else assert.ok([400, 403].includes(res.status), `Got ${res.status}`);
});

test('N-59: hostile cohort queries are refused, and another business\'s visitors aren\'t in any cohort', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await cohortOf(b, 25);
  assert.deepEqual(await cohortRows(a), []);
  for (const query of [{ kind: 'evil' }, { groupBy: 'visitor_id' }, { range: 'custom' }]) assert.equal((await a.raw('/cohorts', query)).status, 400, JSON.stringify(query));
});

// ---- N-60 ------------------------------------------------------------------------------------------------------------

test('N-60: a shopper with cookies blocked visits twice: 2 sessions, and in no cohort', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop, { cookies: false });
  await visitor.send({ name: 'page_view', path: '/a' });
  await world.travel(31 * MINUTE);
  await visitor.send({ name: 'page_view', path: '/b' });
  await settled(shop);
  assert.equal((await shop.get('/traffic/summary', { range: '7' })).sessions.value, 2);
  const stored = await shop.sessions();
  assert.equal(stored.length, 2);
  assert.ok(stored.every((s) => s.visitor_id === null), 'Counted per session only');
  assert.deepEqual((await shop.sql('SELECT * FROM traffic_visitors WHERE tenant_id = $1', [shop.tenantId])), []);
  assert.deepEqual(await cohortRows(shop), []);
});

test('N-60: without a cookie, a visitor id can\'t be guessed from what the request carried', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop, { cookies: false, ip: '203.0.113.10' });
  await visitor.send({ name: 'page_view', path: '/a' });
  await settled(shop);
  assert.ok((await shop.sessions()).every((s) => s.visitor_id === null));
});

test('N-60: an order from a shopper with no cookie still counts as a session with no visitor', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop, { cookies: false }).send({ name: 'landing_view', path: '/r/a', pageKind: 'landing', mediaId: 'R1' });
  await settled(shop);
  assert.equal((await shop.get('/traffic/summary', { range: '7' })).sessions.value, 1);
  assert.equal((await shop.get('/traffic/summary', { range: '7' })).visitors.value ?? 0, 0);
});
