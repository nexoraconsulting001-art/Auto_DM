import crypto from 'node:crypto';
import { formatRupees } from '../../contracts/catalog.js';
import { log } from '../../platform/log.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { tenantId } from '../../tenancy.js';
import { keyedHash, toE164 } from '../shoppers/keys.js';
import { cookieOf } from '../reviews/page-hook.js';
import { LOOP_DEPTH, REF_COOKIE, REF_DEVICE_COOKIE, addressKey, normalizeCode } from './rules.js';

/**
 * Referrals (PRD 9.21): each shopper's link, and the friend who came through it. The friend is a keyed hash of their phone
 * number (referrals.friend_key), so a guest counts and the number is never copied, and a friend is referred once.
 *
 * A referral is judged while the friend's first order is priced (judge, from checkout's buildQuote) and recorded in that
 * order's own transaction (record, from checkout's placeOrder), so the friend's first-order reward (friend_reward_paise,
 * PRD 9.21) is part of the order's discount and the referral row says what was given. It is kept as 'blocked', with the
 * reason, and earns nothing when the friend is the referrer under another name (S-90):
 *   same_phone       the order's phone, or the signed-in shopper, is the referrer's
 *   same_device      the browser that ordered is one the referrer used: their own invite page or link was opened on it,
 *                    or it carried one of their orders or carts
 *   same_address     the delivery address is one of the referrer's (street line and PIN code, see addressKey)
 *   not_first_order  the friend has ordered here before
 * A loop (the friend is the referrer's own referrer, or further up that chain) is refused outright and not recorded: the
 * table has no reason for it, and nobody may be rewarded for it.
 * A pending referral earns the referrer `referrer_points` once the friend's order is delivered and its return window has
 * closed (service.js: referralCredit, then the sweep). A cancelled or fully refunded order voids it.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const COUNTS_AS_ORDER = `fulfilment_status NOT IN ('pending', 'cancelled')`;

export function createReferrals(ctx, service) {
  const { db, config } = ctx;
  const friendKeyOf = (phone) => keyedHash(config, `referral-friend:${tenantId()}`, phone);

  /** The shopper's own code, made the first time it is asked for. */
  async function codeFor(shopperId) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const [found] = await db.query('SELECT code FROM referral_codes WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopperId]);
      if (found) return found.code;
      try {
        await db.query('INSERT INTO referral_codes (tenant_id, shopper_id, code) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, shopper_id) DO NOTHING', [tenantId(), shopperId, randomCode()]);
      } catch (err) {
        if (err?.code !== '23505') throw err; // another shopper's code: try another
      }
    }
    throw new Error('Could not make a referral code');
  }

  /** The shopper a code belongs to, or null. Read on `q`, so it works inside the order's transaction. */
  async function ownerOf(code, q = db) {
    const clean = normalizeCode(code);
    if (!clean) return null;
    const [row] = await q.query(
      'SELECT r.shopper_id, s.phone FROM referral_codes r JOIN shoppers s ON s.tenant_id = r.tenant_id AND s.id = r.shopper_id WHERE r.tenant_id = $1 AND r.code = $2 AND s.erased_at IS NULL',
      [tenantId(), clean],
    );
    return row ? { shopperId: row.shopper_id, phone: row.phone } : null;
  }

  async function sameDevice(t, referrerId, { visitorId, ownDevice }) {
    if (ownDevice) return true;
    if (!visitorId) return false;
    const [hit] = await t.query(
      `SELECT 1 FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND visitor_id = $3::uuid
       UNION ALL SELECT 1 FROM carts WHERE tenant_id = $1 AND shopper_id = $2 AND visitor_id = $3::uuid LIMIT 1`,
      [tenantId(), referrerId, visitorId],
    );
    return Boolean(hit);
  }

  async function sameAddress(t, referrerId, address) {
    const key = addressKey(address ?? {});
    if (!key) return false;
    const saved = await t.query('SELECT line1, pincode FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), referrerId]);
    const shipped = await t.query(
      `SELECT shipping_address->>'line1' AS line1, COALESCE(shipping_address->>'pincode', pincode) AS pincode FROM orders WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id DESC LIMIT 50`,
      [tenantId(), referrerId],
    );
    return [...saved, ...shipped].some((a) => addressKey(a) === key);
  }

  /**
   * True when the friend already sits above the referrer in the chain of who referred whom (A brought B, and now B would
   * bring A). A referrer is found by their shopper id or, for one who was a guest friend, by the hash of their phone.
   */
  async function isLoop(t, friendId, referrerId) {
    if (!friendId) return false;
    let current = referrerId;
    const seen = new Set([referrerId]);
    for (let depth = 0; depth < LOOP_DEPTH; depth++) {
      const [me] = await t.query('SELECT phone FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), current]);
      const [up] = await t.query(
        `SELECT referrer_shopper_id FROM referrals WHERE tenant_id = $1 AND status <> 'blocked' AND (friend_shopper_id = $2 OR friend_key = $3) ORDER BY id LIMIT 1`,
        [tenantId(), current, me?.phone ? friendKeyOf(me.phone) : ''],
      );
      if (!up) return false;
      if (up.referrer_shopper_id === friendId) return true;
      if (seen.has(up.referrer_shopper_id)) return false; // a circle already in the data: stop climbing
      seen.add(up.referrer_shopper_id);
      current = up.referrer_shopper_id;
    }
    return false;
  }

  /**
   * Works out a referral for a checkout, on `q` (inside the order's transaction when placing). `code`, `visitorId` and
   * `ownDevice` come from the request (fromRequest); `phone`, `shopperId` and `address` are the order's. -> null when there
   * is nothing to record (no add-on, referrals off, an unknown code, no phone, a loop), else
   * { referrerId, friendKey, friendId, reason, paise, notice }: `reason` is the S-90 block ('' when none), and `paise` the
   * friend's first-order reward (PRD 9.21), never more than `orderPaise`, and 0 when blocked, already referred, or when there
   * is no address yet to check (same_address can't be ruled out without one).
   */
  async function judge(q, { code, visitorId = null, ownDevice = false, phone, shopperId = null, address = null, orderPaise = 0 }) {
    const settings = await service.active(q);
    if (!settings?.referralEnabled) return null;
    const referrer = await ownerOf(code, q);
    const friendPhone = toE164(phone);
    if (!referrer || !friendPhone) return null;
    const friendKey = friendKeyOf(friendPhone);
    const [known] = await q.query('SELECT id FROM shoppers WHERE tenant_id = $1 AND phone = $2', [tenantId(), friendPhone]);
    const friendId = shopperId ?? known?.id ?? null;

    let reason = '';
    if (friendId === referrer.shopperId || (referrer.phone && referrer.phone === friendPhone)) reason = 'same_phone';
    else if (await sameDevice(q, referrer.shopperId, { visitorId, ownDevice })) reason = 'same_device';
    else if (await sameAddress(q, referrer.shopperId, { line1: address?.line1, pincode: address?.pincode })) reason = 'same_address';
    else {
      const digits = friendPhone.replace(/\D/g, '');
      const [before] = await q.query(
        `SELECT 1 FROM orders WHERE tenant_id = $1 AND ${COUNTS_AS_ORDER}
           AND (regexp_replace(phone, '[^0-9]', '', 'g') IN ($2, $3) ${friendId ? 'OR shopper_id = $4' : ''}) LIMIT 1`,
        [tenantId(), digits, digits.replace(/^91(?=\d{10}$)/, ''), ...(friendId ? [friendId] : [])],
      );
      if (before) reason = 'not_first_order';
    }
    if (!reason && (await isLoop(q, friendId, referrer.shopperId))) return null;

    const [referred] = await q.query('SELECT 1 FROM referrals WHERE tenant_id = $1 AND friend_key = $2', [tenantId(), friendKey]);
    const checkable = Boolean(addressKey(address ?? {}));
    const paise = !reason && !referred && checkable ? Math.max(0, Math.min(Number(settings.friendRewardPaise) || 0, orderPaise)) : 0;
    return {
      referrerId: referrer.shopperId, friendKey, friendId, reason, paise,
      notice: paise > 0 ? `Your friend’s welcome reward of ${formatRupees(paise)} is applied.` : '',
    };
  }

  /**
   * Records the referral of an order, in the order's own transaction, with the reward its price took (`judged` from judge
   * on that transaction). A friend is referred once: when another order recorded them first this returns null, and an order
   * priced with a reward must then not be placed (checkout refuses it). A loop is never recorded (judge gives null).
   */
  async function record(t, order, judged) {
    if (!judged) return null;
    const [row] = await t.query(
      `INSERT INTO referrals (tenant_id, referrer_shopper_id, friend_key, friend_shopper_id, order_id, status, block_reason, friend_reward_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, friend_key) DO NOTHING RETURNING *`,
      [tenantId(), judged.referrerId, judged.friendKey, judged.friendId, order.id, judged.reason ? 'blocked' : 'pending', judged.reason, judged.paise],
    );
    if (row) log.info('loyalty.referral', { referralId: Number(row.id), orderId: order.id, status: row.status, reason: judged.reason });
    return row ?? null;
  }

  /** The referral a checkout request carries: the code in the body, else the one the invite link left in this browser. */
  function fromRequest(req, body = {}) {
    const code = normalizeCode(body.referralCode) || normalizeCode(cookieOf(req, REF_COOKIE));
    if (!code) return null;
    return { code, visitorId: visitorIdFrom(req), ownDevice: normalizeCode(cookieOf(req, REF_DEVICE_COOKIE)) === code };
  }

  return { codeFor, ownerOf, judge, record, fromRequest, friendKeyOf };
}
