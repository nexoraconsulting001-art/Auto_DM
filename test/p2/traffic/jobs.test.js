// The background side: the worker's turn for one business, retention, and how this module shares routes with the contract's stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MODULES } from '../../../src/modules/index.js';
import { purge, syncBusiness, traffic } from '../../../src/modules/traffic/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { NOW, api, beacon, newVisitor, startTraffic } from './support.js';

test('a worker turn builds the daily summaries a screen reads, and a rerun changes nothing', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/p/x', pageKind: 'product', pageRef: 'x', mediaId: '18475694065114168' }, { visitor });
  await world.inTenant(() => syncBusiness(world.jobContext));
  await world.inTenant(() => syncBusiness(world.jobContext));
  const read = (store, measure) => world.inTenant(() => world.drivers.analytics.rollups.read(store, { measures: [measure], since: '2026-11-01', until: '2026-11-30' }));
  assert.deepEqual(await read('traffic_daily', 'sessions'), [{ sessions: 1 }]);
  assert.deepEqual(await read('traffic_items_daily', 'views'), [{ views: 1 }]);
  assert.deepEqual(await read('funnel_daily', 'visits'), [{ visits: 1 }]);
});

test('retention: raw events and visitors go after 13 months, while the daily rollups stay for 25', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const old = new Date(Date.now() - 400 * 86_400_000);
  const oldDay = old.toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 86_400_000);
  const visitor = crypto.randomUUID();
  await world.db.platform.query(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, last_seen_at) VALUES ($1, $2, $3::timestamptz, $3::timestamptz)`, [world.tenant.id, visitor, old]);
  await world.db.platform.query(`INSERT INTO traffic_events (tenant_id, name, at, path) VALUES ($1, 'page_view', $2::timestamptz, '/old'), ($1, 'page_view', $3::timestamptz, '/new')`, [world.tenant.id, old, recent]);
  await withTenant(world.tenant, () => world.drivers.analytics.rollups.write('traffic_daily', [{ day: oldDay, hour: 1, weekday: 1, sessions: 3 }]));
  await purge(world.jobContext);
  const events = await world.db.platform.query('SELECT path FROM traffic_events');
  assert.deepEqual(events.map((e) => e.path), ['/new']);
  assert.equal((await world.db.platform.query('SELECT 1 FROM traffic_visitors')).length, 0);
  const kept = await withTenant(world.tenant, () => world.drivers.analytics.rollups.read('traffic_daily', { measures: ['sessions'], since: oldDay, until: oldDay }));
  assert.deepEqual(kept, [{ sessions: 3 }]);
});

test('the worker registers its queues and schedules them', async () => {
  const worked = [];
  const every = [];
  const ctx = { platform: { queue: { work: (name) => worked.push(name), every: async (name) => every.push(name) } } };
  const schedule = traffic.jobs(ctx);
  await schedule();
  assert.deepEqual(worked.sort(), ['traffic.fanout', 'traffic.purge', 'traffic.sync', 'traffic.tags']);
  assert.deepEqual(every.sort(), ['traffic.fanout', 'traffic.purge', 'traffic.tags']);
});

test('this module answers only its own routes until an app adopts the stubs, and every route is answered once', async (t) => {
  const bare = { repos: {}, config: {}, ig: {}, auth: {} };
  assert.deepEqual(Object.keys(traffic.api(bare)).sort(), ['tags.get', 'tags.health', 'tags.update', 'traffic.breakdown', 'traffic.heatmap', 'traffic.pages', 'traffic.realtime', 'traffic.sources', 'traffic.summary', 'traffic.trend']);
  assert.ok(MODULES.includes(traffic));
  const world = await startTraffic({ at: NOW });
  t.after(world.close);
  assert.equal((await api(world, '/explore/catalog')).status, 200);
  assert.equal((await api(world, '/funnels')).status, 200);
  assert.equal((await api(world, '/insights/funnels')).status, 200);
  assert.equal((await api(world, '/insights/status')).status, 200, 'a route the insights module really built stays answered by it');
  assert.equal((await api(world, '/downloads')).status, 501, 'a stub this track doesn\'t build is untouched');
  assert.ok(MODULES.find((m) => m.name === 'reports').api(bare)['explore.query'], 'the shared module objects are not changed');
});
