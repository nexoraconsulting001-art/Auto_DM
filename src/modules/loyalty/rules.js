import { formatRupees } from '../../contracts/catalog.js';

/**
 * Loyalty's arithmetic (PRD 9.21), with no database: what an order earns, how much of a request can be spent, what a refund
 * leaves, and when two addresses are one. Points are whole numbers; money is integer paise.
 */
export const LOYALTY_FEATURE = 'loyalty';
/** A referral code, as referral_codes holds it. */
export const REFERRAL_CODE = /^[A-Z0-9]{6,12}$/;
/** No single movement is bigger than this, so a balance always fits its integer column. */
export const MAX_POINTS = 100_000_000;
/** How far up a chain of referrals the loop check looks. */
export const LOOP_DEPTH = 25;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  earnPoints: 1,
  earnPerPaise: 10000,
  pointValuePaise: 100,
  maxRedeemPoints: 0,
  expiryDays: null,
  referralEnabled: false,
  friendRewardPaise: 0,
  referrerPoints: 0,
});

export const toSettings = (row) => (!row ? { ...DEFAULT_SETTINGS } : {
  enabled: row.enabled,
  earnPoints: row.earn_points,
  earnPerPaise: Number(row.earn_per_paise),
  pointValuePaise: Number(row.point_value_paise),
  maxRedeemPoints: row.max_redeem_points,
  expiryDays: row.expiry_days,
  referralEnabled: row.referral_enabled,
  friendRewardPaise: Number(row.friend_reward_paise),
  referrerPoints: row.referrer_points,
});

/**
 * Points for an amount after discount and before shipping (S-87): `earnPoints` for every whole `earnPerPaise`.
 * 1 point per Rs 100 is { earnPoints: 1, earnPerPaise: 10000 }, so Rs 1,000 earns 10 and Rs 999 earns 9.
 */
export function pointsFor(amountPaise, { earnPoints, earnPerPaise }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || !(earnPoints > 0) || !(earnPerPaise > 0)) return 0;
  const points = (BigInt(amountPaise) * BigInt(earnPoints)) / BigInt(earnPerPaise);
  return Number(points > BigInt(MAX_POINTS) ? BigInt(MAX_POINTS) : points);
}

/** The amount an order earns on: what was paid for the items, after the coupon and the points used, before delivery. */
export const earningBase = (order) => Math.max(0, Number(order.subtotal_paise) - Number(order.discount_paise) - Number(order.loyalty_paise));

const plural = (n) => `${n} ${n === 1 ? 'point' : 'points'}`;

/**
 * How many of the points asked for an order may use: no more than the per-order cap (S-88), the balance, or the value of
 * the items. -> { points, valuePaise, notice }. The notice says which limit cut the request, as a sentence for the shopper.
 * A cap of 0 means points can't be used at checkout.
 */
export function redeemable({ requested, balance, cap, pointValuePaise, orderPaise }) {
  const none = { points: 0, valuePaise: 0, notice: '' };
  const want = Number.isSafeInteger(requested) ? requested : 0;
  if (want <= 0 || !(pointValuePaise > 0) || !(orderPaise > 0)) return none;
  const byValue = Math.floor(orderPaise / pointValuePaise);
  const limits = [
    { n: Math.max(0, cap), notice: (p) => `You can use up to ${plural(cap)} on one order, so we applied ${p}.` },
    { n: Math.max(0, balance), notice: (p) => `You have ${plural(Math.max(0, balance))}, so we applied ${p}.` },
    { n: byValue, notice: (p) => `Points can pay for up to ${formatRupees(byValue * pointValuePaise)} of this order, so we applied ${p}.` },
  ];
  let points = Math.min(want, MAX_POINTS);
  let binding = null;
  for (const limit of limits) {
    if (limit.n < points) {
      points = limit.n;
      binding = limit;
    }
  }
  if (points <= 0) return none;
  return { points, valuePaise: points * pointValuePaise, notice: binding ? binding.notice(points) : '' };
}

/**
 * What stays of an order's points after refunds (S-89): in proportion to what is still paid. All of it refunded leaves none;
 * nothing captured (nothing to refund) leaves it all.
 */
export function keptAfterRefund(earned, paidPaise, refundedPaise) {
  const paid = Number(paidPaise);
  const refunded = Number(refundedPaise);
  if (!(earned > 0)) return 0;
  if (!(paid > 0)) return earned;
  if (refunded >= paid) return 0;
  return Number((BigInt(earned) * BigInt(Math.max(0, paid - refunded))) / BigInt(paid));
}

/**
 * Two addresses are one when the street line and the PIN code agree once case, spaces and punctuation are set aside:
 * "12 Lake Road" and "12, Lake Road" at 411001 are the same door (S-90). The flat or floor line is left out, so a second
 * number "at the same address" can't get round it by naming another flat.
 */
export function addressKey({ line1, pincode } = {}) {
  const street = String(line1 ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
  const pin = String(pincode ?? '').replace(/[^0-9]/g, '');
  return street && pin ? `${pin}:${street}` : '';
}

/** A code typed or carried in a link, as stored: upper case, or '' when it can't be one. */
export function normalizeCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return REFERRAL_CODE.test(code) ? code : '';
}

/**
 * Points that should have lapsed by now and haven't (FIFO): credits whose time has passed, less every point that has left
 * the account since. What has been spent is taken to have come from the oldest points first, which is the shopper's favour.
 */
export const dueToExpire = ({ expiredCredit, debits }) => Math.max(0, Number(expiredCredit) - Number(debits));
