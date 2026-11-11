import { paiseToRupees, rupeesToPaise } from '../../lib/format.js';
import { HOLD_MINUTES, MAX_PAISE, PINCODE } from '../orders/shared/contract.js';

/**
 * The payment options form (9.5, 9.6) and the API's PaymentOptions, both ways. Money is rupees in the form and paise in the
 * API; a percentage advance is a percent in the form and hundredths of a percent in the API. Pure, so it is tested in Node.
 */
export const ONLINE_METHODS = Object.freeze([['upi', 'UPI'], ['card', 'Cards'], ['netbanking', 'Netbanking'], ['wallet', 'Wallets']]);

/** "12.5" percent to 1250 hundredths; '' is null; anything else NaN. */
export function percentToBp(text) {
  const value = String(text ?? '').trim().replace(/%$/, '');
  if (value === '') return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
export const bpToPercent = (bp) => (bp === null || bp === undefined ? '' : String(bp / 100));

/** "411001, 411002\n560001" to the list of PINs, without repeats. */
export const splitPins = (text) => [...new Set(String(text ?? '').split(/[\s,]+/).map((pin) => pin.trim()).filter(Boolean))];

export function optionsToForm(options) {
  return {
    upi: options.upi, card: options.card, netbanking: options.netbanking, wallet: options.wallet,
    cod: options.cod,
    codFee: paiseToRupees(options.codFeePaise),
    codMax: paiseToRupees(options.codMaxOrderPaise),
    codPins: options.codPincodes.join(', '),
    codBlock: options.codBlockRtoCount === null ? '' : String(options.codBlockRtoCount),
    partAdvance: options.partAdvance,
    advanceKind: options.advanceKind,
    advanceValue: options.advanceKind === 'percent' ? bpToPercent(options.advanceValue) : paiseToRupees(options.advanceValue),
    holdMinutes: String(options.holdMinutes),
  };
}

/** The form as PaymentOptionsUpdate, or { errors } naming each field that isn't right. */
export function formToOptions(values) {
  const errors = {};
  const money = (name, { optional } = {}) => {
    const paise = rupeesToPaise(values[name]);
    if (paise === null) {
      if (!optional) errors[name] = 'Enter an amount, or 0';
      return null;
    }
    if (!Number.isSafeInteger(paise) || paise > MAX_PAISE) errors[name] = 'Enter an amount in rupees, like 49 or 49.50';
    return paise;
  };
  const codFeePaise = money('codFee');
  const codMaxOrderPaise = money('codMax', { optional: true });
  const codPincodes = splitPins(values.codPins);
  const badPin = codPincodes.find((pin) => !PINCODE.test(pin));
  if (badPin) errors.codPins = `${badPin} isn’t a 6-digit PIN code`;
  let codBlockRtoCount = null;
  if (String(values.codBlock ?? '').trim() !== '') {
    codBlockRtoCount = Number(values.codBlock);
    if (!Number.isInteger(codBlockRtoCount) || codBlockRtoCount < 1 || codBlockRtoCount > 20) errors.codBlock = 'Enter a number from 1 to 20, or leave it empty';
  }
  let advanceValue = 0;
  if (values.advanceKind === 'percent') {
    advanceValue = percentToBp(values.advanceValue) ?? 0;
    if (!Number.isInteger(advanceValue) || advanceValue > 10000) errors.advanceValue = 'Enter a percentage from 0 to 100';
    else if (values.partAdvance && advanceValue === 0) errors.advanceValue = 'Enter how much is paid ahead';
  } else {
    advanceValue = rupeesToPaise(values.advanceValue) ?? 0;
    if (!Number.isSafeInteger(advanceValue) || advanceValue > MAX_PAISE) errors.advanceValue = 'Enter an amount in rupees';
    else if (values.partAdvance && advanceValue === 0) errors.advanceValue = 'Enter how much is paid ahead';
  }
  const holdMinutes = Number(values.holdMinutes);
  if (!/^\d+$/.test(String(values.holdMinutes ?? '').trim()) || holdMinutes < HOLD_MINUTES.min || holdMinutes > HOLD_MINUTES.max) errors.holdMinutes = `Enter ${HOLD_MINUTES.min} to ${HOLD_MINUTES.max} minutes`;
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      upi: Boolean(values.upi), card: Boolean(values.card), netbanking: Boolean(values.netbanking), wallet: Boolean(values.wallet),
      cod: Boolean(values.cod), codFeePaise, codMaxOrderPaise, codPincodes, codBlockRtoCount,
      partAdvance: Boolean(values.partAdvance), advanceKind: values.advanceKind === 'percent' ? 'percent' : 'fixed', advanceValue,
      holdMinutes,
    },
  };
}

/** The server's field names in the form's. */
export const OPTION_FIELDS = Object.freeze({ codFeePaise: 'codFee', codMaxOrderPaise: 'codMax', codPincodes: 'codPins', codBlockRtoCount: 'codBlock' });

/** A Razorpay key id as the API takes it: rzp_test_ or rzp_live_ and 6 to 40 letters or digits. */
export const KEY_ID = /^rzp_(?:test|live)_[A-Za-z0-9]{6,40}$/;
