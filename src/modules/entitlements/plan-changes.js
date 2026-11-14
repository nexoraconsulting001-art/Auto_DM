import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';

/** Automation states that count against the plan's automations limit: they can send. */
export const RUNNING_STATES = Object.freeze(['live', 'test']);
/** paused_reason of an automation a downgrade paused (migration 740); an upgrade resumes only these. */
export const PLAN_PAUSE_REASONS = Object.freeze(['plan.limit', 'plan.limit.test']);

/**
 * Called by automations.setState before an automation goes to Test or Live (PRD 5.7, 5.20: F-35, F-123). One that is
 * already running changes nothing. Otherwise the running ones are counted against repos.entitlements.limit('automations'),
 * and at the limit the switch-on is refused with the router's plan.limit_reached and the plan that has more. The database
 * holds the same rule under a lock (automations_within_plan), for two requests that pass this check at once.
 */
export async function automationLimitHook(automation, ctx) {
  if (RUNNING_STATES.includes(automation.state)) return;
  const { repos, db } = ctx;
  const limit = await repos.entitlements.limit('automations');
  if (limit === Infinity) return;
  const [{ n: used }] = await db.query(
    `SELECT count(*)::int AS n FROM automations WHERE tenant_id = $1 AND id <> $2 AND state = ANY($3)`,
    [tenantId(), Number(automation.id) || 0, RUNNING_STATES],
  );
  if (used < limit) return;
  const plan = await repos.entitlements.lowestPlan(['automations'], { moreThan: limit });
  throw new ApiError(
    'plan.limit_reached',
    plan ? `Your plan runs ${limit} automations at once. Pause one, or move to the ${plan.name} plan for more.` : `Your plan runs ${limit} automations at once. Pause one first.`,
    { reason: 'plan', feature: 'automations', limit, used, plan: plan?.code },
  );
}

/** True for the database's refusal of a switch-on above the limit (automations_within_plan), when two requests raced. */
export const isAutomationLimitError = (err) => err?.code === '23514' && /plan\.limit_reached/.test(String(err?.message ?? ''));
