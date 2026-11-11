import { PINCODE } from '../../contracts/orders.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { failureFields } from './util.js';

/**
 * Whether the courier reaches a PIN code, and with cash on delivery (PRD 9.10, S-33), from the seller's pickup PIN on the
 * account it ships with. Answers are kept for an hour (a "no" for five minutes), in this process and in serviceability_cache.
 *
 *   check(pincode, { budgetMs, q }) -> { serviceable, cod, checked }
 *
 * checkout calls ctx.shipping.serviceable(pincode) from inside its order transaction, holding the order's rows. So the
 * answer must come quickly and must never wait on the database behind that transaction (with PGlite there is one
 * connection, and waiting would never end): every read here has a short time limit, a write is never waited for, and the
 * courier gets a few seconds. When the answer can't be had in time the PIN is taken as served (`checked: false`, logged),
 * because a courier that is down must not close every store; the parcel's own booking checks again.
 */
const KEEP_MS = 60 * 60_000;
// A "no" is kept for less time: an answer of the wrong shape reads as no courier, and a wrong no closes a PIN to orders.
const KEEP_NO_MS = 5 * 60_000;
const READ_BUDGET_MS = 400;
const OPEN = Object.freeze({ serviceable: true, cod: true, checked: false });

class TooSlow extends Error {}
function within(ms, promise) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow()), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export function createServiceability(ctx, { settings }) {
  const { db } = ctx;
  const memo = new Map(); // `${tenant}:${pickup}:${delivery}:${mode}` -> { answer, until }

  const remember = (key, answer) => {
    if (memo.size > 5000) memo.clear();
    memo.set(key, { answer, until: Date.now() + (answer.serviceable ? KEEP_MS : KEEP_NO_MS) });
  };

  async function check(pincode, { budgetMs = 3000, q = null } = {}) {
    if (!PINCODE.test(String(pincode ?? ''))) return { serviceable: false, cod: false, checked: true };
    const tid = tenantId();
    // A caller inside a transaction may hand it over (`q`): the reads then go through it, with no need for a time limit.
    const reader = q && typeof q.query === 'function' ? q : db;
    const read = (promise) => (reader === db ? within(READ_BUDGET_MS, promise) : promise);
    let s;
    try {
      s = await read(reader === db ? settings.cachedRow() : settings.row(reader));
    } catch (err) {
      log.warn('shipping.serviceability_open', { tenantId: tid, why: err instanceof TooSlow ? 'settings_slow' : 'settings_failed' });
      return OPEN;
    }
    // A business with no pickup PIN ships by itself: nothing to ask the courier.
    if (!s.pickup_pincode) return OPEN;
    const key = `${tid}:${s.pickup_pincode}:${pincode}:${s.mode}`;
    const held = memo.get(key);
    if (held && held.until > Date.now()) return held.answer;

    try {
      const [row] = await read(reader.query(
        `SELECT serviceable, cod FROM serviceability_cache WHERE tenant_id = $1 AND pickup_pincode = $2 AND delivery_pincode = $3 AND checked_at > now() - make_interval(secs => CASE WHEN serviceable THEN $4::int ELSE $5::int END)`,
        [tid, s.pickup_pincode, pincode, KEEP_MS / 1000, KEEP_NO_MS / 1000],
      ));
      if (row) {
        const answer = { serviceable: row.serviceable, cod: row.serviceable && row.cod, checked: true };
        remember(key, answer);
        return answer;
      }
    } catch {
      // Too slow or failed: ask the courier instead.
    }

    let answer;
    try {
      const courier = settings.courierFor(s.mode, s);
      const got = await within(budgetMs, courier.serviceability({ pickupPincode: s.pickup_pincode, deliveryPincode: pincode, cod: true }));
      if (typeof got?.serviceable !== 'boolean') throw new Error('The courier’s answer could not be read');
      answer = { serviceable: got.serviceable, cod: got.serviceable && Boolean(got.cod), checked: true };
    } catch (err) {
      log.warn('shipping.serviceability_open', { tenantId: tid, why: err instanceof TooSlow ? 'courier_slow' : 'courier_failed', ...(err instanceof TooSlow ? {} : failureFields(err)) });
      ctx.platform?.metrics?.inc?.('serviceability_unchecked_total', {});
      return OPEN;
    }
    remember(key, answer);
    // Kept for other processes; never waited for, so a write behind checkout's transaction holds nothing up.
    db.query(
      `INSERT INTO serviceability_cache (tenant_id, pickup_pincode, delivery_pincode, serviceable, cod, checked_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, pickup_pincode, delivery_pincode) DO UPDATE SET serviceable = EXCLUDED.serviceable, cod = EXCLUDED.cod, checked_at = EXCLUDED.checked_at`,
      [tid, s.pickup_pincode, pincode, answer.serviceable, answer.cod],
    ).catch((err) => log.warn('shipping.serviceability_cache_failed', { tenantId: tid, code: err?.code ?? '' }));
    return answer;
  }

  /** What the shopper or seller reads about a PIN code. */
  const message = (answer) => {
    if (!answer.serviceable) return 'We don’t deliver to this PIN code yet.';
    return answer.cod ? 'We deliver here. Cash on delivery is available.' : 'We deliver here. Pay online for this PIN code.';
  };

  return { check, message, forget: () => memo.clear() };
}
