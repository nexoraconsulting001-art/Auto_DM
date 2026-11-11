import { MAX_PAISE } from '../orders/shared/contract.js';
import { paiseToRupees, rupeesToPaise } from '../../lib/format.js';

/**
 * The loyalty rules form (9.21) and the API's LoyaltySettings, both ways. "Earn 1 point for every ₹100" is earnPoints 1 and
 * earnPerPaise 10000. Pure, so it is tested in Node.
 */
export function settingsToForm(s) {
  return {
    enabled: s.enabled,
    earnPoints: String(s.earnPoints),
    earnPer: paiseToRupees(s.earnPerPaise),
    pointValue: paiseToRupees(s.pointValuePaise),
    maxRedeemPoints: String(s.maxRedeemPoints),
    expiryDays: s.expiryDays === null ? '' : String(s.expiryDays),
    referralEnabled: s.referralEnabled,
    friendReward: paiseToRupees(s.friendRewardPaise),
    referrerPoints: String(s.referrerPoints),
  };
}

const count = (text) => (/^\d+$/.test(String(text ?? '').trim()) && Number(text) <= 1_000_000 ? Number(text) : Number.NaN);

export function formToSettings(values) {
  const errors = {};
  const body = { enabled: Boolean(values.enabled), referralEnabled: Boolean(values.referralEnabled) };
  body.earnPoints = count(values.earnPoints);
  if (Number.isNaN(body.earnPoints)) errors.earnPoints = 'Enter a whole number of points';
  body.earnPerPaise = rupeesToPaise(values.earnPer);
  if (!Number.isSafeInteger(body.earnPerPaise) || body.earnPerPaise <= 0 || body.earnPerPaise > MAX_PAISE) errors.earnPer = 'Enter an amount in rupees, more than zero';
  body.pointValuePaise = rupeesToPaise(values.pointValue);
  if (!Number.isSafeInteger(body.pointValuePaise) || body.pointValuePaise <= 0 || body.pointValuePaise > MAX_PAISE) errors.pointValue = 'Enter an amount in rupees, more than zero';
  body.maxRedeemPoints = count(values.maxRedeemPoints);
  if (Number.isNaN(body.maxRedeemPoints)) errors.maxRedeemPoints = 'Enter a whole number of points';
  const expiry = String(values.expiryDays ?? '').trim();
  body.expiryDays = expiry === '' ? null : Number(expiry);
  if (expiry !== '' && (!/^\d+$/.test(expiry) || body.expiryDays < 1 || body.expiryDays > 3650)) errors.expiryDays = 'Enter 1 to 3,650 days, or leave it empty';
  body.friendRewardPaise = rupeesToPaise(values.friendReward) ?? 0;
  if (!Number.isSafeInteger(body.friendRewardPaise) || body.friendRewardPaise > MAX_PAISE) errors.friendReward = 'Enter an amount in rupees, or 0';
  body.referrerPoints = count(values.referrerPoints);
  if (Number.isNaN(body.referrerPoints)) errors.referrerPoints = 'Enter a whole number of points';
  return Object.keys(errors).length ? { errors } : { body };
}

export const LOYALTY_FIELDS = Object.freeze({ earnPerPaise: 'earnPer', pointValuePaise: 'pointValue', friendRewardPaise: 'friendReward' });
