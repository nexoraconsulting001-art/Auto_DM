import crypto from 'node:crypto';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { keyedHash, toE164 } from '../shoppers/keys.js';
import { LOOP_DEPTH, addressKey, normalizeCode } from './rules.js';

/**
 * Referrals (PRD 9.21): each shopper's link, and the friend who came through it. The friend is a keyed hash of their phone
 * number (referrals.friend_key), so a guest counts and the number is never copied, and a friend is referred once.
 *
 * A referral is recorded against the friend's first order. It is kept as 'blocked', with the reason, and earns nothing when
 * the friend is the referrer under another name (S-90):
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

  /** The shopper a code belongs to, or null. */
  async function ownerOf(code) {
    const clean = normalizeCode(code);
    if (!clean) return null;
    const [row] = await db.query(
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
   * Records the referral of a placed order (after it committed). `visitorId` is the browser's traffic id and `ownDevice`
   * whether this browser is marked as the referrer's. -> the referral row, or null when there is none to record.
   */
  async function attach(orderId, { code, visitorId = null, ownDevice = false }) {
    const settings = await service.active();
    if (!settings?.referralEnabled) return null;
    const referrer = await ownerOf(code);
    if (!referrer) return null;
    return db.tx(async (t) => {
      const [o] = await t.query(
        `SELECT id, shopper_id, phone, pincode, shipping_address, fulfilment_status, delivered_at FROM orders WHERE tenant_id = $1 AND id = $2 AND flow = 'checkout'`,
        [tenantId(), orderId],
      );
      const phone = toE164(o?.phone);
      if (!o || !phone) return null;
      const friendKey = friendKeyOf(phone);
      const [known] = await t.query('SELECT id FROM shoppers WHERE tenant_id = $1 AND phone = $2', [tenantId(), phone]);
      const friendId = o.shopper_id ?? known?.id ?? null;

      let reason = '';
      if (friendId === referrer.shopperId || (referrer.phone && referrer.phone === phone)) reason = 'same_phone';
      else if (await sameDevice(t, referrer.shopperId, { visitorId, ownDevice })) reason = 'same_device';
      else if (await sameAddress(t, referrer.shopperId, { line1: o.shipping_address?.line1, pincode: o.shipping_address?.pincode ?? o.pincode })) reason = 'same_address';
      else {
        const [before] = await t.query(
          `SELECT 1 FROM orders WHERE tenant_id = $1 AND id <> $2 AND ${COUNTS_AS_ORDER}
             AND (regexp_replace(phone, '[^0-9]', '', 'g') IN ($3, $4) ${friendId ? 'OR shopper_id = $5' : ''}) LIMIT 1`,
          [tenantId(), orderId, phone.replace(/\D/g, ''), phone.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''), ...(friendId ? [friendId] : [])],
        );
        if (before) reason = 'not_first_order';
      }
      if (!reason && (await isLoop(t, friendId, referrer.shopperId))) {
        log.info('loyalty.referral_refused', { orderId, reason: 'loop' });
        return null;
      }

      const [row] = await t.query(
        `INSERT INTO referrals (tenant_id, referrer_shopper_id, friend_key, friend_shopper_id, order_id, status, block_reason, friend_reward_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0) ON CONFLICT (tenant_id, friend_key) DO NOTHING RETURNING *`,
        [tenantId(), referrer.shopperId, friendKey, friendId, orderId, reason ? 'blocked' : 'pending', reason],
      );
      if (!row) return null; // this friend was referred before
      log.info('loyalty.referral', { referralId: Number(row.id), orderId, status: row.status, reason });
      // An order delivered before its referral was written still earns its referrer points (normally delivery comes days later).
      if (!reason && o.fulfilment_status === 'delivered') await service.referralCredit(t, o, await service.windowEnd(t, o.delivered_at));
      return row;
    });
  }

  return { codeFor, ownerOf, attach, friendKeyOf };
}
