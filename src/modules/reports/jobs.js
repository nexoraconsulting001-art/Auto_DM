import { reportError } from '../../platform/log.js';
import { REPORTING_STATUSES } from './business.js';
import { clockOf, monthlyDue, weeklyDue } from './clock.js';
import { QUEUE_DOWNLOAD } from './downloads.js';
import { MONTHLY, WEEKLY } from './periodic.js';
import { QUEUE_SCHEDULED, enqueueDueSchedules } from './scheduled.js';
import { reportServices } from './services.js';

/** The queues of this module. tick runs every minute and finds what is due; each due report is then its own job, in its own business. */
export const QUEUE_TICK = 'reports.tick';
export const QUEUE_PERIODIC = 'reports.periodic';
export const QUEUE_SWEEP = 'reports.sweep';
export const TICK_EVERY_MS = 60_000;
export const SWEEP_EVERY_MS = 15 * 60_000;
const IS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ATTEMPTS = 3;

/**
 * Every open business whose Monday 09:00 or 1st-of-the-month 09:00 has come on its own clock gets one job for that period. The job key carries the
 * business and the period, so a second worker or a second tick adds nothing; the report_runs row stops a second report even if it did.
 */
export async function tick(ctx) {
  const { db, platform, config } = ctx;
  const at = clockOf(config)();
  const businesses = await db.platform.query('SELECT id, timezone FROM tenants WHERE status = ANY($1::text[]) ORDER BY id', [REPORTING_STATUSES]);
  const due = [];
  for (const b of businesses) {
    const weekly = weeklyDue(at, b.timezone);
    if (weekly) due.push({ tenantId: b.id, kind: WEEKLY, ...weekly });
    const monthly = monthlyDue(at, b.timezone);
    if (monthly) due.push({ tenantId: b.id, kind: MONTHLY, ...monthly });
  }
  if (due.length) {
    const made = await db.platform.query(
      `SELECT tenant_id, kind, to_char(period_start, 'YYYY-MM-DD') AS period_start FROM report_runs WHERE tenant_id = ANY($1::int[]) AND kind IN ('weekly', 'monthly') AND period_start >= $2::date`,
      [[...new Set(due.map((d) => d.tenantId))], due.reduce((min, d) => (d.periodStart < min ? d.periodStart : min), due[0].periodStart)],
    );
    const done = new Set(made.map((r) => `${r.tenant_id}|${r.kind}|${r.period_start}`));
    for (const d of due) {
      if (done.has(`${d.tenantId}|${d.kind}|${d.periodStart}`)) continue;
      await platform.queue.enqueue(QUEUE_PERIODIC, { kind: d.kind, periodStart: d.periodStart, periodEnd: d.periodEnd }, {
        tenantId: d.tenantId, dedupeKey: `reports.${d.kind}:${d.tenantId}:${d.periodStart}`, maxAttempts: MAX_ATTEMPTS, retryInFlight: true,
      });
    }
  }
  await enqueueDueSchedules(ctx, at);
}

async function periodic(ctx, job) {
  const { kind, periodStart, periodEnd } = job.payload ?? {};
  if (![WEEKLY, MONTHLY].includes(kind) || !IS_DAY.test(periodStart ?? '') || !IS_DAY.test(periodEnd ?? '')) return;
  const { periodic: reports } = reportServices(ctx);
  try {
    await (kind === MONTHLY ? reports.runMonthly : reports.runWeekly)({ periodStart, periodEnd });
  } catch (err) {
    if ((job.attempt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw err;
    reportError(err, { msg: 'reports.periodic_failed', kind });
  }
}

/** The handler of each queue, for jobs() and for tests that drain a queue themselves. */
export function jobHandlers(ctx) {
  return {
    [QUEUE_TICK]: () => tick(ctx),
    [QUEUE_PERIODIC]: (job) => periodic(ctx, job),
    [QUEUE_SCHEDULED]: (job) => reportServices(ctx).scheduled.run(job),
    [QUEUE_DOWNLOAD]: (job) => reportServices(ctx).downloads.build(job),
    [QUEUE_SWEEP]: () => reportServices(ctx).downloads.sweep(),
  };
}

export function registerReportJobs(ctx) {
  const { queue } = ctx.platform;
  for (const [name, handler] of Object.entries(jobHandlers(ctx))) queue.work(name, handler);
  return async function schedule() {
    await queue.every(QUEUE_TICK, TICK_EVERY_MS);
    await queue.every(QUEUE_SWEEP, SWEEP_EVERY_MS);
  };
}
