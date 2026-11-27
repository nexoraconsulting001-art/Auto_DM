import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const INITIAL_WAIT_MINUTES = 30;
/** What the seller calls each channel, so the alert sends them to the right connection. */
const CHANNEL_NAMES = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp' });
const REDUCED_MS = 15 * MINUTE;
const POLICY_WINDOW_MS = 15 * MINUTE;
const POLICY_ERRORS_TO_TRIP = 5;
const SAMPLE_SENDS = 50;
const ERROR_RATE_TO_TRIP = 0.2;
const THROTTLE_CYCLES_TO_TRIP = 3;
const CROSS_TENANT_BREAKERS = 3;
const SEND_KINDS = `('private_reply', 'dm', 'public_reply')`;
const SEND_DECISIONS = `('sent', 'sent_fallback', 'unknown', 'failed')`;

/**
 * The per-business, per-channel breaker (PRD 4.12), and the guard across businesses (4.13). A Facebook problem pauses only Facebook.
 * Everything here is about one business; the only thing that looks across them is the count that freezes activations.
 */
export function createBreaker({ db, repos, now, gate }) {
  const at = () => now();

  async function ensure(channel) {
    await db.query(`INSERT INTO breakers (tenant_id, channel) VALUES ($1, $2) ON CONFLICT (tenant_id, channel) DO NOTHING`, [tenantId(), channel]);
  }

  /** PRD 4.13: 3 breakers in 1h pages ops and freezes new activations. Written once, however many more trip. */
  async function crossTenantGuard() {
    const since = new Date(+at() - HOUR);
    const [{ n }] = await db.platform.query('SELECT count(DISTINCT tenant_id)::int AS n FROM breakers WHERE opened_at > $1::timestamptz', [since]);
    if (n < CROSS_TENANT_BREAKERS) return false;
    const frozen = await db.platform.query(
      `UPDATE platform_switches SET engaged = true, reason = 'Three businesses tripped a breaker within an hour', engaged_by = 'system', engaged_at = $1::timestamptz, updated_at = $1::timestamptz
       WHERE key = 'activations_frozen' AND NOT engaged RETURNING key`,
      [at()],
    );
    if (!frozen.length) return false;
    await db.platform.query(
      `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target) VALUES (NULL, 'ops', 'breakers.cross_tenant', 'critical', $1, '')`,
      [`${n} businesses tripped a breaker within an hour. New activations are frozen.`],
    );
    return true;
  }

  /**
   * Opens the breaker. ownerAlert false: the cause has already told the owner what to do (a refused token raises token.rejected,
   * "reconnect"), so a second alert saying "we'll retry shortly" would only contradict it (PRD 4.2: one alert for the token). Ops'
   * cross-tenant guard still counts the trip.
   */
  async function trip(channel, reason, { ownerAlert = true, onlyClosed = false } = {}) {
    await ensure(channel);
    const time = at();
    // One UPDATE decides: of two processes tripping at once only one gets the row back (the other re-reads it as open), so one alert.
    // onlyClosed (the counted rules): a half-open breaker belongs to its probe, whose result alone reopens or closes it.
    const rows = await db.query(
      `UPDATE breakers SET state = 'open', trip_reason = $3, opened_at = $4::timestamptz, open_until = $5::timestamptz, wait_minutes = $6, throttle_cycles = 0, updated_at = $4::timestamptz
       WHERE tenant_id = $1 AND channel = $2 AND ${onlyClosed ? `state = 'closed'` : `state <> 'open'`} RETURNING channel`,
      [tenantId(), channel, reason, time, new Date(+time + INITIAL_WAIT_MINUTES * MINUTE), INITIAL_WAIT_MINUTES],
    );
    gate.invalidate();
    if (!rows.length) return false;
    try {
      if (ownerAlert) await repos.alerts?.raise({
        kind: 'breaker.open', severity: 'critical', target: channel,
        message: `Sending on ${CHANNEL_NAMES[channel] ?? 'your account'} is paused while we check a problem with your account. Automated messages are held, and we’ll retry shortly.`,
        dedupeKey: `breaker:${channel}:${+time}`,
      });
      await crossTenantGuard();
    } catch (err) {
      reportError(err, { msg: 'compliance.breaker_alert_failed', channel });
    }
    return true;
  }

  /**
   * Counts the last 15 minutes and the last 50 sends. Reads compliance_events, so nothing else has to keep a tally. Only what was
   * logged after the breaker last opened counts: those outcomes already tripped it once, and counting them again would reopen it on
   * the first send after its probe closed it (the same 50 sends would still read over 20%). `errors` false: a success was logged, which
   * cannot add a policy error, so only the rate is read.
   */
  async function shouldTrip(channel, { errors = true } = {}) {
    const opened = `COALESCE((SELECT b.opened_at FROM breakers b WHERE b.tenant_id = $1 AND b.channel = $2), '-infinity'::timestamptz)`;
    if (errors) {
      const [{ policy }] = await db.query(
        `SELECT count(*)::int AS policy FROM compliance_events
         WHERE tenant_id = $1 AND channel = $2 AND created_at > GREATEST($3::timestamptz, ${opened}) AND details->>'errorClass' = 'policy'`,
        [tenantId(), channel, new Date(+at() - POLICY_WINDOW_MS)],
      );
      if (policy >= POLICY_ERRORS_TO_TRIP) return 'policy';
    }
    const [{ sends, failed }] = await db.query(
      `SELECT count(*)::int AS sends, (count(*) FILTER (WHERE decision IN ('unknown', 'failed')))::int AS failed FROM (
         SELECT decision FROM compliance_events
         WHERE tenant_id = $1 AND channel = $2 AND kind IN ${SEND_KINDS} AND decision IN ${SEND_DECISIONS} AND created_at > ${opened}
         ORDER BY id DESC LIMIT ${SAMPLE_SENDS}
       ) recent`,
      [tenantId(), channel],
    );
    if (sends < SAMPLE_SENDS) return null;
    return failed / SAMPLE_SENDS > ERROR_RATE_TO_TRIP ? 'error_rate' : null;
  }

  /**
   * PRD 4.12: the counted rules are weighed after every finished send, success or not. Weighed only after a failure, a window whose
   * errors came first (11 failed, then 39 sent: 22%) was never looked at once it was full.
   */
  async function weigh(channel, options) {
    const reason = await shouldTrip(channel, options);
    if (reason) await trip(channel, reason, { onlyClosed: true });
  }

  return {
    trip,

    /**
     * After 30 minutes open, one send goes as a probe. Only one worker wins it. A half-open breaker whose probe never reported
     * (its worker died) can be taken again once a lease has passed. True when this caller owns the probe. Decided on the row itself,
     * because this is only ever called with a breaker a cached read says is open, and that read may be seconds old.
     */
    async tryProbe(channel, leaseMs) {
      const time = at();
      const rows = await db.query(
        `UPDATE breakers SET state = 'half_open', updated_at = $3::timestamptz
         WHERE tenant_id = $1 AND channel = $2 AND (
           (state = 'open' AND open_until <= $3::timestamptz) OR (state = 'half_open' AND updated_at <= $4::timestamptz)
         ) RETURNING channel`,
        [tenantId(), channel, time, new Date(+time - leaseMs)],
      );
      gate.invalidate();
      return rows.length > 0;
    },

    /** The probe was never sent (the rules stopped it): the breaker stays open for the next job to try. */
    async probeUnused(channel) {
      await db.query(`UPDATE breakers SET state = 'open', open_until = $3::timestamptz, updated_at = $3::timestamptz WHERE tenant_id = $1 AND channel = $2 AND state = 'half_open'`, [tenantId(), channel, at()]);
      gate.invalidate();
    },

    /** Only a half-open breaker is closed by its probe: one another process (or a refused token) has opened since stays open. */
    async probeSucceeded(channel) {
      const time = at();
      await db.query(
        `UPDATE breakers SET state = 'closed', trip_reason = '', open_until = NULL, wait_minutes = $4, reduced_until = $5::timestamptz, throttle_cycles = 0, updated_at = $3::timestamptz
         WHERE tenant_id = $1 AND channel = $2 AND state = 'half_open'`,
        [tenantId(), channel, time, INITIAL_WAIT_MINUTES, new Date(+time + REDUCED_MS)],
      );
      gate.invalidate();
    },

    /** Failure reopens it and doubles the wait. */
    async probeFailed(channel) {
      const time = at();
      await db.query(
        `UPDATE breakers SET state = 'open', opened_at = $3::timestamptz, wait_minutes = wait_minutes * 2,
           open_until = $3::timestamptz + make_interval(mins => wait_minutes * 2), updated_at = $3::timestamptz
         WHERE tenant_id = $1 AND channel = $2`,
        [tenantId(), channel, time],
      );
      gate.invalidate();
    },

    /** Three throttle backoff cycles in a row. A send that goes through resets the count. */
    async noteThrottle(channel) {
      await ensure(channel);
      const [row] = await db.query(
        `UPDATE breakers SET throttle_cycles = throttle_cycles + 1, updated_at = $3::timestamptz WHERE tenant_id = $1 AND channel = $2 RETURNING throttle_cycles`,
        [tenantId(), channel, at()],
      );
      if (row.throttle_cycles >= THROTTLE_CYCLES_TO_TRIP) await trip(channel, 'throttle');
    },

    /** After a delivered send has been logged. */
    async noteSuccess(channel) {
      await db.query(`UPDATE breakers SET throttle_cycles = 0 WHERE tenant_id = $1 AND channel = $2 AND throttle_cycles > 0`, [tenantId(), channel]);
      await weigh(channel, { errors: false });
    },

    /** After a failure has been logged. */
    async noteFailure(channel) {
      await weigh(channel);
    },
  };
}
