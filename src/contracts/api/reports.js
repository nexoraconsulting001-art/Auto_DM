import { z } from 'zod';
import { ANALYTICS_LIMITS, CUSTOM_FUNNEL_STEPS, DOWNLOAD_FORMATS, DOWNLOAD_SOURCES, DOWNLOAD_STATUSES, EXPLORE_DIMENSION_NAMES, EXPLORE_METRIC_NAMES, REPORT_FREQUENCIES, REPORT_KINDS, REPORTING_SCOPE, SOURCE_LABEL_CODES } from '../analytics.js';
import { MANAGERS, OWNER_ONLY, PUBLIC, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Timestamp, page, required, text } from './common.js';
import { IsoDayText, RangeFields, SourceLabel, withRange } from './insights.js';

/**
 * PRD 7.9, 7.11, 7.12 and 7.13, answered by src/modules/reports. Everything is summary data, and everything is built from the cache: a seller can
 * never fetch one visitor's path or a raw event log. Files are not JSON, so a download's fileUrl points at REPORT_FILE_PATH (outside /api/v1).
 */
const reader = staffWith('analytics');

/** Checked by position, not by a pattern: a long address must never be able to stall the server. */
function isEmail(value) {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && value.indexOf('.', at + 2) > 0 && !value.endsWith('.');
}
const Email = text(254).refine(isEmail, 'Enter an email address');

export const ExploreFilter = z.object({ dimension: z.enum(EXPLORE_DIMENSION_NAMES), op: z.enum(['include', 'exclude']), values: z.array(required(200)).min(1).max(50) });
export const ExploreThreshold = z.object({ metric: z.enum(EXPLORE_METRIC_NAMES), op: z.enum(['gte', 'lte']), value: z.number().min(0).max(Number.MAX_SAFE_INTEGER) });

const ExploreFields = {
  metrics: z.array(z.enum(EXPLORE_METRIC_NAMES)).min(1).max(12),
  dimensions: z.array(z.enum(EXPLORE_DIMENSION_NAMES)).max(ANALYTICS_LIMITS.exploreMaxBreakdowns).default([]),
  filters: z.array(ExploreFilter).max(10).default([]),
  thresholds: z.array(ExploreThreshold).max(3).default([]),
  ...RangeFields,
  compare: z.enum(['none', 'previous', 'last_year', 'custom']).default('none'),
  compareFrom: IsoDayText.optional(),
  compareTo: IsoDayText.optional(),
  sortBy: z.string().max(40).optional(),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  chart: z.enum(['table', 'line', 'bar']).default('table'),
};

const checkedExplore = (schema) => withRange(schema.superRefine((value, issues) => {
  if (value.compare === 'custom' && (!value.compareFrom || !value.compareTo)) issues.addIssue({ code: 'custom', path: ['compareFrom'], message: 'Choose the dates to compare with' });
  if (new Set(value.dimensions).size !== value.dimensions.length) issues.addIssue({ code: 'custom', path: ['dimensions'], message: 'Choose two different breakdowns' });
}));

/** Up to 2 breakdowns, AND-ed filters, and only dimensions and metrics from the catalogue: there is no way to name a visitor (7.11). */
export const ExploreQuery = checkedExplore(z.object(ExploreFields));
export const ExploreRequest = checkedExplore(z.object({ ...ExploreFields, page: z.string().max(40).regex(/^[\w-]*$/).optional(), limit: z.coerce.number().int().min(1).max(ANALYTICS_LIMITS.explorePageRows).default(ANALYTICS_LIMITS.explorePageRows) }));

/** A cell. lowVolume is true when a rate's denominator is under 20, and value is then still null (7.4, 7.11). */
export const ExploreCell = z.object({
  value: z.number().nullable(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  changePercent: z.number().nullable(),
  lowVolume: z.boolean(),
});
export const ExploreColumn = z.object({ metric: z.enum(EXPLORE_METRIC_NAMES), label: z.string(), source: SourceLabel, isRate: z.boolean() });
export const ExploreRow = z.object({ dimensions: z.record(z.string(), z.string()), metrics: z.record(z.string(), ExploreCell) });
/** hiddenMetrics are ones this person's role can't see, left out of every row (N-53). */
export const ExploreResult = z.object({
  columns: z.array(ExploreColumn),
  rows: z.array(ExploreRow),
  totals: z.record(z.string(), ExploreCell),
  hiddenMetrics: z.array(z.string()),
  from: z.iso.date(),
  to: z.iso.date(),
  compareFrom: z.iso.date().nullable(),
  compareTo: z.iso.date().nullable(),
  nextPage: z.string().nullable(),
  lastUpdatedAt: Timestamp.nullable(),
});
export const ExploreCatalog = z.object({
  metrics: z.array(z.object({ name: z.enum(EXPLORE_METRIC_NAMES), label: z.string(), source: z.enum(SOURCE_LABEL_CODES), isRate: z.boolean(), available: z.boolean(), reason: z.string().nullable() })),
  dimensions: z.array(z.object({ name: z.enum(EXPLORE_DIMENSION_NAMES), label: z.string() })),
});

export const SavedViewInput = z.object({ name: required(80, 'Name this view'), visibility: z.enum(['private', 'team']).default('private'), definition: ExploreQuery });
export const SavedViewUpdate = z.object({ name: required(80).optional(), visibility: z.enum(['private', 'team']).optional(), definition: ExploreQuery.optional() });
export const SavedView = z.object({ id: Id, name: z.string(), visibility: z.enum(['private', 'team']), definition: z.record(z.string(), z.unknown()), mine: z.boolean(), pinned: z.boolean(), createdAt: Timestamp, updatedAt: Timestamp });
export const DashboardCard = z.object({ view: SavedView, result: ExploreResult });
export const DashboardCards = z.object({ items: z.array(DashboardCard) });

export const CustomFunnelStep = z.object({ kind: z.enum(CUSTOM_FUNNEL_STEPS), page: text(200).optional() }).superRefine((step, issues) => {
  if (step.kind === 'page_view' && !step.page) issues.addIssue({ code: 'custom', path: ['page'], message: 'Choose a page' });
});
const CustomFunnelFields = {
  name: required(80, 'Name this funnel'),
  steps: z.array(CustomFunnelStep).min(ANALYTICS_LIMITS.funnelMinSteps).max(ANALYTICS_LIMITS.funnelMaxSteps),
  countBy: z.enum(['session', 'visitor']).default('session'),
  windowMinutes: z.coerce.number().int().min(ANALYTICS_LIMITS.funnelMinWindowMinutes).max(ANALYTICS_LIMITS.funnelMaxWindowMinutes).default(1440),
};
export const CustomFunnelInput = z.object(CustomFunnelFields);
export const CustomFunnelUpdate = z.object(CustomFunnelFields).partial();
export const CustomFunnel = z.object({ id: Id, name: z.string(), steps: z.array(z.object({ kind: z.enum(CUSTOM_FUNNEL_STEPS), page: z.string().optional() })), countBy: z.enum(['session', 'visitor']), windowMinutes: z.number().int(), updatedAt: Timestamp });
export const FunnelResultsQuery = withRange(z.object({ ...RangeFields, breakdown: z.enum(EXPLORE_DIMENSION_NAMES).optional(), compare: z.enum(['none', 'previous']).default('none') }));
/** unavailable carries "Needs tier 3" in message (N-58). */
export const FunnelStepResult = z.object({ kind: z.enum(CUSTOM_FUNNEL_STEPS), page: z.string().optional(), count: Count, stepRate: z.number().nullable(), dropOff: Count.nullable(), previous: Count.nullable(), unavailable: z.boolean(), message: z.string().nullable() });
export const FunnelResults = z.object({
  funnelId: Id,
  countBy: z.enum(['session', 'visitor']),
  steps: z.array(FunnelStepResult),
  breakdown: z.array(z.object({ key: z.string(), counts: z.array(Count) })),
  source: SourceLabel,
  lastUpdatedAt: Timestamp.nullable(),
});

export const CohortQuery = withRange(z.object({ ...RangeFields, kind: z.enum(['visitors', 'buyers']).default('visitors'), groupBy: z.enum(['first_week', 'first_month', 'first_source']).default('first_week') }));
/** Counts only, never who. lowVolume shows "low volume" with no rates (N-59). */
export const CohortRow = z.object({ key: z.string(), size: Count, lowVolume: z.boolean(), rates: z.array(z.number().nullable()), repeatOrderRate: z.number().nullable(), revenuePerBuyerPaise: z.number().int().min(0).nullable() });
export const CohortResult = z.object({ kind: z.enum(['visitors', 'buyers']), groupBy: z.enum(['first_week', 'first_month', 'first_source']), periods: Count, cohorts: z.array(CohortRow), lastUpdatedAt: Timestamp.nullable() });

/** A summary file. `query` is for explore; funnelId for funnel; range for the fixed sheets. */
export const DownloadCreate = z.object({
  source: z.enum(DOWNLOAD_SOURCES),
  format: z.enum(DOWNLOAD_FORMATS).default('csv'),
  query: ExploreQuery.optional(),
  funnelId: Id.optional(),
  cohort: CohortQuery.optional(),
  from: IsoDayText.optional(),
  to: IsoDayText.optional(),
}).superRefine((value, issues) => {
  if (value.source === 'explore' && !value.query) issues.addIssue({ code: 'custom', path: ['query'], message: 'Choose a view to download' });
  if (value.source === 'funnel' && !value.funnelId) issues.addIssue({ code: 'custom', path: ['funnelId'], message: 'Choose a funnel to download' });
  if (value.source === 'cohort' && !value.cohort) issues.addIssue({ code: 'custom', path: ['cohort'], message: 'Choose a cohort to download' });
});
export const ReportDownload = z.object({ id: z.number().int().positive(), source: z.enum(DOWNLOAD_SOURCES), format: z.enum(DOWNLOAD_FORMATS), status: z.enum(DOWNLOAD_STATUSES), background: z.boolean(), rowCount: Count.nullable(), fileUrl: z.string().nullable(), createdAt: Timestamp, expiresAt: Timestamp.nullable() });

export const ReportRun = z.object({ id: z.number().int().positive(), kind: z.enum(REPORT_KINDS), periodStart: z.iso.date(), periodEnd: z.iso.date(), status: z.enum(['building', 'sent', 'failed', 'skipped']), fileUrl: z.string().nullable(), sentAt: Timestamp.nullable() });
export const ReportsQuery = ListQuery.extend({ kind: z.enum(['all', ...REPORT_KINDS]).default('all') });
export const ReportPreferences = z.object({ weekly: z.boolean(), monthly: z.boolean(), monthlyAvailable: z.boolean() });
export const ReportPreferencesUpdate = z.object({ weekly: z.boolean().optional(), monthly: z.boolean().optional() });
export const ReportUnsubscribe = z.object({ token: required(200), report: z.enum(['weekly', 'monthly', 'all']).default('all') });
export const ReportUnsubscribed = z.object({ ok: z.boolean() });

const ScheduleFields = {
  viewId: Id,
  frequency: z.enum(REPORT_FREQUENCIES).default('weekly'),
  hourOfDay: z.coerce.number().int().min(0).max(23).default(9),
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
  format: z.enum(DOWNLOAD_FORMATS).default('csv'),
  enabled: z.boolean().default(true),
};
export const ScheduledReportInput = z.object(ScheduleFields);
export const ScheduledReportUpdate = z.object({ frequency: z.enum(REPORT_FREQUENCIES).optional(), hourOfDay: z.coerce.number().int().min(0).max(23).optional(), weekday: z.coerce.number().int().min(0).max(6).optional(), dayOfMonth: z.coerce.number().int().min(1).max(28).optional(), format: z.enum(DOWNLOAD_FORMATS).optional(), enabled: z.boolean().optional() });
export const ScheduledRecipient = z.object({ id: Id, kind: z.enum(['team', 'outside']), userId: Id.nullable(), email: z.string(), addedAt: Timestamp });
export const ScheduledReport = z.object({ id: Id, viewId: Id, viewName: z.string(), frequency: z.enum(REPORT_FREQUENCIES), hourOfDay: z.number().int(), weekday: z.number().int().nullable(), dayOfMonth: z.number().int().nullable(), format: z.enum(DOWNLOAD_FORMATS), enabled: z.boolean(), nextRunAt: Timestamp, lastRunAt: Timestamp.nullable(), recipients: z.array(ScheduledRecipient) });
export const RecipientAdd = z.object({ email: Email });

export const ApiKey = z.object({ id: Id, name: z.string(), prefix: z.string(), scope: z.literal(REPORTING_SCOPE), createdAt: Timestamp, lastUsedAt: Timestamp.nullable(), revokedAt: Timestamp.nullable() });
export const ApiKeyInput = z.object({ name: required(60, 'Name this key') });
/** key is shown this once and never stored or returned again. */
export const ApiKeyCreated = ApiKey.extend({ key: z.string() });

export const reportRoutes = {
  'explore.catalog': { method: 'GET', path: '/explore/catalog', access: reader, response: ExploreCatalog },
  'explore.query': { method: 'POST', path: '/explore/query', access: reader, body: ExploreRequest, response: ExploreResult },
  'savedViews.list': { method: 'GET', path: '/saved-views', access: reader, query: ListQuery, response: page(SavedView) },
  'savedViews.create': { method: 'POST', path: '/saved-views', access: reader, body: SavedViewInput, status: 201, response: SavedView },
  'savedViews.get': { method: 'GET', path: '/saved-views/:id', access: reader, params: IdParams, response: SavedView },
  'savedViews.update': { method: 'PATCH', path: '/saved-views/:id', access: reader, params: IdParams, body: SavedViewUpdate, response: SavedView },
  'savedViews.remove': { method: 'DELETE', path: '/saved-views/:id', access: reader, params: IdParams, status: 204, response: null },
  'savedViews.pin': { method: 'POST', path: '/saved-views/:id/pin', access: reader, params: IdParams, response: SavedView },
  'savedViews.unpin': { method: 'DELETE', path: '/saved-views/:id/pin', access: reader, params: IdParams, status: 204, response: null },
  'dashboard.cards': { method: 'GET', path: '/dashboard/cards', access: reader, response: DashboardCards },
  'funnels.list': { method: 'GET', path: '/funnels', access: reader, query: ListQuery, response: page(CustomFunnel) },
  'funnels.create': { method: 'POST', path: '/funnels', access: MANAGERS, body: CustomFunnelInput, status: 201, response: CustomFunnel },
  'funnels.get': { method: 'GET', path: '/funnels/:id', access: reader, params: IdParams, response: CustomFunnel },
  'funnels.update': { method: 'PATCH', path: '/funnels/:id', access: MANAGERS, params: IdParams, body: CustomFunnelUpdate, response: CustomFunnel },
  'funnels.remove': { method: 'DELETE', path: '/funnels/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
  'funnels.results': { method: 'GET', path: '/funnels/:id/results', access: reader, params: IdParams, query: FunnelResultsQuery, response: FunnelResults },
  'cohorts.get': { method: 'GET', path: '/cohorts', access: reader, query: CohortQuery, response: CohortResult },
  'downloads.list': { method: 'GET', path: '/downloads', access: reader, query: ListQuery, response: page(ReportDownload) },
  'downloads.create': { method: 'POST', path: '/downloads', access: reader, body: DownloadCreate, status: 201, response: ReportDownload },
  'downloads.get': { method: 'GET', path: '/downloads/:id', access: reader, params: IdParams, response: ReportDownload },
  'reports.list': { method: 'GET', path: '/reports', access: reader, query: ReportsQuery, response: page(ReportRun) },
  'reports.preferences': { method: 'GET', path: '/reports/preferences', access: reader, response: ReportPreferences },
  'reports.updatePreferences': { method: 'PATCH', path: '/reports/preferences', access: reader, body: ReportPreferencesUpdate, response: ReportPreferences },
  'reports.unsubscribe': { method: 'POST', path: '/reports/unsubscribe', access: PUBLIC, body: ReportUnsubscribe, response: ReportUnsubscribed },
  'reports.get': { method: 'GET', path: '/reports/:id', access: reader, params: IdParams, response: ReportRun },
  'scheduledReports.list': { method: 'GET', path: '/scheduled-reports', access: MANAGERS, query: ListQuery, response: page(ScheduledReport) },
  'scheduledReports.create': { method: 'POST', path: '/scheduled-reports', access: MANAGERS, body: ScheduledReportInput, status: 201, response: ScheduledReport },
  'scheduledReports.update': { method: 'PATCH', path: '/scheduled-reports/:id', access: MANAGERS, params: IdParams, body: ScheduledReportUpdate, response: ScheduledReport },
  'scheduledReports.remove': { method: 'DELETE', path: '/scheduled-reports/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
  'scheduledReports.addRecipient': { method: 'POST', path: '/scheduled-reports/:id/recipients', access: OWNER_ONLY, params: IdParams, body: RecipientAdd, status: 201, response: ScheduledRecipient },
  'scheduledReports.removeRecipient': { method: 'DELETE', path: '/scheduled-report-recipients/:id', access: OWNER_ONLY, params: IdParams, status: 204, response: null },
  'apiKeys.list': { method: 'GET', path: '/api-keys', access: OWNER_ONLY, query: ListQuery, response: page(ApiKey) },
  'apiKeys.create': { method: 'POST', path: '/api-keys', access: OWNER_ONLY, fresh: true, body: ApiKeyInput, status: 201, response: ApiKeyCreated },
  'apiKeys.revoke': { method: 'DELETE', path: '/api-keys/:id', access: OWNER_ONLY, fresh: true, params: IdParams, status: 204, response: null },
};

// ---- the reporting API (7.13): outside /api/v1 and not part of `routes`, because a key, not a session, says who is calling ----

const commaList = (allowed) => z.string().max(800).transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)).pipe(z.array(z.enum(allowed)));

/** ?metrics=sessions,orders&dimensions=source&filter=source:exclude:direct&cursor=&limit=. Dates are ISO, in the business's time zone. */
export const ReportingQuery = withRange(z.object({
  metrics: commaList(EXPLORE_METRIC_NAMES).pipe(z.array(z.enum(EXPLORE_METRIC_NAMES)).min(1).max(12)),
  dimensions: commaList(EXPLORE_DIMENSION_NAMES).pipe(z.array(z.enum(EXPLORE_DIMENSION_NAMES)).max(ANALYTICS_LIMITS.exploreMaxBreakdowns)).default([]),
  filter: z.union([z.string().max(400), z.array(z.string().max(400)).max(10)]).optional(),
  ...RangeFields,
  cursor: ListQuery.shape.cursor,
  limit: z.coerce.number().int().min(1).max(ANALYTICS_LIMITS.explorePageRows).default(ANALYTICS_LIMITS.explorePageRows),
}));
export const ReportingPage = z.object({ columns: z.array(ExploreColumn), data: z.array(ExploreRow), nextCursor: z.string().nullable(), timeZone: z.string() });

/**
 * Same shape as a seller route, with auth: 'api_key' for access. Mount under REPORTING_BASE_PATH in the reports module's beforeTenant. A key is
 * found by its hash through db.platform, which names the business; a business id that isn't the key's own is a 404 and is logged (N-64).
 * Over 60 requests a minute is 429 with Retry-After (N-65). A revoked key is 401 at once (N-66). reporting.events is always refused (N-82).
 */
export const reportingRoutes = {
  'reporting.catalog': { method: 'GET', path: '/businesses/:id/catalog', auth: 'api_key', params: IdParams, response: ExploreCatalog },
  'reporting.query': { method: 'GET', path: '/businesses/:id/metrics', auth: 'api_key', params: IdParams, query: ReportingQuery, response: ReportingPage },
  'reporting.events': { method: 'GET', path: '/businesses/:id/events', auth: 'api_key', params: IdParams, refused: 'forbidden', response: null },
};
export const reportingRouteList = Object.freeze(Object.entries(reportingRoutes).map(([id, route]) => Object.freeze({ id, ...route })));
