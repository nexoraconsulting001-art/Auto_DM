// PRD 7.11: Explore, saved views and pinned cards. N-51 to N-55.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, EXPLORE_METRICS, addP2Shop, assertNoFigure, dayAgo, fileAt, need, unique, useP2World, waitForFile } from './support.js';

const world = useP2World();

const explore = (shop, body) => shop.post('/explore/query', body, 200, 'The Explore query');
const rawExplore = (shop, body) => shop.api('/explore/query', { method: 'POST', body });
const SESSIONS = { metrics: ['sessions'], range: '28' };
const settled = (shop) => shop.settle({ ms: 2000, roundMs: 200 });
const row = (result, dims) => result.rows.find((r) => Object.entries(dims).every(([k, v]) => r.dimensions[k] === v));

async function period(shop) {
  await shop.seedSessions([
    { count: 30, day: dayAgo(3), source: 'bio_link', device: 'mobile' },
    { count: 10, day: dayAgo(3), source: 'bio_link', device: 'desktop' },
    { count: 20, day: dayAgo(5), source: 'whatsapp', device: 'mobile' },
    { count: 15, day: dayAgo(35), source: 'bio_link', device: 'mobile' },
    { count: 40, day: dayAgo(36), source: 'whatsapp', device: 'mobile' },
  ]);
  await settled(shop);
}

// ---- N-51 ------------------------------------------------------------------------------------------------------------

test('N-51: sessions by source and device, 28 days against the previous 28: both periods, absolute and percent change, totals that match Traffic', async () => {
  const shop = await addP2Shop(world);
  await period(shop);
  const res = await explore(shop, { ...SESSIONS, dimensions: ['source', 'device'], compare: 'previous' });
  const cell = row(res, { source: 'bio_link', device: 'mobile' }).metrics.sessions;
  assert.deepEqual([cell.value, cell.previous, cell.change], [30, 15, 15]);
  assert.equal(cell.changePercent, 100);
  assert.deepEqual([res.totals.sessions.value, res.totals.sessions.previous], [60, 55]);
  const traffic = await shop.get('/traffic/summary', { range: '28', compare: 'previous' });
  assert.deepEqual([traffic.sessions.value, traffic.sessions.previous], [res.totals.sessions.value, res.totals.sessions.previous], 'Totals match Traffic');
  assert.ok(res.compareFrom && res.compareTo);
  assert.equal(res.columns[0].source, 'bhava');
  assert.equal(res.columns[0].label, EXPLORE_METRICS.sessions.label);
});

test('N-51: a cell with nothing to compare has no percent, and a new row is not a division by zero', async () => {
  const shop = await addP2Shop(world);
  await period(shop);
  const res = await explore(shop, { ...SESSIONS, dimensions: ['source', 'device'], compare: 'previous' });
  const cell = row(res, { source: 'bio_link', device: 'desktop' }).metrics.sessions;
  assert.equal(cell.value, 10);
  assert.ok(cell.previous === 0 || cell.previous === null);
  assert.equal(cell.changePercent, null);
});

test('N-51: the day at each end of a range is in it, and the day past each end isn\'t', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([
    { count: 1, day: dayAgo(21), source: 'direct' }, { count: 2, day: dayAgo(20), source: 'direct' },
    { count: 4, day: dayAgo(10), source: 'direct' }, { count: 8, day: dayAgo(9), source: 'direct' },
  ]);
  await settled(shop);
  const res = await explore(shop, { metrics: ['sessions'], range: 'custom', from: dayAgo(20), to: dayAgo(10) });
  assert.equal(res.totals.sessions.value, 6);
  assert.deepEqual([res.from, res.to], [dayAgo(20), dayAgo(10)]);
});

test('N-51: comparing with last year and with a chosen range both work', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 3, day: dayAgo(370), source: 'direct' }, { count: 5, day: dayAgo(100), source: 'direct' }]);
  await settled(shop);
  const custom = await explore(shop, { metrics: ['sessions'], range: '7', compare: 'custom', compareFrom: dayAgo(105), compareTo: dayAgo(95) });
  assert.equal(custom.totals.sessions.previous, 5);
  assert.deepEqual([custom.compareFrom, custom.compareTo], [dayAgo(105), dayAgo(95)]);
  const lastYear = await explore(shop, { metrics: ['sessions'], range: 'custom', from: dayAgo(6), to: dayAgo(1), compare: 'last_year' });
  assert.equal(lastYear.totals.sessions.previous ?? 0, 3);
});

test('N-51: tables page at 100 rows, every row once, with totals over them all', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions(Array.from({ length: 130 }, (_, i) => ({ count: 1, landing_page: `/r/p${i}`, source: 'direct' })));
  await settled(shop);
  const body = { metrics: ['sessions'], range: '7', dimensions: ['landing_page'] };
  const first = await explore(shop, body);
  assert.equal(first.rows.length, 100);
  assert.equal(first.totals.sessions.value, 130);
  assert.ok(first.nextPage, 'There is a next page');
  const second = await explore(shop, { ...body, page: first.nextPage });
  assert.equal(second.rows.length, 30);
  assert.equal(second.nextPage, null);
  const seen = new Set([...first.rows, ...second.rows].map((r) => r.dimensions.landing_page));
  assert.equal(seen.size, 130);
});

test('N-51: sorting by a metric and in either direction works, and sorting by anything else is refused or ignored without a crash', async () => {
  const shop = await addP2Shop(world);
  await period(shop);
  const body = { metrics: ['sessions'], range: '28', dimensions: ['source'] };
  const down = await explore(shop, { ...body, sortBy: 'sessions', sortDirection: 'desc' });
  assert.deepEqual(down.rows.map((r) => r.dimensions.source), ['bio_link', 'whatsapp']);
  const up = await explore(shop, { ...body, sortBy: 'sessions', sortDirection: 'asc' });
  assert.deepEqual(up.rows.map((r) => r.dimensions.source), ['whatsapp', 'bio_link']);
  for (const sortBy of ['sessions; DROP TABLE tenants', "source' --", 'visitor_id', 'tenant_id', '__proto__']) {
    const res = await rawExplore(shop, { ...body, sortBy });
    assert.ok([200, 400].includes(res.status), `${sortBy} got ${res.status}`);
  }
  assert.ok((await shop.sql('SELECT count(*)::int AS n FROM tenants'))[0].n > 0);
});

test('N-51: a threshold filter keeps only the rows at or above it', async () => {
  const shop = await addP2Shop(world);
  await period(shop);
  const res = await explore(shop, { ...SESSIONS, dimensions: ['source'], thresholds: [{ metric: 'sessions', op: 'gte', value: 40 }] });
  assert.deepEqual(res.rows.map((r) => r.dimensions.source), ['bio_link']);
});

test('N-51: a rate under 20 shows low volume, and 20 shows a number', async () => {
  const shop = await addP2Shop(world, { plan: 't3' });
  await shop.seedSessions([{ count: 19, source: 'bio_link', product_taps: 1 }, { count: 20, source: 'whatsapp', product_taps: 1 }]);
  await settled(shop);
  const res = await explore(shop, { metrics: ['tap_rate'], range: '7', dimensions: ['source'] });
  const low = row(res, { source: 'bio_link' }).metrics.tap_rate;
  assert.deepEqual([low.lowVolume, low.value], [true, null]);
  const ok = row(res, { source: 'whatsapp' }).metrics.tap_rate;
  assert.equal(ok.lowVolume, false);
  assert.equal(typeof ok.value, 'number');
});

test('N-51: Meta and Bhava figures are labelled and never summed into each other', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 5, day: dayAgo(4), source: 'direct' }]);
  await shop.seedDays('reach', { 4: 7000 });
  await settled(shop);
  const res = await explore(shop, { metrics: ['sessions', 'ig_reach'], range: '7' });
  assert.deepEqual(res.columns.map((c) => c.source), ['bhava', 'platform']);
  assert.deepEqual([res.totals.sessions.value, res.totals.ig_reach.value], [5, 7000]);
});

test('N-51: the catalogue says what the plan can use, with a reason for what it can\'t', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  const { metrics, dimensions } = await shop.get('/explore/catalog', undefined, 'The catalogue');
  const cart = metrics.find((m) => m.name === 'add_to_cart');
  assert.equal(cart.available, false);
  assert.ok(cart.reason);
  assert.equal(metrics.find((m) => m.name === 'sessions').available, true);
  assert.equal(dimensions.some((d) => ['visitor_id', 'user_agent', 'ip', 'session_id'].includes(d.name)), false);
});

test('N-51: a plan\'s excluded metric can\'t be asked for regardless', async () => {
  const shop = await addP2Shop(world, { plan: 't1' });
  await shop.seedSessions([{ count: 5, source: 'direct', orders: 1, revenue_paise: 100 }]);
  await settled(shop);
  const res = await rawExplore(shop, { metrics: ['revenue_paise', 'orders'], range: '7' });
  if (res.status === 200) {
    const body = res.json();
    assertNoFigure(body.totals.revenue_paise?.value, 'Revenue on tier 1');
    assertNoFigure(body.totals.orders?.value, 'Orders on tier 1');
  } else assert.ok([400, 403].includes(res.status), `Got ${res.status}`);
});

const HOSTILE_BODIES = [
  ['no metrics', { metrics: [] }],
  ['an unknown metric', { metrics: ['nope'] }],
  ['13 metrics', { metrics: Array(13).fill('sessions') }],
  ['a metric object', { metrics: [{ $ne: 1 }] }],
  ['three breakdowns', { metrics: ['sessions'], dimensions: ['source', 'device', 'city'] }],
  ['the same breakdown twice', { metrics: ['sessions'], dimensions: ['source', 'source'] }],
  ['a visitor id breakdown', { metrics: ['sessions'], dimensions: ['visitor_id'] }],
  ['a tenant id breakdown', { metrics: ['sessions'], dimensions: ['tenant_id'] }],
  ['a user agent breakdown', { metrics: ['sessions'], dimensions: ['user_agent'] }],
  ['an injection as a breakdown', { metrics: ['sessions'], dimensions: ['source; DROP TABLE tenants'] }],
  ['a filter on a visitor', { metrics: ['sessions'], filters: [{ dimension: 'visitor_id', op: 'include', values: ['x'] }] }],
  ['a filter on an unknown op', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'like', values: ['x'] }] }],
  ['a filter with no values', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'include', values: [] }] }],
  ['51 filter values', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'include', values: Array(51).fill('x') }] }],
  ['a 201-character value', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'include', values: ['x'.repeat(201)] }] }],
  ['an empty value', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'include', values: ['   '] }] }],
  ['a NUL byte', { metrics: ['sessions'], filters: [{ dimension: 'source', op: 'include', values: ['a\u0000b'] }] }],
  ['11 filters', { metrics: ['sessions'], filters: Array(11).fill({ dimension: 'source', op: 'include', values: ['x'] }) }],
  ['4 thresholds', { metrics: ['sessions'], thresholds: Array(4).fill({ metric: 'sessions', op: 'gte', value: 1 }) }],
  ['a threshold that is no number', { metrics: ['sessions'], thresholds: [{ metric: 'sessions', op: 'gte', value: 'x' }] }],
  ['a negative threshold', { metrics: ['sessions'], thresholds: [{ metric: 'sessions', op: 'gte', value: -1 }] }],
  ['a bad compare', { metrics: ['sessions'], compare: 'evil' }],
  ['custom compare with no dates', { metrics: ['sessions'], compare: 'custom' }],
  ['custom range with no dates', { metrics: ['sessions'], range: 'custom' }],
  ['custom range backwards', { metrics: ['sessions'], range: 'custom', from: '2026-02-01', to: '2026-01-01' }],
  ['a page of junk', { metrics: ['sessions'], page: "'; DROP TABLE x" }],
  ['a limit of 0', { metrics: ['sessions'], limit: 0 }],
  ['a limit of 101', { metrics: ['sessions'], limit: 101 }],
];

for (const [label, body] of HOSTILE_BODIES) {
  test(`N-52: ${label} in Explore is refused, never a crash`, async () => {
    const shop = await addP2Shop(world);
    const res = await rawExplore(shop, body);
    assert.equal(res.status, 400, `Got ${res.status}: ${res.text.slice(0, 200)}`);
    assert.equal(res.json().code, 'validation_failed');
  });
}

test('N-52: a body that isn\'t a query is refused, and prototype keys do nothing', async () => {
  const shop = await addP2Shop(world);
  for (const raw of ['[]', 'null', '"x"', '{"metrics":']) {
    const res = await shop.api('/explore/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(res.status, 400, raw);
  }
  const res = await shop.api('/explore/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"metrics":["sessions"],"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}' });
  assert.ok([200, 400].includes(res.status), `Got ${res.status}`);
  assert.equal({}.isAdmin, undefined);
});

// ---- N-52 ------------------------------------------------------------------------------------------------------------

async function cities(shop) {
  await shop.seedSessions([
    { count: 7, city: 'Pune', source: 'bio_link', device: 'mobile' },
    { count: 3, city: 'Pune', source: 'direct', device: 'mobile' },
    { count: 11, city: 'Delhi', source: 'bio_link', device: 'mobile' },
    { count: 2, city: 'Pune', source: 'whatsapp', device: 'desktop' },
  ]);
  await settled(shop);
}

test('N-52: city = Pune and exclude source = Direct counts only Pune sessions from non-direct sources', async () => {
  const shop = await addP2Shop(world);
  await cities(shop);
  const res = await explore(shop, { metrics: ['sessions'], range: '7', filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }, { dimension: 'source', op: 'exclude', values: ['direct'] }] });
  assert.equal(res.totals.sessions.value, 9);
});

test('N-52: filters combine with AND, and a filter\'s values with OR', async () => {
  const shop = await addP2Shop(world);
  await cities(shop);
  const many = await explore(shop, { metrics: ['sessions'], range: '7', filters: [{ dimension: 'source', op: 'include', values: ['bio_link', 'whatsapp'] }, { dimension: 'device', op: 'include', values: ['mobile'] }] });
  assert.equal(many.totals.sessions.value, 18);
  const none = await explore(shop, { metrics: ['sessions'], range: '7', filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }, { dimension: 'city', op: 'include', values: ['Delhi'] }] });
  assert.equal(none.totals.sessions.value ?? 0, 0);
});

test('N-52: a filter value is data: injection text finds nothing and breaks nothing', async () => {
  const shop = await addP2Shop(world);
  await cities(shop);
  for (const value of ["x' OR 1=1 --", '%', '_', '\\', '"; DROP TABLE tenants; --', '${7*7}', '<script>alert(1)</script>']) {
    const res = await explore(shop, { metrics: ['sessions'], range: '7', filters: [{ dimension: 'city', op: 'include', values: [value] }] });
    assert.equal(res.totals.sessions.value ?? 0, 0, value);
  }
  assert.ok((await shop.sql('SELECT count(*)::int AS n FROM tenants'))[0].n > 0);
});

test('N-52: the filter works with a breakdown, on the same rows', async () => {
  const shop = await addP2Shop(world);
  await cities(shop);
  const res = await explore(shop, { metrics: ['sessions'], range: '7', dimensions: ['source'], filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }] });
  assert.deepEqual(res.rows.map((r) => [r.dimensions.source, r.metrics.sessions.value]).sort(), [['bio_link', 7], ['direct', 3], ['whatsapp', 2]]);
});

test('N-52: no answer holds a visitor id, a single person\'s path, or a user agent', async () => {
  const shop = await addP2Shop(world);
  await cities(shop);
  const res = await explore(shop, { metrics: ['sessions', 'visitors'], range: '7', dimensions: ['landing_page'] });
  assert.doesNotMatch(JSON.stringify(res), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|Mozilla/i);
});

test('N-52: a 90-day query with 2 breakdowns answers within the target on a large rollup', async () => {
  const shop = await addP2Shop(world);
  await shop.sql(
    `INSERT INTO traffic_daily (tenant_id, day, dims_hash, hour, weekday, source, device, sessions)
     SELECT $1, current_date - (g % 90), md5(g::text), g % 24, g % 7, (ARRAY['bio_link','direct','whatsapp'])[1 + g % 3], (ARRAY['mobile','desktop'])[1 + g % 2], 1 FROM generate_series(1, 50000) g`,
    [shop.tenantId],
  );
  const started = Date.now();
  await explore(shop, { metrics: ['sessions'], range: '90', dimensions: ['source', 'device'] });
  // The target is for the real database at p95. On a shared in-memory one this only catches a query that scans without grouping.
  assert.ok(Date.now() - started < ANALYTICS_LIMITS.exploreTargetMs * 5, `Took ${Date.now() - started} ms`);
});

// ---- N-53 ------------------------------------------------------------------------------------------------------------

async function revenueView(shop, manager, visibility = 'team') {
  return need(await shop.as(manager.token, '/saved-views', { method: 'POST', body: { name: `Revenue ${unique()}`, visibility, definition: { metrics: ['sessions', 'revenue_paise', 'orders', 'conversion_rate', 'revenue_per_session'], range: '7', dimensions: ['source'] } } }), 201, 'Saving the view').json();
}

async function seeded(shop) {
  await shop.seedSessions([{ count: 29, source: 'bio_link' }, { count: 1, source: 'bio_link', orders: 1, revenue_paise: 100000 }]);
  await settled(shop);
}

test('N-53: a manager\'s shared view with revenue opens for staff without revenue access, with revenue hidden', async () => {
  const shop = await addP2Shop(world);
  await seeded(shop);
  const manager = await shop.addManager();
  const view = await revenueView(shop, manager);
  const staff = await shop.addStaff(['analytics']);
  const opened = need(await shop.as(staff.token, `/saved-views/${view.id}`), 200, 'Opening the view').json();
  assert.equal(opened.id, view.id);
  const res = need(await shop.as(staff.token, '/explore/query', { method: 'POST', body: { ...opened.definition } }), 200, 'Running the view').json();
  for (const metric of ['revenue_paise', 'orders', 'conversion_rate', 'revenue_per_session']) {
    assert.ok(res.hiddenMetrics.includes(metric), `${metric} is hidden: ${res.hiddenMetrics}`);
    assert.equal(res.columns.some((c) => c.metric === metric), false, `${metric} column`);
    assert.equal(Object.hasOwn(res.totals, metric), false, `${metric} total`);
    for (const r of res.rows) assert.equal(Object.hasOwn(r.metrics, metric), false, `${metric} cell`);
  }
  assert.equal(res.totals.sessions.value, 30, 'The rest still shows');
  assert.equal(JSON.stringify(res).includes('100000'), false, 'The figure appears nowhere');
});

test('N-53: staff holding orders see revenue in the same view', async () => {
  const shop = await addP2Shop(world);
  await seeded(shop);
  const manager = await shop.addManager();
  const view = await revenueView(shop, manager);
  const staff = await shop.addStaff(['analytics', 'orders']);
  const definition = need(await shop.as(staff.token, `/saved-views/${view.id}`), 200, 'Opening').json().definition;
  const res = need(await shop.as(staff.token, '/explore/query', { method: 'POST', body: definition }), 200, 'Running').json();
  assert.deepEqual(res.hiddenMetrics, []);
  assert.equal(res.totals.revenue_paise.value, 100000);
});

test('N-53: staff can\'t work revenue out from a threshold, a sort, or a filter on it', async () => {
  const shop = await addP2Shop(world);
  await seeded(shop);
  const staff = await shop.addStaff(['analytics']);
  const probe = async (body) => shop.as(staff.token, '/explore/query', { method: 'POST', body: { metrics: ['sessions'], range: '7', dimensions: ['source'], ...body } });
  for (const value of [0, 1, 99999, 100000, 100001]) {
    const res = await probe({ thresholds: [{ metric: 'revenue_paise', op: 'gte', value }] });
    if (res.status === 200) assert.equal(res.json().rows.length, 1, `A threshold of ${value} changed the rows: revenue could be probed`);
    else assert.ok([400, 403].includes(res.status));
  }
  const sorted = await probe({ sortBy: 'revenue_paise' });
  assert.ok([200, 400, 403].includes(sorted.status));
});

test('N-53: a download of the same view hides revenue from them too', async () => {
  const shop = await addP2Shop(world);
  await seeded(shop);
  const staff = await shop.addStaff(['analytics']);
  const made = need(await shop.as(staff.token, '/downloads', { method: 'POST', body: { source: 'explore', format: 'csv', query: { metrics: ['sessions', 'revenue_paise'], range: '7' } } }), 201, 'The download').json();
  assert.ok(made.id);
  const done = await waitForFile(world, shop, made, { token: staff.token });
  if (done.fileUrl) {
    const file = await fileAt(world, shop, done.fileUrl, { token: staff.token });
    assert.equal(file.text.includes('100000'), false, 'Revenue is not in the file');
    assert.doesNotMatch(file.text, /revenue/i);
  }
});

test('N-53: a private view is its owner\'s alone', async () => {
  const shop = await addP2Shop(world);
  const manager = await shop.addManager();
  const view = await revenueView(shop, manager, 'private');
  const other = await shop.addStaff(['analytics']);
  assert.equal((await shop.as(other.token, `/saved-views/${view.id}`)).status, 404);
  assert.equal((await shop.as(other.token, `/saved-views/${view.id}/pin`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await shop.as(other.token, '/saved-views')).json().items.some((v) => v.id === view.id), false);
});

test('N-53: someone else can\'t change or delete a shared view they didn\'t make', async () => {
  const shop = await addP2Shop(world);
  const manager = await shop.addManager();
  const view = await revenueView(shop, manager);
  const staff = await shop.addStaff(['analytics']);
  assert.ok([403, 404].includes((await shop.as(staff.token, `/saved-views/${view.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).status));
  assert.ok([403, 404].includes((await shop.as(staff.token, `/saved-views/${view.id}`, { method: 'DELETE' })).status));
});

test('N-53: a saved view takes only what Explore takes', async () => {
  const shop = await addP2Shop(world);
  for (const definition of [{ metrics: ['sessions'], dimensions: ['visitor_id'] }, { metrics: [] }, {}, { metrics: ['sessions'], filters: [{ dimension: 'tenant_id', op: 'include', values: ['1'] }] }]) {
    assert.equal((await shop.api('/saved-views', { method: 'POST', body: { name: 'Bad', definition } })).status, 400, JSON.stringify(definition));
  }
});

// ---- N-54 ------------------------------------------------------------------------------------------------------------

test('N-54: a pinned view appears on the dashboard and refreshes with the cache', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 3, source: 'bio_link' }]);
  await settled(shop);
  const view = await shop.post('/saved-views', { name: 'Sessions', definition: { metrics: ['sessions'], range: '7' } }, 201);
  await shop.post(`/saved-views/${view.id}/pin`, {}, 200, 'Pinning');
  const before = await shop.get('/dashboard/cards', undefined, 'The cards');
  const card = before.items.find((c) => c.view.id === view.id);
  assert.ok(card, 'It is on the dashboard');
  assert.equal(card.view.pinned, true);
  assert.equal(card.result.totals.sessions.value, 3);
  await shop.seedSessions([{ count: 4, source: 'whatsapp' }]);
  await settled(shop);
  assert.equal((await shop.get('/dashboard/cards')).items.find((c) => c.view.id === view.id).result.totals.sessions.value, 7);
});

test('N-54: pinning twice is one card, unpinning takes it off, and a pin is per person', async () => {
  const shop = await addP2Shop(world);
  const view = await shop.post('/saved-views', { name: 'Sessions', visibility: 'team', definition: { metrics: ['sessions'], range: '7' } }, 201);
  await shop.post(`/saved-views/${view.id}/pin`, {}, 200);
  await shop.post(`/saved-views/${view.id}/pin`, {}, 200);
  assert.equal((await shop.get('/dashboard/cards')).items.length, 1);
  const manager = await shop.addManager();
  assert.deepEqual((await shop.as(manager.token, '/dashboard/cards')).json().items, []);
  need(await shop.api(`/saved-views/${view.id}/pin`, { method: 'DELETE' }), 204, 'Unpinning');
  assert.deepEqual((await shop.get('/dashboard/cards')).items, []);
});

test('N-54: a card for a shared view shows staff only what they may see', async () => {
  const shop = await addP2Shop(world);
  await seeded(shop);
  const manager = await shop.addManager();
  const view = await revenueView(shop, manager);
  const staff = await shop.addStaff(['analytics']);
  need(await shop.as(staff.token, `/saved-views/${view.id}/pin`, { method: 'POST', body: {} }), 200, 'Pinning');
  const card = (await shop.as(staff.token, '/dashboard/cards')).json().items.find((c) => c.view.id === view.id);
  assert.ok(card.result.hiddenMetrics.includes('revenue_paise'));
  assert.equal(JSON.stringify(card.result).includes('100000'), false);
});

test('N-54: deleting a pinned view removes its card', async () => {
  const shop = await addP2Shop(world);
  const view = await shop.post('/saved-views', { name: 'Sessions', definition: { metrics: ['sessions'], range: '7' } }, 201);
  await shop.post(`/saved-views/${view.id}/pin`, {}, 200);
  need(await shop.api(`/saved-views/${view.id}`, { method: 'DELETE' }), 204, 'Deleting');
  assert.deepEqual((await shop.get('/dashboard/cards')).items, []);
  assert.equal((await shop.api(`/saved-views/${view.id}`)).status, 404);
});

// ---- N-55 ------------------------------------------------------------------------------------------------------------

async function twoBusinesses() {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await b.seedSessions([{ count: 6, source: 'bio_link' }]);
  const view = await b.post('/saved-views', { name: 'Theirs', visibility: 'team', definition: { metrics: ['sessions'], range: '7' } }, 201);
  return { a, b, view };
}

for (const [label, method, suffix, body] of [
  ['reading', 'GET', '', undefined],
  ['changing', 'PATCH', '', { name: 'Stolen' }],
  ['deleting', 'DELETE', '', undefined],
  ['pinning', 'POST', '/pin', {}],
  ['unpinning', 'DELETE', '/pin', undefined],
]) {
  test(`N-55: ${label} another business's saved view is not found, and changes nothing`, async () => {
    const { a, b, view } = await twoBusinesses();
    const res = await a.api(`/saved-views/${view.id}${suffix}`, { method, ...(body ? { body } : {}) });
    assert.equal(res.status, 404, `Got ${res.status}: ${res.text.slice(0, 200)}`);
    assert.doesNotMatch(res.text, /Theirs/);
    const [row] = await b.sql('SELECT name FROM saved_views WHERE tenant_id = $1 AND id = $2', [b.tenantId, view.id]);
    assert.equal(row.name, 'Theirs', 'Still there, unchanged');
  });
}

test('N-55: a scheduled report can\'t be made from another business\'s view', async () => {
  const { a, view } = await twoBusinesses();
  const res = await a.api('/scheduled-reports', { method: 'POST', body: { viewId: view.id, frequency: 'weekly', hourOfDay: 9, weekday: 1 } });
  assert.ok([400, 404].includes(res.status), `Got ${res.status}`);
});

test('N-55: nonsense as a view id is refused', async () => {
  const shop = await addP2Shop(world);
  for (const id of ['abc', '0', '-1', '9999999999999', "1'%20OR%201=1"]) assert.ok([400, 404].includes((await shop.api(`/saved-views/${id}`)).status), id);
});

test('N-55: a business lists only its own views', async () => {
  const { a, view } = await twoBusinesses();
  assert.equal((await a.get('/saved-views')).items.some((v) => v.id === view.id), false);
});

test('N-55: one business never gets another\'s figures from Explore, even with a crafted body', async () => {
  const { a, b } = await twoBusinesses();
  await b.settle({ ms: 2000, roundMs: 200 });
  const res = await explore(a, { metrics: ['sessions'], range: '7', tenantId: b.tenantId, tenant_id: b.tenantId, businessId: b.tenantId });
  assert.equal(res.totals.sessions.value ?? 0, 0);
});
