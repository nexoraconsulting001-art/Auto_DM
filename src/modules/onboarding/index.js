import { ApiError } from '../../contracts/api/index.js';
import { OPS_ROUTE_OWNERS } from '../../contracts/api/ops.js';
import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { createChecklist } from './checklist.js';
import { onboardingConsoleRoutes } from './console.js';
import { createInvites } from './invites.js';

const API = OPS_ROUTE_OWNERS.onboarding;
const PLATFORM = OPS_PLATFORM_OWNERS.onboarding;

/** How often the worker looks again at steps waiting on somebody else (Razorpay's KYC, the courier, DNS), and how many at once. */
const RECHECK_EVERY_MS = 5 * 60_000;
const RECHECK_BATCH = 25;

/** Opening the owner's link, per address: enough for a person, too few to guess a token. */
const OPEN_LIMIT = Object.freeze({ scope: 'onboarding.invite_open', limit: 30, windowMs: 10 * 60_000 });

const built = new WeakMap();
function servicesFor(ctx) {
  if (!built.has(ctx)) built.set(ctx, { checklist: createChecklist(ctx), invites: createInvites(ctx) });
  return built.get(ctx);
}

/**
 * Done-for-you onboarding (PRD 5.6, F-26 to F-31, F-77 to F-80, F-108): the owner's single-use link, the checklist
 * filtered by tier, and the operator's workspace with its timings. A step is done when its live checks say so; the steps
 * and checks are data in src/contracts/onboarding.js, and checks.js supplies one function per check name. The Route
 * linked account's KYC goes through the payments module and ctx.providers.razorpay.route; the pickup location through the
 * shipping module onto Bhava's master Shiprocket account.
 */
export const onboarding = {
  name: 'onboarding',
  owns: {
    migrations: ['730_platform_ops.sql'],
    tables: ['onboarding_invites', 'onboarding_steps', 'onboarding_timings'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: ['onboarding.checks'],
  },

  api: (ctx) => {
    const s = () => servicesFor(ctx);
    return {
      'setup.get': () => s().checklist.get(),
      'setup.check': ({ body }) => s().checklist.check(body.step),
      'setup.acceptTerms': ({ body, user }) => s().checklist.acceptTerms(body.version, user),
      'setup.pickupAddress': ({ body, user }) => s().checklist.pickupAddress(body, user),
      'setup.kycLink': ({ user }) => s().checklist.kycLink(user),
      'setup.ownKeys': ({ body, user }) => s().checklist.ownKeys(body, user),
      'setup.openInvite': async ({ body, user, req }) => {
        // Only on the sign-in host, which belongs to no business: a business's own address never opens an invite.
        if (!req?.appHost) throw new ApiError('not_found');
        const hit = await ctx.platform.rateLimit.hit(OPEN_LIMIT.scope, String(req.ip ?? ''), OPEN_LIMIT);
        if (!hit.allowed) throw new ApiError('rate_limited');
        return s().invites.open(body.token, user ?? null);
      },
    };
  },

  platformRoutes: (router, ctx) => onboardingConsoleRoutes(router, ctx),

  /** onboarding.checks: steps left waiting on somebody else are checked again every few minutes, a batch at a time. */
  jobs(ctx) {
    let next = 0;
    const platformDb = ctx.db.platform ?? ctx.db;
    return async function schedule() {
      if (Date.now() < next) return;
      next = Date.now() + RECHECK_EVERY_MS;
      try {
        const due = await platformDb.query(
          `SELECT s.tenant_id, array_agg(s.step) AS steps, t.slug, t.name FROM onboarding_steps s JOIN tenants t ON t.id = s.tenant_id
           WHERE s.status = 'waiting' AND (s.checked_at IS NULL OR s.checked_at < now() - interval '5 minutes') AND t.status NOT IN ('closed', 'killed')
           GROUP BY s.tenant_id, t.slug, t.name ORDER BY min(s.checked_at) NULLS FIRST LIMIT ${RECHECK_BATCH}`,
        );
        for (const row of due) {
          await withTenant({ id: Number(row.tenant_id), slug: row.slug, name: row.name }, () => servicesFor(ctx).checklist.run(row.steps))
            .catch((err) => reportError(err, { msg: 'onboarding.recheck_failed', tenantId: Number(row.tenant_id) }));
        }
      } catch (err) {
        reportError(err, { msg: 'onboarding.recheck_sweep_failed' });
      }
    };
  },
};
