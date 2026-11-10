// PRD 7.11: any metric by any dimension, inside one business, and nothing that isn't in the catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { api, newVisitor, secondBusiness, beacon, staffToken, startTraffic } from './support.js';

const TODAY = '2026-11-05';

const session = (day, more = {}) => ({ session_id: crypto.randomUUID(), day, hour: 12, weekday: 4, source: 'direct', device: 'mobile', page_views: 1, bounced: 1, ...more });

function writeSessions(world, rows, tenant = world.tenant) {
  return withTenant(tenant, () => world.drivers.analytics.rollups.write('traffic_sessions', rows));
}

const days = (start, n) => Array.from({ length: n }, (_v, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const query = (world, body, token) => api(world, '/explore/query', { method: 'POST', body, token });

test('N-51: sessions by source and device, against the previous 28 days, with changes and totals that match the traffic screen', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [
    ...Array.from({ length: 3 }, () => session('2026-11-01', { source: 'bio_link', device: 'mobile' })),
    session('2026-11-02', { source: 'bio_link', device: 'desktop' }),
    ...Array.from({ length: 2 }, () => session('2026-10-01', { source: 'bio_link', device: 'mobile' })),
  ]);
  const { status, body } = await query(world, { metrics: ['sessions'], dimensions: ['source', 'device'], range: '28', compare: 'previous' });
  assert.equal(status, 200);
  assert.equal(body.from, '2026-10-09');
  assert.equal(body.to, TODAY);
  assert.equal(body.compareFrom, '2026-09-11');
  const mobile = body.rows.find((r) => r.dimensions.source === 'bio_link' && r.dimensions.device === 'mobile');
  assert.deepEqual(mobile.metrics.sessions, { value: 3, previous: 2, change: 1, changePercent: 50, lowVolume: false });
  assert.equal(body.totals.sessions.value, 4);
  assert.equal(body.totals.sessions.previous, 2);
  assert.equal(body.columns[0].source, 'bhava');
  const screen = (await api(world, '/traffic/summary?range=28&compare=previous')).body;
  assert.equal(screen.sessions.value, body.totals.sessions.value);
  assert.equal(screen.sessions.previous, body.totals.sessions.previous);
});

test('N-52: include and exclude filters combine with AND', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [session(TODAY, { city: 'Pune', source: 'bio_link' }), session(TODAY, { city: 'Pune', source: 'direct' }), session(TODAY, { city: 'Delhi', source: 'bio_link' })]);
  const { body } = await query(world, { metrics: ['sessions'], filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }, { dimension: 'source', op: 'exclude', values: ['direct'] }] });
  assert.equal(body.totals.sessions.value, 1);
});

test('a threshold keeps rows of at least that size, and paging and sorting follow the request', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [
    ...Array.from({ length: 5 }, () => session(TODAY, { source: 'bio_link' })),
    ...Array.from({ length: 2 }, () => session(TODAY, { source: 'whatsapp' })),
    session(TODAY, { source: 'direct' }),
  ]);
  const above = (await query(world, { metrics: ['sessions'], dimensions: ['source'], thresholds: [{ metric: 'sessions', op: 'gte', value: 2 }] })).body;
  assert.deepEqual(above.rows.map((r) => r.dimensions.source), ['bio_link', 'whatsapp']);
  const firstPage = (await query(world, { metrics: ['sessions'], dimensions: ['source'], sortBy: 'sessions', sortDirection: 'asc', limit: 2 })).body;
  assert.deepEqual(firstPage.rows.map((r) => r.dimensions.source), ['direct', 'whatsapp']);
  const next = (await query(world, { metrics: ['sessions'], dimensions: ['source'], sortBy: 'sessions', sortDirection: 'asc', limit: 2, page: firstPage.nextPage })).body;
  assert.deepEqual(next.rows.map((r) => r.dimensions.source), ['bio_link']);
  assert.equal(next.nextPage, null);
});

test('Explore takes only names from the catalogue, never a column or SQL', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [session(TODAY)]);
  const hostile = [
    { metrics: ['visitor_id'] },
    { metrics: ['sessions; DROP TABLE traffic_daily'] },
    { metrics: ['sessions'], dimensions: ['visitor_id'] },
    { metrics: ['sessions'], dimensions: ['ip'] },
    { metrics: ['sessions'], filters: [{ dimension: 'session_id', op: 'include', values: ['x'] }] },
    { metrics: ['sessions'], filters: [{ dimension: 'hour', op: 'include', values: ['1 OR 1=1'] }] },
    { metrics: ['sessions'], dimensions: ['source', 'device', 'city'] },
    { metrics: ['sessions'], dimensions: ['product', 'category'] },
  ];
  for (const body of hostile) assert.equal((await query(world, body)).status, 400, JSON.stringify(body));

  const { status, body } = await query(world, { metrics: ['sessions'], dimensions: ['source'], sortBy: `sessions'; DROP TABLE traffic_daily; --`, filters: [{ dimension: 'source', op: 'exclude', values: [`' OR '1'='1`] }] });
  assert.equal(status, 200);
  assert.equal(body.totals.sessions.value, 1, 'the odd text is only a value to compare with');
  const [still] = await world.db.platform.query(`SELECT count(*)::int AS n FROM traffic_daily`);
  assert.ok(still.n >= 1);
});

test('Explore stays inside one business', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  await writeSessions(world, [session(TODAY, { source: 'bio_link' })]);
  await writeSessions(world, [session(TODAY, { source: 'whatsapp' }), session(TODAY, { source: 'whatsapp' })], other.tenant);
  const mine = (await query(world, { metrics: ['sessions'], dimensions: ['source'] })).body;
  assert.deepEqual(mine.rows.map((r) => [r.dimensions.source, r.metrics.sessions.value]), [['bio_link', 1]]);
  const theirs = (await api(world, '/explore/query', { method: 'POST', body: { metrics: ['sessions'], dimensions: ['source'] }, token: other.token, host: other.host })).body;
  assert.deepEqual(theirs.rows.map((r) => [r.dimensions.source, r.metrics.sessions.value]), [['whatsapp', 2]]);
});

test('Meta and Bhava figures are labelled separately and never added together, and a figure that does not exist at that level stays empty', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [session('2026-11-02', { source: 'bio_link' })]);
  await world.inTenant(() => world.drivers.analytics.rollups.write('meta_account_daily', [{ day: '2026-11-02', account_id: 'ME', reach: 900 }]));
  const byDate = (await query(world, { metrics: ['sessions', 'ig_reach'], dimensions: ['date'], range: '7' })).body;
  assert.deepEqual(byDate.columns.map((c) => c.source), ['bhava', 'platform']);
  const day = byDate.rows.find((r) => r.dimensions.date === '2026-11-02');
  assert.equal(day.metrics.sessions.value, 1);
  assert.equal(day.metrics.ig_reach.value, 900);
  const bySource = (await query(world, { metrics: ['sessions', 'ig_reach'], dimensions: ['source'], range: '7' })).body;
  assert.equal(bySource.rows[0].metrics.ig_reach.value, null, 'Instagram doesn\'t know what a session\'s source is');
  const filtered = (await query(world, { metrics: ['ig_reach'], range: '7', filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }] })).body;
  assert.equal(filtered.totals.ig_reach.value, null, 'a filter that can\'t apply is not silently ignored');
});

test('a rate under 20 shows low volume, and rates over enough sessions are worked out', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, Array.from({ length: 5 }, () => session(TODAY)));
  const small = (await query(world, { metrics: ['bounce_rate'] })).body.totals.bounce_rate;
  assert.deepEqual([small.value, small.lowVolume], [null, true]);
  await writeSessions(world, Array.from({ length: 15 }, () => session(TODAY, { page_views: 3, bounced: 0 })));
  const enough = (await query(world, { metrics: ['bounce_rate'] })).body.totals.bounce_rate;
  assert.deepEqual([enough.value, enough.lowVolume], [0.25, false]);
});

test('a metric the plan doesn\'t include is unavailable in the catalogue and left out of a query', async (t) => {
  const world = await startTraffic({ plan: 't2' });
  t.after(world.close);
  await writeSessions(world, [session(TODAY)]);
  const catalog = (await api(world, '/explore/catalog')).body;
  const revenue = catalog.metrics.find((m) => m.name === 'revenue_paise');
  assert.deepEqual([revenue.available, revenue.reason], [false, 'Needs tier 3']);
  assert.ok(catalog.metrics.find((m) => m.name === 'product_taps').available);
  assert.ok(catalog.dimensions.some((d) => d.name === 'source'));
  const result = (await query(world, { metrics: ['sessions', 'revenue_paise'] })).body;
  assert.deepEqual(result.hiddenMetrics, ['revenue_paise']);
  assert.equal(result.totals.revenue_paise, undefined);
});

test('breakdowns by product come from the events, and only for figures that exist per product', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/p/kurta', pageKind: 'product', pageRef: 'kurta' }, { visitor });
  await beacon(world, { name: 'product_view', path: '/p/kurta', pageKind: 'product', pageRef: 'kurta' }, { visitor });
  await beacon(world, { name: 'product_tap', path: '/p/kurta', pageKind: 'product', pageRef: 'kurta' }, { visitor });
  await beacon(world, { name: 'page_view', path: '/p/saree', pageKind: 'product', pageRef: 'saree' }, { visitor: newVisitor() });
  const { body } = await query(world, { metrics: ['product_views', 'product_taps', 'bounce_rate'], dimensions: ['product'] });
  const kurta = body.rows.find((r) => r.dimensions.product === 'kurta');
  assert.equal(kurta.metrics.product_views.value, 1);
  assert.equal(kurta.metrics.product_taps.value, 1);
  assert.equal(kurta.metrics.bounce_rate.value, null);
  assert.equal(body.rows.find((r) => r.dimensions.product === 'saree').metrics.product_views.value, 1);
});

test('N-53: a shared view opens for staff, with revenue hidden unless they may see it', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [session(TODAY, { orders: 1, revenue_paise: 5000 })]);
  const manager = await staffToken(world, { role: 'manager', phone: '9123456781' });
  const definition = { metrics: ['sessions', 'revenue_paise'], dimensions: [] };
  const saved = await api(world, '/saved-views', { method: 'POST', body: { name: 'Money', visibility: 'team', definition }, token: manager });
  assert.equal(saved.status, 201);
  const staff = await staffToken(world, { permissions: ['analytics'], phone: '9123456782' });
  const opened = await api(world, `/saved-views/${saved.body.id}`, { token: staff });
  assert.equal(opened.status, 200);
  const run = (await query(world, { ...opened.body.definition }, staff)).body;
  assert.deepEqual(run.hiddenMetrics, ['revenue_paise']);
  assert.ok(!JSON.stringify(run).includes('5000'));
  const withOrders = await staffToken(world, { permissions: ['analytics', 'orders'], phone: '9123456783' });
  assert.equal((await query(world, definition, withOrders)).body.totals.revenue_paise.value, 5000);
});

test('a private view is only its maker\'s; staff can\'t edit a shared one', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const staff = await staffToken(world, { permissions: ['analytics'] });
  const definition = { metrics: ['sessions'] };
  const mine = (await api(world, '/saved-views', { method: 'POST', body: { name: 'Mine', definition } })).body;
  assert.equal((await api(world, `/saved-views/${mine.id}`, { token: staff })).status, 404);
  const shared = (await api(world, '/saved-views', { method: 'POST', body: { name: 'Team', visibility: 'team', definition } })).body;
  assert.equal((await api(world, `/saved-views/${shared.id}`, { method: 'PATCH', body: { name: 'Mine now' }, token: staff })).status, 404);
  assert.equal((await api(world, `/saved-views/${shared.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).body.name, 'Renamed');
  const list = (await api(world, '/saved-views', { token: staff })).body;
  assert.deepEqual(list.items.map((v) => v.name), ['Renamed']);
  assert.equal((await api(world, `/saved-views/${shared.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(world, `/saved-views/${shared.id}`, { method: 'DELETE' })).status, 404);
});

test('N-54: a pinned view appears on the dashboard and shows new figures', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, [session(TODAY)]);
  const view = (await api(world, '/saved-views', { method: 'POST', body: { name: 'Pinned', definition: { metrics: ['sessions'], range: '7' } } })).body;
  assert.equal((await api(world, `/saved-views/${view.id}/pin`, { method: 'POST' })).body.pinned, true);
  let cards = (await api(world, '/dashboard/cards')).body;
  assert.equal(cards.items.length, 1);
  assert.equal(cards.items[0].result.totals.sessions.value, 1);
  await writeSessions(world, [session(TODAY)]);
  cards = (await api(world, '/dashboard/cards')).body;
  assert.equal(cards.items[0].result.totals.sessions.value, 2);
  assert.equal((await api(world, `/saved-views/${view.id}/pin`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(world, '/dashboard/cards')).body.items.length, 0);
});

test('N-55: another business\'s saved view id is not found, whatever is done with it', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  const theirs = (await api(world, '/saved-views', { method: 'POST', body: { name: 'Theirs', visibility: 'team', definition: { metrics: ['sessions'] } }, token: other.token, host: other.host })).body;
  assert.equal((await api(world, `/saved-views/${theirs.id}`)).status, 404);
  assert.equal((await api(world, `/saved-views/${theirs.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 404);
  assert.equal((await api(world, `/saved-views/${theirs.id}/pin`, { method: 'POST' })).status, 404);
  assert.equal((await api(world, `/saved-views/${theirs.id}`, { method: 'DELETE' })).status, 404);
});

test('a date breakdown fills the chart in order', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await writeSessions(world, days('2026-11-01', 3).map((d) => session(d)));
  const { body } = await query(world, { metrics: ['sessions'], dimensions: ['date'], range: '7', chart: 'line' });
  assert.deepEqual(body.rows.map((r) => r.dimensions.date), days('2026-11-01', 3));
});
