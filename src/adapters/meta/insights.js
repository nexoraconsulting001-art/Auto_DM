import { META_METRICS } from '../../contracts/analytics.js';
import { MetaApiError } from './errors.js';

const DAY_SECONDS = 86_400;
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url';
const id = (value) => encodeURIComponent(String(value));

/** Not an API failure: the 4.3 rules said this call must wait. retryAt is a Date when the pause has an end. Nothing was sent to Meta. */
export class InsightsDeferredError extends Error {
  constructor({ callClass, reason, retryAt = null }) {
    super(`Insights call deferred (${reason})`);
    this.name = 'InsightsDeferredError';
    this.callClass = callClass;
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/** True when Meta refused for lack of permission: Analytics and Reach Guard then show "Permission needed", and automation runs in slow mode (4.2). */
export const isInsightsDenied = (err) => err instanceof MetaApiError && err.kind === 'permission';

function kindOfMedia(raw) {
  if (raw.media_product_type === 'STORY') return 'story';
  if (raw.media_product_type === 'REELS') return 'reel';
  return raw.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'feed';
}

const toMedia = (raw) => ({
  id: String(raw.id),
  kind: kindOfMedia(raw),
  caption: raw.caption ?? '',
  permalink: raw.permalink ?? '',
  thumbnailUrl: raw.thumbnail_url ?? raw.media_url ?? '',
  postedAt: raw.timestamp ? new Date(raw.timestamp.replace(/\+0000$/, 'Z')) : null,
});

const pageOf = (data) => ({ items: (data.data ?? []).map(toMedia), next: data.paging?.next ? data.paging.cursors?.after ?? null : null });

const assertNoImpressions = (metrics) => {
  if (metrics.includes('impressions')) throw new Error('Never request impressions (PRD 7.1)');
};

const startOf = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;

function entryValue(entry) {
  if (entry?.total_value?.value !== undefined && entry.total_value.value !== null) return entry.total_value.value;
  const first = entry?.values?.[0]?.value;
  return first === undefined ? null : first;
}

const resultsOf = (entry) => (entry?.total_value?.breakdowns?.[0]?.results ?? []).map((r) => ({ key: (r.dimension_values ?? []).join('|'), value: r.value }));

/** Metric totals as { name: value }, with every metric requested present and null where Meta gave nothing. An empty data set is null, never 0 (7.1). */
function totalsOf(data, metrics) {
  const out = Object.fromEntries(metrics.map((m) => [m, null]));
  for (const entry of data.data ?? []) if (Object.hasOwn(out, entry.name)) out[entry.name] = entryValue(entry);
  return out;
}

/**
 * Insights for one account, with 4.3's rules wrapped round every call. `guard` is compliance.insightsGuard(channel, accountId): it says whether a
 * call class may run now, and is told about each answer, so usage headers and 80002 reach the rate state. Every method resolves to figures the
 * cache can store, or throws InsightsDeferredError (wait, and try later) or MetaApiError (see isInsightsDenied). Every call has Meta's 10 s timeout.
 *
 * Results say what happened, so a track never has to read an error code:
 *   status 'ok'               metrics are there; null is "No data"
 *   status 'gone'             the media no longer exists on Instagram
 *   status 'expired'          Meta no longer keeps it (a story past 24h, media past 2 years)
 *   status 'below_threshold'  error 10 "Not enough viewers": stored as "<5", and not an API failure (7.3)
 */
export function createInsightsReader({ owner, graph }, guard) {
  if (typeof guard?.check !== 'function' || typeof guard?.observe !== 'function') throw new Error('Insights calls need the rate guard from compliance.insightsGuard() (PRD 4.3)');

  async function note(outcome) {
    try {
      await guard.observe(outcome);
    } catch {
      // Recording what Meta said can never change the outcome of the call.
    }
  }

  /** One call: asks whether it may run, makes it, and reports what came back. */
  async function run(callClass, pathname, query) {
    const verdict = await guard.check(callClass);
    if (!verdict.allow) throw new InsightsDeferredError({ callClass, reason: verdict.reason, retryAt: verdict.retryAt ?? null });
    try {
      const result = await graph('GET', pathname, { query });
      await note({ callClass, usage: result.usage });
      return result.data;
    } catch (err) {
      if (err instanceof MetaApiError) await note({ callClass, kind: err.kind, usage: err.usage });
      throw err;
    }
  }

  async function objectInsights(callClass, objectId, kind) {
    const metrics = META_METRICS[kind];
    const plain = metrics.filter((m) => !Object.hasOwn(META_METRICS.breakdowns, m));
    assertNoImpressions(metrics);
    try {
      const base = await run(callClass, `${id(objectId)}/insights`, { metric: plain.join(',') });
      const breakdowns = {};
      for (const metric of metrics.filter((m) => Object.hasOwn(META_METRICS.breakdowns, m))) {
        const answer = await run(callClass, `${id(objectId)}/insights`, { metric, breakdown: META_METRICS.breakdowns[metric], metric_type: 'total_value' });
        breakdowns[metric] = Object.fromEntries(resultsOf((answer.data ?? [])[0]).map((r) => [r.key, r.value]));
      }
      return { status: 'ok', metrics: totalsOf(base, plain), breakdowns };
    } catch (err) {
      if (err instanceof MetaApiError) {
        if (err.kind === 'not_enough_viewers') return { status: 'below_threshold', metrics: {}, breakdowns: {} };
        if (err.kind === 'not_found') return { status: 'gone', metrics: {}, breakdowns: {} };
        if (err.kind === 'insights_expired') return { status: 'expired', metrics: {}, breakdowns: {} };
      }
      throw err;
    }
  }

  const accountBreakdown = async (day, query) => run('insights', `${owner}/insights`, { period: 'day', metric_type: 'total_value', since: String(startOf(day)), until: String(startOf(day) + DAY_SECONDS), ...query });

  return {
    /** One day's account metrics, as rows { day, metric, breakdown, breakdownValue, value } ready for insight_daily. Late revisions: call it again. */
    async accountDay(day, { breakdowns = true } = {}) {
      assertNoImpressions(META_METRICS.accountDaily);
      const totals = totalsOf(await accountBreakdown(day, { metric: META_METRICS.accountDaily.join(',') }), META_METRICS.accountDaily);
      const rows = Object.entries(totals).map(([metric, value]) => ({ day, metric, breakdown: '', breakdownValue: '', value }));
      if (!breakdowns) return rows;
      for (const [breakdown, metrics] of Object.entries(META_METRICS.accountBreakdowns)) {
        const answer = await accountBreakdown(day, { metric: metrics.join(','), breakdown });
        for (const entry of answer.data ?? []) {
          for (const { key, value } of resultsOf(entry)) rows.push({ day, metric: entry.name, breakdown, breakdownValue: key, value });
        }
      }
      return rows;
    },

    /** [{ key, value }]. Empty below Meta's minimum: the caller shows "Available once you reach 100 followers" (7.1). */
    async demographics(metric, timeframe, breakdown) {
      const data = await run('insights', `${owner}/insights`, { metric, period: 'lifetime', metric_type: 'total_value', timeframe, breakdown });
      return resultsOf((data.data ?? [])[0]);
    },

    /** { available, hours: { '0': n, ... } }. available is false when Meta no longer returns it (7.5, to confirm). */
    async onlineFollowers() {
      const data = await run('insights', `${owner}/insights`, { metric: 'online_followers', period: 'lifetime' });
      const hours = (data.data ?? [])[0]?.values?.[0]?.value;
      return { available: Boolean(hours && Object.keys(hours).length), hours: hours ?? {} };
    },

    /** followers_count, or null when Meta didn't give one (to confirm for Instagram Login). */
    async followers() {
      const data = await run('insights', owner, { fields: 'followers_count' });
      return data.followers_count ?? null;
    },

    /** One page of /media: { items, next }. Go back 2 years by passing next as after (7.2). */
    async mediaPage({ after, limit = 100 } = {}) {
      return pageOf(await run('media_list', `${owner}/media`, { fields: MEDIA_FIELDS, limit: String(limit), ...(after ? { after } : {}) }));
    },

    /** One page of live stories. available is false when this account can't use the edge: track only stories seen through replies and mentions (7.3). */
    async storiesPage({ after, limit = 100 } = {}) {
      try {
        const data = await run('story_insights', `${owner}/stories`, { fields: MEDIA_FIELDS, limit: String(limit), ...(after ? { after } : {}) });
        return { available: true, ...pageOf(data) };
      } catch (err) {
        if (err instanceof MetaApiError && err.code === 2500) return { available: false, items: [], next: null };
        throw err;
      }
    },

    /** A post, reel or carousel. A carousel is asked for on its album id only: never call this for a slide (7.2). */
    mediaInsights: (mediaId, kind) => objectInsights('insights', mediaId, kind),

    /** A story: its own call class, because story data disappears after 24 hours and outranks other insights (4.3). */
    storyInsights: (storyId) => objectInsights('story_insights', storyId, 'story'),
  };
}
