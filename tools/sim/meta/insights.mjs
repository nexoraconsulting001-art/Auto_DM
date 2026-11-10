/**
 * Instagram insights as Meta serves them: data delays, late revisions, retention, permission refusals and the shape of each request. Everything reads the
 * simulator's controlled clock. What a request may ask is checked as Graph would, so a request Meta would refuse fails here too.
 *
 * Controls, under /__sim:
 *   POST /insights             { id, metrics: { reach: 10, profile_activity: { BIO_LINK_CLICKED: 2 } }, notEnoughViewers? }; null is an empty data set. id is a media or account id
 *   POST /insights/daily       { igUserId, metric, points: [{ day, value, early?, breakdowns? }] }: one account's daily series. value null is an empty data set.
 *                              early is what shows while the day is still settling (see the limit insightsSettleMs); leave it out and value shows at once
 *   POST /insights/demographics  { igUserId, metric, breakdown, timeframe?, results: { Mumbai: 12 } }
 *   POST /insights/options     { igUserId, storiesEdge?, readReceipts? }: what this account's login can do. Both default to true
 *   POST /tokens/scopes        { igUserId, scopes }: replaces the scopes on the account's tokens, for a permission revoked later
 *   POST /throttle             { igUserId, regainMinutes }: 80002 on everything but messaging, lifting by itself on the controlled clock
 *   POST /media/delete         { id }: gone from Instagram. Its insights are then not found
 *   POST /seen                 { igUserId, from, mid?, at? }: a person reads a DM (messaging_seen, only if the account subscribed and readReceipts is on)
 * Limits, under POST /limits: accountInsightsMs, mediaInsightsMs, insightsRangeMs, insightsSettleMs, insightsDelayMs.
 */
import { SimError } from '../base.mjs';
import { DAY, ERRORS, INSIGHT_METRICS, MINUTE, SCOPES, graphError, ACCOUNT_INSIGHT_METRICS, MEDIA_INSIGHT_METRICS } from './constants.mjs';
import { authenticate, chargeBuc, input, isOwnAccount, nextId, person } from './state.mjs';
import { emit } from './webhooks.mjs';

const refuse = (error, status = 400) => new SimError(status, { error });
const notFound = () => graphError(ERRORS.OBJECT_NOT_FOUND);
const invalid = (message) => graphError(ERRORS.INVALID_PARAM, `(#100) ${message}`);

const IS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00Z`);
const endTime = (day) => new Date(dayStart(day) + DAY).toISOString().replace(/\.\d{3}Z$/, '+0000');

/** A metric that must be asked for alone, and the breakdown it needs. */
const NEEDS_BREAKDOWN = Object.freeze({
  profile_activity: ['action_type'],
  navigation: ['story_navigation_action_type'],
  profile_links_taps: ['contact_button_type'],
  follows_and_unfollows: ['follow_type'],
  follower_demographics: ['age', 'gender', 'city', 'country'],
  engaged_audience_demographics: ['age', 'gender', 'city', 'country'],
});
const CAN_BREAK_BY_PRODUCT = new Set(['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'replies', 'total_interactions']);
const TIMEFRAMES = new Set(['this_week', 'this_month']);
const DEMOGRAPHICS = new Set(['follower_demographics', 'engaged_audience_demographics']);
const DEMOGRAPHICS_MIN_FOLLOWERS = 100;

function checkBreakdown(metrics, breakdown) {
  const strict = metrics.filter((m) => Object.hasOwn(NEEDS_BREAKDOWN, m));
  if (strict.length) {
    if (metrics.length > 1) throw invalid(`${strict[0]} must be requested on its own`);
    if (!NEEDS_BREAKDOWN[strict[0]].includes(breakdown)) throw invalid(`${strict[0]} requires breakdown ${NEEDS_BREAKDOWN[strict[0]].join(' or ')}`);
    return;
  }
  if (breakdown === undefined) return;
  if (breakdown !== 'media_product_type') throw invalid(`Unsupported breakdown ${breakdown}`);
  for (const metric of metrics) if (!CAN_BREAK_BY_PRODUCT.has(metric)) throw invalid(`${metric} does not support breakdown media_product_type`);
}

function parseWhen(value) {
  if (value === undefined || value === '') return undefined;
  const text = String(value);
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!IS_DAY.test(text)) throw invalid('since and until must be a unix time or a date');
  return dayStart(text);
}

const entry = (key, name, period, body) => ({ name, period, ...body, title: name, id: `${key}/insights/${name}/${period}` });

const breakdownBody = (breakdown, results) => ({
  breakdowns: [{ dimension_keys: [breakdown], results: Object.entries(results).map(([key, value]) => ({ dimension_values: [key], value })) }],
});

function metricList(params) {
  const metrics = String(params.metric ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (!metrics.length) throw invalid('Param metric is required');
  for (const name of metrics) {
    if (name === 'impressions') throw invalid('impressions is no longer supported; use views');
    if (!INSIGHT_METRICS.includes(name)) throw invalid(`metric[0] must be one of the supported metrics, got ${name}`);
  }
  return metrics;
}

/** A day's point as Meta would show it now: nothing during the delay, the early figure while it settles, then the final one. */
function pointNow(ctx, account, metric, day) {
  const point = ctx.s.insightDaily.get(`${account.igUserId}|${metric}`)?.get(day);
  if (!point) return null;
  const ended = dayStart(day) + DAY;
  const now = ctx.clock.now();
  if (now < ended + ctx.s.limits.insightsDelayMs) return null;
  if (Object.hasOwn(point, 'early') && now < ended + ctx.s.limits.insightsSettleMs) return { value: point.early, breakdowns: point.earlyBreakdowns ?? {} };
  return point;
}

function accountWindow(ctx, params) {
  const now = ctx.clock.now();
  const until = parseWhen(params.until) ?? now;
  const since = parseWhen(params.since) ?? until - DAY;
  if (until <= since) throw invalid('until must be after since');
  if (until - since > ctx.s.limits.insightsRangeMs) throw invalid('The date range can be at most 30 days');
  if (since < now - ctx.s.limits.accountInsightsMs) throw invalid('Account insights older than 90 days are not available');
  const days = [];
  for (let at = dayStart(dayOf(since)); at < until; at += DAY) days.push(dayOf(at));
  return days;
}

function accountSeries(ctx, account, name, days) {
  const flat = ctx.s.insights.get(account.igUserId)?.[name];
  const hasSeries = ctx.s.insightDaily.has(`${account.igUserId}|${name}`);
  return days.flatMap((day) => {
    const point = hasSeries ? pointNow(ctx, account, name, day) : (flat === undefined ? null : { value: flat });
    return point && point.value !== null ? [{ day, point }] : [];
  });
}

function totalValue(series, breakdown) {
  const total = series.reduce((sum, { point }) => sum + point.value, 0);
  if (breakdown === undefined) return { value: total };
  const results = {};
  for (const { point } of series) for (const [key, value] of Object.entries(point.breakdowns?.[breakdown] ?? {})) results[key] = (results[key] ?? 0) + value;
  return { value: total, ...breakdownBody(breakdown, results) };
}

function demographics(ctx, account, metric, params) {
  if (!TIMEFRAMES.has(params.timeframe)) throw invalid('timeframe must be this_week or this_month');
  checkBreakdown([metric], params.breakdown);
  // Meta gives these only from 100 followers. Whether it says so with an error or an empty set is to confirm: this is the empty form.
  const seeded = account.followersCount < DEMOGRAPHICS_MIN_FOLLOWERS ? {} : ctx.s.demographics.get(`${account.igUserId}|${metric}|${params.breakdown}|${params.timeframe}`) ?? ctx.s.demographics.get(`${account.igUserId}|${metric}|${params.breakdown}|*`) ?? {};
  return { data: [entry(account.igUserId, metric, 'lifetime', { total_value: { value: 0, ...breakdownBody(params.breakdown, seeded) } })] };
}

function accountInsights(ctx, account, params, metrics) {
  for (const name of metrics) if (!ACCOUNT_INSIGHT_METRICS.includes(name)) throw invalid(`${name} is not an account metric`);
  if (metrics.some((m) => DEMOGRAPHICS.has(m))) return demographics(ctx, account, metrics[0], params);

  const seeded = ctx.s.insights.get(account.igUserId) ?? {};
  if (metrics.includes('online_followers')) {
    if (metrics.length > 1) throw invalid('online_followers must be requested on its own');
    const hours = seeded.online_followers;
    return { data: hours ? [entry(account.igUserId, 'online_followers', 'lifetime', { values: [{ value: hours, end_time: endTime(dayOf(ctx.clock.now())) }] })] : [] };
  }

  const period = params.period ?? 'lifetime';
  checkBreakdown(metrics, params.breakdown);
  const ranged = params.since !== undefined || params.until !== undefined || params.metric_type !== undefined;
  if (!ranged && params.breakdown === undefined) {
    return { data: metrics.map((name) => (seeded[name] === null ? entry(account.igUserId, name, period, { values: [] }) : entry(account.igUserId, name, period, { values: [{ value: seeded[name] ?? 0 }] }))) };
  }

  const days = accountWindow(ctx, params);
  const metricType = params.metric_type ?? 'time_series';
  if (metricType !== 'time_series' && metricType !== 'total_value') throw invalid('metric_type must be time_series or total_value');
  if (metricType === 'time_series' && params.breakdown !== undefined) throw invalid('A breakdown needs metric_type total_value');
  const data = [];
  for (const name of metrics) {
    const series = accountSeries(ctx, account, name, days);
    if (!series.length) continue; // an empty data set: Meta leaves the metric out
    data.push(metricType === 'total_value'
      ? entry(account.igUserId, name, period, { total_value: totalValue(series, params.breakdown) })
      : entry(account.igUserId, name, period, { values: series.map(({ day, point }) => ({ value: point.value, end_time: endTime(day) })) }));
  }
  return { data };
}

function mediaInsights(ctx, media, params, metrics) {
  if (media.parentId) throw invalid('Insights are available on the album id, not on its children');
  const allowed = MEDIA_INSIGHT_METRICS[media.productType] ?? MEDIA_INSIGHT_METRICS.REELS;
  for (const name of metrics) if (!allowed.includes(name)) throw invalid(`${name} is not supported for ${media.productType}`);
  checkBreakdown(metrics, params.breakdown);

  const now = ctx.clock.now();
  if (media.productType === 'STORY') {
    if (now - media.at >= ctx.s.limits.storyMs) throw graphError(ERRORS.INSIGHTS_EXPIRED);
    if (ctx.s.lowViewers.has(media.id)) throw graphError(ERRORS.NOT_ENOUGH_VIEWERS);
  } else if (now - media.at >= ctx.s.limits.mediaInsightsMs) {
    throw graphError(ERRORS.INSIGHTS_EXPIRED);
  }

  const seeded = ctx.s.insights.get(media.id) ?? {};
  const period = params.period ?? 'lifetime';
  return {
    data: metrics.map((name) => {
      const value = seeded[name];
      if (value === null) return entry(media.id, name, period, { values: [] });
      if (params.breakdown !== undefined) {
        const results = value && typeof value === 'object' ? value : {};
        return entry(media.id, name, period, { total_value: { value: Object.values(results).reduce((a, b) => a + b, 0), ...breakdownBody(params.breakdown, results) } });
      }
      return entry(media.id, name, period, { values: [{ value: value ?? 0 }] });
    }),
  };
}

/** GET /:id/insights, for the business account or one of its media. */
export function insightsRoute(ctx) {
  return (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.insights]);
    chargeBuc(ctx, account);
    const params = input(req);
    if (isOwnAccount(req.params.id, account)) return accountInsights(ctx, account, params, metricList(params));
    const media = ctx.s.media.get(req.params.id);
    if (!media || media.igUserId !== account.igUserId || media.deleted) throw notFound();
    return mediaInsights(ctx, media, params, metricList(params));
  };
}

export function insightControls(on, ctx) {
  const needAccount = (igUserId) => {
    const account = ctx.s.accounts.get(String(igUserId));
    if (!account) throw refuse(`No account ${igUserId}; POST /__sim/accounts first.`, 404);
    return account;
  };

  on('POST', '/insights/daily', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (typeof body.metric !== 'string' || !body.metric) throw refuse('metric is required.');
    if (!Array.isArray(body.points)) throw refuse('points must be an array.');
    const key = `${account.igUserId}|${body.metric}`;
    const series = ctx.s.insightDaily.get(key) ?? new Map();
    for (const point of body.points) {
      if (!IS_DAY.test(point?.day ?? '')) throw refuse('Each point needs a day, YYYY-MM-DD.');
      series.set(point.day, point);
    }
    ctx.s.insightDaily.set(key, series);
    return { ok: true };
  });

  on('POST', '/insights/demographics', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (!DEMOGRAPHICS.has(body.metric)) throw refuse('metric must be follower_demographics or engaged_audience_demographics.');
    ctx.s.demographics.set(`${account.igUserId}|${body.metric}|${body.breakdown}|${body.timeframe ?? '*'}`, body.results ?? {});
    return { ok: true };
  });

  on('POST', '/insights/options', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (body.storiesEdge !== undefined) account.storiesEdge = Boolean(body.storiesEdge);
    if (body.readReceipts !== undefined) account.readReceipts = Boolean(body.readReceipts);
    return { storiesEdge: account.storiesEdge, readReceipts: account.readReceipts };
  });

  on('POST', '/tokens/scopes', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (!Array.isArray(body.scopes)) throw refuse('scopes must be an array.');
    for (const token of ctx.s.tokens.values()) if (token.igUserId === account.igUserId) token.scopes = [...body.scopes];
    return { ok: true };
  });

  on('POST', '/throttle', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (!Number.isFinite(body.regainMinutes) || body.regainMinutes <= 0) throw refuse('regainMinutes must be a number above 0.');
    account.throttledUntil = ctx.clock.now() + body.regainMinutes * MINUTE;
    return { ok: true, until: account.throttledUntil };
  });

  on('POST', '/media/delete', ({ body }) => {
    const media = ctx.s.media.get(String(body.id));
    if (!media) throw refuse('No such media.', 404);
    media.deleted = true;
    return { ok: true };
  });

  on('POST', '/seen', async ({ body }) => {
    const account = needAccount(body.igUserId);
    if (!account.readReceipts) return { delivered: false, reason: 'read_receipts_off' };
    const sender = String(typeof body.from === 'object' && body.from !== null ? body.from.id : body.from ?? '');
    if (!sender) throw refuse('from is required.');
    const at = body.at ?? ctx.clock.now();
    person(ctx, account.igUserId, sender);
    const mid = body.mid ?? `m_${nextId(ctx)}`;
    const event = { sender: { id: sender }, recipient: { id: account.igUserId }, timestamp: at, read: { mid } };
    return { delivery: await emit(ctx, account, 'messaging_seen', { id: account.igUserId, time: at, messaging: [event] }, { deliver: body.deliver, hold: body.hold, duplicates: body.duplicates, signature: body.signature }) };
  });
}
