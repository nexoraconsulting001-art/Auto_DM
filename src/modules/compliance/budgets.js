import { tenantId } from '../../tenancy.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SECOND = 1000;

/**
 * Per-account token buckets (PRD 4.3) and what Meta's answers have done to one account's sending.
 *
 * A bucket gives at most `limit` in any window of its size: it holds a small burst and refills at (limit - burst) per window, because a
 * bucket that refilled at the full rate could let out burst + limit. No business ever touches another's row.
 */
export function createBudgets({ db, now, random, limits }) {
  const BUDGETS = {
    private_reply: { limit: limits.privateRepliesPerHour, windowMs: HOUR, burst: 1 / 60 },
    send_api: { limit: limits.sendApiPerSecond, windowMs: SECOND, burst: 1 / 4 },
    conversations: { limit: limits.conversationsPerSecond, windowMs: SECOND, burst: 1 },
  };

  function bucket(budget, multiplier) {
    const { limit, windowMs, burst } = BUDGETS[budget];
    const scaled = Math.max(1, limit * multiplier);
    const capacity = Math.max(1, Math.floor(scaled * burst));
    const perWindow = scaled > capacity ? scaled - capacity : scaled;
    return { capacity, perSecond: perWindow / (windowMs / SECOND) };
  }

  /** Takes one token, atomically. False when the bucket is empty: the job waits, unsent and unclaimed. */
  async function take(channel, accountId, budget, multiplier = 1) {
    const { capacity, perSecond } = bucket(budget, multiplier);
    const filled = `LEAST($5::double precision, send_budgets.tokens + GREATEST(EXTRACT(EPOCH FROM ($7::timestamptz - send_budgets.refilled_at)), 0) * $6::double precision)`;
    const rows = await db.query(
      `INSERT INTO send_budgets AS send_budgets (tenant_id, channel, account_id, budget, tokens, refilled_at)
       VALUES ($1, $2, $3, $4, GREATEST($5::double precision - 1, 0), $7::timestamptz)
       ON CONFLICT (tenant_id, channel, account_id, budget) DO UPDATE SET tokens = GREATEST(${filled} - 1, 0), refilled_at = $7::timestamptz
       WHERE ${filled} >= 1
       RETURNING tokens`,
      [tenantId(), channel, accountId, budget, capacity, perSecond, now()],
    );
    return rows.length > 0;
  }

  function nextBackoff(previous) {
    return Math.min(60, Math.max(1, previous * 2));
  }

  const upsertState = (channel, accountId, set, params) => db.query(
    `INSERT INTO account_rate_state (tenant_id, channel, account_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, channel, account_id) DO NOTHING`,
    [tenantId(), channel, accountId],
  ).then(() => db.query(
    `UPDATE account_rate_state SET ${set}, updated_at = now() WHERE tenant_id = $1 AND channel = $2 AND account_id = $3 RETURNING *`,
    [tenantId(), channel, accountId, ...params],
  ));

  return {
    take,
    /** For tests and the console's explanation. */
    describe: bucket,

    /**
     * Row 19 codes or a 429 on the messaging class: messaging pauses for this account until the regain time Meta gives, or else
     * for a backoff of 1 to 60 minutes with jitter. Insights are untouched (C-10). Returns when sending may resume.
     */
    async throttled(channel, accountId, usage) {
      const at = +now();
      const regain = usage?.regainMinutes > 0 ? usage.regainMinutes : 0;
      const [row] = await db.query('SELECT backoff_minutes FROM account_rate_state WHERE tenant_id = $1 AND channel = $2 AND account_id = $3', [tenantId(), channel, accountId]);
      const backoff = regain ? (row?.backoff_minutes ?? 0) : nextBackoff(row?.backoff_minutes ?? 0);
      const waitMs = regain ? regain * MINUTE : Math.round(backoff * MINUTE * (0.8 + random() * 0.4));
      const until = new Date(at + waitMs);
      await upsertState(channel, accountId, 'messaging_paused_until = $4::timestamptz, backoff_minutes = $5', [until, backoff]);
      return until;
    },

    /** A messaging call went through, so the next throttle starts from a minute again. */
    async messagingOk(channel, accountId, state) {
      if (!state?.backoffMinutes && !state?.messagingPausedUntil) return;
      await db.query('UPDATE account_rate_state SET backoff_minutes = 0, messaging_paused_until = NULL WHERE tenant_id = $1 AND channel = $2 AND account_id = $3', [tenantId(), channel, accountId]);
    },

    async usage(channel, accountId, usage) {
      if (!usage) return null;
      const percent = Math.min(2_147_000_000, Math.round(usage.percent ?? 0));
      const [row] = await upsertState(channel, accountId, 'usage_percent = $4, usage_at = $5::timestamptz', [percent, now()]);
      return row;
    },

    /** 80002: everything but messaging pauses until the regain time (C-11). */
    async bucThrottled(channel, accountId, usage) {
      const until = new Date(+now() + (usage?.regainMinutes > 0 ? usage.regainMinutes : 60) * MINUTE);
      await upsertState(channel, accountId, 'other_paused_until = $4::timestamptz', [until]);
      return until;
    },

    /**
     * The only way slow mode starts (PRD 4.3). A second trigger extends it and does not restart the 48h restore. Each cause is kept, so one ending can't end another.
     * A reach drop never takes over from a cause the owner can't override, and asking again for a cause already in force keeps the owner's override.
     */
    async startSlowMode(channel, accountId, trigger, until) {
      const at = now();
      const [row] = await upsertState(channel, accountId,
        `slow_mode_started_at = CASE WHEN slow_mode_until IS NOT NULL AND slow_mode_until > $4::timestamptz THEN slow_mode_started_at ELSE $4::timestamptz END,
         slow_mode_until = GREATEST(slow_mode_until, $5::timestamptz),
         slow_mode_holds = slow_mode_holds || jsonb_build_object($6::text, GREATEST($5::timestamptz, (slow_mode_holds->>$6::text)::timestamptz)),
         slow_mode_trigger = CASE WHEN $6::text = 'reach_drop' AND slow_mode_trigger IS NOT NULL AND slow_mode_trigger <> 'reach_drop' AND (slow_mode_holds->>slow_mode_trigger)::timestamptz > $4::timestamptz
                                  THEN slow_mode_trigger ELSE $6::text END,
         slow_mode_override_at = CASE WHEN (slow_mode_holds->>$6::text)::timestamptz > $4::timestamptz THEN slow_mode_override_at ELSE NULL END`,
        [at, until, trigger]);
      return row;
    },

    /** One cause has ended. Another still in force keeps slow mode on, until its own end; otherwise slow mode stops now and the 48h restore begins. False when there was nothing to end. */
    async leaveSlowMode(channel, accountId, trigger) {
      const at = now();
      return db.tx(async (t) => {
        const [row] = await t.query(
          'SELECT slow_mode_until, slow_mode_holds, slow_mode_trigger FROM account_rate_state WHERE tenant_id = $1 AND channel = $2 AND account_id = $3 FOR UPDATE',
          [tenantId(), channel, accountId],
        );
        if (!row?.slow_mode_until || +new Date(row.slow_mode_until) <= +at) return false;
        if (!row.slow_mode_holds[trigger] && row.slow_mode_trigger !== trigger) return false;
        const holds = Object.fromEntries(Object.entries(row.slow_mode_holds).filter(([name]) => name !== trigger));
        const remaining = Object.entries(holds).filter(([, until]) => +new Date(until) > +at).sort(([, a], [, b]) => +new Date(a) - +new Date(b));
        const [nextTrigger, nextUntil] = remaining.at(-1) ?? [row.slow_mode_trigger, at];
        await t.query(
          `UPDATE account_rate_state SET slow_mode_holds = $4::jsonb, slow_mode_until = $5::timestamptz, slow_mode_trigger = $6, updated_at = now()
           WHERE tenant_id = $1 AND channel = $2 AND account_id = $3`,
          [tenantId(), channel, accountId, JSON.stringify(holds), new Date(nextUntil), nextTrigger],
        );
        return true;
      });
    },

    /** The owner's typed override. Only a reach drop can be overridden. False when nothing could be. */
    async overrideSlowMode(channel, accountId) {
      const rows = await db.query(
        `UPDATE account_rate_state SET slow_mode_override_at = $4::timestamptz, updated_at = now()
         WHERE tenant_id = $1 AND channel = $2 AND account_id = $3 AND slow_mode_trigger = 'reach_drop' AND slow_mode_until > $4::timestamptz RETURNING account_id`,
        [tenantId(), channel, accountId, now()],
      );
      return rows.length > 0;
    },
  };
}
