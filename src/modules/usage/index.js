import { isAllowed, OWNER_ONLY } from '../../contracts/api/access.js';
import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { reportError } from '../../platform/log.js';
import { USAGE_JOBS, createUsage } from './service.js';
import { parseStatementRef } from './statements.js';

export { USAGE_JOBS } from './service.js';
export { monthBounds, previousMonth } from './meter.js';
export { statementFilePath, toStatement } from './statements.js';

/**
 * The meters (PRD 5.12): DMs, WhatsApp messages and AI units per business and calendar month in India; the hold at 100%;
 * the 80% and 100% alerts; pass-through charges; the monthly settlement statement. Owns usage_events and usage_months (701),
 * and writes pass_through_charges and settlement_statements.
 *
 *   setup(ctx)        app and worker: compliance.onAccepted counts each accepted private reply or DM once (meter 'dms', or
 *                     'whatsapp_messages' for the WhatsApp channel), and compliance.useQuota holds automated DMs at 100%.
 *   billing.usage     the live meters.
 *   jobs              usage.alerts (10 min), usage.month_reset (every minute: held DMs back, as many as fit), usage.reconcile (10 min), usage.pass_through (hourly),
 *                     usage.statements (hourly; one usage.statement job per business for last month).
 *   routes            the statement files, owner only, at /billing/statement-files/s<id>.<pdf|csv>.
 *
 * For other modules:
 *   usageFor(ctx).meter.record({ meter: 'ai_units', quantity, costPaise, key, at })   inside the business: AI units, once per key
 *   usageFor(ctx).meter.allowanceChanged()      inside the business, after a pack is bought or the plan upgraded: held DMs go
 *   statementsApi(ctx)                          handlers for billing.statements and billing.statementFile, which the billing
 *                                               module answers (BILLING_ROUTE_OWNERS) and can spread into its api()
 *   usageFor(ctx).passThrough.summary(month)    the month's pass-through charges with counts, for the invoice
 */
const API = BILLING_ROUTE_OWNERS.usage;
const MINUTE = 60_000;
const services = new WeakMap();

/** The one usage service of a context (the app's or the worker's). */
export function usageFor(ctx) {
  let service = services.get(ctx);
  if (!service) {
    service = createUsage({ db: ctx.db, config: ctx.config ?? {}, notify: ctx.notify ?? null, compliance: ctx.compliance ?? null, providers: ctx.providers ?? {}, platform: ctx.platform ?? {} });
    services.set(ctx, service);
  }
  return service;
}

export const statementsApi = (ctx) => ({
  'billing.statements': ({ query }) => usageFor(ctx).statements.list(query),
  'billing.statementFile': ({ params, query }) => usageFor(ctx).statements.fileLink(Number(params.id), query?.format ?? 'pdf'),
});

export const usage = {
  name: 'usage',
  owns: {
    migrations: [],
    tables: ['usage_events', 'usage_months'],
    api: API,
    store: [],
    platform: [],
    jobs: Object.values(USAGE_JOBS),
  },
  setup(ctx) {
    if (!ctx?.compliance?.useQuota || !ctx.db) return;
    const { meter } = usageFor(ctx);
    ctx.compliance.useQuota({ hasDmsLeft: (call) => meter.hasDmsLeft(call) });
    ctx.compliance.onAccepted((event) => meter.accepted(event));
  },
  api: (ctx) => ({
    'billing.usage': () => usageFor(ctx).meter.view(),
  }),
  routes(app, ctx) {
    app.get('/billing/statement-files/:ref', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'private, no-store');
        if (!req.user) return res.status(401).type('text').send('Sign in to your Bhava admin, then open this link again.');
        if (!isAllowed(req.user, OWNER_ONLY)) return res.status(403).type('text').send('Owner only.');
        const ref = parseStatementRef(req.params.ref);
        const found = ref && (await usageFor(ctx).statements.file(ref.id, ref.format));
        if (!found) return res.status(404).type('text').send('We couldn’t find that file.');
        res.set('Content-Type', found.type);
        res.set('Content-Disposition', `attachment; filename="${found.name}"`);
        return res.send(found.buffer);
      } catch (err) {
        return next(err);
      }
    });
  },
  jobs(ctx) {
    const queue = ctx.platform?.queue;
    if (!queue) return undefined;
    const service = usageFor(ctx);
    queue.work(USAGE_JOBS.alerts, () => service.sweepAlerts());
    queue.work(USAGE_JOBS.monthReset, () => service.sweepHeld());
    queue.work(USAGE_JOBS.reconcile, () => service.sweepUncounted());
    queue.work(USAGE_JOBS.passThrough, () => service.sweepPassThrough());
    queue.work(USAGE_JOBS.statements, () => service.sweepStatements());
    queue.work(USAGE_JOBS.statement, (job) => service.statements.run(job.payload?.month));
    return async () => {
      try {
        await queue.every(USAGE_JOBS.alerts, 10 * MINUTE);
        await queue.every(USAGE_JOBS.monthReset, MINUTE);
        await queue.every(USAGE_JOBS.reconcile, 10 * MINUTE);
        await queue.every(USAGE_JOBS.passThrough, 60 * MINUTE);
        await queue.every(USAGE_JOBS.statements, 60 * MINUTE);
      } catch (err) {
        reportError(err, { msg: 'usage.schedule_failed' });
      }
    };
  },
};
