/** Pure rules of the billing screens: the words for a plan, the meter's state, request keys and plan refusals. No money is worked out here: every price comes from the server. */

export const PLAN_LABELS = Object.freeze({ free: 'Free', t1: 'Starter', t2: 'Growth', t3: 'Store', t4: 'Android app', t5: 'iOS app' });
export const PLAN_ORDER = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);
export const planRank = (code) => PLAN_ORDER.indexOf(code);
export const planLabel = (code) => PLAN_LABELS[code] ?? String(code ?? '');

/** 4,000 and 1,50,000: Indian grouping of a whole number. */
export function groupDigits(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '';
  const digits = String(Math.abs(n));
  const grouped = digits.length <= 3 ? digits : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  return `${n < 0 ? '−' : ''}${grouped}`;
}

/** A key that makes a repeated request the same change (the server wants 8 to 80 of A-Z a-z 0-9 _ -). */
export function newRequestKey() {
  const part = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `rk_${Date.now().toString(36)}_${part()}${part()}`;
}

/** What the DM meter says: the numbers as the server counted them, and `state` 'ok', 'near' (80% and up) or 'over' (all used). */
export function meterView(meter) {
  if (!meter) return null;
  const unlimited = meter.allowance === null || meter.allowance === undefined;
  const percent = unlimited ? 0 : Math.max(0, Math.min(100, Number(meter.percent) || 0));
  const state = unlimited ? 'ok' : meter.over || percent >= 100 ? 'over' : percent >= 80 ? 'near' : 'ok';
  return { used: meter.used, allowance: meter.allowance, unlimited, percent, state, packUnits: meter.packUnits ?? 0, left: meter.left };
}

/** The plan's price for the cycle, from the catalog's own numbers. */
export const priceOf = (plan, cycle) => (cycle === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise);

/** 'plan.feature_off' and 'plan.limit_reached' are the two answers that mean "not on your plan". Null for any other error. */
export function planRefusal(error) {
  if (error?.code === 'plan.feature_off') return { kind: 'feature', plan: error.plan ?? '', feature: error.feature ?? '' };
  if (error?.code === 'plan.limit_reached') return { kind: 'limit', plan: error.plan ?? '', feature: error.feature ?? '', limit: error.limit, used: error.used };
  return null;
}

/** The entitlements the plan screen names, by code. Others are not listed. */
export const FEATURE_KEYS = Object.freeze({
  automations: 'billing.feature.automations',
  'links.one_tap': 'billing.feature.oneTap',
  'links.two_tap': 'billing.feature.twoTap',
  'store.checkout': 'billing.feature.checkout',
  ai_replies: 'billing.feature.ai',
  whatsapp: 'billing.feature.whatsapp',
});
export const STORE_FEATURE = /^(store\.|loyalty|app\.)/;
