import { PROD_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { BUSINESS_OPS_EVENTS } from '../../contracts/metrics.js';
import { log, onError } from '../../platform/log.js';
import { onProviderCall } from '../../adapters/http.js';
import { errorKind, instrumentQueue, metaCallClass, metaCallResult } from '../../platform/metrics.js';
import { currentTenant, withTenant } from '../../tenancy.js';
import { Refusal, mountRoute } from '../platform-console/mount.js';
import { readBusinessOps } from './read.js';

/**
 * Monitoring's side of the code (Phase 9; G-04 to G-07, G-14). Track: prod-observability. Registered as `business-ops`
 * (src/modules/business-ops/index.js hands over to this).
 *
 * What the whole platform shows at /metrics (bounded labels only, METRICS in src/contracts/metrics.js):
 *   meta_calls_total, meta_usage_ratio     from onMetaCall: the class of the call and how it ended; the highest share of a limit used in the last 10 minutes
 *   errors_reported_total                  from every reportError(): the service and the first part of the log entry's name
 *   job_runs_total, job_failures_total     from the queue's drain()
 *   provider_calls_total                   from onProviderCall: every call through src/adapters/http.js, by provider and result
 *   queue_oldest_job_seconds               the age of the oldest job waiting, per queue
 *   db_pool_connections                    connections to the database by pool and state, as the database counts them
 *   businesses                             by plan and status (web only, so a sum over both services is not doubled)
 *   process_draining
 *
 * What one business sees, as analytics events in its own name (BUSINESS_OPS_EVENTS), never as labels:
 *   ops.error, ops.meta_call, ops.meta_usage    when a business is current where the thing happens
 *   ops.queue_depth                             sampled every 5 minutes for a business with jobs waiting, and once more when it clears
 *
 *   platform.businessOps   GET /tenants/:id/ops?hours=24    for the Platform Console (console/src/platform/features/observability)
 *
 * Nothing here holds a message, name, phone, address, token or key: calls are counted by class and result, errors by kind.
 */
const PLATFORM = PROD_PLATFORM_OWNERS['business-ops'];
export const SAMPLE_EVERY_MS = 5 * 60_000;
const USAGE_WINDOW_MINUTES = 10;
const MINUTE = 60_000;

const states = new WeakMap();

/** What this module keeps for one platform (web and worker each have their own). */
function stateFor(ctx) {
  const key = ctx.platform;
  if (!states.has(key)) states.set(key, { usage: new Map(), queued: new Set(), wired: false, next: 0 });
  return states.get(key);
}

const serviceOf = (ctx) => ctx.service ?? (ctx.tenantResolver ? 'web' : 'worker');
const pick = (props, keys) => Object.fromEntries(keys.filter((k) => props[k] !== undefined).map((k) => [k, props[k]]));

/** Writes one of BUSINESS_OPS_EVENTS as the current business (or `as`), never blocking and never failing the caller. */
function record(ctx, event, props, as = null) {
  const write = () => ctx.platform.analytics.track(event.name, pick(props, event.props));
  const run = as ? () => withTenant(as, write) : currentTenant() ? write : null;
  if (!run) return;
  Promise.resolve()
    .then(run)
    .catch((err) => log.warn('ops_metrics.write_failed', { code: err?.code }));
}

/** The highest share of a limit used in the last ten minutes, per call class, 0 to 1. */
function usageRatios(state, now) {
  const rows = [];
  const floor = Math.floor(now / MINUTE) - USAGE_WINDOW_MINUTES;
  for (const [call_class, minutes] of state.usage) {
    let high = null;
    for (const [minute, percent] of minutes) {
      if (minute <= floor) minutes.delete(minute);
      else high = Math.max(high ?? 0, percent);
    }
    if (high !== null) rows.push({ labels: { call_class }, value: Math.min(1, high / 100) });
  }
  return rows;
}

/** pg_stat_activity as pool and state: connections of the owner's login are `owner`, any other login `app`; idle, else used. */
export async function readConnections(db) {
  const [{ me }] = await db.platform.query('SELECT current_user AS me');
  const rows = await db.platform.query('SELECT usename, state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state IS NOT NULL GROUP BY 1, 2');
  const totals = new Map();
  for (const row of rows) {
    const pool = row.usename === me ? 'owner' : 'app';
    const state = row.state === 'idle' ? 'idle' : 'used';
    totals.set(`${pool}|${state}`, (totals.get(`${pool}|${state}`) ?? 0) + Number(row.n));
  }
  return [...totals].map(([k, value]) => {
    const [pool, state] = k.split('|');
    return { labels: { pool, state }, value };
  });
}

export function createOpsMetrics(ctx, { now = () => Date.now() } = {}) {
  const { metrics, analytics } = ctx.platform;
  const state = stateFor(ctx);
  const service = serviceOf(ctx);

  return {
    /** Registers the instruments once per platform: gauges, the queue's counters and the error hook. */
    wire() {
      if (state.wired || !metrics) return;
      state.wired = true;
      const platformDb = ctx.db?.platform;
      if (platformDb) {
        metrics.gauge('queue_oldest_job_seconds', async () => {
          const rows = await platformDb.query("SELECT queue, extract(epoch FROM now() - min(run_at))::float AS age FROM jobs WHERE status = 'queued' AND run_at <= now() GROUP BY queue");
          return rows.map((r) => ({ labels: { queue: r.queue }, value: Math.max(0, Number(r.age)) }));
        });
        metrics.gauge('db_pool_connections', () => readConnections(ctx.db));
        if (service === 'web') {
          metrics.gauge('businesses', async () => {
            const rows = await platformDb.query('SELECT plan, status, count(*)::int AS n FROM tenants GROUP BY 1, 2');
            return rows.map((r) => ({ labels: { plan: r.plan, state: r.status }, value: Number(r.n) }));
          });
        }
      }
      metrics.gauge('meta_usage_ratio', () => usageRatios(state, now()));
      metrics.gauge('process_draining', () => [{ labels: { service }, value: ctx.platform.health?.draining ? 1 : 0 }]);
      instrumentQueue(metrics, ctx.platform.queue);
      onError((_err, context = {}) => this.error(context));
      // Every call to another outside service through the shared adapter (src/adapters/http.js), by provider and result.
      onProviderCall(({ provider, result }) => metrics.inc('provider_calls_total', { provider, result }));
    },

    /** One error passed to reportError(): counted by kind, and put in its business's own numbers when it has one. */
    error(context = {}) {
      const kind = errorKind(context.msg);
      metrics.inc('errors_reported_total', { service, kind });
      if (Number.isInteger(context.tenantId)) record(ctx, BUSINESS_OPS_EVENTS.error, { service, kind }, context.tenantId);
    },

    /** One call to Meta, with the current business when it had one. */
    metaCall(call) {
      const call_class = metaCallClass(call);
      const result = metaCallResult(call);
      metrics.inc('meta_calls_total', { call_class, result });
      record(ctx, BUSINESS_OPS_EVENTS.metaCall, { call_class, result });
      const percent = Number(call.usage?.percent);
      if (Number.isFinite(percent) && percent >= 0) {
        const minutes = state.usage.get(call_class) ?? new Map();
        const minute = Math.floor(now() / MINUTE);
        minutes.set(minute, Math.max(minutes.get(minute) ?? 0, percent));
        state.usage.set(call_class, minutes);
        record(ctx, BUSINESS_OPS_EVENTS.metaUsage, { call_class, percent: Math.round(percent) });
      }
    },

    /**
     * Writes the depth and age of each business's waiting jobs, for every business that has some and for one that had some
     * the last time (so a queue that cleared shows as cleared). Finding them needs the unfenced connection; each write is that business's own.
     */
    async sampleQueues() {
      const rows = await ctx.db.platform.query(
        `SELECT tenant_id, count(*)::int AS depth, greatest(0, extract(epoch FROM now() - min(run_at)))::float AS oldest
           FROM jobs WHERE status = 'queued' AND run_at <= now() AND tenant_id IS NOT NULL GROUP BY tenant_id`,
      );
      const waiting = new Set();
      for (const row of rows) {
        waiting.add(row.tenant_id);
        await withTenant(row.tenant_id, () => analytics.track(BUSINESS_OPS_EVENTS.queueDepth.name, { queue: 'all', depth: Number(row.depth), oldest_seconds: Math.round(Number(row.oldest)) }));
      }
      for (const id of state.queued) {
        if (!waiting.has(id)) await withTenant(id, () => analytics.track(BUSINESS_OPS_EVENTS.queueDepth.name, { queue: 'all', depth: 0, oldest_seconds: 0 })).catch(() => {});
      }
      state.queued = waiting;
      return rows.length;
    },
  };
}

export const opsMetrics = {
  name: 'ops-metrics',
  owns: { migrations: [], tables: [], api: [], store: [], platform: PLATFORM, jobs: [] },

  setup(ctx) {
    if (ctx.platform?.metrics) createOpsMetrics(ctx).wire();
  },

  onMetaCall(call, ctx) {
    if (ctx.platform?.metrics) createOpsMetrics(ctx).metaCall(call);
  },

  /** Sampled every 5 minutes by the worker; a failed sample is logged and tried again at the next one. */
  jobs(ctx) {
    const state = stateFor(ctx);
    state.next = Date.now() + SAMPLE_EVERY_MS;
    let running = false;
    return async function schedule() {
      if (running || Date.now() < state.next) return;
      running = true;
      state.next = Date.now() + SAMPLE_EVERY_MS;
      try {
        await createOpsMetrics(ctx).sampleQueues();
      } catch (err) {
        log.warn('ops_metrics.sample_failed', { code: err?.code });
      } finally {
        running = false;
      }
    };
  },

  platformRoutes(router, ctx) {
    mountRoute(router, 'platform.businessOps', async ({ params, query }) => {
      const [found] = await ctx.db.platform.query('SELECT id FROM tenants WHERE id = $1', [params.id]);
      if (!found) throw new Refusal(404, 'Not found.');
      return readBusinessOps(ctx, found.id, query.hours);
    });
  },
};
