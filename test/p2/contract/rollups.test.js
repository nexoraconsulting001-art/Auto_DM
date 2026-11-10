// analytics.rollups: the interface a separate analytics database can take over without changing a caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createAnalytics } from '../../../src/platform/analytics.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

const row = (day, more = {}) => ({ day, hour: 10, weekday: 1, source: 'direct', sessions: 1, ...more });

async function world() {
  const base = await setup();
  const b = await base.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  const analytics = createAnalytics({ analyticsDriver: 'pg' }, { db: base.db });
  return { ...base, b, rollups: analytics.rollups, inA: (fn) => withTenant(base.tenant, fn), inB: (fn) => withTenant(b, fn) };
}

test('a write replaces by key, so a rerun changes nothing', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    await rollups.write('traffic_daily', [row('2026-11-01', { sessions: 3 })]);
    await rollups.write('traffic_daily', [row('2026-11-01', { sessions: 5 })]);
    assert.deepEqual(await rollups.read('traffic_daily', { measures: ['sessions'], since: '2026-11-01', until: '2026-11-01' }), [{ sessions: 5 }]);
  });
});

test('breakdowns, include and exclude filters, thresholds and ordering', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    await rollups.write('traffic_daily', [
      row('2026-11-01', { source: 'bio_link', city: 'Pune', sessions: 60 }),
      row('2026-11-01', { source: 'direct', city: 'Pune', sessions: 30 }),
      row('2026-11-02', { source: 'bio_link', city: 'Delhi', sessions: 10 }),
    ]);
    const bySource = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['source'], since: '2026-11-01', until: '2026-11-02' });
    assert.deepEqual(bySource, [{ source: 'bio_link', sessions: 70 }, { source: 'direct', sessions: 30 }]);
    const filtered = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['source'], filters: [{ dimension: 'city', op: 'include', values: ['Pune'] }, { dimension: 'source', op: 'exclude', values: ['direct'] }], since: '2026-11-01', until: '2026-11-02' });
    assert.deepEqual(filtered, [{ source: 'bio_link', sessions: 60 }]);
    const threshold = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['city'], having: [{ measure: 'sessions', op: 'gte', value: 50 }], since: '2026-11-01', until: '2026-11-02' });
    assert.deepEqual(threshold, [{ city: 'Pune', sessions: 90 }]);
    const byDay = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['day'], orderBy: 'day', direction: 'asc', since: '2026-11-01', until: '2026-11-02' });
    assert.deepEqual(byDay, [{ day: '2026-11-01', sessions: 90 }, { day: '2026-11-02', sessions: 10 }]);
  });
});

test('traffic_sessions counts distinct visitors and a median, and a session with no cookie is still a session', async () => {
  const { db, tenant, rollups, inA } = await world();
  const visitor = crypto.randomUUID();
  await inA(async () => {
    await db.query(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, last_seen_at) VALUES ($1, $2, now(), now())`, [tenant.id, visitor]);
    await rollups.write('traffic_sessions', [
      { session_id: crypto.randomUUID(), visitor_id: visitor, day: '2026-11-01', hour: 9, weekday: 0, source: 'direct', engaged_ms: 1000 },
      { session_id: crypto.randomUUID(), visitor_id: visitor, day: '2026-11-02', hour: 9, weekday: 1, source: 'bio_link', engaged_ms: 3000 },
      { session_id: crypto.randomUUID(), day: '2026-11-02', hour: 9, weekday: 1, source: 'direct', engaged_ms: 5000 },
    ]);
    const [totals] = await rollups.read('traffic_sessions', { measures: ['sessions', 'visitors', 'median_engaged_ms'], since: '2026-11-01', until: '2026-11-02' });
    assert.deepEqual(totals, { sessions: 3, visitors: 1, median_engaged_ms: 3000 });
  });
});

test('a figure Meta did not give stays null, never 0', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    await rollups.write('meta_account_daily', [{ day: '2026-11-01', account_id: 'IG', reach: 100 }]);
    assert.deepEqual(await rollups.read('meta_account_daily', { measures: ['reach', 'comments'], since: '2026-11-01', until: '2026-11-01' }), [{ reach: 100, comments: null }]);
  });
});

test('rebuild takes out rows that no longer exist, and only in the range', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    await rollups.write('funnel_daily', [{ day: '2026-11-01', media_id: 'M1', orders: 1, revenue_paise: 500 }, { day: '2026-11-02', media_id: 'M1', orders: 2, revenue_paise: 700 }]);
    await rollups.rebuild('funnel_daily', { since: '2026-11-01', until: '2026-11-01' }, []);
    assert.deepEqual(await rollups.read('funnel_daily', { measures: ['orders', 'revenue_paise'], since: '2026-11-01', until: '2026-11-02' }), [{ orders: 2, revenue_paise: 700 }]);
  });
});

test('one business never reads another\'s, and nothing runs without a business', async () => {
  const { rollups, inA, inB } = await world();
  await inA(() => rollups.write('traffic_daily', [row('2026-11-01', { sessions: 9 })]));
  assert.deepEqual(await inB(() => rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['source'], since: '2026-11-01', until: '2026-11-01' })), []);
  await assert.rejects(() => rollups.write('traffic_daily', [row('2026-11-01')]), /tenant context/);
  await assert.rejects(() => rollups.read('traffic_daily', { measures: ['sessions'], since: '2026-11-01', until: '2026-11-01' }), /tenant context/);
});

test('only what the catalogue names can reach SQL', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    const range = { since: '2026-11-01', until: '2026-11-01' };
    await assert.rejects(() => rollups.read('nope', { measures: ['sessions'], ...range }), /Unknown rollup store/);
    await assert.rejects(() => rollups.read('traffic_daily', { measures: ['sessions; DROP TABLE tenants'], ...range }), /Unknown rollup measure/);
    await assert.rejects(() => rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['visitor_id'], ...range }), /Unknown rollup dimension/);
    await assert.rejects(() => rollups.read('traffic_daily', { measures: ['sessions'], orderBy: 'tenant_id', ...range }), /ordered only/);
    await assert.rejects(() => rollups.read('traffic_daily', { measures: ['sessions'], since: 'x', until: '2026-11-01' }), /since/);
    await assert.rejects(() => rollups.write('traffic_daily', [row('2026-11-01', { client_ip: '1.2.3.4' })]), /no column/);
    await assert.rejects(() => rollups.write('traffic_sessions', [{ day: '2026-11-01', hour: 1, weekday: 1 }]), /session_id/);
  });
});

test('a filter value is data, whatever it holds', async () => {
  const { rollups, inA } = await world();
  await inA(async () => {
    await rollups.write('traffic_daily', [row('2026-11-01', { source: "x' OR 1=1 --", sessions: 1 })]);
    const rows = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['source'], filters: [{ dimension: 'source', op: 'include', values: ["x' OR 1=1 --"] }], since: '2026-11-01', until: '2026-11-01' });
    assert.deepEqual(rows, [{ source: "x' OR 1=1 --", sessions: 1 }]);
  });
});

test('purgeExpired applies each store\'s retention across businesses', async () => {
  const { db, rollups, inA, inB } = await world();
  await inA(() => rollups.write('traffic_daily', [row('2024-01-01'), row('2026-11-01')]));
  await inB(() => rollups.write('traffic_daily', [row('2024-01-01')]));
  await rollups.purgeExpired(new Date('2026-11-02T00:00:00Z'));
  const rows = await db.platform.query(`SELECT day::text FROM traffic_daily`);
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-01']);
});

test('the ClickHouse driver has the same interface, and sends its values as parameters', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ query: url.searchParams.get('query'), params: Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith('param_'))), body });
      res.end(url.searchParams.get('query')?.startsWith('SELECT') ? '{"d_source":"direct","m_sessions":"4"}\n' : '');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { tenant } = await setup();
    const { rollups } = createAnalytics({ analyticsDriver: 'clickhouse', clickhouseUrl: `http://127.0.0.1:${server.address().port}` }, {});
    await withTenant(tenant, async () => {
      assert.deepEqual(Object.keys(rollups).sort(), ['clear', 'purgeExpired', 'read', 'rebuild', 'write']);
      await rollups.write('traffic_daily', [row('2026-11-01')]);
      const rows = await rollups.read('traffic_daily', { measures: ['sessions'], dimensions: ['source'], filters: [{ dimension: 'source', op: 'include', values: ["it's"] }], since: '2026-11-01', until: '2026-11-01' });
      assert.deepEqual(rows, [{ source: 'direct', sessions: 4 }]);
    });
    const insert = seen.find((s) => s.query.startsWith('INSERT'));
    assert.equal(JSON.parse(insert.body).tenant_id, tenant.id);
    const select = seen.find((s) => s.query.startsWith('SELECT'));
    assert.match(select.query, /FINAL/);
    assert.doesNotMatch(select.query, /it's|2026-11-01/, 'values travel as parameters');
    assert.ok(Object.values(select.params).includes(String(tenant.id)));
  } finally {
    server.close();
  }
});
