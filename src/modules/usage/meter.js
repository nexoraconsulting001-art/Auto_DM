import { DM_ALERT_PERCENTS, METERED_SEND_KINDS, METERS, alertsDue, dmUsageKey, meterOf, usageMonthOf } from '../../contracts/billing.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * The meters (PRD 5.12): what a business used this calendar month in India, and whether it may send one more automated
 * DM. Everything here runs inside one business and reads only that business's rows.
 *
 * Counting. One accepted send is one usage_events row keyed by its job (dmUsageKey). The insert is ON CONFLICT DO NOTHING
 * and the database adds a row that was really written to usage_months in the same statement, so a send reported twice,
 * or by two workers at once, is counted once, and two different sends counted at once are both counted (the row update
 * takes the row's lock). The month is set by the database from the send's own time, so no send lands in two months.
 * The demo business is never counted (the insert checks tenant_is_demo), and neither is a test send.
 *
 * The allowance is read from data on every ask: the plan's dms.monthly (or the business's override), plus the units of
 * every DM pack running this month. A plan change, a pack bought or the month turning applies to the very next send.
 *
 * Holding at 100%. hasDmsLeft is asked by the gate at send time, in one statement that reads the month's count and every
 * DM already on its way (claimed by a worker, being sent, or accepted and not yet counted). A worker claims its job
 * before it asks, so of two workers asking at once the later one always sees the other's job: parallel sends at the
 * boundary cannot both pass. A tie is settled the safe way: the job is held, and release() puts it back a minute later.
 */
export const USAGE_COST_DEFAULTS = Object.freeze({ dms: 0, whatsapp_messages: 0, ai_units: 0 });
const DM_LIMIT_FEATURE = 'dms.monthly';
const SENT = ['sent', 'sent_fallback'];
// An accepted send waits this long at most between the job write and its usage row; older ones are the reconcile job's.
const UNCOUNTED_WINDOW_MS = 15 * 60_000;
const KEY = /^[\x21-\x7E]{1,120}$/;

/** When a usage month (YYYY-MM-01) starts and ends, as instants: midnight in India. */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const offset = 330 * 60_000;
  return { start: new Date(Date.UTC(y, m - 1, 1) - offset), end: new Date(Date.UTC(y, m, 1) - offset) };
}
export const previousMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};

/** One read: plan limit or override, packs running this month, the month's row, and (when asked) DMs on their way. */
function allowanceSql(withInFlight) {
  const inFlight = withInFlight
    ? `(SELECT count(*) FROM outbound_jobs j
        WHERE j.tenant_id = t.id AND j.channel <> 'whatsapp' AND j.kind = ANY($5::text[]) AND NOT j.is_test AND j.purpose <> 'test'
          AND (j.status = 'sending'
            OR (j.status = 'queued' AND j.locked_by IS NOT NULL AND j.lease_until > $2::timestamptz)
            OR (j.status = ANY($6::text[]) AND j.sent_at >= GREATEST($4::timestamptz, $7::timestamptz)
                AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.tenant_id = j.tenant_id AND e.idempotency_key = 'dm:' || j.id::text))))`
    : '0';
  const held = withInFlight
    ? `(SELECT count(*) FROM outbound_jobs h WHERE h.tenant_id = t.id AND h.status = 'held' AND h.reason = 'held.dm_limit' AND h.expires_at > $2::timestamptz)`
    : '0';
  return `SELECT tenant_is_demo(t.id) AS demo, t.plan,
       CASE WHEN o.feature IS NOT NULL THEN o.enabled ELSE f.feature IS NOT NULL END AS enabled,
       CASE WHEN o.feature IS NOT NULL THEN o.limit_value ELSE f.limit_value END AS limit_value,
       COALESCE(p.units, 0) AS pack_units, COALESCE(p.packs, 0) AS packs,
       COALESCE(u.used, 0) AS used, u.month IS NOT NULL AS has_row, u.included AS row_included, u.pack_units AS row_pack_units, u.packs AS row_packs,
       u.alert_80_at, u.alert_100_at,
       ${inFlight} AS in_flight, ${held} AS held
     FROM tenants t
     LEFT JOIN plan_features f ON f.plan_code = t.plan AND f.feature = '${DM_LIMIT_FEATURE}'
     LEFT JOIN tenant_features o ON o.tenant_id = t.id AND o.feature = '${DM_LIMIT_FEATURE}'
     LEFT JOIN usage_months u ON u.tenant_id = t.id AND u.meter = 'dms' AND u.month = $3::date
     LEFT JOIN LATERAL (
       SELECT sum(i.quantity::bigint * a.units) AS units, sum(i.quantity) AS packs
       FROM subscription_items i JOIN addons a ON a.code = i.addon_code
       WHERE i.tenant_id = t.id AND a.kind = 'pack' AND a.meter = 'dms' AND i.starts_at <= $2::timestamptz AND (i.ends_at IS NULL OR i.ends_at > $4::timestamptz)
     ) p ON true
     WHERE t.id = $1`;
}

/** The DM meter from one allowance row. Included null is no limit. */
function dmMeter(row) {
  if (row.demo) return meterOf({ used: Number(row.used), included: null });
  const included = !row.enabled ? 0 : row.limit_value === null ? null : Number(row.limit_value);
  return meterOf({ used: Number(row.used), included, packUnits: included === null ? 0 : Number(row.pack_units) });
}

export function createMeter({ db, config = {}, notify = null, compliance = null }) {
  const clock = config.usageNow ?? config.complianceNow ?? Date.now;
  const now = () => new Date(clock());
  const unitCost = { ...USAGE_COST_DEFAULTS, ...(config.usageCostPaise ?? {}) };

  async function readAllowance(at, { inFlight = false } = {}) {
    const month = usageMonthOf(at);
    const { start } = monthBounds(month);
    const params = [tenantId(), at, month, start];
    if (inFlight) params.push([...METERED_SEND_KINDS], SENT, new Date(+at - UNCOUNTED_WINDOW_MS));
    const [row] = await db.query(allowanceSql(inFlight), params);
    return row ? { ...row, month } : null;
  }

  /**
   * Counts one thing on a meter, once per key. Returns true when this call counted it, false for a repeat (or the demo
   * business). `at` decides the month. Callers: the accepted-send listener (dms, whatsapp_messages), the AI replies module
   * (ai_units, with the provider's units and cost), the reconcile job.
   */
  async function record({ meter, quantity = 1, costPaise = 0, key, at = now() }) {
    if (!METERS.includes(meter)) throw new Error(`Unknown meter "${meter}"`);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2_147_483_647) throw new Error('record() counts a whole number above 0');
    if (!Number.isSafeInteger(costPaise) || costPaise < 0) throw new Error('record() takes the cost in whole paise');
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error('record() needs an idempotency key of 1 to 120 characters');
    const when = new Date(at);
    if (Number.isNaN(+when)) throw new Error('record() needs a time');
    const rows = await db.query(
      `INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at)
       SELECT $1, $2, $3, $4, $5, $6::timestamptz WHERE NOT tenant_is_demo($1)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
      [tenantId(), meter, quantity, costPaise, key, when],
    );
    return rows.length > 0;
  }

  /**
   * compliance.onAccepted: one private reply or DM Meta accepted, ids only. WhatsApp goes on its own meter at its unit cost;
   * Instagram and Facebook on the DM meter, which may now owe an alert.
   */
  async function accepted(event) {
    if (!event || event.tenantId !== tenantId()) return false;
    if (!METERED_SEND_KINDS.includes(event.kind) || event.purpose === 'test') return false;
    const meter = event.channel === 'whatsapp' ? 'whatsapp_messages' : 'dms';
    const key = typeof event.key === 'string' && /^dm:\d+$/.test(event.key) ? event.key : dmUsageKey(event.jobId);
    const counted = await record({ meter, key, at: event.at ?? now(), costPaise: unitCost[meter] ?? 0 });
    if (counted && meter === 'dms') await checkAlerts({ at: event.at ?? now() }).catch((err) => reportError(err, { msg: 'usage.alert_failed' }));
    return counted;
  }

  /**
   * compliance.useQuota: whether one more automated DM may go now. Asked by a worker after it claimed its job (that job is
   * among those on their way), by a send asked for now before its job exists, and by release() with purpose 'release'.
   */
  async function hasDmsLeft({ channel = null, purpose = null } = {}) {
    if (channel === 'whatsapp') return true;
    const row = await readAllowance(now(), { inFlight: true });
    if (!row || row.demo) return true;
    const meter = dmMeter(row);
    if (meter.allowance === null) return true;
    const inFlight = Number(row.in_flight);
    // The gate's own release() puts every held DM back at once: it is told yes only when they all fit. Otherwise
    // releaseRoom() below puts back just as many as there is room for, so the workers can't all tie at the boundary again.
    if (purpose === 'release') return meter.used + inFlight + Math.max(1, Number(row.held)) <= meter.allowance;
    return meter.used + Math.max(inFlight, 1) <= meter.allowance;
  }

  /**
   * Puts held DMs back in the queue, oldest first, as many as the month has room for, unexpired only. When all of them fit
   * this is the gate's releaseDmLimit() (which also wakes the worker); otherwise it moves just that many itself, with the
   * same update the gate uses, because releaseDmLimit() can only move all of them.
   */
  async function releaseRoom() {
    if (!compliance?.releaseDmLimit) return 0;
    const at = now();
    const row = await readAllowance(at, { inFlight: true });
    if (!row || !Number(row.held)) return 0;
    const meter = dmMeter(row);
    if (meter.allowance === null || row.demo) return compliance.releaseDmLimit();
    const room = meter.allowance - meter.used - Number(row.in_flight);
    if (room <= 0) return 0;
    if (room >= Number(row.held)) return compliance.releaseDmLimit();
    const moved = await db.query(
      `WITH pick AS MATERIALIZED (
         SELECT id FROM outbound_jobs WHERE tenant_id = $1 AND status = 'held' AND reason = 'held.dm_limit' AND expires_at > $2::timestamptz
         ORDER BY run_at, id LIMIT $3::integer FOR UPDATE SKIP LOCKED
       )
       UPDATE outbound_jobs o SET status = 'queued', reason = '', lease_until = NULL, updated_at = $2::timestamptz
       FROM pick WHERE o.tenant_id = $1 AND o.id = pick.id AND o.status = 'held' RETURNING o.id`,
      [tenantId(), at, room],
    );
    return moved.length;
  }

  /** The DM meter now, keeping usage_months' included and pack figures current for the month (they are for display). */
  async function dmsNow(at = now()) {
    const row = await readAllowance(at);
    if (!row) return null;
    const meter = dmMeter(row);
    const included = meter.included;
    if (row.has_row && (String(row.row_included) !== String(included) || Number(row.row_pack_units) !== meter.packUnits || Number(row.row_packs) !== Number(row.packs))) {
      await db.query(
        `UPDATE usage_months SET included = $3, pack_units = $4, packs = $5, updated_at = $6::timestamptz WHERE tenant_id = $1 AND meter = 'dms' AND month = $2::date`,
        [tenantId(), row.month, included, meter.packUnits, Number(row.packs), at],
      );
    }
    return { row, meter, month: row.month };
  }

  async function packOption() {
    const [pack] = await db.query(`SELECT units, price_paise FROM addons WHERE kind = 'pack' AND meter = 'dms' AND active ORDER BY position, code LIMIT 1`);
    return pack ? { units: Number(pack.units), pricePaise: Number(pack.price_paise) } : null;
  }

  /**
   * The 80% and 100% alerts of included DMs plus packs, once each per business and month (F-86, F-112). The mark is set by
   * an UPDATE that only one caller can win, in the same transaction as the outbox row, so two workers crossing the line at
   * once tell the owner once. Reaching both at once (a downgrade, a big jump) sends the 100% one and marks both.
   * The alert's used and percent are the count this caller read when it crossed the line (decided, R3-MONEY-P1): with
   * workers counting at the same moment that may be one or two short of the settled count, never below the mark.
   */
  async function checkAlerts({ at = now() } = {}) {
    if (!notify?.emit) return [];
    const current = await dmsNow(at);
    if (!current?.row.has_row || current.row.demo) return [];
    const { row, meter, month } = current;
    const due = alertsDue(meter, { alert80At: row.alert_80_at, alert100At: row.alert_100_at }).filter((p) => DM_ALERT_PERCENTS.includes(p));
    if (!due.length) return [];
    const top = Math.max(...due);
    const pack = await packOption();
    return db.tx(async (t) => {
      const set = due.map((p) => `alert_${p}_at = COALESCE(alert_${p}_at, $3::timestamptz)`).join(', ');
      const claimed = await t.query(`UPDATE usage_months SET ${set} WHERE tenant_id = $1 AND meter = 'dms' AND month = $2::date AND alert_${top}_at IS NULL RETURNING month`, [tenantId(), month, at]);
      if (!claimed.length) return [];
      const data = {
        percent: top === 100 ? 100 : Math.min(99, meter.percent), used: meter.used, allowance: meter.allowance, included: meter.included, packUnits: meter.packUnits,
        ...(pack ? { packSize: pack.units, packPricePaise: pack.pricePaise } : {}),
      };
      await notify.emit({ event: `dm.usage_${top}`, tenantId: tenantId(), key: `dm.usage_${top}:${month}`, data }, t);
      log.info('usage.alert', { tenantId: tenantId(), percent: top, month });
      return [top];
    });
  }

  /**
   * After the allowance grew (a pack added, an upgrade, a new month): held DMs go back in the queue, unexpired ones only,
   * when there is room for at least one. Billing calls this; the worker's release() and the month job do it as well.
   */
  const allowanceChanged = () => releaseRoom();

  /** billing.usage: the live meters for the console and the owner app. */
  async function view() {
    const at = now();
    const current = await dmsNow(at);
    const month = current?.month ?? usageMonthOf(at);
    const others = await db.query(`SELECT meter, used FROM usage_months WHERE tenant_id = $1 AND month = $2::date AND meter <> 'dms'`, [tenantId(), month]);
    const [{ held }] = await db.query(`SELECT count(*)::int AS held FROM outbound_jobs WHERE tenant_id = $1 AND status = 'held' AND reason = 'held.dm_limit'`, [tenantId()]);
    const [buy] = await db.query(
      `SELECT pr.rank >= mp.rank OR (t.plan = 'free' AND COALESCE((SELECT free_can_buy_packs FROM billing_settings LIMIT 1), false)) AS can
       FROM tenants t JOIN plans pr ON pr.code = t.plan, addons a JOIN plans mp ON mp.code = a.min_plan
       WHERE t.id = $1 AND a.kind = 'pack' AND a.meter = 'dms' AND a.active ORDER BY a.position LIMIT 1`,
      [tenantId()],
    );
    const usedOf = (meter) => Number(others.find((r) => r.meter === meter)?.used ?? 0);
    return {
      month,
      resetsAt: monthBounds(month).end,
      meters: [
        { meter: 'dms', ...(current?.meter ?? meterOf({ used: 0, included: null })) },
        { meter: 'whatsapp_messages', ...meterOf({ used: usedOf('whatsapp_messages'), included: null }) },
        { meter: 'ai_units', ...meterOf({ used: usedOf('ai_units'), included: null }) },
      ],
      heldDms: Number(held),
      canBuyPacks: Boolean(buy?.can),
    };
  }

  return { now, record, accepted, hasDmsLeft, releaseRoom, checkAlerts, allowanceChanged, view, dmsNow, unitCost };
}
