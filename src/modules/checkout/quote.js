import { formatRupees } from '../../contracts/catalog.js';
import { INDIAN_STATES, STORE_LIMITS, orderTotal } from '../../contracts/orders.js';
import { SETTING_DEFAULTS, shippingFor } from '../../repos/settings.js';
import { tenantId } from '../../tenancy.js';
import { normalizePhone } from '../../util.js';
import { evaluate, normalizeCode } from '../coupons/rules.js';
import { entitlementsRepo } from '../entitlements/index.js';
import { buyable, lineTax, priceLines, publicLine } from './pricing.js';

/**
 * Every amount of a checkout, worked out on the server from the database (PRD 9.5, 9.6, 9.14): the lines, the coupon,
 * delivery, the cash-on-delivery fee, GST inside the prices, the total, and for part-advance the advance and the balance.
 * The same function answers a quote (changes nothing) and prices the order inside its transaction (`lock: true`: the
 * product, variant and coupon rows are locked until the order commits).
 *
 *   buildQuote(q, ctx, { lines, address?, phone?, paymentMode?, couponCode?, redeemPoints?, shopperId?, lock? })
 *     -> { quote (the Quote of src/contracts/store-routes.js), lines (priced, buyable, with discount shares and tax), coupon, options }
 *
 * Ways to pay come from the business's payment settings (payment_settings, migration 404). No row means online payment is
 * not set up yet and cash on delivery is off. Payments owns that table; checkout only reads it.
 */
export const toE164 = (phone) => {
  const digits = normalizePhone(phone);
  return digits ? `+91${digits}` : null;
};

const DEFAULT_OPTIONS = Object.freeze({
  mode: 'managed', kycStatus: 'not_started', linkedAccount: false, ownConnection: 'none', methods: false, cod: false, partAdvance: false,
  codFeePaise: 0, codMaxPaise: null, codPincodes: [], codBlockRto: null, advanceKind: 'fixed', advanceValue: 0, holdMinutes: STORE_LIMITS.holdMinutes,
});

/** How this business takes money, as checkout needs it. */
export async function paymentOptions(q) {
  const [row] = await q.query('SELECT * FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
  if (!row) return { ...DEFAULT_OPTIONS };
  return {
    mode: row.mode, kycStatus: row.kyc_status, linkedAccount: Boolean(row.linked_account_id), ownConnection: row.own_connection,
    methods: Boolean(row.upi || row.card || row.netbanking || row.wallet), cod: row.cod, partAdvance: row.part_advance,
    codFeePaise: Number(row.cod_fee_paise), codMaxPaise: row.cod_max_order_paise === null ? null : Number(row.cod_max_order_paise),
    codPincodes: row.cod_pincodes ?? [], codBlockRto: row.cod_block_rto_count, advanceKind: row.advance_kind, advanceValue: Number(row.advance_value),
    holdMinutes: row.hold_minutes ?? STORE_LIMITS.holdMinutes,
  };
}

/** Online payment can be taken: managed with KYC passed and a linked account, or the seller's own account connected (9.6). */
export const onlineReady = (o) => o.methods && (o.mode === 'own' ? o.ownConnection !== 'none' : o.kycStatus === 'verified' && o.linkedAccount);

/** The advance and what is left for the door. Null when the split can't be made (under ₹1 online, or nothing left for the door). */
export function advanceSplit(o, totalPaise) {
  const advance = o.advanceKind === 'percent' ? Math.round((totalPaise * o.advanceValue) / 10000) : o.advanceValue;
  if (!Number.isSafeInteger(advance) || advance < 100 || advance >= totalPaise) return null;
  return { advancePaise: advance, balancePaise: totalPaise - advance };
}

/** The store's settings (delivery fee and the free-delivery threshold among them), read on `q` so it works inside the order's transaction. */
export async function storeSettings(q) {
  const rows = await q.query(`SELECT key, value FROM settings WHERE tenant_id = $1 AND key = ANY($2::text[])`, [tenantId(), Object.keys(SETTING_DEFAULTS)]);
  const out = { ...SETTING_DEFAULTS };
  for (const { key, value } of rows) out[key] = value;
  return out;
}

async function rtoCount(q, phone) {
  const digits = normalizePhone(phone);
  if (!digits) return 0;
  const [{ n }] = await q.query(
    `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND phone = ANY($2::text[]) AND fulfilment_status = 'rto_delivered'`,
    [tenantId(), [digits, `+91${digits}`]],
  );
  return n;
}

/** Whether the courier reaches a PIN code. The shipping module answers it once built (ctx.shipping); until then every valid PIN is served. */
async function serviceability(ctx, pincode) {
  if (!pincode) return { serviceable: true, cod: true };
  const check = ctx?.shipping?.serviceable;
  if (typeof check !== 'function') return { serviceable: true, cod: true };
  const answer = await check(pincode);
  return { serviceable: answer?.serviceable !== false, cod: answer?.cod !== false };
}

export async function buildQuote(q, ctx, { lines: linesIn, address = null, phone = '', paymentMode, couponCode = '', redeemPoints = 0, shopperId = null, lock = false }) {
  const priced = await priceLines(q, linesIn, { lock });
  const notices = [...priced.notices];
  const sellable = priced.lines.filter(buyable);
  const subtotalPaise = sellable.reduce((sum, l) => sum + l.linePaise, 0);
  const buyerPhone = address?.phone || phone;

  // Coupons are a plan feature; asked on `q`, so it holds inside the order's transaction too.
  const couponsOn = couponCode ? await entitlementsRepo(q).can('store.coupons') : false;
  const coupon = !couponCode || !sellable.length ? null
    : couponsOn ? await evaluate(q, { code: couponCode, lines: sellable, phone: buyerPhone, shopperId, lock, config: ctx.config })
      : { code: normalizeCode(couponCode), applied: false, message: 'This code isn’t valid.' };
  const applied = coupon?.applied ? coupon : null;
  const discountPaise = applied?.discountPaise ?? 0;
  const shares = applied?.shares ?? sellable.map(() => 0);

  const settings = await storeSettings(q);
  const deliveryFee = sellable.length ? shippingFor(subtotalPaise, settings) : 0;
  const shippingPaise = applied?.freeShipping ? 0 : deliveryFee;

  // Points belong to the loyalty add-on (9.21), which answers through ctx.loyalty once built.
  let loyaltyPaise = 0;
  let pointsUsed = 0;
  if (redeemPoints > 0) {
    const preview = typeof ctx.loyalty?.preview === 'function' && typeof ctx.loyalty?.redeem === 'function' && shopperId
      ? await ctx.loyalty.preview({ shopperId, points: redeemPoints, orderPaise: subtotalPaise - discountPaise }, q)
      : null;
    if (preview && preview.points > 0) {
      pointsUsed = preview.points;
      loyaltyPaise = Math.min(preview.valuePaise, subtotalPaise - discountPaise);
      if (preview.notice) notices.push(preview.notice);
    } else {
      notices.push('Points can’t be used on this order.');
    }
  }

  const options = await paymentOptions(q);
  const online = onlineReady(options);
  const pincode = address?.pincode ?? '';
  const reach = await serviceability(ctx, pincode);
  if (!reach.serviceable) notices.push('We don’t deliver to this PIN code yet. Try another address.');

  const beforeFees = subtotalPaise - discountPaise - loyaltyPaise + shippingPaise;
  const codTotal = beforeFees + options.codFeePaise;
  let codReason = '';
  if (!options.cod) codReason = 'Cash on delivery isn’t offered by this store.';
  else if (options.codMaxPaise !== null && codTotal > options.codMaxPaise) codReason = `Cash on delivery is available on orders up to ${formatRupees(options.codMaxPaise)}.`;
  else if (pincode && options.codPincodes.length && !options.codPincodes.includes(pincode)) codReason = 'Cash on delivery isn’t available at this PIN code.';
  else if (pincode && !reach.cod) codReason = 'Cash on delivery isn’t available at this PIN code.';
  else if (options.codBlockRto !== null && buyerPhone && (await rtoCount(q, buyerPhone)) >= options.codBlockRto) codReason = 'Cash on delivery isn’t available for this number. Please pay online.';
  const split = advanceSplit(options, beforeFees);
  let advanceReason = '';
  if (!options.partAdvance) advanceReason = 'Part payment isn’t offered by this store.';
  else if (!online) advanceReason = 'Online payment isn’t available at this store yet.';
  else if (!split) advanceReason = 'Part payment isn’t available for this order.';
  const paymentModes = [
    { mode: 'prepaid', available: online, reason: online ? '' : 'Online payment isn’t available at this store yet.' },
    { mode: 'cod', available: !codReason, reason: codReason },
    { mode: 'part_advance', available: !advanceReason, reason: advanceReason },
  ];

  const codFeePaise = paymentMode === 'cod' ? options.codFeePaise : 0;
  const totalPaise = orderTotal({ subtotalPaise, discountPaise, loyaltyPaise, shippingPaise, codFeePaise });
  const advancePaise = paymentMode === 'part_advance' && split ? split.advancePaise : 0;
  const balancePaise = paymentMode === 'cod' ? totalPaise : paymentMode === 'part_advance' && split ? split.balancePaise : 0;

  const orderLines = sellable.map((line, i) => ({ ...line, discountPaise: shares[i], taxPaise: lineTax(line, shares[i]) }));
  const taxPaise = orderLines.reduce((sum, l) => sum + l.taxPaise, 0);

  const quote = {
    lines: priced.lines.map(publicLine),
    subtotalPaise, discountPaise, loyaltyPaise, shippingPaise, codFeePaise, taxPaise, totalPaise, advancePaise, balancePaise,
    paymentModes,
    serviceable: reach.serviceable,
    coupon: coupon ? { code: coupon.code, applied: coupon.applied, message: coupon.message } : null,
    pointsUsed,
    notices: [...new Set(notices)],
  };
  return { quote, priced: priced.lines, lines: orderLines, coupon: applied, couponRefused: coupon && !coupon.applied ? coupon : null, options, deliveryFee };
}

/** The address as the order keeps it (S-14), and as the Phase 0 columns need it. */
export function addressSnapshot(address) {
  return {
    name: address.name, phone: address.phone, line1: address.line1, line2: address.line2 ?? '', landmark: address.landmark ?? '',
    city: address.city, stateCode: address.stateCode, pincode: address.pincode,
  };
}

export const stateName = (code) => INDIAN_STATES[code] ?? INDIAN_STATES[Number(code)] ?? '';
