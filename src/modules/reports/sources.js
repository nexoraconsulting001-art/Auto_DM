import { ANALYTICS_LIMITS as L, FIGURE_TEXT, SOURCE_LABELS } from '../../contracts/analytics.js';
import { ApiError, canSeeRevenue } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { servicesFor as trafficServices } from '../traffic/services.js';
import { addDays, clockOf, localParts, localStamp, safeZone } from './clock.js';

/**
 * The summary tables a seller can download (7.9, 7.13). Each is built from the cache and the rollups, for the current business, and shows only what
 * the person asking may see: revenue and order counts need canSeeRevenue and the plan. There is no source that names a visitor, a shopper or an event.
 */
const ROLLUP_PAGE = 10_000;
const ALL_ROWS = Number.MAX_SAFE_INTEGER;
const PLATFORM = SOURCE_LABELS.platform;
const BHAVA = SOURCE_LABELS.bhava;

const KIND_LABELS = Object.freeze({ feed: 'Post', reel: 'Reel', carousel: 'Carousel', story: 'Story' });
const STEP_LABELS = Object.freeze({
  landing_view: 'Landing page view', category_view: 'Category view', product_view: 'Product view', product_tap: 'Product tap', outbound_click: 'Outbound link tap',
  whatsapp_tap: 'WhatsApp tap', add_to_cart: 'Add to cart', checkout_started: 'Checkout started', payment_success: 'Payment success', page_view: 'Page view',
});
/** Steps that are order counts, which only someone who may see revenue sees (7.11). */
const ORDER_STEPS = new Set(['payment_success']);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value) => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const notFound = (message) => new ApiError('not_found', message);

/** A figure from the cache: a number, "<5" where Meta withheld it, or blank where there is none. Never 0 in place of "we don't know". */
const figure = (latest, name, belowThreshold) => {
  const value = latest?.[name];
  if (isNumber(value)) return value;
  return belowThreshold ? FIGURE_TEXT.belowFive : null;
};

export function createSources(ctx) {
  const { db, repos, platform, config } = ctx;
  const now = () => clockOf(config)();
  const rollups = () => platform.analytics.rollups;
  const traffic = () => trafficServices(ctx);

  async function readAll(store, spec) {
    const rows = [];
    for (let offset = 0; ; offset += ROLLUP_PAGE) {
      const page = await rollups().read(store, { ...spec, limit: ROLLUP_PAGE, offset });
      rows.push(...page);
      if (page.length < ROLLUP_PAGE) return rows;
    }
  }

  async function zone() {
    const [row] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId()]);
    return safeZone(row?.timezone);
  }

  /** The days a fixed sheet covers: what was asked, inside what the plan lets this business see. */
  async function daysFor(def, defaultDays, timeZone) {
    const today = localParts(new Date(now()), timeZone).day;
    let since = def.from ?? addDays(today, 1 - defaultDays);
    const until = def.to ?? today;
    const limit = await repos.entitlements.limit('insights.days');
    if (Number.isFinite(limit)) {
      const floor = addDays(today, -limit);
      if (since < floor) since = floor;
    }
    return { since, until };
  }

  // ---- Explore, funnels and cohorts (7.11, 7.12) ----------------------------------------------------------------------

  async function explore(def, user, { allowRevenue = false } = {}) {
    const query = { ...def.query, page: '0', limit: ALL_ROWS };
    const result = await traffic().explore.query(query, { user, allowRevenue });
    const catalog = await traffic().explore.catalog(user ?? { role: 'owner' });
    const dimensionLabel = new Map(catalog.dimensions.map((d) => [d.name, d.label]));
    const comparing = Boolean(result.compareFrom);
    const dimensions = query.dimensions ?? [];
    const columns = dimensions.map((d) => ({ key: `d:${d}`, label: dimensionLabel.get(d) ?? d }));
    for (const column of result.columns) {
      const label = `${column.label} (${SOURCE_LABELS[column.source]})`;
      columns.push({ key: `m:${column.metric}`, label });
      if (comparing) {
        columns.push({ key: `p:${column.metric}`, label: `${column.label}, previous` });
        columns.push({ key: `c:${column.metric}`, label: `${column.label}, change %` });
      }
    }
    const cellOf = (cell) => (cell.lowVolume ? FIGURE_TEXT.lowVolume : cell.value);
    const rows = result.rows.map((row) => {
      const out = {};
      for (const d of dimensions) out[`d:${d}`] = row.dimensions[d] ?? '';
      for (const column of result.columns) {
        const cell = row.metrics[column.metric];
        out[`m:${column.metric}`] = cellOf(cell);
        if (comparing) {
          out[`p:${column.metric}`] = cell.previous;
          out[`c:${column.metric}`] = cell.changePercent;
        }
      }
      return out;
    });
    // A view with no breakdown is one row: its totals.
    if (!dimensions.length && !rows.length) {
      const out = {};
      for (const column of result.columns) out[`m:${column.metric}`] = cellOf(result.totals[column.metric]);
      rows.push(out);
    }
    return { table: { columns, rows }, period: { since: result.from, until: result.to }, name: 'explore' };
  }

  async function funnel(def, user) {
    const saved = await repos.customFunnels.get(def.funnelId);
    if (!saved) throw notFound('We couldn’t find that funnel.');
    const range = def.from && def.to ? { range: 'custom', from: def.from, to: def.to } : { range: '28' };
    const result = await traffic().funnelResults.results(def.funnelId, { ...range, compare: 'none' });
    if (!result) throw notFound('We couldn’t find that funnel.');
    const revenue = canSeeRevenue(user);
    const columns = [
      { key: 'n', label: 'Step' }, { key: 'kind', label: 'What happens' }, { key: 'page', label: 'Page' }, { key: 'count', label: `${result.countBy === 'visitor' ? 'Visitors' : 'Sessions'} (${BHAVA})` },
      { key: 'rate', label: 'Step rate' }, { key: 'drop', label: 'Drop-off' }, { key: 'note', label: 'Note' },
    ];
    const rows = result.steps.map((step, i) => {
      const hidden = ORDER_STEPS.has(step.kind) && !revenue;
      return {
        n: i + 1, kind: STEP_LABELS[step.kind] ?? step.kind, page: step.page ?? '',
        count: step.unavailable || hidden ? null : step.count, rate: hidden ? null : step.stepRate, drop: hidden ? null : step.dropOff,
        note: step.unavailable ? step.message ?? FIGURE_TEXT.needsTier3 : hidden ? FIGURE_TEXT.ownerOnly : '',
      };
    });
    return { table: { columns, rows }, name: saved.name };
  }

  async function cohort(def, user) {
    const result = await traffic().cohorts.get(def.cohort);
    const revenue = canSeeRevenue(user);
    const periods = Math.max(result.periods, ...result.cohorts.map((c) => c.rates.length), 0);
    const columns = [{ key: 'key', label: result.groupBy === 'first_source' ? 'First source' : 'Cohort' }, { key: 'size', label: `${result.kind === 'buyers' ? 'Buyers' : 'Visitors'} (${BHAVA})` }];
    for (let i = 0; i < periods; i++) columns.push({ key: `r${i}`, label: `Period ${i + 1} returning rate` });
    if (result.kind === 'buyers') {
      columns.push({ key: 'repeat', label: 'Repeat order rate' });
      if (revenue) columns.push({ key: 'rpb', label: 'Revenue per buyer (paise)' });
    }
    columns.push({ key: 'note', label: 'Note' });
    const rows = result.cohorts.map((c) => {
      const out = { key: c.key, size: c.size, note: c.lowVolume ? FIGURE_TEXT.lowVolume : '' };
      for (let i = 0; i < periods; i++) out[`r${i}`] = c.lowVolume ? null : c.rates[i] ?? null;
      if (result.kind === 'buyers') {
        out.repeat = c.lowVolume ? null : c.repeatOrderRate;
        if (revenue) out.rpb = c.lowVolume ? null : c.revenuePerBuyerPaise;
      }
      return out;
    });
    return { table: { columns, rows }, name: `cohorts-${result.kind}` };
  }

  // ---- the fixed sheets of 7.9 ---------------------------------------------------------------------------------------

  async function accounts() {
    return db.query(`SELECT id, channel, account_id FROM analytics_accounts WHERE tenant_id = $1 ORDER BY id`, [tenantId()]);
  }

  async function accountDaily(def) {
    const timeZone = await zone();
    const range = await daysFor(def, L.accountRetentionDays, timeZone);
    const known = await accounts();
    const channelOf = new Map(known.map((a) => [a.account_id, a.channel]));
    const measures = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts', 'follows', 'unfollows', 'profile_links_taps', 'followers_count'];
    const rows = known.length ? await readAll('meta_account_daily', { measures, dimensions: ['day', 'account_id'], ...range, orderBy: 'day', direction: 'asc' }) : [];
    const labels = { views: FIGURE_TEXT.viewsColumn, reach: 'Reach', accounts_engaged: 'Accounts engaged', total_interactions: 'Interactions', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', replies: 'Replies', reposts: 'Reposts', follows: 'Follows', unfollows: 'Unfollows', profile_links_taps: 'Profile link taps', followers_count: 'Followers' };
    const columns = [{ key: 'day', label: 'Day' }, { key: 'channel', label: 'Channel' }, ...measures.map((m) => ({ key: m, label: labels[m] })), { key: 'source', label: 'Source' }];
    const out = rows.filter((r) => channelOf.has(r.account_id)).map((r) => ({
      day: r.day, channel: channelOf.get(r.account_id) === 'facebook' ? 'Facebook' : 'Instagram',
      ...Object.fromEntries(measures.map((m) => [m, num(r[m])])), source: PLATFORM,
    }));
    return { table: { columns, rows: out }, name: 'account-daily' };
  }

  /** Posts, reels and carousels from the cache. A business on a plan that looks back a limited time sees only that far (5.20). */
  async function mediaRows(def, { stories }) {
    const timeZone = await zone();
    const limit = await repos.entitlements.limit('insights.days');
    const params = [tenantId()];
    const where = ['tenant_id = $1', stories ? `kind = 'story' AND story_final_state IN ('final', 'final_incomplete')` : `kind <> 'story'`];
    if (Number.isFinite(limit)) {
      params.push(new Date(now() - limit * 86_400_000));
      where.push(`COALESCE(posted_at, created_at) >= $${params.length}::timestamptz`);
    }
    const rows = await db.query(
      `SELECT media_id, kind, caption, posted_at, created_at, deleted_at, latest, latest_breakdowns, below_threshold, story_final_state, story_tracking
       FROM insight_media WHERE ${where.join(' AND ')} ORDER BY COALESCE(posted_at, created_at) DESC, id DESC`,
      params,
    );
    const inRange = (row) => {
      const day = localStamp(row.posted_at ?? row.created_at, timeZone).slice(0, 10);
      return (!def.from || day >= def.from) && (!def.to || day <= def.to);
    };
    return { rows: rows.filter(inRange), timeZone };
  }

  async function media(def) {
    const { rows, timeZone } = await mediaRows(def, { stories: false });
    const metrics = [['views', FIGURE_TEXT.viewsColumn], ['reach', 'Reach'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saved', 'Saves'], ['total_interactions', 'Interactions'], ['follows', 'Follows']];
    const columns = [{ key: 'id', label: 'Media ID' }, { key: 'kind', label: 'Type' }, { key: 'posted', label: 'Posted' }, { key: 'caption', label: 'Caption' }, ...metrics.map(([key, label]) => ({ key, label })), { key: 'status', label: 'Status' }, { key: 'source', label: 'Source' }];
    const out = rows.map((r) => ({
      id: r.media_id, kind: KIND_LABELS[r.kind] ?? r.kind, posted: localStamp(r.posted_at, timeZone), caption: r.caption ?? '',
      ...Object.fromEntries(metrics.map(([key]) => [key, figure(r.latest, key, r.below_threshold)])),
      status: r.deleted_at ? 'Deleted on Instagram' : '', source: PLATFORM,
    }));
    return { table: { columns, rows: out }, name: 'media' };
  }

  async function storyFinals(def) {
    const { rows, timeZone } = await mediaRows(def, { stories: true });
    const metrics = [['views', FIGURE_TEXT.viewsColumn], ['reach', 'Reach'], ['replies', 'Replies'], ['shares', 'Shares'], ['link_clicks', 'Link clicks'], ['follows', 'Follows'], ['total_interactions', 'Interactions']];
    const navigation = [['tap_forward', 'Taps forward'], ['tap_back', 'Taps back'], ['tap_exit', 'Exits'], ['swipe_forward', 'Swipes forward']];
    const columns = [{ key: 'id', label: 'Story ID' }, { key: 'posted', label: 'Posted' }, { key: 'state', label: 'Final figures' }, ...metrics.map(([key, label]) => ({ key, label })), ...navigation.map(([key, label]) => ({ key: `nav:${key}`, label })), { key: 'source', label: 'Source' }];
    const out = rows.map((r) => ({
      id: r.media_id, posted: localStamp(r.posted_at, timeZone), state: r.story_final_state === 'final' ? 'Final' : 'Final, some figures missing',
      ...Object.fromEntries(metrics.map(([key]) => [key, figure(r.latest, key, r.below_threshold)])),
      ...Object.fromEntries(navigation.map(([key]) => [`nav:${key}`, isNumber(r.latest_breakdowns?.navigation?.[key]) ? r.latest_breakdowns.navigation[key] : null])),
      source: PLATFORM,
    }));
    return { table: { columns, rows: out }, name: 'story-finals' };
  }

  /** Bhava's funnel per reel, post and story (7.4). Orders and revenue only with the plan and for someone who may see them. */
  async function contentFunnel(def, user) {
    const timeZone = await zone();
    const range = await daysFor(def, 90, timeZone);
    const money = canSeeRevenue(user) && (await repos.entitlements.can('funnel.sales'));
    const measures = ['comments', 'dms_sent', 'seen', 'taps', 'visits', ...(money ? ['orders', 'revenue_paise'] : [])];
    const rows = await readAll('funnel_daily', { measures, dimensions: ['media_id', 'content_kind'], ...range, orderBy: 'dms_sent', direction: 'desc' });
    const ids = [...new Set(rows.map((r) => r.media_id).filter(Boolean))];
    const captions = ids.length ? await db.query('SELECT media_id, caption FROM insight_media WHERE tenant_id = $1 AND media_id = ANY($2::text[])', [tenantId(), ids]) : [];
    const captionOf = new Map(captions.map((c) => [c.media_id, c.caption]));
    const labels = { comments: 'Comments', dms_sent: 'DMs sent', seen: 'Seen', taps: 'Taps or visits', visits: 'Visits to Bhava pages', orders: 'Orders', revenue_paise: 'Revenue (paise)' };
    const columns = [{ key: 'id', label: 'Media ID' }, { key: 'kind', label: 'Type' }, { key: 'caption', label: 'Caption' }, ...measures.map((m) => ({ key: m, label: labels[m] })), { key: 'source', label: 'Source' }];
    const out = rows.map((r) => ({
      id: r.media_id, kind: KIND_LABELS[r.content_kind] ?? r.content_kind, caption: captionOf.get(r.media_id) ?? '',
      ...Object.fromEntries(measures.map((m) => [m, num(r[m])])), source: BHAVA,
    }));
    return { table: { columns, rows: out }, name: 'content-funnel' };
  }

  async function healthHistory(def) {
    const timeZone = await zone();
    const range = await daysFor(def, L.healthHistoryDays, timeZone);
    const history = await repos.reachGuard.healthHistory(range.since, range.until);
    const bands = { good: 'Good', watch: 'Watch', at_risk: 'At risk' };
    const columns = [{ key: 'day', label: 'Day' }, { key: 'score', label: 'Score' }, { key: 'band', label: 'Band' }, { key: 'deductions', label: 'What lowered it' }];
    const rows = [...history.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, h]) => ({
      day, score: h.score, band: bands[h.band] ?? h.band,
      deductions: (h.deductions ?? []).map((d) => `${d.message || d.code}${isNumber(d.points) ? ` (${d.points})` : ''}`).join('; '),
    }));
    return { table: { columns, rows }, name: 'account-health' };
  }

  const BUILDERS = Object.freeze({
    explore, funnel, cohort, account_daily: accountDaily, media, story_finals: storyFinals, content_funnel: contentFunnel, health_history: healthHistory,
  });

  /** The table for one download. `def` is what was asked for, as stored on the download row. */
  async function build(source, def, user) {
    if (!Object.hasOwn(BUILDERS, source)) throw new ApiError('validation_failed', 'Choose what to download.');
    return BUILDERS[source](def, user);
  }

  return { build, explore };
}

export const sourceTitle = Object.freeze({
  explore: 'Explore view', funnel: 'Funnel', cohort: 'Cohorts', account_daily: 'Account daily figures', media: 'Posts and reels', story_finals: 'Story finals', content_funnel: 'Funnel per post', health_history: 'Account Health history',
});
