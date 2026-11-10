import { z } from 'zod';
import { ANALYTICS_LIMITS, HEALTH_BANDS, REACH_GUARD_STATES, REACH_TRIP_TRIGGERS } from '../analytics.js';
import { SLOW_MODE_TRIGGERS } from '../compliance.js';
import { OWNER_ONLY, staffWith } from './access.js';
import { Count, Id, ListQuery, Timestamp, page } from './common.js';
import { DayValue, RangeQuery } from './insights.js';

/**
 * PRD 7.6 and 7.7, answered by src/modules/reach-guard. Overriding slow mode is compliance.slowModeOverride, which already holds the owner rule,
 * the typed confirmation, the audit row, and the reach-drop-only rule; there is deliberately no second route for it.
 */
const reader = staffWith('analytics');
const between = (range) => z.number().int('Use a whole number').min(range.min, `Use ${range.min} or more`).max(range.max, `Use ${range.max} or less`);

export const ReachGuardThresholds = z.object({
  reachDropPercent: between(ANALYTICS_LIMITS.reachDropPercent),
  mediaDropPercent: between(ANALYTICS_LIMITS.mediaDropPercent),
  clearPercent: between(ANALYTICS_LIMITS.clearPercent),
});
export const ReachGuardThresholdsUpdate = ReachGuardThresholds.partial();

export const ReachGuardTrip = z.object({
  id: Id,
  trigger: z.enum(REACH_TRIP_TRIGGERS),
  startedAt: Timestamp,
  clearedAt: Timestamp.nullable(),
  baseline: z.number().nullable(),
  dropPercent: z.number().nullable(),
  overriddenAt: Timestamp.nullable(),
});

/** message is the owner-facing copy (7.6): "Reach is down X% vs your usual" with normal causes, and never "shadowbanned" or "safe". */
export const ReachGuardStatus = z.object({
  state: z.enum(REACH_GUARD_STATES),
  since: Timestamp.nullable(),
  message: z.string(),
  settledDays: Count,
  mediaCounted: Count,
  baselineReach: z.number().nullable(),
  thresholds: ReachGuardThresholds,
  trip: ReachGuardTrip.nullable(),
  slowMode: z.object({ active: z.boolean(), trigger: z.enum(SLOW_MODE_TRIGGERS).nullable(), until: Timestamp.nullable(), canOverride: z.boolean(), restoring: z.boolean() }),
  lastEvaluatedAt: Timestamp.nullable(),
});

export const HealthDeduction = z.object({ code: z.string(), points: z.number().int(), message: z.string(), fix: z.string() });
export const AccountHealth = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  band: z.enum(HEALTH_BANDS).nullable(),
  deductions: z.array(HealthDeduction),
  computedAt: Timestamp.nullable(),
});
export const AccountHealthHistory = z.object({
  days: z.array(DayValue.extend({ band: z.enum(HEALTH_BANDS).nullable(), deductions: z.array(HealthDeduction) })),
});

export const reachGuardRoutes = {
  'reachGuard.status': { method: 'GET', path: '/reach-guard', access: reader, response: ReachGuardStatus },
  'reachGuard.setThresholds': { method: 'PATCH', path: '/reach-guard/thresholds', access: OWNER_ONLY, body: ReachGuardThresholdsUpdate, response: ReachGuardStatus },
  'reachGuard.trips': { method: 'GET', path: '/reach-guard/trips', access: reader, query: ListQuery, response: page(ReachGuardTrip) },
  'accountHealth.get': { method: 'GET', path: '/account-health', access: reader, response: AccountHealth },
  'accountHealth.history': { method: 'GET', path: '/account-health/history', access: reader, query: RangeQuery, response: AccountHealthHistory },
};
