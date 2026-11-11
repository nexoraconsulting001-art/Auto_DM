import { formatPaise, paiseToRupees, rupeesToPaise } from '../../lib/format.js';
import { fromLocalInput, toLocalInput } from '../catalog/shared/time.js';
import { COUPON_CODE, MAX_PAISE } from '../orders/shared/contract.js';
import { bpToPercent, percentToBp } from '../payments/form.js';

/**
 * The coupon form (9.14) and the API's Coupon, both ways: rupees and percents in the form, paise and hundredths of a percent
 * in the API, the seller's own time in the form and ISO times in the API. Pure, so it is tested in Node.
 */
export const EMPTY_COUPON = Object.freeze({
  code: '', kind: 'percent', percent: '', cap: '', amount: '', minOrder: '', startsAt: '', endsAt: '', maxUses: '', maxUsesPerCustomer: '',
  firstOrderOnly: false, scope: 'all', scopeIds: [], pageId: '', active: true,
});

export function couponToForm(coupon) {
  return {
    code: coupon.code,
    kind: coupon.kind,
    percent: bpToPercent(coupon.percentBp),
    cap: paiseToRupees(coupon.maxDiscountPaise),
    amount: paiseToRupees(coupon.amountPaise),
    minOrder: coupon.minOrderPaise ? paiseToRupees(coupon.minOrderPaise) : '',
    startsAt: toLocalInput(coupon.startsAt),
    endsAt: toLocalInput(coupon.endsAt),
    maxUses: coupon.maxUses === null ? '' : String(coupon.maxUses),
    maxUsesPerCustomer: coupon.maxUsesPerCustomer === null ? '' : String(coupon.maxUsesPerCustomer),
    firstOrderOnly: coupon.firstOrderOnly,
    scope: coupon.scope,
    scopeIds: coupon.scopeIds,
    pageId: coupon.pageId === null ? '' : String(coupon.pageId),
    active: coupon.active,
  };
}

const whole = (text, max) => {
  const value = String(text ?? '').trim();
  if (value === '') return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) return Number.NaN;
  return Number(value);
};

/** The form as a CouponCreate body, or { errors }. `locked` leaves the code and kind out, for a coupon already used. */
export function formToCoupon(values, { locked = false } = {}) {
  const errors = {};
  const code = String(values.code ?? '').trim().toUpperCase();
  if (!COUPON_CODE.test(code)) errors.code = 'Use 2 to 40 letters, digits, - or _';
  const body = { kind: values.kind };
  if (values.kind === 'percent') {
    const bp = percentToBp(values.percent);
    if (!Number.isInteger(bp) || bp < 1 || bp > 10000) errors.percent = 'Enter a percentage from 0.01 to 100';
    body.percentBp = bp;
    const cap = rupeesToPaise(values.cap);
    if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_PAISE)) errors.cap = 'Enter the most it takes off, in rupees, or leave it empty';
    body.maxDiscountPaise = cap;
    body.amountPaise = null;
  } else if (values.kind === 'flat') {
    const amount = rupeesToPaise(values.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_PAISE) errors.amount = 'Enter how much it takes off, in rupees';
    body.amountPaise = amount;
    body.percentBp = null;
    body.maxDiscountPaise = null;
  } else {
    body.percentBp = null;
    body.amountPaise = null;
    body.maxDiscountPaise = null;
  }
  const minOrder = rupeesToPaise(values.minOrder);
  if (minOrder !== null && (!Number.isSafeInteger(minOrder) || minOrder > MAX_PAISE)) errors.minOrder = 'Enter an amount in rupees, or leave it empty';
  body.minOrderPaise = minOrder ?? 0;
  const startsAt = fromLocalInput(values.startsAt);
  const endsAt = fromLocalInput(values.endsAt);
  if (startsAt === undefined) errors.startsAt = 'Pick a date and time';
  if (endsAt === undefined) errors.endsAt = 'Pick a date and time';
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) errors.endsAt = 'Pick a time after it starts';
  body.startsAt = startsAt ?? null;
  body.endsAt = endsAt ?? null;
  body.maxUses = whole(values.maxUses, 10_000_000);
  if (Number.isNaN(body.maxUses)) errors.maxUses = 'Enter a whole number, or leave it empty for no limit';
  body.maxUsesPerCustomer = whole(values.maxUsesPerCustomer, 1000);
  if (Number.isNaN(body.maxUsesPerCustomer)) errors.maxUsesPerCustomer = 'Enter 1 to 1,000, or leave it empty for no limit';
  body.firstOrderOnly = Boolean(values.firstOrderOnly);
  body.scope = values.scope;
  body.scopeIds = values.scope === 'all' ? [] : [...values.scopeIds];
  if (values.scope !== 'all' && !body.scopeIds.length) errors.scopeIds = values.scope === 'products' ? 'Pick at least one product' : 'Pick at least one category';
  body.pageId = values.pageId ? Number(values.pageId) : null;
  body.active = Boolean(values.active);
  if (Object.keys(errors).length) return { errors };
  if (locked) {
    delete body.kind;
    return { body };
  }
  return { body: { code, ...body } };
}

/** What a coupon takes off, in a few words. */
export function couponSummary(coupon) {
  const off = coupon.kind === 'percent'
    ? `${coupon.percentBp / 100}% off${coupon.maxDiscountPaise ? `, up to ${formatPaise(coupon.maxDiscountPaise)}` : ''}`
    : coupon.kind === 'flat' ? `${formatPaise(coupon.amountPaise)} off` : 'Free delivery';
  return `${off}${coupon.minOrderPaise ? ` on ${formatPaise(coupon.minOrderPaise)} or more` : ''}`;
}

/** Is it running now: on, started, not ended, not used up. */
export function couponState(coupon, now = new Date()) {
  if (!coupon.active) return { tone: 'neutral', text: 'Off' };
  if (coupon.endsAt && new Date(coupon.endsAt) <= now) return { tone: 'neutral', text: 'Ended' };
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) return { tone: 'neutral', text: 'Used up' };
  if (coupon.startsAt && new Date(coupon.startsAt) > now) return { tone: 'neel', text: 'Starts later' };
  return { tone: 'good', text: 'Running' };
}

/** The server's field names in the form's. */
export const COUPON_FIELDS = Object.freeze({ percentBp: 'percent', maxDiscountPaise: 'cap', amountPaise: 'amount', minOrderPaise: 'minOrder' });
