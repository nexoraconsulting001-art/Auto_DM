import { BUSINESS_OPS_EVENTS } from '../../contracts/metrics.js';
import { withTenant, tenantId } from '../../tenancy.js';

const HOUR = 3_600_000;
const NAMES = Object.values(BUSINESS_OPS_EVENTS).map((e) => e.name);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The shape every driver gives back before it becomes BusinessOps. */
const shape = (tenant, since, until, sums, queue) => ({
  tenantId: tenant,
  since,
  until,
  errors: Math.max(0, Math.round(num(sums?.errors))),
  metaCalls: Math.max(0, Math.round(num(sums?.calls))),
  metaThrottled: Math.max(0, Math.round(num(sums?.throttled))),
  metaUsagePercent: Math.min(100, Math.max(0, num(sums?.usage))),
  queueDepth: Math.max(0, Math.round(num(queue?.depth))),
  queueOldestSeconds: Math.max(0, num(queue?.oldest)),
});

async function fromPg(db, id, since, until) {
  return withTenant(id, async () => {
    // Fenced twice: the connection is the business's own (row level security), and every statement names the business.
    const [sums] = await db.query(
      `SELECT count(*) FILTER (WHERE name = $2)::int AS errors,
              count(*) FILTER (WHERE name = $3)::int AS calls,
              count(*) FILTER (WHERE name = $3 AND props->>'result' = 'throttled')::int AS throttled,
              coalesce(max((props->>'percent')::numeric) FILTER (WHERE name = $4), 0)::float AS usage
         FROM events WHERE tenant_id = $1 AND at >= $5 AND at < $6 AND name = ANY($7::text[])`,
      [tenantId(), BUSINESS_OPS_EVENTS.error.name, BUSINESS_OPS_EVENTS.metaCall.name, BUSINESS_OPS_EVENTS.metaUsage.name, since.toISOString(), until.toISOString(), NAMES],
    );
    const [last] = await db.query(
      `SELECT (props->>'depth')::float AS depth, (props->>'oldest_seconds')::float AS oldest FROM events
        WHERE tenant_id = $1 AND name = $2 AND at >= $3 AND at < $4 ORDER BY at DESC, id DESC LIMIT 1`,
      [tenantId(), BUSINESS_OPS_EVENTS.queueDepth.name, since.toISOString(), until.toISOString()],
    );
    return shape(id, since, until, sums, last);
  });
}

/** ClickHouse, over its HTTP interface as src/platform/analytics.js does. Not run against a real server by this track's tests. */
async function fromClickhouse(config, id, since, until) {
  const base = new URL(config.clickhouseUrl);
  const auth = base.username ? `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}` : undefined;
  base.username = '';
  base.password = '';
  const ch = (d) => d.toISOString().replace('T', ' ').replace('Z', '');
  const run = async (sql) => {
    const url = new URL(base);
    url.searchParams.set('query', sql);
    url.searchParams.set('database', config.clickhouseDb || 'bhava');
    url.searchParams.set('param_t', String(id));
    url.searchParams.set('param_s', ch(since));
    url.searchParams.set('param_u', ch(until));
    const res = await fetch(url, { method: 'POST', headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse error ${res.status}`);
    return text.trim() ? JSON.parse(text.trim().split('\n')[0]) : null;
  };
  const window = 'tenant_id = {t:UInt32} AND at >= {s:DateTime64(3)} AND at < {u:DateTime64(3)}';
  const sums = await run(`SELECT countIf(name = '${BUSINESS_OPS_EVENTS.error.name}') AS errors, countIf(name = '${BUSINESS_OPS_EVENTS.metaCall.name}') AS calls,
    countIf(name = '${BUSINESS_OPS_EVENTS.metaCall.name}' AND JSONExtractString(props, 'result') = 'throttled') AS throttled,
    maxIf(JSONExtractFloat(props, 'percent'), name = '${BUSINESS_OPS_EVENTS.metaUsage.name}') AS usage FROM events WHERE ${window} FORMAT JSONEachRow`);
  const last = await run(`SELECT JSONExtractFloat(props, 'depth') AS depth, JSONExtractFloat(props, 'oldest_seconds') AS oldest FROM events
    WHERE ${window} AND name = '${BUSINESS_OPS_EVENTS.queueDepth.name}' ORDER BY at DESC LIMIT 1 FORMAT JSONEachRow`);
  return shape(id, since, until, sums, last);
}

/** One business's numbers over the last `hours` hours (BusinessOps). Reads only that business's events. */
export function readBusinessOps(ctx, id, hours, now = new Date()) {
  const until = new Date(now);
  const since = new Date(+until - hours * HOUR);
  if (ctx.platform.analytics.driver === 'clickhouse') return fromClickhouse(ctx.config, id, since, until);
  return fromPg(ctx.db, id, since, until);
}
