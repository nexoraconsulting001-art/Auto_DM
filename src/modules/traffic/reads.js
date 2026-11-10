import { ANALYTICS_LIMITS as L, PAGE_KINDS, TRAFFIC_SOURCES } from '../../contracts/analytics.js';
import { canSeeRevenue } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { readAll } from './rollup.js';
import { DIMS_LIKE } from './sessions.js';
import { addDays, clockOf, daysBetween, rangeOf, timeZoneOf } from './time.js';

const SUMMARY_FIELDS = { sessions: 'sessions', visitors: 'visitors', page_views: 'pageViews', product_taps: 'productTaps', outbound_taps: 'outboundTaps', whatsapp_taps: 'whatsappTaps', add_to_cart: 'addToCart', checkout_started: 'checkoutStarted', orders: 'orders', revenue_paise: 'revenuePaise', bounce_rate: 'bounceRate', median_engaged_ms: 'medianEngagedMs' };
const BLANK_DELTA = Object.freeze({ value: null, previous: null, change: null, changePercent: null });

const asSource = (value) => (TRAFFIC_SOURCES.includes(value) ? value : value ? 'other_referrer' : 'direct');
const count = (value) => Math.max(0, Math.trunc(Number(value ?? 0)));
const toDelta = (cell) => (cell ? { value: cell.value, previous: cell.previous, change: cell.change, changePercent: cell.changePercent } : BLANK_DELTA);

/** The fixed traffic screens (7.10). Each is a named question on the same engine as Explore, so the totals always agree (N-51). Aggregates only: nothing here can name a visitor. */
export function createTrafficReads(ctx, explore, rollupService) {
  const { db, platform, config, repos } = ctx;
  const rollups = platform.analytics.rollups;
  const now = clockOf(config);

  /** A slug that is not one of this business's pages finds nothing, and the attempt is logged with ids only (N-49). */
  async function noteForeignPage(page, route, user) {
    if (!page) return;
    const [known] = await db.query('SELECT 1 FROM reels WHERE tenant_id = $1 AND slug = $2', [tenantId(), page]);
    if (!known) log.warn('traffic.page_not_found', { route, userId: user?.id ?? null, role: user?.role ?? null });
  }

  const pageFilter = (query) => (query.page ? [{ dimension: 'landing_page', op: 'include', values: [query.page, `/r/${query.page}`] }] : []);
  const base = (query) => ({ range: query.range, from: query.from, to: query.to, compare: query.compare ?? 'none', filters: pageFilter(query), dimensions: [], thresholds: [], limit: L.explorePageRows });

  async function previewsIn({ since, until }) {
    const [row] = await db.query('SELECT COALESCE(sum(n), 0)::bigint AS n FROM traffic_previews WHERE tenant_id = $1 AND day >= $2::date AND day <= $3::date', [tenantId(), since, until]);
    return Number(row.n);
  }

  async function lastHit() {
    const [row] = await db.query('SELECT max(at) AS at FROM traffic_events WHERE tenant_id = $1', [tenantId()]);
    return row.at ?? null;
  }

  async function summary(query, user) {
    await noteForeignPage(query.page, 'traffic.summary', user);
    const metrics = Object.keys(SUMMARY_FIELDS);
    const result = await explore.query({ ...base(query), metrics }, { user });
    const visitorsOf = async (type) => (await explore.query({ ...base(query), metrics: ['visitors'], filters: [...pageFilter(query), { dimension: 'visitor_type', op: 'include', values: [type] }] }, { user })).totals.visitors;
    const [newVisitors, returningVisitors] = [await visitorsOf('new'), await visitorsOf('returning')];
    const range = { since: result.from, until: result.to };
    const out = { source: 'bhava', newVisitors: toDelta(newVisitors), returningVisitors: toDelta(returningVisitors), previews: await previewsIn(range), notIncluded: result.hiddenMetrics.map((m) => SUMMARY_FIELDS[m]), lastUpdatedAt: await lastHit() };
    for (const [metric, field] of Object.entries(SUMMARY_FIELDS)) out[field] = toDelta(result.totals[metric]);
    return out;
  }

  async function sources(query, user) {
    await noteForeignPage(query.page, 'traffic.sources', user);
    const range = rangeOf(query, await rollupService.today());
    await rollupService.ensureTrafficDaily(range);
    const filters = query.page ? [{ dimension: 'landing_page', op: 'include', values: [query.page, `/r/${query.page}`] }] : [];
    const taps = await repos.entitlements.can('traffic.pages');
    const commerce = await repos.entitlements.can('traffic.commerce') && canSeeRevenue(user);
    const dimensions = ['source', 'referrer_domain'];
    const daily = await readAll(rollups, 'traffic_daily', { measures: ['sessions', 'product_taps', 'orders', 'revenue_paise'], dimensions, filters, since: range.since, until: range.until });
    const visitors = await readAll(rollups, 'traffic_sessions', { measures: ['visitors'], dimensions, filters, since: range.since, until: range.until });
    const visitorsOf = new Map(visitors.map((row) => [`${row.source}|${row.referrer_domain}`, row.visitors]));
    const items = daily.map((row) => ({
      source: asSource(row.source), referrerDomain: row.referrer_domain ?? '', sessions: count(row.sessions), visitors: count(visitorsOf.get(`${row.source}|${row.referrer_domain}`)),
      productTaps: taps ? count(row.product_taps) : null, orders: commerce ? count(row.orders) : null, revenuePaise: commerce ? count(row.revenue_paise) : null,
    }));
    return { items, label: 'bhava' };
  }

  async function trend(query, user) {
    await noteForeignPage(query.page, 'traffic.trend', user);
    const result = await explore.query({ ...base(query), metrics: ['sessions'], dimensions: ['date'] }, { user });
    const compare = query.compare === 'previous';
    const byDay = new Map(result.rows.map((row) => [row.dimensions.date, row.metrics.sessions]));
    const length = daysBetween(result.from, result.to) + 1;
    const points = Array.from({ length }, (_v, i) => {
      const day = addDays(result.from, i);
      const cell = byDay.get(day);
      return { day, sessions: count(cell?.value), previous: compare ? count(cell?.previous) : null };
    });
    return { points, label: 'bhava' };
  }

  async function heatmap(query, user) {
    await noteForeignPage(query.page, 'traffic.heatmap', user);
    const result = await explore.query({ ...base(query), compare: 'none', metrics: ['sessions'], dimensions: ['weekday', 'hour'] }, { user });
    return {
      timeZone: await timeZoneOf(db),
      cells: result.rows.map((row) => ({ weekday: Number(row.dimensions.weekday), hour: Number(row.dimensions.hour), sessions: count(row.metrics.sessions.value) })),
      label: 'bhava',
    };
  }

  async function titlesFor(rows) {
    const refsOf = (kind) => [...new Set(rows.filter((r) => r.item_kind === kind && r.item_ref).map((r) => r.item_ref))];
    const tid = tenantId();
    const titles = new Map();
    const collect = async (kind, sql) => {
      const refs = refsOf(kind);
      if (!refs.length) return;
      for (const row of await db.query(sql, [tid, refs])) titles.set(`${kind}|${row.slug}`, row.title);
    };
    await collect('landing', 'SELECT slug, headline AS title FROM reels WHERE tenant_id = $1 AND slug = ANY($2::text[])');
    await collect('product', 'SELECT slug, name AS title FROM products WHERE tenant_id = $1 AND slug = ANY($2::text[])');
    await collect('category', 'SELECT slug, name AS title FROM categories WHERE tenant_id = $1 AND slug = ANY($2::text[])');
    return titles;
  }

  async function pages(query, user) {
    await noteForeignPage(query.page, 'traffic.pages', user);
    if (!await repos.entitlements.can('traffic.pages')) return { items: [], label: 'bhava' };
    const range = rangeOf(query, await rollupService.today());
    await rollupService.ensureItems(range);
    const filters = [];
    if (query.kind !== 'all') filters.push({ dimension: 'item_kind', op: 'include', values: [query.kind] });
    if (query.page) filters.push({ dimension: 'landing_page', op: 'include', values: [query.page, `/r/${query.page}`] });
    const rows = await rollups.read('traffic_items_daily', { measures: ['views', 'sessions', 'taps'], dimensions: ['item_kind', 'item_ref'], filters, since: range.since, until: range.until, limit: 500 });
    const titles = await titlesFor(rows);
    return {
      items: rows.filter((row) => PAGE_KINDS.includes(row.item_kind)).map((row) => ({ kind: row.item_kind, ref: row.item_ref, title: titles.get(`${row.item_kind}|${row.item_ref}`) || row.item_ref, views: count(row.views), sessions: count(row.sessions), taps: count(row.taps) })),
      label: 'bhava',
    };
  }

  async function breakdown(query, user) {
    await noteForeignPage(query.page, 'traffic.breakdown', user);
    const result = await explore.query({ ...base(query), compare: 'none', metrics: ['sessions', 'orders'], dimensions: [query.by] }, { user });
    return {
      by: query.by,
      items: result.rows.map((row) => ({ key: row.dimensions[query.by], sessions: count(row.metrics.sessions.value), orders: row.metrics.orders ? count(row.metrics.orders.value) : null })),
      label: 'bhava',
    };
  }

  /** Who is on the seller's pages in the last 30 minutes (N-48). Read from the events, so a hit shows on the next refresh. */
  async function realtime() {
    const tid = tenantId();
    const at = new Date(now());
    const since = new Date(+at - L.realtimeWindowMs);
    const [{ active }] = await db.query(`SELECT count(DISTINCT COALESCE(visitor_id::text, session_id::text))::int AS active FROM traffic_events WHERE tenant_id = $1 AND at >= $2::timestamptz AND session_id IS NOT NULL`, [tid, since]);
    const pageRows = await db.query(
      `SELECT page_kind, page_ref, path, count(DISTINCT COALESCE(visitor_id::text, session_id::text))::int AS n FROM traffic_events
       WHERE tenant_id = $1 AND at >= $2::timestamptz AND session_id IS NOT NULL AND name = 'page_view' GROUP BY page_kind, page_ref, path ORDER BY n DESC, path LIMIT 10`,
      [tid, since],
    );
    const sourceRows = await db.query(
      `WITH live AS (SELECT DISTINCT session_id FROM traffic_events WHERE tenant_id = $1 AND at >= $2::timestamptz AND session_id IS NOT NULL)
       SELECT d.outbound_host::jsonb ->> 'source' AS source, count(*)::int AS n FROM live JOIN traffic_events d ON d.tenant_id = $1 AND d.session_id = live.session_id AND d.outbound_host LIKE $3
       GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      [tid, since, DIMS_LIKE],
    );
    const titles = await titlesFor(pageRows.map((row) => ({ item_kind: row.page_kind, item_ref: row.page_ref })));
    return {
      active,
      topPages: pageRows.map((row) => ({ ref: row.page_ref || row.path, title: titles.get(`${row.page_kind}|${row.page_ref}`) || row.page_ref || row.path, active: row.n })),
      topSources: sourceRows.map((row) => ({ source: asSource(row.source), active: row.n })),
      at,
    };
  }

  return { summary, sources, trend, heatmap, pages, breakdown, realtime };
}
