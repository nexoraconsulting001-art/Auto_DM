import { ANALYTICS_LIMITS as L, FIGURE_TEXT } from '../../contracts/analytics.js';
import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { PAID_STATUSES } from './sessions.js';
import { addDays, dayStart, rangeOf, timeZoneOf } from './time.js';

const MAX_PERIODS = 12;
const round4 = (value) => Number(value.toFixed(4));

/** Cohorts by first visit or first order (7.12). Visitor ids are used inside the query only; what comes back is counts. */
export function createCohorts(ctx, rollupService) {
  const { db, repos } = ctx;

  async function visitorCohorts({ groupBy }, bounds, timeZone) {
    const unit = groupBy === 'first_month' ? 'month' : 'week';
    const baseOf = `date_trunc('${unit}', first_local)`;
    const key = groupBy === 'first_source' ? 'first_source' : groupBy === 'first_month' ? `to_char(first_local, 'YYYY-MM')` : `to_char(${baseOf}, 'YYYY-MM-DD')`;
    const when = `date_trunc('${unit}', e.at AT TIME ZONE $4)`;
    const offset = unit === 'month'
      ? `((extract(year FROM ${when})::int * 12 + extract(month FROM ${when})::int) - (extract(year FROM c.base)::int * 12 + extract(month FROM c.base)::int))`
      : `floor(extract(epoch FROM (${when} - c.base)) / 604800)::int`;
    const rows = await db.query(
      `WITH v AS (SELECT visitor_id, first_seen_at AT TIME ZONE $4 AS first_local, first_source FROM traffic_visitors WHERE tenant_id = $1 AND first_seen_at >= $2::timestamptz AND first_seen_at < $3::timestamptz),
            c AS (SELECT visitor_id, ${key} AS key, ${baseOf} AS base FROM v),
            sizes AS (SELECT key, count(*)::int AS size FROM c GROUP BY key),
            a AS (SELECT DISTINCT c.key, c.visitor_id, ${offset} AS period FROM c JOIN traffic_events e ON e.tenant_id = $1 AND e.visitor_id = c.visitor_id AND e.at >= $2::timestamptz)
       SELECT s.key, s.size, a.period, count(a.visitor_id)::int AS n FROM sizes s LEFT JOIN a ON a.key = s.key AND a.period > 0 GROUP BY s.key, s.size, a.period ORDER BY s.key, a.period`,
      [tenantId(), bounds.from, bounds.to, timeZone],
    );
    const groups = new Map();
    let periods = 0;
    for (const row of rows) {
      if (!groups.has(row.key)) groups.set(row.key, { key: row.key, size: row.size, counts: new Map() });
      if (row.period) {
        groups.get(row.key).counts.set(row.period, row.n);
        periods = Math.max(periods, Math.min(row.period, MAX_PERIODS));
      }
    }
    const cohorts = [...groups.values()].map((group) => {
      const lowVolume = group.size < L.cohortLowVolume;
      return {
        key: group.key, size: group.size, lowVolume,
        rates: Array.from({ length: periods }, (_v, i) => (lowVolume ? null : round4((group.counts.get(i + 1) ?? 0) / group.size))),
        repeatOrderRate: null, revenuePerBuyerPaise: null,
      };
    });
    return { periods, cohorts };
  }

  async function buyerCohorts({ groupBy }, bounds, timeZone) {
    const unit = groupBy === 'first_week' ? 'week' : 'month';
    const key = unit === 'week' ? `to_char(date_trunc('week', first_at AT TIME ZONE $5), 'YYYY-MM-DD')` : `to_char(first_at AT TIME ZONE $5, 'YYYY-MM')`;
    const rows = await db.query(
      `WITH paid AS (SELECT COALESCE(user_id::text, md5(phone)) AS buyer, created_at, total_paise FROM orders WHERE tenant_id = $1 AND status = ANY($2::text[])),
            buyers AS (SELECT buyer, min(created_at) AS first_at, count(*)::int AS orders, sum(total_paise)::bigint AS spent FROM paid GROUP BY buyer)
       SELECT ${key} AS key, count(*)::int AS size, count(*) FILTER (WHERE orders >= 2)::int AS repeaters, COALESCE(sum(spent), 0)::bigint AS revenue
       FROM buyers WHERE first_at >= $3::timestamptz AND first_at < $4::timestamptz GROUP BY 1 ORDER BY 1`,
      [tenantId(), PAID_STATUSES, bounds.from, bounds.to, timeZone],
    );
    const cohorts = rows.map((row) => {
      const lowVolume = row.size < L.cohortLowVolume;
      return { key: row.key, size: row.size, lowVolume, rates: [], repeatOrderRate: lowVolume ? null : round4(row.repeaters / row.size), revenuePerBuyerPaise: lowVolume ? null : Math.round(Number(row.revenue) / row.size) };
    });
    return { periods: 0, cohorts };
  }

  async function get(query) {
    if (query.kind === 'buyers' && !await repos.entitlements.can('cohorts.buyers')) throw new ApiError('forbidden', FIGURE_TEXT.needsTier3);
    const timeZone = await timeZoneOf(db);
    const range = rangeOf(query, await rollupService.today());
    const bounds = { from: dayStart(range.since, timeZone), to: dayStart(addDays(range.until, 1), timeZone) };
    const { periods, cohorts } = query.kind === 'buyers' ? await buyerCohorts(query, bounds, timeZone) : await visitorCohorts(query, bounds, timeZone);
    return { kind: query.kind, groupBy: query.groupBy, periods, cohorts, lastUpdatedAt: new Date().toISOString() };
  }

  return { get };
}
