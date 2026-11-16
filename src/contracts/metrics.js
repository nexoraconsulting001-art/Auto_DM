import { z } from 'zod';

/**
 * Every metric the code emits at /metrics (Phase 9): its name, type and labels, with the values a label may take. The
 * contract test reads the source and fails on a metric that is not here, and the monitoring track's tests fail on an
 * alert rule or a dashboard that names a metric that is neither here nor in EXTERNAL_METRICS (G-06, G-07).
 *
 * Rules:
 * - A label's values are bounded: a fixed list, or a pattern with a ceiling on how many values exist. No label ever
 *   names a business, a person, an account, an address or free text (FORBIDDEN_LABELS). A business appears in /metrics
 *   only as a member of a bounded class: its plan, its account type.
 * - Per-business numbers (errors, Meta calls and usage, queue depth, for the Platform Console, G-14) are not metrics.
 *   They are analytics events (BUSINESS_OPS_EVENTS), written as the business through platform.analytics.track() and read
 *   through its rollups, so the fence keeps one business's numbers from another's and nothing grows without bound.
 * - `since` is the phase that first emits it: 0 is there today; 9 is this phase's tracks (runtime, monitoring).
 */
export const METRIC_TYPES = Object.freeze(['counter', 'gauge', 'histogram']);

/** Labels and what each may hold. `values` is the whole set; `pattern` with `max` bounds an open one. */
export const METRIC_LABELS = Object.freeze({
  method: { values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
  // The route class: the first path segment when it is a short lower-case word, else `other` (src/platform/metrics.js).
  group: { pattern: /^[a-z-]{1,20}$/, max: 80 },
  status: { pattern: /^[1-5]\d\d$/, max: 60 },
  queue: { pattern: /^[a-z][a-z0-9_.-]{0,40}$/, max: 80 },
  // Job states of the queue (stats() in src/platform/queue.js): `queued` (ready now), `delayed` (waiting for its time), `running`, `failed`, `unknown`.
  state: { values: ['queued', 'delayed', 'running', 'failed', 'unknown', 'idle', 'used', 'waiting'] },
  result: { pattern: /^[a-z][a-z0-9_]{0,30}$/, max: 40 },
  provider: { values: ['meta', 'whatsapp', 'razorpay', 'razorpay_billing', 'shiprocket', 'shopify', 'google', 'apple', 'email', 'ai', 'fcm', 'apns', 'eas', 'appstore', 'play', 'ga4'] },
  channel: { values: ['instagram', 'facebook', 'whatsapp'] },
  outcome: { values: ['sent', 'queued', 'blocked', 'skipped', 'failed'] },
  // The part of a reason code before its first dot (src/contracts/compliance.js): window, cap, paused, optout, token, ...
  family: { pattern: /^[a-z][a-z_]{0,20}$/, max: 30 },
  call_class: { values: ['send', 'read', 'insights', 'token', 'subscribe', 'media', 'other'] },
  pool: { values: ['app', 'owner'] },
  plan: { pattern: /^[a-z][a-z0-9_]{0,20}$/, max: 12 },
  service: { values: ['web', 'worker'] },
  kind: { pattern: /^[a-z][a-z0-9_]{0,30}$/, max: 40 },
});

/** Never a label, under any name. */
export const FORBIDDEN_LABELS = Object.freeze(['tenant', 'tenant_id', 'business', 'slug', 'shop', 'user', 'user_id', 'username', 'phone', 'email', 'ig_user_id', 'account', 'host', 'domain', 'ip', 'path', 'url', 'text', 'message', 'token', 'order', 'request_id']);

const metric = (type, labels, help, since = 9) => Object.freeze({ type, labels: Object.freeze(labels), help, since });

export const METRICS = Object.freeze({
  // Requests, by route class and status.
  http_requests_total: metric('counter', ['method', 'group', 'status'], 'Requests answered', 0),
  http_request_seconds: metric('histogram', ['group'], 'Time to answer a request', 0),
  http_requests_in_flight: metric('gauge', ['service'], 'Requests being answered now'),
  // The queue.
  queue_jobs: metric('gauge', ['queue', 'status'], 'Jobs by queue and state', 0),
  queue_oldest_job_seconds: metric('gauge', ['queue'], 'Age of the oldest job waiting'),
  job_failures_total: metric('counter', ['queue'], 'Jobs that failed a run'),
  job_runs_total: metric('counter', ['queue', 'result'], 'Jobs run, by result'),
  // Webhooks: received, written down, and worked through.
  webhook_comments_total: metric('counter', ['result'], 'Comment webhooks handled (Phase 0 path)', 0),
  webhook_received_total: metric('counter', ['provider', 'result'], 'Webhook requests received; result is accepted, bad_signature or refused'),
  webhook_stored_total: metric('counter', ['provider'], 'Webhook events stored before the 200'),
  webhook_processed_total: metric('counter', ['provider', 'result'], 'Stored webhook events worked through'),
  // The compliance gate.
  compliance_outcomes_total: metric('counter', ['channel', 'outcome', 'family'], 'Send decisions, by the family of the reason'),
  sends_accepted_total: metric('counter', ['channel'], 'Messages a provider accepted'),
  // Outside services.
  meta_calls_total: metric('counter', ['call_class', 'result'], 'Calls to Meta'),
  meta_usage_ratio: metric('gauge', ['call_class'], 'Highest share of a Meta rate limit in use, 0 to 1, over every account'),
  provider_calls_total: metric('counter', ['provider', 'result'], 'Calls to every other outside service'),
  // Housekeeping.
  backup_last_success_seconds: metric('gauge', [], 'When the last backup finished, as a Unix time', 0),
  backup_age_seconds: metric('gauge', [], 'Seconds since the last backup finished'),
  db_pool_connections: metric('gauge', ['pool', 'state'], 'Database connections by pool and state'),
  secret_refresh_failures_total: metric('counter', [], 'Refreshes of the secret source that failed; the last good values stayed'),
  secret_rewrap_rows_total: metric('counter', ['result'], 'Stored secrets moved to the current master key'),
  errors_reported_total: metric('counter', ['service', 'kind'], 'Errors passed to reportError'),
  process_draining: metric('gauge', ['service'], '1 while the process is shutting down'),
  businesses: metric('gauge', ['plan', 'state'], 'Businesses by plan and status'),
});

/** `queue_jobs` and `businesses` use the label name `status`/`state` for a job or business state, not an HTTP status. */
export const LABEL_OVERRIDES = Object.freeze({
  queue_jobs: { status: METRIC_LABELS.state },
  businesses: { state: { pattern: /^[a-z_]{1,20}$/, max: 12 } },
});

/** Metrics that come from the monitoring stack itself, which alert rules and dashboards may also name. */
export const EXTERNAL_METRICS = Object.freeze(['up', 'probe_success', 'probe_duration_seconds', 'probe_http_status_code', 'probe_ssl_earliest_cert_expiry', 'ALERTS']);

/** The names a rule or a dashboard may use: every metric, a histogram's three series, and the external ones. */
export function metricSeriesNames() {
  const names = new Set(EXTERNAL_METRICS);
  for (const [name, def] of Object.entries(METRICS)) {
    if (def.type === 'histogram') for (const suffix of ['_bucket', '_sum', '_count']) names.add(`${name}${suffix}`);
    else names.add(name);
  }
  return names;
}

/** Why a metric with these labels may not be emitted, or null. For tests and for a strict metrics driver. */
export function metricProblem(name, labels = {}) {
  const def = METRICS[name];
  if (!def) return `${name} is not in the catalogue`;
  for (const [label, value] of Object.entries(labels)) {
    if (FORBIDDEN_LABELS.includes(label)) return `${name} has the label ${label}`;
    if (!def.labels.includes(label)) return `${name} does not take the label ${label}`;
    const rule = LABEL_OVERRIDES[name]?.[label] ?? METRIC_LABELS[label];
    if (!rule) return `${label} is not a known label`;
    const ok = rule.values ? rule.values.includes(String(value)) : rule.pattern.test(String(value));
    if (!ok) return `${name} has a value of ${label} outside its set`;
  }
  return null;
}

/**
 * Per-business operating numbers (G-14): analytics events, tracked inside withTenant(). Each has the properties it may
 * carry, all of them classes or numbers. The Platform Console's route platform.businessOps reads them.
 */
export const BUSINESS_OPS_EVENTS = Object.freeze({
  error: Object.freeze({ name: 'ops.error', props: ['service', 'kind'] }),
  metaCall: Object.freeze({ name: 'ops.meta_call', props: ['call_class', 'result'] }),
  metaUsage: Object.freeze({ name: 'ops.meta_usage', props: ['call_class', 'percent'] }),
  queueDepth: Object.freeze({ name: 'ops.queue_depth', props: ['queue', 'depth', 'oldest_seconds'] }),
});

/** What platform.businessOps answers for one business over a window. Numbers only. */
export const BusinessOps = z.object({
  tenantId: z.number().int().positive(),
  since: z.coerce.date(),
  until: z.coerce.date(),
  errors: z.number().int().min(0),
  metaCalls: z.number().int().min(0),
  metaThrottled: z.number().int().min(0),
  metaUsagePercent: z.number().min(0).max(100),
  queueDepth: z.number().int().min(0),
  queueOldestSeconds: z.number().min(0),
});

/**
 * The document the error sink posts (src/platform/error-sink.js), field for field. There is no message, body, header
 * or address among them, and the sink sends nothing else.
 */
export const ERROR_EVENT_FIELDS = Object.freeze(['time', 'service', 'release', 'event', 'errorClass', 'code', 'frames', 'requestId', 'tenantId', 'route']);
export const ErrorEvent = z.strictObject({
  time: z.string(),
  service: z.enum(['web', 'worker']),
  release: z.string().max(80),
  event: z.string().max(80),
  errorClass: z.string().max(80),
  code: z.string().max(80).nullable(),
  frames: z.array(z.strictObject({ fn: z.string().max(80), file: z.string().max(160), line: z.number().int() })).max(20),
  requestId: z.string().max(64).nullable(),
  tenantId: z.number().int().positive().nullable(),
  route: z.string().max(80).nullable(),
});

/** The uptime objective (G-13): the share of good probes in a 30-day window, and the burn rates that page and warn. */
export const UPTIME_SLO = Object.freeze({
  objective: 0.995,
  windowDays: 30,
  probes: Object.freeze(['webhook', 'shopper_page']),
  burnAlerts: Object.freeze([
    Object.freeze({ severity: 'page', longWindow: '1h', shortWindow: '5m', burnRate: 14.4 }),
    Object.freeze({ severity: 'page', longWindow: '6h', shortWindow: '30m', burnRate: 6 }),
    Object.freeze({ severity: 'ticket', longWindow: '3d', shortWindow: '6h', burnRate: 1 }),
  ]),
});
