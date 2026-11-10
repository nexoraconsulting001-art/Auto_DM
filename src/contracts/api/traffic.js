import { z } from 'zod';
import { PAGE_KINDS, TAG_PROVIDERS, TRAFFIC_EVENT_NAMES, TRAFFIC_SOURCES } from '../analytics.js';
import { OWNER_ONLY, staffWith } from './access.js';
import { Count, Id, Paise, Timestamp, text } from './common.js';
import { RangeFields, SourceLabel, withRange } from './insights.js';

/**
 * PRD 7.10 and 7.14, answered by src/modules/traffic. Sellers get aggregates only: nothing here can name one visitor.
 * Mount the beacon and script at TRAFFIC_PATHS in the module's beforeTenant: a buyer's POST carries no CSRF token, and the
 * module finds the business with ctx.tenantResolver from the host, never from the body.
 */
const reader = staffWith('analytics');

const TrafficFields = {
  ...RangeFields,
  compare: z.enum(['none', 'previous']).default('none'),
  /** A landing slug. Another business's returns nothing and is logged (N-49). */
  page: text(200).optional(),
};
export const TrafficQuery = withRange(z.object(TrafficFields));

const Delta = z.object({ value: z.number().nullable(), previous: z.number().nullable(), change: z.number().nullable(), changePercent: z.number().nullable() });

/** A metric the plan doesn't include comes back null, with its name in notIncluded. revenuePaise is hidden the same way for staff without revenue access. */
export const TrafficSummary = z.object({
  source: SourceLabel,
  sessions: Delta,
  visitors: Delta,
  newVisitors: Delta,
  returningVisitors: Delta,
  pageViews: Delta,
  productTaps: Delta,
  outboundTaps: Delta,
  whatsappTaps: Delta,
  addToCart: Delta,
  checkoutStarted: Delta,
  orders: Delta,
  revenuePaise: Delta,
  bounceRate: Delta,
  medianEngagedMs: Delta,
  previews: Count,
  notIncluded: z.array(z.string()),
  lastUpdatedAt: Timestamp.nullable(),
});

export const TrafficSourceRow = z.object({ source: z.enum(TRAFFIC_SOURCES), referrerDomain: z.string(), sessions: Count, visitors: Count, productTaps: Count.nullable(), orders: Count.nullable(), revenuePaise: Paise.nullable() });
export const TrafficSources = z.object({ items: z.array(TrafficSourceRow), label: SourceLabel });
export const TrafficTrend = z.object({ points: z.array(z.object({ day: z.iso.date(), sessions: Count, previous: Count.nullable() })), label: SourceLabel });
export const TrafficHeatmap = z.object({ timeZone: z.string(), cells: z.array(z.object({ weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), sessions: Count })), label: SourceLabel });

export const TrafficPagesQuery = withRange(z.object({ ...TrafficFields, kind: z.enum(['all', ...PAGE_KINDS]).default('all') }));
export const TrafficPages = z.object({ items: z.array(z.object({ kind: z.enum(PAGE_KINDS), ref: z.string(), title: z.string(), views: Count, sessions: Count, taps: Count })), label: SourceLabel });

export const TRAFFIC_BREAKDOWNS = Object.freeze(['device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type', 'utm_campaign']);
export const TrafficBreakdownQuery = withRange(z.object({ ...TrafficFields, by: z.enum(TRAFFIC_BREAKDOWNS).default('device') }));
export const TrafficBreakdown = z.object({ by: z.enum(TRAFFIC_BREAKDOWNS), items: z.array(z.object({ key: z.string(), sessions: Count, orders: Count.nullable() })), label: SourceLabel });

/** The last 30 minutes, refreshed every 15 s (7.10). */
export const TrafficRealtime = z.object({
  active: Count,
  topPages: z.array(z.object({ ref: z.string(), title: z.string(), active: Count })),
  topSources: z.array(z.object({ source: z.enum(TRAFFIC_SOURCES), active: Count })),
  at: Timestamp,
});

/** What a buyer page sends to TRAFFIC_PATHS.event. Everything else about the visit is derived on the server at ingest, and the IP and user agent are dropped there. */
export const TrafficBeacon = z.object({
  name: z.enum(TRAFFIC_EVENT_NAMES),
  path: text(500),
  pageKind: z.enum(PAGE_KINDS).default('other'),
  pageRef: text(200).default(''),
  productId: Id.optional(),
  categoryId: Id.optional(),
  mediaId: z.string().regex(/^[\w-]{0,80}$/).default(''),
  outboundHost: text(253).default(''),
  valuePaise: Paise.default(0),
  eventId: z.string().regex(/^[\w-]{0,64}$/).default(''),
  referrer: text(500).default(''),
  engagedMs: z.number().int().min(0).max(86_400_000).default(0),
  utm: z.object({ source: text(200).default(''), medium: text(200).default(''), campaign: text(200).default(''), content: text(200).default('') }).default({ source: '', medium: '', campaign: '', content: '' }),
  src: text(40).default(''),
});

/** Secrets are never returned: only whether one is set. available is false below tier 2. */
export const TagSettings = z.object({
  available: z.boolean(),
  meta: z.object({ enabled: z.boolean(), pixelId: z.string(), capiTokenSet: z.boolean() }),
  ga4: z.object({ enabled: z.boolean(), measurementId: z.string(), apiSecretSet: z.boolean() }),
  consentReady: z.boolean(),
});
export const TagSettingsUpdate = z.object({
  meta: z.object({ enabled: z.boolean().optional(), pixelId: z.string().regex(/^\d{5,20}$/, 'Enter the Pixel ID').optional(), capiToken: z.string().trim().min(10).max(400).optional() }).optional(),
  ga4: z.object({ enabled: z.boolean().optional(), measurementId: z.string().regex(/^G-[A-Z0-9]{4,20}$/, 'Enter the measurement ID').optional(), apiSecret: z.string().trim().min(10).max(200).optional() }).optional(),
});
export const TagHealth = z.object({
  items: z.array(z.object({ provider: z.enum(TAG_PROVIDERS), enabled: z.boolean(), sent: Count, failed: Count, failedDaysInARow: Count, lastError: z.string(), lastErrorAt: Timestamp.nullable() })),
});

export const trafficRoutes = {
  'traffic.summary': { method: 'GET', path: '/traffic/summary', access: reader, query: TrafficQuery, response: TrafficSummary },
  'traffic.sources': { method: 'GET', path: '/traffic/sources', access: reader, query: TrafficQuery, response: TrafficSources },
  'traffic.trend': { method: 'GET', path: '/traffic/trend', access: reader, query: TrafficQuery, response: TrafficTrend },
  'traffic.heatmap': { method: 'GET', path: '/traffic/heatmap', access: reader, query: TrafficQuery, response: TrafficHeatmap },
  'traffic.pages': { method: 'GET', path: '/traffic/pages', access: reader, query: TrafficPagesQuery, response: TrafficPages },
  'traffic.breakdown': { method: 'GET', path: '/traffic/breakdown', access: reader, query: TrafficBreakdownQuery, response: TrafficBreakdown },
  'traffic.realtime': { method: 'GET', path: '/traffic/realtime', access: reader, response: TrafficRealtime },
  'tags.get': { method: 'GET', path: '/tags', access: OWNER_ONLY, response: TagSettings },
  'tags.update': { method: 'PATCH', path: '/tags', access: OWNER_ONLY, body: TagSettingsUpdate, response: TagSettings },
  'tags.health': { method: 'GET', path: '/tags/health', access: reader, response: TagHealth },
};
