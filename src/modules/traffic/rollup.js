import { ROLLUP_STORES, FUNNEL_MEASUREMENT } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';
import { decodeDims, DIMS_LIKE, PAID_STATUSES } from './sessions.js';
import { addDays, clockOf, dayStart, localParts, timeZoneOf } from './time.js';

const PAGE = 10_000;
const MAX_PAGES = 50;
const RECENT_DAYS = 95;
const STILL_MOVING_DAYS = 2;
const CHECKED = ['sessions', 'page_views', 'landing_views', 'product_views', 'product_taps', 'add_to_cart', 'orders', 'revenue_paise'];
const SESSION_DIMS = ['hour', 'weekday', 'source', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'media_id', 'landing_page', 'device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type'];

/** Reads every group of a rollup, a page at a time. */
export async function readAll(rollups, store, query) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const chunk = await rollups.read(store, { ...query, limit: PAGE, offset: page * PAGE });
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

function mapByDay(rows) {
  return new Map(rows.map((row) => [row.day, row]));
}

/** The summaries, kept in step with what they summarise. A rollup is only ever rebuilt for a day that has rows to rebuild it from, so a day past raw retention is never emptied. */
export function createRollups(ctx) {
  const { db, platform, config } = ctx;
  const rollups = platform.analytics.rollups;
  const now = clockOf(config);

  async function rebuildTrafficDay(day) {
    const measures = ['sessions', 'bounces', ...ROLLUP_STORES.traffic_daily.columns.filter((c) => c !== 'sessions' && c !== 'bounces')];
    const rows = await readAll(rollups, 'traffic_sessions', { measures, dimensions: ['day', ...SESSION_DIMS], since: day, until: day });
    await rollups.rebuild('traffic_daily', { since: day, until: day }, rows);
  }

  /** Any day in the range whose sessions and daily summary disagree is rebuilt, so a page never shows a stale total. */
  async function ensureTrafficDaily({ since, until }) {
    const today = localParts(new Date(now()), await timeZoneOf(db)).day;
    const from = since > addDays(today, -RECENT_DAYS) ? since : addDays(today, -RECENT_DAYS);
    if (from > until) return;
    const query = { measures: CHECKED, dimensions: ['day'], since: from, until };
    const [sessions, daily] = [await readAll(rollups, 'traffic_sessions', query), await readAll(rollups, 'traffic_daily', query)];
    const summarised = mapByDay(daily);
    for (const row of sessions) {
      const have = summarised.get(row.day);
      if (!have || CHECKED.some((m) => Number(have[m] ?? 0) !== Number(row[m] ?? 0))) await rebuildTrafficDay(row.day);
    }
  }

  async function rebuildItemsDay(day, timeZone) {
    const tid = tenantId();
    const from = dayStart(day, timeZone);
    const to = dayStart(addDays(day, 1), timeZone);
    const [events, dimsRows, sold] = [
      await db.query(
        `SELECT session_id, name, page_kind, page_ref FROM traffic_events WHERE tenant_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz AND session_id IS NOT NULL
           AND name IN ('page_view', 'landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_tap', 'whatsapp_tap', 'add_to_cart', 'checkout_started')`,
        [tid, from, to],
      ),
      await db.query(`SELECT session_id, outbound_host FROM traffic_events WHERE tenant_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz AND outbound_host LIKE $4`, [tid, from, to, DIMS_LIKE]),
      await db.query(
        `SELECT e.session_id, p.slug, i.qty, i.price_paise FROM traffic_events e
         JOIN orders o ON o.tenant_id = e.tenant_id AND o.id = e.order_id AND o.status = ANY($4::text[])
         JOIN order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
         LEFT JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
         WHERE e.tenant_id = $1 AND e.name = 'order' AND e.at >= $2::timestamptz AND e.at < $3::timestamptz AND e.session_id IS NOT NULL`,
        [tid, from, to, PAID_STATUSES],
      ),
    ];
    const dimsOf = new Map(dimsRows.map((row) => [row.session_id, decodeDims(row.outbound_host)]));
    const perSession = new Map();
    const touch = (sessionId, kind, ref) => {
      const key = `${sessionId}|${kind}|${ref}`;
      if (!perSession.has(key)) perSession.set(key, { sessionId, kind, ref, page: 0, specific: 0, taps: 0, outbound_taps: 0, whatsapp_taps: 0, add_to_cart: 0, checkout_started: 0, orders: 0, revenue_paise: 0 });
      return perSession.get(key);
    };
    const SPECIFIC = { landing_view: 'landing', category_view: 'category', product_view: 'product' };
    for (const e of events) {
      if (e.name === 'page_view') touch(e.session_id, e.page_kind, e.page_ref).page += 1;
      else if (Object.hasOwn(SPECIFIC, e.name)) touch(e.session_id, SPECIFIC[e.name], e.page_ref).specific += 1;
      else if (e.name === 'product_tap') touch(e.session_id, 'product', e.page_ref).taps += 1;
      else if (e.name === 'add_to_cart') touch(e.session_id, 'product', e.page_ref).add_to_cart += 1;
      else if (e.name === 'checkout_started') touch(e.session_id, 'checkout', '').checkout_started += 1;
      else touch(e.session_id, e.page_kind, e.page_ref)[e.name === 'outbound_tap' ? 'outbound_taps' : 'whatsapp_taps'] += 1;
    }
    for (const s of sold) {
      const item = touch(s.session_id, 'product', s.slug ?? '');
      item.orders += 1;
      item.revenue_paise += Number(s.price_paise) * Number(s.qty);
    }

    const grouped = new Map();
    for (const item of perSession.values()) {
      const dims = dimsOf.get(item.sessionId);
      if (!dims) continue;
      const dimensions = { day, item_kind: item.kind, item_ref: item.ref, ...Object.fromEntries(SESSION_DIMS.map((d) => [d, dims[d] ?? (d === 'hour' || d === 'weekday' ? 0 : '')])) };
      const key = JSON.stringify(dimensions);
      const row = grouped.get(key) ?? { ...dimensions, sessions: 0, views: 0, taps: 0, outbound_taps: 0, whatsapp_taps: 0, add_to_cart: 0, checkout_started: 0, orders: 0, revenue_paise: 0 };
      row.sessions += 1;
      row.views += Math.max(item.page, item.specific);
      for (const c of ['taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'orders', 'revenue_paise']) row[c] += item[c];
      grouped.set(key, row);
    }
    if (grouped.size) await rollups.rebuild('traffic_items_daily', { since: day, until: day }, [...grouped.values()]);
  }

  /** Per item, from the events: the only rollup needing a recount of events rather than of sessions. Only the last days move; an older day is built once, if it never was. */
  async function ensureItems({ since, until }) {
    const timeZone = await timeZoneOf(db);
    const today = localParts(new Date(now()), timeZone).day;
    const first = since > addDays(today, -RECENT_DAYS) ? since : addDays(today, -RECENT_DAYS);
    if (first > until) return;
    const days = { measures: ['sessions'], dimensions: ['day'], since: first, until };
    const [sessionDays, itemDays] = [await readAll(rollups, 'traffic_sessions', days), await readAll(rollups, 'traffic_items_daily', days)];
    const built = new Set(itemDays.map((row) => row.day));
    const stillMoving = addDays(today, -STILL_MOVING_DAYS);
    for (const { day } of sessionDays) if (!built.has(day) || day >= stillMoving) await rebuildItemsDay(day, timeZone);
  }

  async function funnelRowsFor({ since, until }, timeZone) {
    const tid = tenantId();
    const from = dayStart(since, timeZone);
    const to = dayStart(addDays(until, 1), timeZone);
    const linkOf = `(SELECT a.link_type || '|' || a.link_mode FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id WHERE t.tenant_id = f.tenant_id AND t.media_id = f.media_id AND t.active LIMIT 1)`;
    const [events, jobs] = [
      await db.query(
        `SELECT f.channel, f.media_id, f.content_kind, f.stage, f.origin, f.source_label, f.amount_paise, f.occurred_at, ${linkOf} AS link
         FROM funnel_events f WHERE f.tenant_id = $1 AND f.occurred_at >= $2::timestamptz AND f.occurred_at < $3::timestamptz AND f.voided_at IS NULL`,
        [tid, from, to],
      ),
      await db.query(
        `SELECT channel, media_id, status, reason, created_at FROM outbound_jobs
         WHERE tenant_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz AND media_id <> '' AND NOT is_test AND kind IN ('private_reply', 'dm') AND purpose = 'trigger'`,
        [tid, from, to],
      ),
    ];
    const blank = { comments: 0, dms_queued: 0, dms_sent: 0, dms_failed: 0, dms_paced: 0, seen: 0, taps: 0, visits: 0, orders: 0, revenue_paise: 0, earnings_paise: 0 };
    const rows = new Map();
    const rowFor = (dimensions) => {
      const key = JSON.stringify(dimensions);
      if (!rows.has(key)) rows.set(key, { ...dimensions, ...blank });
      return rows.get(key);
    };
    for (const e of events) {
      const [linkType = '', linkMode = ''] = (e.link ?? '').split('|');
      const row = rowFor({ day: localParts(new Date(e.occurred_at), timeZone).day, channel: e.channel, media_id: e.media_id, content_kind: e.content_kind, link_type: linkType, link_mode: linkMode, origin: e.origin, source_label: e.source_label });
      if (e.stage === 'comments') row.comments += 1;
      else if (e.stage === 'dms') row.dms_sent += 1;
      else if (e.stage === 'seen') row.seen += 1;
      else if (e.stage === 'taps_or_visits') {
        if (e.origin !== 'two_tap') row.visits += 1;
        if (countsAsHeadline(linkType, linkMode, e.origin)) row.taps += 1;
      } else if (e.stage === 'sales') {
        if (e.origin === 'bhava_store' || e.origin === 'shopify' || e.origin === 'discount_code') {
          row.orders += 1;
          row.revenue_paise += Number(e.amount_paise);
        } else row.earnings_paise += Number(e.amount_paise);
      }
    }
    for (const job of jobs) {
      const row = rowFor({ day: localParts(new Date(job.created_at), timeZone).day, channel: job.channel, media_id: job.media_id, content_kind: '', link_type: '', link_mode: '', origin: 'automation', source_label: 'bhava' });
      if (job.status === 'queued' || job.status === 'sending') row.dms_queued += 1;
      else if (job.status === 'failed') row.dms_failed += 1;
      else if (job.status === 'held' && String(job.reason).startsWith('rate.')) row.dms_paced += 1;
    }
    return [...rows.values()];
  }

  /** funnel_daily comes from funnel_events, and is never rebuilt for a day with nothing to build it from. Only the last days move; the rest are built the first time they are asked for. */
  async function ensureFunnelDaily({ since, until }) {
    const timeZone = await timeZoneOf(db);
    const moving = addDays(localParts(new Date(now()), timeZone).day, -STILL_MOVING_DAYS);
    const existing = await readAll(rollups, 'funnel_daily', { measures: ['comments'], dimensions: ['day'], since, until });
    const from = existing.length && since < moving ? moving : since;
    if (from > until) return;
    const rows = await funnelRowsFor({ since: from, until }, timeZone);
    for (const [day, dayRows] of Map.groupBy(rows, (row) => row.day)) await rollups.rebuild('funnel_daily', { since: day, until: day }, dayRows);
  }

  return { ensureTrafficDaily, ensureItems, ensureFunnelDaily, rebuildItems: async (day) => rebuildItemsDay(day, await timeZoneOf(db)), today: async () => localParts(new Date(now()), await timeZoneOf(db)).day };
}

/** Whether this origin is the figure 7.15 shows in "Taps or visits" for this link. A two-tap link's visits are extra detail and not added to its taps. */
function countsAsHeadline(linkType, linkMode, origin) {
  if (!linkType) return true;
  return FUNNEL_MEASUREMENT[linkType]?.[linkMode]?.origin === origin;
}
