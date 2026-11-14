/**
 * Plans, billing, metering, sign-up and referrals (PRD 3, 5.7, 5.12, 5.20), as data and pure rules. No imports, so the
 * server, the worker, the console and the owner app read the same rules.
 *
 * Prices are never here. They are rows: plan_prices, addons, offers and billing_settings (migration 700). The names and
 * numbers below are the vocabulary those rows and the tables of 701 use, and the arithmetic that must come out the same
 * everywhere: tax, the offer, the yearly fee, the meter.
 */
export const PLANS = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);
export const PAID_PLANS = Object.freeze(PLANS.filter((plan) => plan !== 'free'));
export const BILLING_CYCLES = Object.freeze(['monthly', 'yearly']);
export const planRank = (plan) => PLANS.indexOf(plan);
export const isUpgrade = (from, to) => planRank(to) > planRank(from);

/** subscriptions.status. `grace` runs until grace_until; `suspended` is an owner-locked pause with the data kept (4.12). */
export const SUBSCRIPTION_STATUSES = Object.freeze(['active', 'past_due', 'grace', 'suspended', 'cancelled']);
/** addons.kind and subscription_items.kind. */
export const ITEM_KINDS = Object.freeze(['addon', 'pack', 'service', 'setup']);
export const ITEM_CYCLES = Object.freeze(['monthly', 'one_time']);
export const PLAN_CHANGE_SOURCES = Object.freeze(['owner', 'console', 'billing', 'signup', 'direct']);
export const INVOICE_LINE_KINDS = Object.freeze(['plan', 'addon', 'pack', 'service', 'setup', 'pass_through']);
export const PASS_THROUGH_KINDS = Object.freeze(['gateway_fee', 'shipping', 'whatsapp', 'ai']);
export const PROVIDER_PAYMENT_STATUSES = Object.freeze(['captured', 'failed', 'refunded']);

/**
 * Entitlement names added in Phase 7. The first two are switched on by an add-on, the services by a managed service
 * (5.17), `staff.seats` is a limit, and `badge.made_with` is on the free plan only (U-07, U-08).
 */
export const BILLING_FEATURES = Object.freeze({
  aiReplies: 'ai_replies',
  whatsapp: 'whatsapp_automation',
  seats: 'staff.seats',
  dms: 'dms.monthly',
  badge: 'badge.made_with',
  services: Object.freeze(['service.reel_management', 'service.reel_backlog', 'service.merchandising', 'service.catalog_management', 'service.performance_report']),
});

// ---- Metering ----

export const METERS = Object.freeze(['dms', 'whatsapp_messages', 'ai_units']);
/** The reason a held DM carries when the month's DMs are used up (4.16), and what lifts it. */
export const DM_LIMIT_REASON = 'held.dm_limit';
export const DM_ALERT_PERCENTS = Object.freeze([80, 100]);
/** What counts on the DM meter: a private reply or a DM that Meta accepted. A public comment reply is not a DM. */
export const METERED_SEND_KINDS = Object.freeze(['private_reply', 'dm']);
/** Never held for the limit: the owner's own reply, the confirmation of an opt-out, and a test send. */
export const UNMETERED_HOLD_PURPOSES = Object.freeze(['manual', 'optout_confirm', 'test']);

/** The key that makes one accepted send one usage event: unique per business in usage_events. */
export const dmUsageKey = (jobId) => `dm:${jobId}`;
/** The first day of the calendar month in India that `at` falls in, as 'YYYY-MM-01'. The database's usage_month_of agrees. */
export function usageMonthOf(at = new Date()) {
  const india = new Date(new Date(at).getTime() + 330 * 60_000);
  return `${india.getUTCFullYear()}-${String(india.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
/**
 * The meter, from one usage_months row: { used, included, packUnits, allowance, left, percent, over }. `included` null
 * is no limit: allowance and left are null and percent is 0.
 */
export function meterOf({ used = 0, included = null, packUnits = 0 } = {}) {
  if (included === null || included === undefined || included === Infinity) return { used, included: null, packUnits, allowance: null, left: null, percent: 0, over: false };
  const allowance = included + packUnits;
  const left = Math.max(0, allowance - used);
  const percent = allowance > 0 ? Math.floor((used * 100) / allowance) : 100;
  return { used, included, packUnits, allowance, left, percent, over: used >= allowance };
}
/** Which alert marks a meter has reached and not yet sent: [80], [100], both or none. */
export function alertsDue(meter, { alert80At = null, alert100At = null } = {}, percents = DM_ALERT_PERCENTS) {
  if (meter.allowance === null) return [];
  const sent = { 80: alert80At, 100: alert100At };
  return percents.filter((p) => meter.percent >= p && !sent[p]);
}

// ---- Money ----

/** Half-up, in whole paise. */
const share = (paise, bp) => Math.floor((paise * bp + 5000) / 10000);

/** A yearly fee is `yearlyMonths` months of the monthly one (10: two months free). */
export const yearlyPaise = (monthlyPaise, yearlyMonths = 10) => monthlyPaise * yearlyMonths;
/** What an offer takes off a gross amount. */
export const offerDiscountPaise = (grossPaise, percentOff = 0) => share(grossPaise, Math.max(0, Math.min(100, percentOff)) * 100);

/**
 * Tax on one line (F-54). The same state as Bhava's: CGST and SGST, each half the rate, so the two are always equal.
 * Any other state: IGST. Answers { cgstPaise, sgstPaise, igstPaise, totalPaise }.
 */
export function taxFor(taxablePaise, { rateBp = 1800, sellerState, buyerState } = {}) {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) throw new Error('taxFor needs whole paise');
  if (sellerState && buyerState && sellerState === buyerState) {
    const half = share(taxablePaise, rateBp / 2);
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0, totalPaise: taxablePaise + 2 * half };
  }
  const igst = share(taxablePaise, rateBp);
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: igst, totalPaise: taxablePaise + igst };
}

/**
 * The days left of a cycle as a part of its price, for billing_settings.proration 'daily'; 'none' is the whole price.
 * Whole paise, never more than the price.
 */
export function proratedPaise(pricePaise, { rule = 'none', daysLeft, daysInCycle } = {}) {
  if (rule !== 'daily' || !(daysInCycle > 0)) return pricePaise;
  const left = Math.max(0, Math.min(daysInCycle, daysLeft));
  return Math.floor((pricePaise * left) / daysInCycle);
}

/** The financial year in India by its first calendar year, as the database's financial_year() answers it: April to March. */
export function financialYearOf(at = new Date()) {
  const india = new Date(new Date(at).getTime() + 330 * 60_000);
  return india.getUTCMonth() >= 3 ? india.getUTCFullYear() : india.getUTCFullYear() - 1;
}

// ---- The billing provider ----

/**
 * Bhava's own Razorpay account, with Subscriptions. The address is not one of the store's (STORE_PROVIDER_PATHS): those
 * end in a business's key. Events go into provider_webhook_events with this provider and scope before the answer.
 */
export const BILLING_WEBHOOK = Object.freeze({ method: 'POST', path: '/webhooks/billing/razorpay', owner: 'billing', provider: 'razorpay', scope: 'billing', badSignatureStatus: 400 });
export const BILLING_QUEUE = 'billing.webhooks';
/**
 * What each subscription event means here (names to confirm with Razorpay, 5.12). An event not listed is stored and
 * ignored with outcome 'not_handled'.
 *   charged    a payment was taken: one billing_payments row and one invoice per payment id, status back to active
 *   failed     a charge failed: past_due, then grace for billing_settings.grace_days
 *   halted     the provider gave up retrying: still in grace until grace_until, then suspended (F-53)
 *   cancelled  the subscription ended
 */
export const BILLING_EVENTS = Object.freeze({
  'subscription.charged': 'charged',
  'subscription.pending': 'failed',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.activated': 'activated',
  'subscription.updated': 'updated',
  'payment.failed': 'failed',
});
/** An event older than the state it would set changes nothing (outcome 'stale'): ranks by how far along a subscription is. */
export const isStaleBillingEvent = (eventAt, lastAppliedAt) => Boolean(lastAppliedAt) && +new Date(eventAt) < +new Date(lastAppliedAt);

// ---- Sign-up and referrals ----

export const SIGNUP_MODES = Object.freeze(['closed', 'invite', 'public']);
export const ACCOUNT_TYPES = Object.freeze(['creator', 'seller']);
/** In order. Each is written once per run with its time (signup_steps), so the three-minute target can be measured (F-121). */
export const SIGNUP_STEPS = Object.freeze(['opened', 'signed_in', 'account_type', 'instagram_connected', 'automation_drafted', 'automation_live', 'finished']);
export const SIGNUP_TARGET_MS = 3 * 60_000;
export const REFERRAL_STATES = Object.freeze(['pending', 'credited', 'blocked']);
export const REFERRAL_BLOCKS = Object.freeze(['same_instagram', 'same_phone', 'same_payment_method']);
/** The query parameter a referral link carries to the sign-up page. A referral link never goes inside a DM (4.10). */
export const REFERRAL_PARAM = 'ref';
/** A seller's own referral code, as seller_referral_codes keeps it. */
export const REFERRAL_CODE = /^[a-z0-9]{6,20}$/;
/**
 * The link an account shares: the sign-up page's address with its code (5.20). Shown in the console and behind the Free
 * plan's badge on the creator page (8.14); never put inside a DM. '' when either part is missing or malformed.
 */
export function referralLink(signupUrl, code) {
  const base = String(signupUrl ?? '').trim();
  if (!/^https:\/\/[^\s"'<>\\?#]+$/i.test(base) || !REFERRAL_CODE.test(String(code ?? ''))) return '';
  return `${base}?${REFERRAL_PARAM}=${code}`;
}

/**
 * Whether a flag is on for a business: its own tenant_flags row, else the flag's default, else the percentage, which is
 * a stable bucket of the business's id so a business does not flip in and out as the percentage grows.
 */
export function flagOn({ enabled = false, percent = 0 } = {}, tenantFlag, tenantId) {
  if (tenantFlag === true || tenantFlag === false) return tenantFlag;
  if (enabled) return true;
  return percent > 0 && (((Number(tenantId) * 2654435761) >>> 0) % 100) < percent;
}

/**
 * Which jobs must ask repos.entitlements before they act (5.7: "every route, screen and job"). The router checks routes
 * from the route table; these run with no route, so each asks for itself and skips, never fails, a business without it.
 */
export const JOB_ENTITLEMENTS = Object.freeze({
  'automation runs': Object.freeze(['triggers.comment', 'triggers.story_dm', 'links.one_tap', 'automations', 'ai_replies', 'whatsapp_automation']),
  'the send gate': Object.freeze(['dms.monthly']),
  imports: Object.freeze(['catalog.import']),
  'catalog re-check': Object.freeze(['catalog.import']),
  checkout: Object.freeze(['store.checkout', 'store.payments', 'store.coupons', 'loyalty']),
  'cart reminders': Object.freeze(['store.cart_reminders']),
  'order alerts': Object.freeze(['store.order_alerts']),
  'review requests': Object.freeze(['store.reviews']),
  'Shopify sync': Object.freeze(['shopify.sync']),
  reports: Object.freeze(['report.monthly', 'reports.scheduled', 'service.performance_report']),
  'app builds and updates': Object.freeze(['app.android', 'app.ios']),
  'shopper push': Object.freeze(['app.android', 'app.ios']),
  'managed service sessions': BILLING_FEATURES.services,
});
