import { METERED_SEND_KINDS, usageMonthOf } from '../../contracts/billing.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { createMeter, monthBounds, previousMonth } from './meter.js';
import { createPassThrough } from './pass-through.js';
import { createStatements } from './statements.js';

export const USAGE_JOBS = Object.freeze({
  alerts: 'usage.alerts',
  monthReset: 'usage.month_reset',
  reconcile: 'usage.reconcile',
  passThrough: 'usage.pass_through',
  statements: 'usage.statements',
  statement: 'usage.statement',
});

/**
 * One usage service per app or worker context: the meter, pass-through charges, statements, and the sweeps the worker
 * runs across businesses. The sweeps look across businesses through db.platform and leave the demo business out
 * (counted_tenants); everything they do for a business runs inside that business.
 */
export function createUsage({ db, config = {}, notify = null, compliance = null, providers = {}, platform = {} }) {
  const meter = createMeter({ db, config, notify, compliance });
  const passThrough = createPassThrough({ db });
  const statements = createStatements({ db, providers, storage: platform.storage ?? null, queue: platform.queue ?? null, now: meter.now });

  async function eachBusiness(ids, fn, msg) {
    let done = 0;
    for (const tenant of ids) {
      try {
        await withTenant(tenant, fn);
        done++;
      } catch (err) {
        reportError(err, { msg, tenant });
      }
    }
    return done;
  }

  /** The 80% and 100% marks for every business with DMs this month and the 100% alert not yet sent: a downgrade mid-month is caught here. */
  async function sweepAlerts() {
    const month = usageMonthOf(meter.now());
    const rows = await db.platform.query(
      `SELECT u.tenant_id FROM usage_months u JOIN counted_tenants t ON t.id = u.tenant_id WHERE u.meter = 'dms' AND u.month = $1::date AND u.alert_100_at IS NULL`,
      [month],
    );
    return eachBusiness(rows.map((r) => r.tenant_id), () => meter.checkAlerts(), 'usage.alerts_failed');
  }

  /** Businesses with DMs held for the limit get them back when there is room: a new month, a pack, an upgrade. */
  async function sweepHeld() {
    const rows = await db.platform.query(
      `SELECT DISTINCT j.tenant_id FROM outbound_jobs j JOIN counted_tenants t ON t.id = j.tenant_id WHERE j.status = 'held' AND j.reason = 'held.dm_limit'`,
    );
    let released = 0;
    await eachBusiness(rows.map((r) => r.tenant_id), async () => {
      released += await meter.allowanceChanged();
    }, 'usage.release_failed');
    if (released) log.info('usage.released', { jobs: released });
    return released;
  }

  /**
   * A send Meta accepted whose usage row is missing (its listener failed, or the process stopped between the two writes)
   * is counted here, under the same key, so it is counted once whichever writes it. Only the last two days, so nothing
   * sent before metering existed is counted.
   */
  async function sweepUncounted({ limit = 1000 } = {}) {
    const at = meter.now();
    const rows = await db.platform.query(
      `SELECT j.tenant_id, j.id, j.channel, j.sent_at FROM outbound_jobs j JOIN counted_tenants t ON t.id = j.tenant_id
       WHERE j.status IN ('sent', 'sent_fallback') AND j.kind = ANY($1::text[]) AND NOT j.is_test AND j.purpose <> 'test'
         AND j.sent_at >= $2::timestamptz AND j.sent_at < $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.tenant_id = j.tenant_id AND e.idempotency_key = 'dm:' || j.id::text)
       ORDER BY j.sent_at LIMIT $4`,
      [[...METERED_SEND_KINDS], new Date(+at - 2 * 86_400_000), new Date(+at - 2 * 60_000), limit],
    );
    let counted = 0;
    for (const job of rows) {
      try {
        await withTenant(job.tenant_id, async () => {
          if (await meter.accepted({ tenantId: job.tenant_id, jobId: Number(job.id), key: `dm:${job.id}`, channel: job.channel, kind: 'dm', purpose: 'reconcile', at: job.sent_at })) counted++;
        });
      } catch (err) {
        reportError(err, { msg: 'usage.reconcile_failed', tenant: job.tenant_id, job: Number(job.id) });
      }
    }
    if (counted) log.info('usage.reconciled', { counted });
    return counted;
  }

  /** Pass-through charges for last month (final) and this month (so far), for every business with something to pass on. */
  async function sweepPassThrough() {
    const month = usageMonthOf(meter.now());
    const prev = previousMonth(month);
    const rows = await db.platform.query(
      `SELECT DISTINCT x.tenant_id FROM (
         SELECT tenant_id FROM usage_months WHERE month >= $1::date AND meter <> 'dms'
         UNION SELECT tenant_id FROM settlement_lines WHERE occurred_at >= $2::timestamptz
       ) x JOIN counted_tenants t ON t.id = x.tenant_id`,
      [prev, monthBounds(prev).start],
    );
    return eachBusiness(rows.map((r) => r.tenant_id), async () => {
      await passThrough.collect(prev);
      await passThrough.collect(month);
    }, 'usage.pass_through_failed');
  }

  /**
   * Every business on the default payment or shipping path gets last month's statement made, through the queue. Only a
   * business that existed in that month, or has money lines in it, gets one (D1-1, F-83): a business that signed up after
   * the month closed was given an empty statement for a month it was never in.
   */
  async function sweepStatements() {
    const month = previousMonth(usageMonthOf(meter.now()));
    const { start, end } = monthBounds(month);
    const rows = await db.platform.query(
      `SELECT t.id FROM counted_tenants t
       WHERE (EXISTS (SELECT 1 FROM payment_settings p WHERE p.tenant_id = t.id AND p.mode = 'managed' AND p.linked_account_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM shipping_settings s WHERE s.tenant_id = t.id AND s.mode = 'managed'))
         AND (t.created_at < $3::timestamptz OR EXISTS (SELECT 1 FROM settlement_lines l WHERE l.tenant_id = t.id AND l.occurred_at >= $2::timestamptz AND l.occurred_at < $3::timestamptz))
         AND NOT EXISTS (SELECT 1 FROM settlement_statements s WHERE s.tenant_id = t.id AND s.month = $1::date AND s.sent_at IS NOT NULL AND s.reconciliation <> 'pending')`,
      [month, start.toISOString(), end.toISOString()],
    );
    if (!platform.queue) return 0;
    for (const { id } of rows) await platform.queue.enqueue(USAGE_JOBS.statement, { month }, { tenantId: id });
    return rows.length;
  }

  return { meter, passThrough, statements, sweepAlerts, sweepHeld, sweepUncounted, sweepPassThrough, sweepStatements };
}
