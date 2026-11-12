import { demoTenantService } from './service.js';

export { demoTenantService, IDLE_MS, REFRESH_AFTER_DAYS } from './service.js';
export { DEMO_BUSINESS, SAMPLE_ACCOUNT, SAMPLE_ID_PREFIX, SAMPLE_VERSION, buildSample, sampleDigest } from './sample.js';

/** The worker's job that rebuilds an out-of-date demo business when nobody is in it. */
export const DEMO_REFRESH_JOB = 'demo-tenant.refresh';
const HOUR = 3_600_000;

/**
 * The demo business that App Review signs in to (PRD 10.6, P-24, P-25; 5.11, F-50). It has no routes of its own: it
 * is an ordinary business, made and kept by this module (and `node scripts/demo-tenant.js`), that the review login in
 * src/modules/accounts opens.
 *
 *   sample.js   the sample as plain data: one pure function of the day, so two builds for a day are the same
 *   fill.js     writes a sample into the business, in the shapes the real flows and the simulators leave
 *   service.js  ensure / reset / remove / status / refreshIfIdle
 *
 * What makes it the demo business is one column, tenants.is_demo, and migration 540 holds everything the flag means
 * in the database, so no other code asks "is this the demo business?":
 *
 * - It never sends. Its compliance settings stay paused by ops with dry run on, so the engine holds every DM, reply and
 *   message; its Instagram account is made up ("sample-" ids), holds no token and is never active; it can't add a
 *   Facebook Page or a WhatsApp account; its sample shoppers have 555 numbers and no email.
 * - When Instagram is unavailable (always, for it) the screens show the stored sample, because they read the same
 *   cache tables every business reads (insights, inbox, automations, orders) and none of them call Meta.
 * - The review login opens it and nothing else: review_logins.tenant_id can name only it, no membership links it to
 *   another business, and no other business may hold an account of the review number's person.
 * - Billing, metering and platform totals count `counted_tenants`, which leaves it out.
 */
export const demoTenant = {
  name: 'demo-tenant',
  jobs({ db, repos, platform, config }) {
    const service = demoTenantService({ db, repos, config });
    platform.queue.work(DEMO_REFRESH_JOB, () => service.refreshIfIdle());
    return () => platform.queue.every(DEMO_REFRESH_JOB, HOUR);
  },
};
