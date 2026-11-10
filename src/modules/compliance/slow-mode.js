import { SLOW_MODE_TRIGGERS } from '../../contracts/compliance.js';
import { budgetMultiplier, slowModeActive } from './gate.js';

const DAY = 86_400_000;

/** How far ahead enter() holds slow mode unless told otherwise. A cause with no set end asks again at each evaluation, and a stopped job can't hold it for ever. */
export const SLOW_MODE_HOLD_MS = 7 * DAY;

/**
 * Slow mode (PRD 4.3) as anything outside the send path sees it: compliance.slowMode. This only changes the account's rate state, which the gate reads
 * on every send. It sends nothing, and it is not a way to send: DMs still go only through compliance.send().
 *
 *   enter(channel, accountId, trigger, { until? })   Starts or extends it. A second cause extends it and does not restart the 48h restore. Asking again for a cause
 *                                                    already in force keeps the owner's override.
 *   leave(channel, accountId, trigger)               This cause has ended. Another still in force holds slow mode; otherwise restoring starts now, at 75% then 100% over 48h.
 *   status(channel, accountId)                       { active, trigger, triggers, until, startedAt, overridden, restoring, multiplier, canOverride }
 *
 * The override itself is compliance.slowModeOverride, with its owner check, typed confirmation and audit row. Runs inside withTenant().
 */
export function createSlowMode({ budgets, gate, now, limits }) {
  const check = (trigger) => {
    if (!SLOW_MODE_TRIGGERS.includes(trigger)) throw new Error(`Unknown slow mode trigger: ${trigger}`);
  };

  return {
    enter(channel, accountId, trigger, { until } = {}) {
      check(trigger);
      return budgets.startSlowMode(channel, accountId, trigger, until ?? new Date(+now() + SLOW_MODE_HOLD_MS));
    },

    leave(channel, accountId, trigger) {
      check(trigger);
      return budgets.leaveSlowMode(channel, accountId, trigger);
    },

    async status(channel, accountId) {
      const rate = await gate.rateState(channel, accountId);
      const at = +now();
      const active = slowModeActive(rate, at);
      const multiplier = rate ? budgetMultiplier({ rate }, at, limits) : 1;
      const held = Object.entries(rate?.slowModeHolds ?? {}).filter(([, until]) => +new Date(until) > at).map(([trigger]) => trigger);
      const trigger = rate?.slowModeTrigger ?? null;
      const overridden = Boolean(rate?.overrideAt && rate?.startedAt && +rate.overrideAt >= +rate.startedAt);
      return {
        active,
        trigger: active || overridden ? trigger : null,
        triggers: active ? held : [],
        until: rate?.slowModeUntil && +rate.slowModeUntil > at ? rate.slowModeUntil : null,
        startedAt: rate?.startedAt ?? null,
        overridden,
        restoring: !active && !overridden && multiplier > limits.reducedBudgetMultiplier && multiplier < 1,
        multiplier,
        canOverride: active && trigger === 'reach_drop' && held.every((name) => name === 'reach_drop'),
      };
    },
  };
}
