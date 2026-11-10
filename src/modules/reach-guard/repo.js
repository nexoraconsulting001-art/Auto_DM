import { ApiError } from '../../contracts/api/index.js';
import { ANALYTICS_LIMITS } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { DISCONNECTED_BY_OWNER, raiseAlert } from '../ig-accounts/index.js';

const L = ANALYTICS_LIMITS;
const MINUTES_24H = 24 * 60;
/** A media poll runs every 3h, so one lands inside this window. A later figure would no longer be a 24h figure. */
const MEDIA_24H_FROM = 23 * 60;
const MEDIA_24H_TO = 36 * 60;
/** A story's final snapshot is taken at 22 to 23.5h, and Meta keeps nothing after 24h. */
const STORY_FROM = Math.round(L.storyFinalFromMs / 60_000);
const STORY_TO = MINUTES_24H;
/** More media per type than the last 10 plus a run of 3, so media without a yardstick can't push the run out of view. */
const MEDIA_PER_KIND = 30;
const SERIES_DAYS = 120;

const num = (value) => (value === null || value === undefined ? null : Number(value));

const toState = (row) => row && ({
  state: row.state,
  stateSince: row.state_since,
  settledDays: Number(row.settled_days),
  mediaCounted: Number(row.media_counted),
  baselineReach: num(row.baseline_reach),
  thresholds: { reachDropPercent: row.reach_drop_percent, mediaDropPercent: row.media_drop_percent, clearPercent: row.clear_percent },
  evaluatedAt: row.evaluated_at,
});

const toTrip = (row) => row && ({
  id: row.id,
  trigger: row.trigger,
  startedAt: row.started_at,
  clearedAt: row.cleared_at,
  baseline: num(row.baseline),
  dropPercent: row.drop_percent,
  observed: row.observed ?? [],
  overrideAt: row.override_at,
});

const toHealth = (row) => row && ({ score: row.score, band: row.band, deductions: row.deductions ?? [], computedAt: row.computed_at });

/** One row of the compliance log, in the transaction of the change it records. Ids and numbers only (PRD 4.16). */
const logDecision = (t, { channel, decision, reason, details, at }) => t.query(
  `INSERT INTO compliance_events (tenant_id, channel, kind, decision, reason, details, created_at) VALUES ($1, $2, 'reach_guard', $3, $4, $5::jsonb, $6::timestamptz)`,
  [tenantId(), channel, decision, reason, JSON.stringify(details), at],
);

/** The tables of migration 204 and what the checks read from elsewhere, always for the current business. Decisions are in rules.js and service.js. */
export function reachGuardRepo(db) {
  async function state(accountRef) {
    const [row] = await db.query('SELECT * FROM reach_guard_state WHERE tenant_id = $1 AND account_ref = $2', [tenantId(), accountRef]);
    return toState(row) ?? null;
  }

  return {
    /** The accounts Reach Guard looks after. A connected account with no analytics row yet comes back with id null: it has health checks, and nothing stored. */
    async accounts() {
      const known = await db.query('SELECT id, channel, account_id, permission FROM analytics_accounts WHERE tenant_id = $1 ORDER BY id', [tenantId()]);
      const waiting = await db.query(
        `SELECT 'instagram' AS channel, i.ig_user_id AS account_id FROM ig_accounts i
          WHERE i.tenant_id = $1 AND i.status_reason <> $2 AND (i.access_token_enc <> '' OR i.status <> 'active')
            AND NOT EXISTS (SELECT 1 FROM analytics_accounts a WHERE a.tenant_id = i.tenant_id AND a.channel = 'instagram' AND a.ig_user_id = i.ig_user_id)
         UNION ALL
         SELECT 'facebook', p.page_id FROM fb_pages p
          WHERE p.tenant_id = $1 AND p.status_reason <> $2 AND (p.access_token_enc <> '' OR p.status <> 'active')
            AND NOT EXISTS (SELECT 1 FROM analytics_accounts a WHERE a.tenant_id = p.tenant_id AND a.channel = 'facebook' AND a.fb_page_id = p.page_id)`,
        [tenantId(), DISCONNECTED_BY_OWNER],
      );
      return [
        ...known.map((r) => ({ id: r.id, channel: r.channel, accountId: r.account_id, permission: r.permission })),
        ...waiting.map((r) => ({ id: null, channel: r.channel, accountId: r.account_id, permission: 'ok' })),
      ];
    },

    async account(id) {
      const [r] = await db.query('SELECT id, channel, account_id, permission FROM analytics_accounts WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return r ? { id: r.id, channel: r.channel, accountId: r.account_id, permission: r.permission } : null;
    },

    state,

    async ensureState(accountRef, at) {
      await db.query('INSERT INTO reach_guard_state (tenant_id, account_ref, state_since) VALUES ($1, $2, $3::timestamptz) ON CONFLICT (tenant_id, account_ref) DO NOTHING', [tenantId(), accountRef, at]);
      return state(accountRef);
    },

    /** Saves one evaluation. Returns the state before it, read under the row's lock, so only one worker sees a given change of state. */
    async saveState(accountRef, { state, at, settledDays, mediaCounted, baselineReach }) {
      return db.tx(async (t) => {
        const [before] = await t.query('SELECT state FROM reach_guard_state WHERE tenant_id = $1 AND account_ref = $2 FOR UPDATE', [tenantId(), accountRef]);
        await t.query(
          `UPDATE reach_guard_state SET state = $3, state_since = CASE WHEN state = $3 THEN state_since ELSE $4::timestamptz END,
             settled_days = $5, media_counted = $6, baseline_reach = $7, evaluated_at = $4::timestamptz
           WHERE tenant_id = $1 AND account_ref = $2`,
          [tenantId(), accountRef, state, at, settledDays, mediaCounted, baselineReach],
        );
        return before?.state ?? null;
      });
    },

    /** Settled daily reach, oldest first, with the empty days left out. */
    async settledReach(accountRef, throughDay) {
      const rows = await db.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS d, value FROM insight_daily
         WHERE tenant_id = $1 AND account_ref = $2 AND metric = 'reach' AND breakdown = '' AND breakdown_value = '' AND day <= $3::date AND value IS NOT NULL
         ORDER BY day DESC LIMIT $4`,
        [tenantId(), accountRef, throughDay, SERIES_DAYS],
      );
      return rows.reverse().map((r) => ({ day: r.d, reach: Number(r.value) }));
    },

    /** Each media's reach at about 24h, oldest first. A story uses its final snapshot. "<5" has no figure, so it is left out rather than called low. */
    async media24h(accountRef) {
      const rows = await db.query(
        `WITH picked AS (
           SELECT DISTINCT ON (m.id) m.id, m.media_id, m.kind, m.posted_at, (s.metrics->>'reach')::numeric::bigint AS reach
             FROM insight_media m
             JOIN insight_snapshots s ON s.tenant_id = m.tenant_id AND s.media_ref = m.id
            WHERE m.tenant_id = $1 AND m.account_ref = $2 AND m.posted_at IS NOT NULL AND NOT s.below_threshold AND jsonb_typeof(s.metrics->'reach') = 'number'
              AND s.age_minutes >= CASE WHEN m.kind = 'story' THEN $3::int ELSE $4::int END
              AND s.age_minutes <= CASE WHEN m.kind = 'story' THEN $5::int ELSE $6::int END
            ORDER BY m.id, abs(s.age_minutes - ${MINUTES_24H}), s.id DESC
         ), ranked AS (
           SELECT *, row_number() OVER (PARTITION BY kind ORDER BY posted_at DESC, id DESC) AS n FROM picked
         )
         SELECT media_id, kind, posted_at, reach FROM ranked WHERE n <= $7 ORDER BY posted_at, id`,
        [tenantId(), accountRef, STORY_FROM, MEDIA_24H_FROM, STORY_TO, MEDIA_24H_TO, MEDIA_PER_KIND],
      );
      return rows.map((r) => ({ mediaId: r.media_id, kind: r.kind, postedAt: r.posted_at, reach: Number(r.reach) }));
    },

    async openTrip(accountRef) {
      const [row] = await db.query('SELECT * FROM reach_guard_trips WHERE tenant_id = $1 AND account_ref = $2 AND cleared_at IS NULL', [tenantId(), accountRef]);
      return toTrip(row) ?? null;
    },

    async lastClearedAt(accountRef) {
      const [row] = await db.query('SELECT max(cleared_at) AS at FROM reach_guard_trips WHERE tenant_id = $1 AND account_ref = $2', [tenantId(), accountRef]);
      return row?.at ?? null;
    },

    /**
     * Starts a trip: the row, the owner's alert and the reason code land together, so a repeat evaluation has nothing left to alert about (N-23). The owner is told
     * once per trip on each channel: email and push read the one alerts row (5.13), which is also the web banner. Null when another worker got there first.
     */
    async startTrip(accountRef, { trigger, baseline, dropPercent, observed }, { at, channel, target, message }) {
      return db.tx(async (t) => {
        const [row] = await t.query(
          `INSERT INTO reach_guard_trips (tenant_id, account_ref, trigger, started_at, baseline, drop_percent, observed, alert_push_at, alert_banner_at, alert_email_at)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $4::timestamptz, $4::timestamptz, $4::timestamptz)
           ON CONFLICT (tenant_id, account_ref) WHERE cleared_at IS NULL DO NOTHING RETURNING *`,
          [tenantId(), accountRef, trigger, at, baseline, dropPercent, JSON.stringify(observed)],
        );
        if (!row) return null;
        await raiseAlert(t, { kind: 'reach_guard.tripped', message, target, dedupeKey: `reach_guard:trip:${row.id}` });
        await logDecision(t, { channel, decision: 'held', reason: 'rate.slow_mode', details: { slowMode: 'start', trigger: 'reach_drop', reachTrigger: trigger, tripId: row.id, dropPercent }, at });
        return toTrip(row);
      });
    },

    /** Ends a trip. True for the one caller that did, which is the one that goes on to end slow mode. */
    async endTrip(id, { at, channel }) {
      return db.tx(async (t) => {
        const rows = await t.query('UPDATE reach_guard_trips SET cleared_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2 AND cleared_at IS NULL RETURNING id', [tenantId(), id, at]);
        if (!rows.length) return false;
        await logDecision(t, { channel, decision: 'queued', reason: 'rate.slow_mode', details: { slowMode: 'restore', trigger: 'reach_drop', tripId: id }, at });
        return true;
      });
    },

    /** Puts the owner's override on the trip it belongs to. The override itself and its audit row are compliance.slowModeOverride's. */
    async noteOverride(id, at) {
      await db.query(
        `UPDATE reach_guard_trips SET override_at = $3::timestamptz,
           override_by = (SELECT u.id FROM users u WHERE u.tenant_id = $1 AND u.id = (
             SELECT substring(a.actor from '^user:([0-9]{1,9})$')::integer FROM audit_log a
              WHERE a.tenant_id = $1 AND a.action = 'compliance.slow_mode_override' ORDER BY a.id DESC LIMIT 1))
         WHERE tenant_id = $1 AND id = $2 AND override_at IS NULL`,
        [tenantId(), id, at],
      );
    },

    /** Records entering Permission needed: the alert and the reason code, once for each time the state is entered. */
    async notePermissionNeeded(accountRef, { at, channel, target, message }) {
      await db.tx(async (t) => {
        await raiseAlert(t, { kind: 'reach_guard.permission_needed', message, target, dedupeKey: `reach_guard:permission:${accountRef}:${+new Date(at)}` });
        await logDecision(t, { channel, decision: 'held', reason: 'rate.slow_mode', details: { slowMode: 'start', trigger: 'insights_denied', accountRef }, at });
      });
    },

    async saveBaselines(accountRef, day, rows) {
      for (const { scope, baseline, sample, observed } of rows) {
        await db.query(
          `INSERT INTO reach_guard_baselines (tenant_id, account_ref, day, scope, baseline, sample, observed) VALUES ($1, $2, $3::date, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, account_ref, day, scope) DO UPDATE SET baseline = EXCLUDED.baseline, sample = EXCLUDED.sample, observed = EXCLUDED.observed`,
          [tenantId(), accountRef, day, scope, baseline, sample, observed],
        );
      }
    },

    /** Applies the owner's change to every account of this business, with its audit row. The clear level must stay above the trip level, or a day could be both. */
    async setThresholds(change, actor) {
      return db.tx(async (t) => {
        const rows = await t.query('SELECT account_ref, reach_drop_percent, media_drop_percent, clear_percent FROM reach_guard_state WHERE tenant_id = $1 ORDER BY account_ref FOR UPDATE', [tenantId()]);
        if (!rows.length) return false;
        const before = { reachDropPercent: rows[0].reach_drop_percent, mediaDropPercent: rows[0].media_drop_percent, clearPercent: rows[0].clear_percent };
        const after = { ...before, ...change };
        if (after.clearPercent <= after.reachDropPercent) {
          throw new ApiError('validation_failed', 'The recovery level must be above the drop level.', { fields: { clearPercent: `Use more than ${after.reachDropPercent}` } });
        }
        await t.query(
          `UPDATE reach_guard_state SET reach_drop_percent = $2, media_drop_percent = $3, clear_percent = $4, evaluated_at = NULL WHERE tenant_id = $1`,
          [tenantId(), after.reachDropPercent, after.mediaDropPercent, after.clearPercent],
        );
        await writeAudit(t, { actor, action: 'reach_guard.thresholds_changed', target: String(tenantId()), details: { before, after } });
        return true;
      });
    },

    async trips({ cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        'SELECT * FROM reach_guard_trips WHERE tenant_id = $1 AND ($2::integer IS NULL OR id < $2) ORDER BY id DESC LIMIT $3',
        [tenantId(), after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map(toTrip), nextCursor: page.nextCursor };
    },

    // ---- Account Health -------------------------------------------------------------------------------------------------

    /** One call to Meta, added to its hour. A failure that isn't an API failure is `excluded`, and is still a call. */
    async recordCall({ channel, accountId, hour, errors, excluded, bucThrottles, usagePercent }) {
      await db.query(
        `INSERT INTO meta_call_stats (tenant_id, channel, account_id, hour, calls, errors, excluded, buc_throttles, max_usage_percent) VALUES ($1, $2, $3, $4::timestamptz, 1, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, channel, account_id, hour) DO UPDATE SET calls = meta_call_stats.calls + 1, errors = meta_call_stats.errors + EXCLUDED.errors,
           excluded = meta_call_stats.excluded + EXCLUDED.excluded, buc_throttles = meta_call_stats.buc_throttles + EXCLUDED.buc_throttles,
           max_usage_percent = GREATEST(meta_call_stats.max_usage_percent, EXCLUDED.max_usage_percent)`,
        [tenantId(), channel, accountId, hour, errors, excluded, bucThrottles, usagePercent],
      );
    },

    async callStats(channel, accountId, since) {
      const [row] = await db.query(
        `SELECT COALESCE(sum(calls), 0)::bigint AS calls, COALESCE(sum(errors), 0)::bigint AS errors, COALESCE(sum(excluded), 0)::bigint AS excluded,
                COALESCE(sum(buc_throttles), 0)::bigint AS buc, COALESCE(max(max_usage_percent), 0)::int AS usage
         FROM meta_call_stats WHERE tenant_id = $1 AND channel = $2 AND account_id = $3 AND hour > $4::timestamptz`,
        [tenantId(), channel, accountId, since],
      );
      return { calls: Number(row.calls), errors: Number(row.errors), excluded: Number(row.excluded), bucThrottles: Number(row.buc), maxUsagePercent: row.usage };
    },

    /** Meta's messaging policy refusals. The compliance log already marks them, for the breaker (4.12); which codes count is decided in one place there (to confirm). */
    async policyErrors(channel, since) {
      const [{ n }] = await db.query(
        `SELECT count(*)::int AS n FROM compliance_events WHERE tenant_id = $1 AND channel = $2 AND created_at > $3::timestamptz AND details->>'errorClass' = 'policy'`,
        [tenantId(), channel, since],
      );
      return n;
    },

    async webhookSince(channel, accountId, since) {
      const rows = await db.query('SELECT 1 FROM inbound_events WHERE tenant_id = $1 AND channel = $2 AND account_id = $3 AND received_at > $4::timestamptz LIMIT 1', [tenantId(), channel, accountId, since]);
      return rows.length > 0;
    },

    /** True when a poll saw a media's comment count rise since `since`, or a daily figure shows comments on a day in that window. */
    async commentsSince(accountRef, since) {
      const [row] = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM insight_daily WHERE tenant_id = $1 AND account_ref = $2 AND metric = 'comments' AND breakdown = '' AND breakdown_value = '' AND day >= $3::timestamptz::date AND value > 0
          ) OR EXISTS (
            SELECT 1 FROM insight_snapshots s JOIN insight_media m ON m.tenant_id = s.tenant_id AND m.id = s.media_ref
            WHERE s.tenant_id = $1 AND m.account_ref = $2 AND s.captured_at > $3::timestamptz AND jsonb_typeof(s.metrics->'comments') = 'number'
              AND (s.metrics->>'comments')::numeric > COALESCE((
                SELECT (p.metrics->>'comments')::numeric FROM insight_snapshots p
                WHERE p.tenant_id = s.tenant_id AND p.media_ref = s.media_ref AND p.captured_at < s.captured_at AND jsonb_typeof(p.metrics->'comments') = 'number'
                ORDER BY p.captured_at DESC LIMIT 1), 0)
          ) AS yes`,
        [tenantId(), accountRef, since],
      );
      return Boolean(row.yes);
    },

    async health(accountRef) {
      const [row] = await db.query('SELECT * FROM account_health WHERE tenant_id = $1 AND account_ref = $2', [tenantId(), accountRef]);
      return toHealth(row) ?? null;
    },

    async saveHealth(accountRef, { score, band, deductions }, { at, day }) {
      const list = JSON.stringify(deductions);
      await db.query(
        `INSERT INTO account_health (tenant_id, account_ref, score, band, deductions, computed_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (tenant_id, account_ref) DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, deductions = EXCLUDED.deductions, computed_at = EXCLUDED.computed_at`,
        [tenantId(), accountRef, score, band, list, at],
      );
      await db.query(
        `INSERT INTO account_health_history (tenant_id, account_ref, day, score, band, deductions, computed_at) VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::timestamptz)
         ON CONFLICT (tenant_id, account_ref, day) DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, deductions = EXCLUDED.deductions, computed_at = EXCLUDED.computed_at`,
        [tenantId(), accountRef, day, score, band, list, at],
      );
    },

    async dropHealth(accountRef) {
      await db.query('DELETE FROM account_health WHERE tenant_id = $1 AND account_ref = $2', [tenantId(), accountRef]);
    },

    /** The worst account's row for each day. */
    async healthHistory(from, to) {
      const rows = await db.query(
        `SELECT DISTINCT ON (h.day) to_char(h.day, 'YYYY-MM-DD') AS d, h.score, h.band, h.deductions FROM account_health_history h
         WHERE h.tenant_id = $1 AND h.day BETWEEN $2::date AND $3::date ORDER BY h.day, h.score`,
        [tenantId(), from, to],
      );
      return new Map(rows.map((r) => [r.d, { score: r.score, band: r.band, deductions: r.deductions ?? [] }]));
    },

    /** History is kept for 90 days (7.7), and the yardsticks as long, to explain it. */
    async purgeOld(accountRef, beforeDay) {
      await db.query('DELETE FROM account_health_history WHERE tenant_id = $1 AND account_ref = $2 AND day < $3::date', [tenantId(), accountRef, beforeDay]);
      await db.query('DELETE FROM reach_guard_baselines WHERE tenant_id = $1 AND account_ref = $2 AND day < $3::date', [tenantId(), accountRef, beforeDay]);
    },
  };
}
