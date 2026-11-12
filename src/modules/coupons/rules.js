import crypto from 'node:crypto';
import { formatRupees } from '../../contracts/catalog.js';
import { currentChannel } from '../../platform/channel.js';
import { tenantId } from '../../tenancy.js';
import { splitDiscount } from '../checkout/pricing.js';

/**
 * Coupon rules (PRD 9.14). One coupon per order, the same whatever case the shopper types it in.
 *
 *   evaluate(q, { code, lines, phone?, shopperId?, lock?, config }) -> null | { applied, message, coupon, discountPaise, freeShipping, shares }
 *       Works a code out against priced lines. Changes nothing. With `lock` (inside the order's transaction) the coupon row
 *       is locked first, so every redemption of one code happens one at a time and each sees the ones before it (S-47).
 *   redeem(t, { coupon, orderId, shopperId, phone, discountPaise, config })
 *       Counts the use and writes the redemption, in the order's transaction. The count goes up only while it is under the
 *       limit, and the database's own check (used_count <= max_uses) is the second lock.
 *   release(t, orderId)   a cancelled order's use stops counting, once.
 *
 * A customer is known by a keyed hash of the phone number, so a guest's uses count too (S-46) and no number is copied.
 *
 * An app-only coupon (coupons.app_only, Phase 6, P-63) applies only when the request came through the shopper app's gate with a valid app
 * session (currentChannel() is 'app'); anywhere else it is refused with APP_ONLY_MESSAGE. A trigger on coupon_redemptions is the second lock.
 */
export const APP_ONLY_MESSAGE = 'This offer works only in the app';
export const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

/** The last ten digits of an Indian number, which is how one person's number is recognised however it was typed. */
export const phoneDigits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

const keyCache = new WeakMap();
function hashKey(config = {}) {
  let key = keyCache.get(config);
  if (!key) {
    const secret = config.dataKey || config.sessionSecret;
    if (!secret) throw new Error('Coupon limits need DATA_KEY or SESSION_SECRET');
    key = crypto.createHash('sha256').update(`coupon-customer\n${secret}`).digest();
    keyCache.set(config, key);
  }
  return key;
}
export const customerKey = (config, phone) => crypto.createHmac('sha256', hashKey(config)).update(`${tenantId()}\n${phoneDigits(phone)}`).digest('hex');

const refused = (code, message, coupon = null) => ({ applied: false, message, coupon, code, discountPaise: 0, freeShipping: false, shares: null });

/** `lines` are priced lines that can be bought ({ productId, linePaise }). */
export async function evaluate(q, { code: typed, lines, phone = '', shopperId = null, lock = false, now = new Date(), config = {} }) {
  const tid = tenantId();
  const code = normalizeCode(typed);
  if (!code) return null;
  if (!COUPON_CODE.test(code)) return refused(code, 'This code isn’t valid.');
  const [coupon] = await q.query(`SELECT * FROM coupons WHERE tenant_id = $1 AND code = $2${lock ? ' FOR UPDATE' : ''}`, [tid, code]);
  if (!coupon || !coupon.active) return refused(code, 'This code isn’t valid.');
  if (coupon.app_only && currentChannel() !== 'app') return refused(code, APP_ONLY_MESSAGE, coupon);
  if (coupon.starts_at && new Date(coupon.starts_at) > now) return refused(code, 'This code isn’t active yet.', coupon);
  if (coupon.ends_at && new Date(coupon.ends_at) <= now) return refused(code, 'This code has expired.', coupon);
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return refused(code, 'This code has been used up.', coupon);

  let eligible = lines.map(() => true);
  if (coupon.scope === 'products') eligible = lines.map((l) => coupon.scope_ids.includes(l.productId));
  if (coupon.scope === 'categories') {
    const rows = await q.query(
      'SELECT DISTINCT product_id FROM product_categories WHERE tenant_id = $1 AND product_id = ANY($2::int[]) AND category_id = ANY($3::int[])',
      [tid, lines.map((l) => l.productId), coupon.scope_ids],
    );
    const inScope = new Set(rows.map((r) => r.product_id));
    eligible = lines.map((l) => inScope.has(l.productId));
  }
  const subtotal = lines.reduce((sum, l) => sum + l.linePaise, 0);
  const base = lines.reduce((sum, l, i) => sum + (eligible[i] ? l.linePaise : 0), 0);
  if (base <= 0) return refused(code, 'This code doesn’t apply to the items in your bag.', coupon);
  if (subtotal < Number(coupon.min_order_paise)) return refused(code, `Add ${formatRupees(Number(coupon.min_order_paise) - subtotal)} more to use this code.`, coupon);

  const digits = phoneDigits(phone);
  if (digits.length === 10) {
    if (coupon.max_uses_per_customer !== null) {
      const [{ n }] = await q.query(
        `SELECT count(*)::int AS n FROM coupon_redemptions WHERE tenant_id = $1 AND coupon_id = $2 AND customer_key = $3 AND status = 'applied'`,
        [tid, coupon.id, customerKey(config, phone)],
      );
      if (n >= coupon.max_uses_per_customer) return refused(code, 'You’ve already used this code.', coupon);
    }
    if (coupon.first_order_only) {
      // Phase 0 kept ten digits, checkout keeps +91 and ten digits: both are looked up, and both use the phone index.
      const [earlier] = await q.query(
        `SELECT 1 FROM orders WHERE tenant_id = $1 AND fulfilment_status <> 'cancelled' AND (phone = ANY($2::text[]) OR ($3::int IS NOT NULL AND shopper_id = $3)) LIMIT 1`,
        [tid, [digits, `+91${digits}`], shopperId],
      );
      if (earlier) return refused(code, 'This code is for a first order only.', coupon);
    }
  } else if (coupon.max_uses_per_customer !== null || coupon.first_order_only) {
    return refused(code, 'Enter your phone number to use this code.', coupon);
  }

  let discountPaise = 0;
  if (coupon.kind === 'percent') {
    discountPaise = Number((BigInt(base) * BigInt(coupon.percent_bp)) / 10000n);
    if (coupon.max_discount_paise !== null) discountPaise = Math.min(discountPaise, Number(coupon.max_discount_paise));
  } else if (coupon.kind === 'flat') {
    discountPaise = Math.min(Number(coupon.amount_paise), base);
  }
  const freeShipping = coupon.kind === 'free_shipping';
  return {
    applied: true, code, coupon, discountPaise, freeShipping, shares: splitDiscount(lines, eligible, discountPaise),
    message: freeShipping ? 'Free delivery applied.' : `${formatRupees(discountPaise)} off applied.`,
  };
}

export class CouponUsedUpError extends Error {
  constructor() {
    super('This code has been used up.');
    this.name = 'CouponUsedUpError';
    this.code = 'coupon_used_up';
  }
}

export async function redeem(t, { coupon, orderId, shopperId = null, phone, discountPaise, config = {} }) {
  const tid = tenantId();
  const [counted] = await t.query(
    'UPDATE coupons SET used_count = used_count + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND (max_uses IS NULL OR used_count < max_uses) RETURNING id',
    [tid, coupon.id],
  );
  if (!counted) throw new CouponUsedUpError();
  await t.query(
    `INSERT INTO coupon_redemptions (tenant_id, coupon_id, order_id, shopper_id, customer_key, discount_paise) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tid, coupon.id, orderId, shopperId, customerKey(config, phone), discountPaise],
  );
}

/** A cancelled order's use stops counting. Safe to call twice: only an applied redemption is released. */
export async function release(t, orderId) {
  const tid = tenantId();
  const [row] = await t.query(
    `UPDATE coupon_redemptions SET status = 'released', released_at = now() WHERE tenant_id = $1 AND order_id = $2 AND status = 'applied' RETURNING coupon_id`,
    [tid, orderId],
  );
  if (!row) return { released: false };
  await t.query('UPDATE coupons SET used_count = GREATEST(used_count - 1, 0), updated_at = now() WHERE tenant_id = $1 AND id = $2', [tid, row.coupon_id]);
  return { released: true };
}
