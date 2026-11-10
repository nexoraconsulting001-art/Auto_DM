import { z } from 'zod';
import { ANALYTICS_LIMITS, CONTENT_KINDS, DESTINATION_SOURCES, FUNNEL_ORIGINS, FUNNEL_STAGES, LINK_MODES, LINK_TYPES_MEASURED, SOURCE_LABEL_CODES, STORY_FINAL_STATES } from '../analytics.js';
import { Channel } from '../compliance.js';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, ListQuery, Paise, Timestamp, page, text } from './common.js';

/**
 * PRD 7.1 to 7.5 and 7.15, answered by src/modules/insights. Every route here reads the per-business cache and none calls Meta. The one
 * exception is insights.refresh, which only moves polls forward, within the 15 minute limit and the 4.3 pauses.
 */
const reader = staffWith('analytics');

export const SourceLabel = z.enum(SOURCE_LABEL_CODES);
export const IsoDay = z.iso.date();
export const IsoDayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).pipe(z.iso.date());

/** A figure that might not exist. `value` null always comes with a state that says why; a number is never made up. */
export const FigureState = z.enum(['ok', 'no_data', 'not_collected', 'below_threshold', 'not_available']);

/** The fields of every date-ranged query. Add these, then wrap with withRange() so a custom range is checked. */
export const RangeFields = {
  range: z.enum(['7', '28', '90', 'custom']).default('28'),
  from: IsoDayText.optional(),
  to: IsoDayText.optional(),
};

/** A range of at most 25 months, the longest anything is kept. */
export const withRange = (schema) => schema.superRefine((value, issues) => {
  if (value.range !== 'custom') return;
  if (!value.from || !value.to) {
    issues.addIssue({ code: 'custom', path: ['from'], message: 'Choose a start and an end date' });
    return;
  }
  if (value.from > value.to) issues.addIssue({ code: 'custom', path: ['from'], message: 'The start date must be before the end date' });
  if ((Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 > ANALYTICS_LIMITS.rollupDays) issues.addIssue({ code: 'custom', path: ['to'], message: 'Choose a shorter range' });
});

export const RangeQuery = withRange(z.object(RangeFields));

const Metrics = z.record(z.string(), z.number().nullable());

export const InsightsPermission = z.enum(['ok', 'needed']);

export const InsightsStatus = z.object({
  connected: z.boolean(),
  permission: InsightsPermission,
  collectingSince: IsoDay.nullable(),
  lastUpdatedAt: Timestamp.nullable(),
  nextRefreshAt: Timestamp.nullable(),
  storyDiscovery: z.enum(['edge', 'replies_and_mentions_only', 'unknown']),
});

/** One day of one metric. mayChange is true for the last 2 days (N-01). not_collected is before the account was connected (N-04). */
export const DayValue = z.object({ day: IsoDay, value: z.number().nullable(), state: FigureState, mayChange: z.boolean() });

export const AccountMetric = z.object({
  metric: z.string(),
  label: z.string(),
  estimated: z.boolean(),
  total: z.number().nullable(),
  gapDays: Count,
  days: z.array(DayValue),
  breakdowns: z.array(z.object({ breakdown: z.string(), items: z.array(z.object({ key: z.string(), value: z.number() })) })),
});

export const AccountInsights = z.object({
  from: IsoDay,
  to: IsoDay,
  source: SourceLabel,
  permission: InsightsPermission,
  lastUpdatedAt: Timestamp.nullable(),
  metrics: z.array(AccountMetric),
  followers: z.array(DayValue),
});

export const AudienceQuery = z.object({ timeframe: z.enum(ANALYTICS_LIMITS.demographicsTimeframes).default('this_month') });
const AudienceBreakdown = z.object({ breakdown: z.enum(['age', 'gender', 'city', 'country']), items: z.array(z.object({ key: z.string(), value: z.number() })) });
/** available is false below 100 followers, with `message` to show and no error (N-02). */
export const Audience = z.object({
  available: z.boolean(),
  message: z.string().nullable(),
  timeframe: z.enum(ANALYTICS_LIMITS.demographicsTimeframes),
  followers: z.array(AudienceBreakdown),
  engaged: z.array(AudienceBreakdown),
  source: SourceLabel,
  lastUpdatedAt: Timestamp.nullable(),
});

export const MediaIdParams = z.object({ id: z.string().regex(/^[\w-]{1,80}$/) });

export const InsightsMediaQuery = ListQuery.extend({
  kind: z.enum(['all', ...CONTENT_KINDS]).default('all'),
  includeDeleted: z.enum(['true', 'false']).default('true'),
});

export const MediaInsight = z.object({
  id: z.string(),
  kind: z.enum(CONTENT_KINDS),
  caption: z.string(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  postedAt: Timestamp.nullable(),
  deleted: z.boolean(),
  metrics: Metrics,
  estimated: z.array(z.string()),
  historicImpressions: z.number().nullable(),
  source: SourceLabel,
  lastUpdatedAt: Timestamp.nullable(),
});

export const MediaGrowthPoint = z.object({ ageMinutes: Count, capturedAt: Timestamp, metrics: Metrics });
export const MediaInsightDetail = MediaInsight.extend({ growth: z.array(MediaGrowthPoint), breakdowns: z.record(z.string(), z.record(z.string(), z.number())) });

/** belowThreshold shows "<5" (N-11). linkClicks is Meta's; bhavaVisits is null unless the sticker opens a Bhava-hosted page (N-13). */
export const StoryInsight = z.object({
  id: z.string(),
  postedAt: Timestamp.nullable(),
  tracking: z.enum(['tracked', 'not_tracked']),
  finalState: z.enum(STORY_FINAL_STATES),
  belowThreshold: z.boolean(),
  metrics: Metrics,
  navigation: z.record(z.string(), z.number()),
  bhavaVisits: Count.nullable(),
  source: SourceLabel,
  lastUpdatedAt: Timestamp.nullable(),
});
export const StoryInsightsPage = page(StoryInsight).extend({ discovery: z.enum(['edge', 'replies_and_mentions_only', 'unknown']) });

/** One step of the funnel. state 'not_available' comes with `reason`, and count is null: Bhava never estimates a step (7.15). */
export const FunnelStep = z.object({
  stage: z.enum(FUNNEL_STAGES),
  count: Count.nullable(),
  amountPaise: Paise.nullable(),
  source: SourceLabel.nullable(),
  state: z.enum(['ok', 'not_available']),
  reason: z.string().nullable(),
  rate: z.number().nullable(),
  lowVolume: z.boolean(),
  origins: z.array(z.object({ origin: z.enum(FUNNEL_ORIGINS), count: Count, amountPaise: Paise, source: SourceLabel })),
});
export const ContentFunnel = z.object({
  mediaId: z.string(),
  kind: z.enum(CONTENT_KINDS),
  channel: Channel,
  linkType: z.enum(LINK_TYPES_MEASURED).nullable(),
  linkMode: z.enum(LINK_MODES).nullable(),
  steps: z.array(FunnelStep),
  platform: z.object({ reach: z.number().nullable(), views: z.number().nullable(), source: SourceLabel, lastUpdatedAt: Timestamp.nullable() }),
  lastUpdatedAt: Timestamp.nullable(),
});
export const ContentFunnelQuery = ListQuery.extend({ kind: z.enum(['all', ...CONTENT_KINDS]).default('all') });

export const TOP_RANKS = Object.freeze(['views', 'reach', 'interactions', 'dms', 'taps_or_visits', 'sales']);
export const TopContentQuery = ListQuery.extend({
  rank: z.enum(TOP_RANKS).default('views'),
  kind: z.enum(['all', ...CONTENT_KINDS]).default('all'),
  linkMode: z.enum(['all', ...LINK_MODES]).default('all'),
  days: z.coerce.number().int().min(1).max(ANALYTICS_LIMITS.mediaHistoryDays).default(30),
});
export const TopContentItem = z.object({ mediaId: z.string(), kind: z.enum(CONTENT_KINDS), caption: z.string(), thumbnailUrl: z.string(), postedAt: Timestamp.nullable(), value: z.number().nullable(), ageDays: Count });
/** comparedAtAgeDays is the shared age every row was ranked at (N-21). */
export const TopContentPage = page(TopContentItem).extend({ comparedAtAgeDays: Count.nullable(), source: SourceLabel });

/** Suggested posting times (7.5), in the business's time zone. available false comes with message (N-22). */
export const BestTime = z.object({
  available: z.boolean(),
  message: z.string().nullable(),
  basis: z.enum(['online_followers', 'average_reach']).nullable(),
  timeZone: z.string(),
  label: z.string(),
  cells: z.array(z.object({ weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), value: z.number() })),
});

/** Refresh now (7.8). refreshed false means no call was made, and lastUpdatedAt says how old the cache is. */
export const RefreshResult = z.object({ refreshed: z.boolean(), message: z.string(), lastUpdatedAt: Timestamp.nullable(), nextRefreshAt: Timestamp.nullable() });

export const DestinationConnection = z.object({ source: z.enum(DESTINATION_SOURCES), enabled: z.boolean(), connectedAt: Timestamp.nullable() });
export const DestinationConnections = z.object({ items: z.array(DestinationConnection) });
export const SiteTagBody = z.object({ enabled: z.boolean() });
/** snippet is the script tag to paste on the seller's own site; empty when off. */
export const SiteTag = z.object({ enabled: z.boolean(), snippet: z.string() });

export const DESTINATION_UPLOAD = Object.freeze({
  field: 'file',
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: Object.freeze(['text/csv', 'application/vnd.ms-excel', 'text/plain']),
});
export const DestinationUploadQuery = z.object({ source: z.enum(['amazon', 'affiliate']).default('amazon'), network: text(40).default('') });
export const DestinationUploadRow = z.object({ id: Id, source: z.enum(['amazon', 'affiliate']), network: z.string(), periodFrom: IsoDay.nullable(), periodTo: IsoDay.nullable(), rowsImported: Count, rowsUnmatched: Count, uploadedAt: Timestamp });

export const insightRoutes = {
  'insights.status': { method: 'GET', path: '/insights/status', access: reader, response: InsightsStatus },
  'insights.account': { method: 'GET', path: '/insights/account', access: reader, query: RangeQuery, response: AccountInsights },
  'insights.audience': { method: 'GET', path: '/insights/audience', access: reader, query: AudienceQuery, response: Audience },
  'insights.media': { method: 'GET', path: '/insights/media', access: reader, query: InsightsMediaQuery, response: page(MediaInsight) },
  'insights.mediaDetail': { method: 'GET', path: '/insights/media/:id', access: reader, params: MediaIdParams, response: MediaInsightDetail },
  'insights.stories': { method: 'GET', path: '/insights/stories', access: reader, query: ListQuery, response: StoryInsightsPage },
  'insights.funnels': { method: 'GET', path: '/insights/funnels', access: reader, query: ContentFunnelQuery, response: page(ContentFunnel) },
  'insights.funnel': { method: 'GET', path: '/insights/funnels/:id', access: reader, params: MediaIdParams, response: ContentFunnel },
  'insights.top': { method: 'GET', path: '/insights/top', access: reader, query: TopContentQuery, response: TopContentPage },
  'insights.bestTime': { method: 'GET', path: '/insights/best-time', access: reader, response: BestTime },
  'insights.refresh': { method: 'POST', path: '/insights/refresh', access: reader, response: RefreshResult },
  'destinations.connections': { method: 'GET', path: '/destinations/connections', access: reader, response: DestinationConnections },
  'destinations.setSiteTag': { method: 'PUT', path: '/destinations/site-tag', access: MANAGERS, body: SiteTagBody, response: SiteTag },
  'destinations.reports': { method: 'GET', path: '/destinations/reports', access: reader, query: ListQuery, response: page(DestinationUploadRow) },
  'destinations.uploadReport': { method: 'POST', path: '/destinations/reports', access: MANAGERS, query: DestinationUploadQuery, upload: DESTINATION_UPLOAD, status: 201, response: DestinationUploadRow },
};
