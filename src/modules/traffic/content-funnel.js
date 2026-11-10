import { canSeeRevenue } from '../../contracts/api/index.js';
import { ANALYTICS_LIMITS as L, FIGURE_TEXT, FUNNEL_MEASUREMENT, FUNNEL_STAGES } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { countSession, loadDims, PAID_STATUSES, writeSession } from './sessions.js';
import { addDays, clockOf } from './time.js';

const SYNC_LOOKBACK_DAYS = 14;
const SYNC_ORDER_LOOKBACK_DAYS = 30;
const PAYMENT_BATCH = 500;
const NOT_AVAILABLE = FIGURE_TEXT.notAvailableForLink;
const NO_RECEIPTS = 'Not available: Instagram doesn’t report this yet.';
const KIND_OF_TARGET = { reel: 'reel', post: 'feed', story: 'story', any_story: 'story' };
const round4 = (value) => Number(value.toFixed(4));

/**
 * Keeps funnel_events in step with what happened: DMs sent, two-tap taps, paid orders. Each statement is safe to run again, because dedupe_key is what stops a
 * second copy (N-15). Only hashed subjects are copied here, and no username or message text ever is (N-19).
 */
export function createFunnelSync(ctx, tags, rollupService) {
  const { db, platform, config, repos } = ctx;
  const rollups = platform.analytics.rollups;
  const now = clockOf(config);

  const sinceDays = (days) => new Date(+now() - days * 86_400_000);

  async function syncDms(since) {
    await db.query(
      `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, dedupe_key, occurred_at)
       SELECT j.tenant_id, j.channel, j.media_id, '', 'dms', 'automation', 'bhava', j.subject_hash, 'job:' || j.id, COALESCE(j.sent_at, j.updated_at)
       FROM outbound_jobs j
       WHERE j.tenant_id = $1 AND j.media_id <> '' AND NOT j.is_test AND j.kind IN ('private_reply', 'dm') AND j.purpose = 'trigger'
         AND j.status IN ('sent', 'sent_fallback') AND COALESCE(j.sent_at, j.updated_at) >= $2::timestamptz
       ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
      [tenantId(), since],
    );
  }

  async function syncTaps(since) {
    await db.query(
      `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, dedupe_key, occurred_at)
       SELECT t.tenant_id, t.channel, t.media_id, '', 'taps_or_visits', 'two_tap', 'bhava', t.subject_hash, 'tap:' || t.automation_id || ':' || t.channel || ':' || t.media_id || ':' || t.subject_hash, t.first_tapped_at
       FROM link_taps t WHERE t.tenant_id = $1 AND NOT t.is_test AND t.media_id <> '' AND t.last_tapped_at >= $2::timestamptz
       ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
      [tenantId(), since],
    );
    // The same taps, as link events beside the page hits. They carry no session or visitor: a tap happens inside Instagram, before any page.
    await db.query(
      `INSERT INTO traffic_events (tenant_id, surface, name, media_id, at, event_key)
       SELECT t.tenant_id, 'link', 'link_tap', t.media_id, t.first_tapped_at, 'tap:' || t.automation_id || ':' || t.channel || ':' || t.media_id || ':' || t.subject_hash
       FROM link_taps t WHERE t.tenant_id = $1 AND NOT t.is_test AND t.media_id <> '' AND t.last_tapped_at >= $2::timestamptz
       ON CONFLICT (tenant_id, event_key) WHERE event_key <> '' DO NOTHING`,
      [tenantId(), since],
    );
  }

  /** Comments the engine set aside before anyone could answer them, which still count as comments received. */
  async function syncSetAsideComments(since) {
    await db.query(
      `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, dedupe_key, occurred_at)
       SELECT e.tenant_id, COALESCE(e.channel, 'instagram'), e.media_id, '', 'comments', 'automation', 'bhava', e.subject, 'comment:' || e.comment_id, e.created_at
       FROM compliance_events e WHERE e.tenant_id = $1 AND e.comment_id <> '' AND e.media_id <> '' AND e.reason IN ('negative_intent', 'optout') AND e.channel IN ('instagram', 'facebook') AND e.created_at >= $2::timestamptz
       ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
      [tenantId(), since],
    );
  }

  /** Paid orders go to the media of the last tagged visit within 7 days (7.4), or the reel the order was placed from when the visit is unknown. A cancelled one stops counting (N-18). */
  async function syncSales(since) {
    await db.query(
      `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, amount_paise, order_id, dedupe_key, occurred_at)
       SELECT o.tenant_id, 'instagram', COALESCE(v.media_id, o.reel_id), '', 'sales', 'bhava_store', 'bhava', o.total_paise, o.id, 'order:' || o.id, o.created_at
       FROM orders o
       LEFT JOIN traffic_events oe ON oe.tenant_id = o.tenant_id AND oe.order_id = o.id AND oe.name = 'order'
       LEFT JOIN LATERAL (
         SELECT e.media_id FROM traffic_events e
         WHERE e.tenant_id = o.tenant_id AND e.visitor_id = oe.visitor_id AND e.media_id <> '' AND e.name <> 'order' AND e.at <= oe.at AND e.at >= oe.at - make_interval(secs => $3::double precision / 1000)
         ORDER BY e.at DESC, e.id DESC LIMIT 1
       ) v ON true
       WHERE o.tenant_id = $1 AND o.status = ANY($4::text[]) AND o.updated_at >= $2::timestamptz AND COALESCE(v.media_id, o.reel_id) IS NOT NULL
       ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
      [tenantId(), since, L.orderAttributionWindowMs, PAID_STATUSES],
    );
    await db.query(
      `UPDATE funnel_events f SET voided_at = CASE WHEN o.status = ANY($2::text[]) THEN NULL ELSE COALESCE(f.voided_at, $3::timestamptz) END, amount_paise = o.total_paise
       FROM orders o WHERE f.tenant_id = $1 AND o.tenant_id = f.tenant_id AND o.id = f.order_id AND f.stage = 'sales' AND f.origin = 'bhava_store' AND o.updated_at >= $4::timestamptz`,
      [tenantId(), PAID_STATUSES, new Date(now()), since],
    );
  }

  /** The other side of a paid order: its session's counters and tags. An order placed through the app has a visit; an older one is marked done, so it isn't looked at again. */
  async function syncPayments() {
    const since = sinceDays(SYNC_ORDER_LOOKBACK_DAYS);
    const rows = await db.query(
      `SELECT o.id, o.order_number, o.status, o.total_paise, o.user_id, o.status = ANY($2::text[]) AS paid, oe.session_id, oe.visitor_id, oe.at, pe.id AS pay_id
       FROM orders o
       LEFT JOIN traffic_events oe ON oe.tenant_id = o.tenant_id AND oe.order_id = o.id AND oe.name = 'order'
       LEFT JOIN traffic_events pe ON pe.tenant_id = o.tenant_id AND pe.event_key = 'payment_success:order-' || o.id
       WHERE o.tenant_id = $1 AND o.updated_at >= $3::timestamptz AND ((o.status = ANY($2::text[]) AND pe.id IS NULL) OR (NOT o.status = ANY($2::text[]) AND pe.id IS NOT NULL))
       LIMIT $4`,
      [tenantId(), PAID_STATUSES, since, PAYMENT_BATCH],
    );
    const days = new Set();
    for (const row of rows) {
      if (row.paid) await markPaid(row);
      else await db.query('DELETE FROM traffic_events WHERE tenant_id = $1 AND id = $2', [tenantId(), row.pay_id]);
      const dims = await recount(row.session_id);
      if (dims) days.add(dims.day);
    }
    // A sale can change a day long after it has stopped moving by itself.
    for (const day of days) await rollupService.rebuildItems(day);
    return rows.length;
  }

  async function markPaid(row) {
    const at = new Date(now());
    const inserted = await db.query(
      `INSERT INTO traffic_events (tenant_id, session_id, visitor_id, at, name, page_kind, order_id, value_paise, event_key) VALUES ($1, $2, $3, $4::timestamptz, 'payment_success', 'checkout', $5, $6, $7)
       ON CONFLICT (tenant_id, event_key) WHERE event_key <> '' DO NOTHING RETURNING id`,
      [tenantId(), row.session_id, row.visitor_id, at, row.id, row.total_paise, `payment_success:order-${row.id}`],
    );
    if (!inserted.length) return;
    const user = row.user_id ? await repos.users.get(row.user_id) : null;
    await tags.onPurchase({ orderId: row.id, orderNumber: row.order_number, totalPaise: row.total_paise, at, visitorId: row.visitor_id, sessionId: row.session_id, user });
  }

  async function recount(sessionId) {
    if (!sessionId) return null;
    const found = await loadDims(db, sessionId);
    if (!found) return null;
    await writeSession(rollups, sessionId, found.dims, await countSession(db, sessionId));
    return found.dims;
  }

  async function run() {
    const since = sinceDays(SYNC_LOOKBACK_DAYS);
    await syncDms(since);
    await syncTaps(since);
    await syncSetAsideComments(since);
    await syncSales(sinceDays(SYNC_ORDER_LOOKBACK_DAYS));
    await syncPayments();
  }

  /** A comment or a read receipt, as the compliance worker sees it. Testers are never counted. */
  async function onInbound(event) {
    if (event.type === 'comment' && event.mediaId) {
      if (await repos.testers?.isTester?.(event.channel, event.subject)) return false;
      await db.query(
        `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, dedupe_key, occurred_at)
         VALUES ($1, $2, $3, '', 'comments', 'automation', 'bhava', $4, $5, $6::timestamptz) ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
        [tenantId(), event.channel, String(event.mediaId), event.subject ?? '', `comment:${event.commentId}`, event.receivedAt ?? new Date(now())],
      );
    }
    if (event.type === 'seen' && event.mid) {
      await db.query(
        `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, dedupe_key, occurred_at)
         SELECT j.tenant_id, j.channel, j.media_id, '', 'seen', 'automation', 'bhava', j.subject_hash, 'seen:' || j.id, $3::timestamptz
         FROM outbound_jobs j WHERE j.tenant_id = $1 AND j.message_id = $2 AND j.media_id <> '' AND NOT j.is_test AND j.purpose = 'trigger'
         ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
        [tenantId(), event.mid, event.receivedAt ?? new Date(now())],
      );
    }
    return false;
  }

  return { run, onInbound };
}

/** The funnel per reel, post and story (7.4), each step with its one source label and never a guess (7.15). */
export function createContentFunnels(ctx, sync) {
  const { db, repos, platform, config } = ctx;
  const rollups = platform.analytics.rollups;

  async function loadLink(mediaId) {
    const [row] = await db.query(
      `SELECT a.link_type, a.link_mode, t.target_type, t.channel FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id
       WHERE t.tenant_id = $1 AND t.media_id = $2 ORDER BY t.active DESC, t.id DESC LIMIT 1`,
      [tenantId(), mediaId],
    );
    return row ?? null;
  }

  async function platformFigures(mediaId, media) {
    const today = new Date().toISOString().slice(0, 10);
    let figures = { reach: null, views: null };
    if (media?.latest) figures = { reach: numberOrNull(media.latest.reach), views: numberOrNull(media.latest.views) };
    if (figures.reach === null && figures.views === null) {
      const [row] = await rollups.read('meta_content_daily', { measures: ['reach', 'views'], filters: [{ dimension: 'media_id', op: 'include', values: [mediaId] }], since: addDays(today, -L.mediaHistoryDays), until: today });
      if (row) figures = { reach: row.reach, views: row.views };
    }
    return { ...figures, source: 'platform', lastUpdatedAt: media?.latest_at ?? null };
  }

  const originRow = (origin, count, amountPaise, source) => ({ origin, count, amountPaise, source });

  function buildSteps({ rows, figures, link, connected, canSeeSales, canSeeMoney, readReceipts }) {
    const stageRows = (stage) => rows.filter((r) => r.stage === stage);
    const total = (stage) => stageRows(stage).reduce((sum, r) => sum + r.n, 0);
    const counted = (stage) => ({ stage, count: total(stage), amountPaise: null, source: 'bhava', state: 'ok', reason: null, origins: stageRows(stage).map((r) => originRow(r.origin, r.n, 0, r.source_label)) });
    const notAvailable = (stage, reason) => ({ stage, count: null, amountPaise: null, source: null, state: 'not_available', reason, origins: [] });

    function seenStep() {
      if (!readReceipts && total('seen') === 0) return notAvailable('seen', NO_RECEIPTS);
      return counted('seen');
    }

    function tapsStep() {
      const taps = stageRows('taps_or_visits');
      const origins = [...taps.map((r) => originRow(r.origin, r.n, 0, r.source_label))];
      const utm = figures.filter((f) => ['ga4', 'site_tag'].includes(f.source) && f.visits !== null);
      if (utm.length) origins.push(originRow('utm', utm.reduce((sum, f) => sum + Number(f.visits), 0), 0, 'destination'));
      const countOf = (origin) => origins.find((o) => o.origin === origin)?.count ?? 0;
      if (!link) {
        if (!origins.length) return { ...notAvailable('taps_or_visits', NOT_AVAILABLE), state: 'ok', reason: null, count: 0, source: 'bhava' };
        const headline = origins.find((o) => o.origin === 'two_tap') ?? origins.find((o) => o.origin === 'bhava_page') ?? origins[0];
        return { stage: 'taps_or_visits', count: headline.count, amountPaise: null, source: headline.source, state: 'ok', reason: null, origins };
      }
      const cell = FUNNEL_MEASUREMENT[link.link_type]?.[link.link_mode] ?? null;
      if (!cell || (cell.when && !cell.when.some((source) => connected.has(source)) && !utm.length)) return { ...notAvailable('taps_or_visits', NOT_AVAILABLE), origins };
      return { stage: 'taps_or_visits', count: countOf(cell.origin), amountPaise: null, source: cell.source, state: 'ok', reason: null, origins };
    }

    function salesStep() {
      if (!canSeeMoney) return notAvailable('sales', FIGURE_TEXT.ownerOnly);
      const own = stageRows('sales').filter((r) => r.origin === 'bhava_store');
      const ownOrigins = canSeeSales ? own.map((r) => originRow('bhava_store', r.n, r.amount, 'bhava')) : [];
      const destination = figures.filter((f) => ['shopify', 'amazon', 'affiliate', 'discount_code'].includes(f.source));
      const destinationOrigins = destination.map((f) => originRow(f.source, Number(f.orders ?? 0), Number(f.earnings ?? 0), 'destination'));
      const origins = [...ownOrigins, ...destinationOrigins];
      const allowed = link ? FUNNEL_MEASUREMENT[link.link_type]?.sales ?? [] : [...new Set(origins.map((o) => o.origin))];
      const shown = origins.filter((o) => allowed.includes(o.origin));
      const hasOwn = allowed.includes('bhava_store');
      if (hasOwn && !canSeeSales) return notAvailable('sales', FIGURE_TEXT.needsTier3);
      if (!hasOwn && !shown.length && !allowed.some((source) => connected.has(source))) return { ...notAvailable('sales', NOT_AVAILABLE), origins };
      const labels = new Set(shown.map((o) => o.source));
      if (labels.size > 1) return { stage: 'sales', count: null, amountPaise: null, source: null, state: 'ok', reason: null, origins }; // never summed across sources
      const onlyEarnings = shown.length > 0 && shown.every((o) => ['amazon', 'affiliate'].includes(o.origin));
      return {
        stage: 'sales', count: onlyEarnings ? null : shown.reduce((sum, o) => sum + o.count, 0), amountPaise: shown.reduce((sum, o) => sum + o.amountPaise, 0),
        source: hasOwn ? 'bhava' : 'destination', state: 'ok', reason: null, origins,
      };
    }

    const steps = { comments: counted('comments'), dms: counted('dms'), seen: seenStep(), taps_or_visits: tapsStep(), sales: salesStep() };
    let before = null;
    return FUNNEL_STAGES.map((stage) => {
      const step = steps[stage];
      let rate = null;
      let lowVolume = false;
      if (before !== null && step.count !== null) {
        if (before < L.lowVolumeDenominator) lowVolume = true;
        else rate = before === 0 ? null : round4(step.count / before);
      }
      if (step.count !== null) before = step.count;
      return { ...step, rate, lowVolume };
    });
  }

  async function funnel(mediaId, { canSeeSales, canSeeMoney }) {
    const tid = tenantId();
    const rows = (await db.query(
      `SELECT stage, origin, source_label, count(*) FILTER (WHERE voided_at IS NULL)::int AS n, COALESCE(sum(amount_paise) FILTER (WHERE voided_at IS NULL), 0)::bigint AS amount, max(occurred_at) AS last_at
       FROM funnel_events WHERE tenant_id = $1 AND media_id = $2 GROUP BY stage, origin, source_label`,
      [tid, mediaId],
    )).map((r) => ({ ...r, amount: Number(r.amount) }));
    const figures = await db.query(
      `SELECT source, sum(visits)::bigint AS visits, sum(orders)::bigint AS orders, sum(earnings_paise)::bigint AS earnings, max(fetched_at) AS last_at FROM destination_figures WHERE tenant_id = $1 AND media_id = $2 GROUP BY source`,
      [tid, mediaId],
    );
    const link = await loadLink(mediaId);
    if (!rows.length && !figures.length && !link) return null;
    const connected = new Set((await db.query('SELECT source FROM destination_connections WHERE tenant_id = $1 AND enabled', [tid])).map((r) => r.source));
    const [media] = await db.query('SELECT kind, latest, latest_at FROM insight_media WHERE tenant_id = $1 AND media_id = $2 ORDER BY id DESC LIMIT 1', [tid, mediaId]);
    const steps = buildSteps({ rows, figures, link, connected, canSeeSales, canSeeMoney, readReceipts: Boolean(config.readReceipts) });
    const lastAt = [...rows.map((r) => r.last_at), ...figures.map((f) => f.last_at)].filter(Boolean).map((at) => +new Date(at));
    return {
      mediaId,
      kind: media?.kind ?? KIND_OF_TARGET[link?.target_type] ?? 'reel',
      channel: link?.channel ?? (await channelFromEvents(mediaId)),
      linkType: link?.link_type ?? null,
      linkMode: link?.link_mode ?? null,
      steps,
      platform: await platformFigures(mediaId, media),
      lastUpdatedAt: lastAt.length ? new Date(Math.max(...lastAt)) : null,
    };
  }

  async function channelFromEvents(mediaId) {
    const [row] = await db.query('SELECT channel FROM funnel_events WHERE tenant_id = $1 AND media_id = $2 LIMIT 1', [tenantId(), mediaId]);
    return row?.channel ?? 'instagram';
  }

  async function one(mediaId, user) {
    await sync.run();
    return funnel(mediaId, { canSeeSales: await repos.entitlements.can('funnel.sales'), canSeeMoney: canSeeRevenue(user) });
  }

  async function list({ cursor, limit, kind }, user) {
    await sync.run();
    const canSeeSales = await repos.entitlements.can('funnel.sales');
    const tid = tenantId();
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && typeof key[0] === 'string' && key[0].length <= 80)[0] : null;
    const rows = await db.query(
      `SELECT media_id FROM (SELECT media_id FROM funnel_events WHERE tenant_id = $1 UNION SELECT media_id FROM automation_triggers WHERE tenant_id = $1 AND media_id <> '' UNION SELECT media_id FROM destination_figures WHERE tenant_id = $1 AND media_id <> '') m
       WHERE media_id <> '' AND ($2::text IS NULL OR media_id < $2) ORDER BY media_id DESC LIMIT $3`,
      [tid, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (row) => [row.media_id]);
    const items = [];
    for (const { media_id: mediaId } of page.items) {
      const item = await funnel(mediaId, { canSeeSales, canSeeMoney: canSeeRevenue(user) });
      if (item && (kind === 'all' || item.kind === kind)) items.push(item);
    }
    return { items, nextCursor: page.nextCursor };
  }

  return { one, list };
}

const numberOrNull = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
