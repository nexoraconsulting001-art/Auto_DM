// What the Phase 2 tracks build against: the requirement list, the module folders, and the API contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_LIMITS, EXPLORE_DIMENSION_NAMES, EXPLORE_METRICS, FUNNEL_MEASUREMENT, META_METRICS, ROLLUP_STORES, SOURCE_LABEL_CODES, TRAFFIC_PATHS, VISITOR_COOKIE } from '../../../src/contracts/analytics.js';
import * as contract from '../../../src/contracts/api/index.js';
import { DownloadCreate, ExploreQuery, OWNER_ONLY, RangeQuery, ReportingQuery, TagSettingsUpdate, TrafficBeacon, canSeeRevenue, platformRouteList, reportingRouteList, routeList } from '../../../src/contracts/api/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { setup, startApp, OWNER } from '../../helpers.js';
import { withTenant } from '../../../src/tenancy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p2.json'), 'utf8'));
const signIn = async (base, who = OWNER) => (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })).json()).token;

test('requirements/p2.json lists every N scenario once, with a short title', () => {
  assert.equal(requirements.length, 83);
  assert.equal(new Set(requirements.map((r) => r.id)).size, 83);
  assert.deepEqual(requirements.map((r) => r.id).sort(), Array.from({ length: 83 }, (_, i) => `N-${String(i + 1).padStart(2, '0')}`));
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.ok(r.title.length > 0 && r.title.length <= 80, r.id);
  }
});

test('each track has its module folder, listed in the registry', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of ['insights', 'reach-guard', 'traffic', 'reports']) {
    assert.ok(names.includes(name), name);
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
  }
  assert.ok(names.indexOf('reports') < names.indexOf('api-v1'), 'api-v1 mounts last');
});

test('every Phase 2 route belongs to the module named for it', () => {
  const owner = { insights: 'insights', destinations: 'insights', reachGuard: 'reach-guard', accountHealth: 'reach-guard', traffic: 'traffic', tags: 'traffic', explore: 'reports', savedViews: 'reports', dashboard: 'reports', funnels: 'reports', cohorts: 'reports', downloads: 'reports', reports: 'reports', scheduledReports: 'reports', apiKeys: 'reports' };
  const answers = new Map(MODULES.flatMap((m) => Object.keys(m.api?.({ repos: {}, config: {}, ig: {}, auth: {} }) ?? {}).map((id) => [id, m.name])));
  const phase2 = routeList.filter((r) => owner[r.id.split('.')[0]]);
  assert.ok(phase2.length >= 60, `found ${phase2.length}`);
  for (const route of phase2) assert.equal(answers.get(route.id), owner[route.id.split('.')[0]], route.id);
});

test('a Phase 2 route not built yet answers 501, in the one error format', async () => {
  const app = await startApp();
  try {
    const token = await signIn(app.base);
    const res = await fetch(`${app.base}/api/v1/insights/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, 'not_implemented');
    const provider = await fetch(`${app.base}${TRAFFIC_PATHS.script}`);
    assert.notEqual(provider.status, 500);
  } finally {
    app.close();
  }
});

test('no seller route or path can name raw events or a visitor, and owner-only routes say so', () => {
  assert.deepEqual(routeList.filter((r) => /raw|export/i.test(`${r.id} ${r.path}`)).map((r) => r.id), []);
  for (const banned of ['visitor_id', 'session_id', 'ip', 'user_agent', 'username']) assert.equal(EXPLORE_DIMENSION_NAMES.includes(banned), false, banned);
  assert.equal(ExploreQuery.safeParse({ metrics: ['sessions'], dimensions: ['visitor_id'] }).success, false);
  assert.equal(ExploreQuery.safeParse({ metrics: ['sessions'], dimensions: ['source', 'device', 'city'] }).success, false, 'at most 2 breakdowns');
  assert.equal(ExploreQuery.safeParse({ metrics: ['sessions'], filters: [{ dimension: 'visitor_id', op: 'include', values: ['x'] }] }).success, false);
  assert.equal(ReportingQuery.safeParse({ metrics: 'sessions', dimensions: 'visitor_id' }).success, false);
  assert.equal(ReportingQuery.parse({ metrics: 'sessions,orders', dimensions: 'source' }).metrics.length, 2);
  assert.deepEqual([...routeList.find((r) => r.id === 'apiKeys.create').access.roles], ['owner']);
  assert.deepEqual([...routeList.find((r) => r.id === 'reachGuard.setThresholds').access.roles], ['owner']);
  assert.deepEqual([...routeList.find((r) => r.id === 'tags.update').access.roles], ['owner']);
  assert.equal(OWNER_ONLY.denied, 'Owner only.');
  assert.equal(routeList.find((r) => r.id === 'traffic.summary').access.permission, 'analytics');
});

test('the reporting API is a separate list, read-only, and always refuses event-level rows', () => {
  const sellers = new Set(routeList.map((r) => r.id));
  for (const route of reportingRouteList) {
    assert.equal(sellers.has(route.id), false, route.id);
    assert.equal(route.method, 'GET', route.id);
    assert.equal(route.auth, 'api_key', route.id);
    assert.match(route.path, /^\/businesses\/:id\//, route.id);
  }
  assert.equal(reportingRouteList.find((r) => r.id === 'reporting.events').refused, 'forbidden');
  assert.ok(platformRouteList.find((r) => r.id === 'platform.accountHealthList'));
});

test('an outside address is checked in linear time', () => {
  const { RecipientAdd } = contract;
  assert.equal(RecipientAdd.safeParse({ email: 'accounts@example.com' }).success, true);
  for (const bad of ['no-at-sign', 'two@@example.com', '@example.com', 'a@b', 'a@b.', 'a b@example.com', `a@${'.'.repeat(100)} `]) assert.equal(RecipientAdd.safeParse({ email: bad }).success, false, bad);
  const started = Date.now();
  assert.equal(RecipientAdd.safeParse({ email: `a@${'.a'.repeat(100_000)} ` }).success, false);
  assert.ok(Date.now() - started < 200, 'a long address does not stall the check');
});

test('a custom range is checked, and downloads need what they describe', () => {
  assert.equal(RangeQuery.safeParse({ range: 'custom' }).success, false);
  assert.equal(RangeQuery.safeParse({ range: 'custom', from: '2026-02-01', to: '2026-01-01' }).success, false);
  assert.equal(RangeQuery.safeParse({ range: 'custom', from: '2024-01-01', to: '2026-11-01' }).success, false, 'past 25 months');
  assert.equal(RangeQuery.parse({}).range, '28');
  assert.equal(DownloadCreate.safeParse({ source: 'explore' }).success, false);
  assert.equal(DownloadCreate.safeParse({ source: 'media' }).success, true);
});

test('tag settings and the beacon can\'t carry something they should not', () => {
  assert.equal(TagSettingsUpdate.safeParse({ meta: { pixelId: 'abc' } }).success, false);
  assert.equal(TagSettingsUpdate.safeParse({ ga4: { measurementId: 'UA-1' } }).success, false);
  const beacon = TrafficBeacon.parse({ name: 'page_view', path: '/r/x' });
  assert.equal('ip' in beacon || 'userAgent' in beacon, false);
  assert.equal(TrafficBeacon.safeParse({ name: 'made_up', path: '/' }).success, false);
  for (const value of [...Object.values(TRAFFIC_PATHS), VISITOR_COOKIE]) assert.doesNotMatch(value, /bhava/i, value);
});

test('analytics catalogues hold together: labels, stores, and no impressions', () => {
  for (const [name, metric] of Object.entries(EXPLORE_METRICS)) {
    assert.ok(SOURCE_LABEL_CODES.includes(metric.source), name);
    if (metric.rate) continue;
    assert.ok(Object.hasOwn(ROLLUP_STORES[metric.store].measures, metric.measure), name);
  }
  for (const list of [META_METRICS.accountDaily, META_METRICS.feed, META_METRICS.carousel, META_METRICS.reel, META_METRICS.story]) assert.equal(list.includes('impressions'), false);
  assert.equal(META_METRICS.accountDaily.includes('profile_views') || META_METRICS.accountDaily.includes('website_clicks'), false);
  assert.equal(EXPLORE_METRICS.ig_reach.source, 'platform');
  assert.equal(EXPLORE_METRICS.sessions.source, 'bhava');
  assert.equal(ANALYTICS_LIMITS.lowVolumeDenominator, 20);
  assert.equal(FUNNEL_MEASUREMENT.amazon.one_tap, null, 'never estimated');
  assert.equal(FUNNEL_MEASUREMENT.bhava_page.two_tap.source, 'bhava');
});

test('revenue access: owner, manager, or staff with orders, and analytics alone is not enough', () => {
  assert.equal(canSeeRevenue({ role: 'owner' }), true);
  assert.equal(canSeeRevenue({ role: 'manager' }), true);
  assert.equal(canSeeRevenue({ role: 'staff', permissions: ['analytics'] }), false);
  assert.equal(canSeeRevenue({ role: 'staff', permissions: ['analytics', 'orders'] }), true);
  assert.equal(canSeeRevenue(null), false);
});

test('until shopper consent is built, consent is always no, and needs a business (for N-67)', async () => {
  const { createConsent, CONSENT_NOT_ASKED } = await import('../../../src/platform/consent.js');
  const { tenant } = await setup();
  const consent = createConsent();
  await assert.rejects(() => consent.analyticsAndAds({ visitorId: 'v' }), /tenant context/);
  const answer = await withTenant(tenant, () => consent.analyticsAndAds({ visitorId: 'v' }));
  assert.equal(answer.granted, false);
  assert.equal(answer, CONSENT_NOT_ASKED);
});

test('geography is empty until a provider is chosen, and a table can stand in for one', async () => {
  const { createGeo } = await import('../../../src/platform/geo.js');
  assert.deepEqual(createGeo({}).lookup('203.0.113.9'), { city: '', state: '' });
  assert.deepEqual(createGeo({ geoTable: { '203.0.113.9': { city: 'Pune', state: 'Maharashtra' } } }).lookup('203.0.113.9'), { city: 'Pune', state: 'Maharashtra' });
});

test('every module folder is tracked by git, not hidden by an ignore rule', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const name of ['insights', 'reach-guard', 'traffic', 'reports']) {
    assert.throws(() => execFileSync('git', ['check-ignore', '-q', `src/modules/${name}/index.js`], { cwd: repoRoot }), undefined, `${name} is ignored`);
  }
});

test('Reach Guard has no way to send: its module never touches a send path', () => {
  const folder = path.join(repoRoot, 'src/modules/reach-guard');
  for (const file of fs.readdirSync(folder)) {
    assert.doesNotMatch(fs.readFileSync(path.join(folder, file), 'utf8'), /\.sender\(|sendMessage|sendPrivateReply|\.enqueue\(|compliance\.send\(/, file);
  }
});
