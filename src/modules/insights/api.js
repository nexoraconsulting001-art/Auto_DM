import { ApiError, canSeeRevenue } from '../../contracts/api/index.js';
import { ANALYTICS_LIMITS as L, EXPLORE_METRICS, FIGURE_TEXT, META_METRICS } from '../../contracts/analytics.js';
import { log } from '../../platform/log.js';
import { pageOf, readCursor, writeCursor } from '../admin-api/paging.js';
import { DAY, MINUTE, addDays, dayOf, eachDay, zonedTime } from './schedule.js';

const SOURCE = 'platform'; // everything on these screens comes from Meta (7.15): Bhava's own counts are the funnel's
const ACCOUNT_METRICS = Object.freeze([...META_METRICS.accountDaily, ...Object.values(META_METRICS.accountBreakdowns).filter((m) => m.length === 1).flat()]);
const RANK_METRIC = Object.freeze({ views: 'views', reach: 'reach', interactions: 'total_interactions' });
const FUNNEL_MEASURES = Object.freeze({ dms: ['dms_sent'], taps_or_visits: ['taps', 'visits'], sales: ['revenue_paise', 'earnings_paise'] });
const ROLLUP_PAGE = 10_000;

const LABELS = Object.freeze({ views: FIGURE_TEXT.viewsColumn, follows_and_unfollows: 'Follows and unfollows', followers_count: 'Followers' });
const labelOf = (metric) => LABELS[metric] ?? EXPLORE_METRICS[`ig_${metric}`]?.label ?? metric;

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const latestOf = (rows) => rows.reduce((max, r) => (r.fetched_at && (!max || +new Date(r.fetched_at) > +new Date(max)) ? r.fetched_at : max), null);
const onlyNumbers = (record) => Object.fromEntries(Object.entries(record ?? {}).filter(([, v]) => v === null || isNumber(v)));
const numbersOnly = (record) => Object.fromEntries(Object.entries(record ?? {}).filter(([, v]) => isNumber(v)));

const validCursor = (key) => key.length === 2 && typeof key[0] === 'string' && Number.isSafeInteger(key[1]) && key[1] > 0;
const cursorKey = (cursor) => (cursor ? readCursor(cursor, validCursor) : null);

function pageByKey(rows, limit) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? writeCursor([items.at(-1).sort_at, Number(items.at(-1).id)]) : null };
}

/** Presets end yesterday: today is not a whole day yet. Meta's day labels are UTC, so "today" is too. */
function rangeDays({ range, from, to }, today) {
  if (range === 'custom') return { from, to };
  const end = addDays(today, -1);
  return { from: addDays(end, -(Number(range) - 1)), to: end };
}

function dayState(day, row, account, planFloor) {
  if (planFloor !== null && day < planFloor) return 'not_available';
  if (row && row.value !== null) return 'ok';
  return !account || day < account.collecting_since ? 'not_collected' : 'no_data';
}

/** Sold-separately limits stay on the server (5.20). Null when this plan has no limit. */
const planFloorOf = (limit, today) => (limit === Infinity ? null : addDays(today, -limit));

function toDays(days, rowOf, account, planFloor, today) {
  const settled = addDays(today, -L.mayChangeDays);
  return days.map((day) => {
    const row = rowOf(day);
    const state = dayState(day, row, account, planFloor);
    return { day, value: state === 'ok' ? Number(row.value) : null, state, mayChange: day >= settled };
  });
}

function accountMetric(metric, days, rows, account, planFloor, today) {
  const own = rows.filter((r) => r.metric === metric && (planFloor === null || r.day >= planFloor));
  const totals = new Map(own.filter((r) => r.breakdown === '').map((r) => [r.day, r]));
  const items = own.filter((r) => r.breakdown !== '' && r.value !== null);
  if (!totals.size) {
    // profile_links_taps and follows_and_unfollows come only broken down, and Meta's total is the sum of the parts.
    for (const row of items) totals.set(row.day, { value: (totals.get(row.day)?.value ?? 0) + Number(row.value) });
  }

  const dayValues = toDays(days, (day) => totals.get(day), account, planFloor, today);
  const present = dayValues.filter((d) => d.state === 'ok');
  const breakdowns = new Map();
  for (const row of items) {
    const group = breakdowns.get(row.breakdown) ?? new Map();
    breakdowns.set(row.breakdown, group);
    group.set(row.breakdown_value, (group.get(row.breakdown_value) ?? 0) + Number(row.value));
  }
  return {
    metric,
    label: labelOf(metric),
    estimated: META_METRICS.estimated.includes(metric),
    total: present.length ? present.reduce((sum, d) => sum + d.value, 0) : null,
    gapDays: dayValues.filter((d) => d.state === 'no_data').length,
    days: dayValues,
    breakdowns: [...breakdowns].map(([breakdown, group]) => ({ breakdown, items: [...group].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value) })),
  };
}

const toMedia = (row) => {
  const latest = onlyNumbers(row.latest);
  return {
    id: row.media_id,
    kind: row.kind,
    caption: row.caption,
    permalink: row.permalink,
    thumbnailUrl: row.thumbnail_url,
    postedAt: row.posted_at,
    deleted: row.deleted_at !== null,
    metrics: latest,
    estimated: Object.keys(latest).filter((m) => META_METRICS.estimated.includes(m)),
    historicImpressions: numberOrNull(row.historic_impressions),
    source: SOURCE,
    lastUpdatedAt: row.latest_at,
  };
};

const toStory = (row, visits) => ({
  id: row.media_id,
  postedAt: row.posted_at,
  tracking: row.story_tracking === 'not_tracked' ? 'not_tracked' : 'tracked',
  finalState: row.story_final_state,
  belowThreshold: row.below_threshold,
  metrics: onlyNumbers(row.latest),
  navigation: numbersOnly(row.latest_breakdowns?.navigation),
  bhavaVisits: visits ?? null,
  source: SOURCE,
  lastUpdatedAt: row.latest_at,
});

const DISCOVERY = Object.freeze({ available: 'edge', unavailable: 'replies_and_mentions_only', unknown: 'unknown' });

/**
 * The seller's insights screens (PRD 7.1 to 7.3, 7.5, 7.8). Every answer comes from the per-business cache or the rollups, so opening a screen makes no call to Meta. The
 * one write is Refresh now, which moves polls forward for the worker to pick up. A null figure comes with a state saying why, and is never 0.
 */
export function insightsApi(ctx) {
  const { repos, platform, compliance, config } = ctx;
  const now = () => (config?.complianceNow ?? Date.now)();
  const rollups = () => platform.analytics.rollups;

  const planDays = () => repos.entitlements.limit('insights.days');

  /** When the plan limits how far back a business can look, the oldest moment it can see; null when it doesn't (5.20). */
  async function planSince(at) {
    const limit = await planDays();
    return limit === Infinity ? null : at - limit * DAY;
  }

  /** All rows of a rollup read, however many pages. */
  async function readAll(store, spec) {
    const rows = [];
    for (let offset = 0; ; offset += ROLLUP_PAGE) {
      const page = await rollups().read(store, { ...spec, limit: ROLLUP_PAGE, offset });
      rows.push(...page);
      if (page.length < ROLLUP_PAGE) return rows;
    }
  }

  // ---- account --------------------------------------------------------------------------------------------------------

  async function status() {
    const [account, connection, settings] = await Promise.all([repos.insights.currentAccount(), repos.igAccounts.primary(), repos.insights.settings()]);
    return {
      connected: Boolean(connection && connection.status === 'active' && connection.hasToken),
      permission: account?.permission === 'denied' ? 'needed' : 'ok',
      collectingSince: account?.collecting_since ?? null,
      lastUpdatedAt: account?.last_refresh_at ?? null,
      nextRefreshAt: nextRefreshAt(settings, now()),
      storyDiscovery: DISCOVERY[account?.stories_edge ?? 'unknown'],
    };
  }

  function nextRefreshAt(settings, at) {
    if (!settings.refresh_now_at) return null;
    const next = +new Date(settings.refresh_now_at) + L.refreshNowEveryMs;
    return next > at ? new Date(next) : null;
  }

  async function account({ query }) {
    const at = now();
    const today = dayOf(at);
    const { from, to } = rangeDays(query, today);
    const [acct, limit] = await Promise.all([repos.insights.currentAccount(), planDays()]);
    const planFloor = planFloorOf(limit, today);
    const rows = acct ? await repos.insights.dailyRows(acct.id, from, to) : [];
    const days = eachDay(from, to);
    const followers = new Map(rows.filter((r) => r.metric === 'followers_count' && (planFloor === null || r.day >= planFloor)).map((r) => [r.day, r]));
    return {
      from,
      to,
      source: SOURCE,
      permission: acct?.permission === 'denied' ? 'needed' : 'ok',
      lastUpdatedAt: latestOf(rows),
      metrics: ACCOUNT_METRICS.map((metric) => accountMetric(metric, days, rows, acct, planFloor, today)),
      followers: toDays(days, (day) => followers.get(day), acct, planFloor, today),
    };
  }

  async function audience({ query }) {
    const acct = await repos.insights.currentAccount();
    const empty = { timeframe: query.timeframe, followers: [], engaged: [], source: SOURCE, lastUpdatedAt: null };
    if (!acct) return { ...empty, available: false, message: FIGURE_TEXT.noData };
    if (acct.followers_count !== null && acct.followers_count < L.minFollowersForDemographics) return { ...empty, available: false, message: FIGURE_TEXT.fewFollowers };
    const rows = await repos.insights.demographicsRows(acct.id, query.timeframe);
    if (!rows.length && acct.followers_count === null) return { ...empty, available: false, message: FIGURE_TEXT.noData };
    const groupOf = (metric) => META_METRICS.demographicBreakdowns.map((breakdown) => ({
      breakdown,
      items: rows.filter((r) => r.metric === metric && r.breakdown === breakdown).map((r) => ({ key: r.breakdown_value, value: Number(r.value) })),
    })).filter((group) => group.items.length);
    return { available: true, message: null, timeframe: query.timeframe, followers: groupOf('follower_demographics'), engaged: groupOf('engaged_audience_demographics'), source: SOURCE, lastUpdatedAt: latestOf(rows) };
  }

  // ---- posts and stories ----------------------------------------------------------------------------------------------

  async function media({ query }) {
    const acct = await repos.insights.currentAccount();
    if (!acct) return { items: [], nextCursor: null };
    const rows = await repos.insights.mediaPage(acct.id, { kind: query.kind, includeDeleted: query.includeDeleted === 'true', limit: query.limit + 1, after: cursorKey(query.cursor), since: await planSince(now()) });
    const page = pageByKey(rows, query.limit);
    return { items: page.items.map(toMedia), nextCursor: page.nextCursor };
  }

  async function mediaDetail({ params }) {
    const acct = await repos.insights.currentAccount();
    if (!acct) return null;
    const row = await repos.insights.mediaById(acct.id, params.id);
    if (!row) return null;
    const since = await planSince(now());
    if (since !== null && row.posted_at && +new Date(row.posted_at) < since) return null;
    const snapshots = await repos.insights.snapshots(row.id);
    return {
      ...toMedia(row),
      growth: snapshots.map((s) => ({ ageMinutes: s.age_minutes, capturedAt: s.captured_at, metrics: onlyNumbers(s.metrics) })),
      breakdowns: Object.fromEntries(Object.entries(row.latest_breakdowns ?? {}).map(([name, values]) => [name, numbersOnly(values)])),
    };
  }

  /** Visits to Bhava-hosted pages a story's sticker opened (N-13). A story with none shows no number at all. */
  async function storyVisits(rows, today) {
    if (!rows.length) return new Map();
    try {
      const firsts = rows.map((r) => dayOf(+new Date(r.posted_at ?? r.created_at)));
      const figures = await rollups().read('funnel_daily', {
        measures: ['visits'],
        dimensions: ['media_id'],
        filters: [{ dimension: 'media_id', op: 'include', values: rows.map((r) => r.media_id) }, { dimension: 'origin', op: 'include', values: ['bhava_page'] }],
        since: firsts.reduce((a, b) => (a < b ? a : b)),
        until: addDays(today, 1),
        limit: ROLLUP_PAGE,
      });
      return new Map(figures.filter((f) => isNumber(f.visits)).map((f) => [f.media_id, f.visits]));
    } catch (err) {
      log.warn('insights.story_visits_failed', { error: err?.name });
      return new Map();
    }
  }

  async function stories({ query }) {
    const acct = await repos.insights.currentAccount();
    const at = now();
    const discovery = DISCOVERY[acct?.stories_edge ?? 'unknown'];
    if (!acct) return { items: [], nextCursor: null, discovery };
    const rows = await repos.insights.mediaPage(acct.id, { kind: 'story', includeDeleted: true, limit: query.limit + 1, after: cursorKey(query.cursor), since: await planSince(at) });
    const page = pageByKey(rows, query.limit);
    const visits = await storyVisits(page.items, dayOf(at));
    return { items: page.items.map((row) => toStory(row, visits.get(row.media_id))), nextCursor: page.nextCursor, discovery };
  }

  // ---- top content and best time --------------------------------------------------------------------------------------

  /** Each post's figure from Bhava's or the destination's counts, up to the same age. One source for the whole list, so figures with different labels are never mixed (7.15). */
  async function funnelValues(candidates, rank, comparedAt, linkMode, timeZone, today) {
    const measures = FUNNEL_MEASURES[rank];
    const postedDays = candidates.map((c) => zonedTime(+new Date(c.posted_at), timeZone).day);
    const rows = await readAll('funnel_daily', {
      measures,
      dimensions: ['media_id', 'day', 'source_label'],
      filters: [{ dimension: 'media_id', op: 'include', values: candidates.map((c) => c.media_id) }, ...(linkMode === 'all' ? [] : [{ dimension: 'link_mode', op: 'include', values: [linkMode] }])],
      since: postedDays.reduce((a, b) => (a < b ? a : b)),
      until: addDays(today, 1), // funnel days are in the business's time zone, which can be ahead of UTC
      orderBy: 'day',
    });
    const cutoffs = new Map(candidates.map((c) => [c.media_id, zonedTime(+new Date(c.posted_at) + comparedAt * DAY, timeZone).day]));
    const totals = { bhava: new Map(), destination: new Map() };
    for (const row of rows) {
      if (row.day > cutoffs.get(row.media_id)) continue;
      const bySource = totals[row.source_label || 'bhava'];
      if (bySource) bySource.set(row.media_id, (bySource.get(row.media_id) ?? 0) + measures.reduce((sum, m) => sum + (row[m] ?? 0), 0));
    }
    const source = totals.bhava.size || !totals.destination.size ? 'bhava' : 'destination';
    return { source, values: totals[source] };
  }

  async function mediaWithLinkMode(candidates, linkMode, today) {
    const firstDay = candidates.map((c) => dayOf(+new Date(c.posted_at))).reduce((a, b) => (a < b ? a : b));
    const rows = await readAll('funnel_daily', {
      measures: ['dms_sent'],
      dimensions: ['media_id'],
      filters: [{ dimension: 'link_mode', op: 'include', values: [linkMode] }],
      since: addDays(firstDay, -1),
      until: addDays(today, 1),
    });
    return new Set(rows.map((r) => r.media_id));
  }

  /** Ranked at the age of the newest post in the list, so an older post's extra weeks don't count for it (7.5, N-21). A post with no snapshot from that age has no figure. */
  async function top({ query, user }) {
    if (query.rank === 'sales' && !canSeeRevenue(user)) throw new ApiError('forbidden', FIGURE_TEXT.ownerOnly);
    const at = now();
    const acct = await repos.insights.currentAccount();
    const usesFunnel = Object.hasOwn(FUNNEL_MEASURES, query.rank);
    const nothing = (source) => ({ items: [], nextCursor: null, comparedAtAgeDays: null, source });
    if (!acct) return nothing(usesFunnel ? 'bhava' : SOURCE);

    const limit = await planDays();
    const days = Math.min(query.days, limit);
    const today = dayOf(at);
    const timeZone = await repos.insights.timeZone();
    let candidates = days > 0 ? await repos.insights.rankable(acct.id, { kind: query.kind, since: at - days * DAY }) : [];
    if (candidates.length && query.linkMode !== 'all') {
      const withMode = await mediaWithLinkMode(candidates, query.linkMode, today);
      candidates = candidates.filter((c) => withMode.has(c.media_id));
    }
    if (!candidates.length) return nothing(usesFunnel ? 'bhava' : SOURCE);

    const ageOf = (c) => Math.max(0, Math.floor((at - +new Date(c.posted_at)) / DAY));
    const comparedAt = Math.min(...candidates.map(ageOf));
    const snapshots = await repos.insights.snapshotsUnderAge(candidates.map((c) => c.id), (comparedAt + 1) * 24 * 60);
    const atAge = new Map(snapshots.map((s) => [String(s.media_ref), s.metrics]));
    const metricOf = (c, name) => numberOrNull(atAge.get(String(c.id))?.[name]);

    const funnel = usesFunnel ? await funnelValues(candidates, query.rank, comparedAt, query.linkMode, timeZone, today) : null;
    const valueOf = (c) => (funnel ? funnel.values.get(c.media_id) ?? null : metricOf(c, RANK_METRIC[query.rank]));
    const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
    const ranked = candidates.map((c) => ({ c, value: valueOf(c), views: metricOf(c, 'views') }))
      .sort((a, b) => desc(a.value, b.value) || desc(a.views, b.views) || +new Date(b.c.posted_at) - +new Date(a.c.posted_at) || a.c.media_id.localeCompare(b.c.media_id));
    const page = pageOf(ranked, query);
    return {
      items: page.items.map(({ c, value }) => ({ mediaId: c.media_id, kind: c.kind, caption: c.caption, thumbnailUrl: c.thumbnail_url, postedAt: c.posted_at, value, ageDays: ageOf(c) })),
      nextCursor: page.nextCursor,
      comparedAtAgeDays: comparedAt,
      source: funnel ? funnel.source : SOURCE,
    };
  }

  /** online_followers while Meta gives it and the account has 100 followers, otherwise average reach by weekday and hour once there are 20 recent posts (7.5). */
  async function bestTime() {
    const timeZone = await repos.insights.timeZone();
    const shape = { timeZone, label: FIGURE_TEXT.suggested };
    const none = { ...shape, available: false, message: FIGURE_TEXT.notEnoughPosts, basis: null, cells: [] };
    const acct = await repos.insights.currentAccount();
    if (!acct) return none;
    if (acct.followers_count !== null && acct.followers_count >= L.minFollowersForDemographics) {
      const cells = await repos.insights.onlineFollowers(acct.id);
      if (cells.length) return { ...shape, available: true, message: null, basis: 'online_followers', cells: cells.map((c) => ({ weekday: c.weekday, hour: c.hour, value: Number(c.value) })) };
    }
    const posts = await repos.insights.postsWithReach(acct.id, now() - L.bestTimeWindowDays * DAY);
    if (posts.length < L.bestTimeMinPosts) return none;
    const buckets = new Map();
    for (const post of posts) {
      const { weekday, hour } = zonedTime(+new Date(post.posted_at), timeZone);
      const bucket = buckets.get(`${weekday}|${hour}`) ?? { weekday, hour, total: 0, count: 0 };
      bucket.total += Number(post.reach);
      bucket.count += 1;
      buckets.set(`${weekday}|${hour}`, bucket);
    }
    return { ...shape, available: true, message: null, basis: 'average_reach', cells: [...buckets.values()].map((b) => ({ weekday: b.weekday, hour: b.hour, value: Math.round(b.total / b.count) })) };
  }

  // ---- refresh now ----------------------------------------------------------------------------------------------------

  /** At most once per 15 minutes for a business, and never while 4.3 has paused insights calls. It only moves due times; the worker still does the calling. */
  async function refresh() {
    const at = now();
    const acct = await repos.insights.currentAccount();
    if (!acct || !acct.token_ok) return { refreshed: false, message: 'Connect Instagram to see your insights.', lastUpdatedAt: acct?.last_refresh_at ?? null, nextRefreshAt: null };

    const tooSoon = (settings) => {
      const tapped = settings.refresh_now_at ? +new Date(settings.refresh_now_at) : 0;
      const newest = Math.max(tapped, acct.last_refresh_at ? +new Date(acct.last_refresh_at) : 0);
      const minutes = Math.max(0, Math.floor((at - newest) / MINUTE));
      return { refreshed: false, message: minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`, lastUpdatedAt: acct.last_refresh_at, nextRefreshAt: nextRefreshAt(settings, at) };
    };

    const settings = await repos.insights.settings();
    if (nextRefreshAt(settings, at)) return tooSoon(settings);

    const verdict = await compliance.callAllowed('instagram', acct.ig_user_id, 'insights');
    if (!verdict.allow) return { refreshed: false, message: 'Instagram has asked us to slow down for now, so your figures will update once that lifts.', lastUpdatedAt: acct.last_refresh_at, nextRefreshAt: verdict.retryAt ?? null };

    if (!(await repos.insights.claimRefresh(at, L.refreshNowEveryMs))) return tooSoon(await repos.insights.settings());
    await repos.insights.pullPollsForward(acct.id, at, at - L.mediaMidUnderMs);
    return { refreshed: true, message: 'Getting your latest figures now.', lastUpdatedAt: acct.last_refresh_at, nextRefreshAt: new Date(at + L.refreshNowEveryMs) };
  }

  return {
    'insights.status': status,
    'insights.account': account,
    'insights.audience': audience,
    'insights.media': media,
    'insights.mediaDetail': mediaDetail,
    'insights.stories': stories,
    'insights.top': top,
    'insights.bestTime': bestTime,
    'insights.refresh': refresh,
  };
}
