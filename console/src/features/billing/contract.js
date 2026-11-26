/**
 * Pure rules of the billing screens. Prices, limits and plan names are never written here: they all come from the server
 * (billing.catalog, billing.plan, billing.usage). What is here is vocabulary the server also uses, kept equal to the server's
 * own copy by test/p7/console-billing.
 */
export const PLAN_OFF = 'plan.feature_off';
export const LIMIT_REACHED = 'plan.limit_reached';
/** The words of every plan refusal, the server's own (PLAN_REFUSAL_MESSAGE, user decision 2026-11-26), and where upgrading is. */
export const PLAN_REFUSAL_TITLE = 'Not included in your current plan';
export const UPGRADE_PATH = '/billing';
export const PLAN_CODES = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);
export const CYCLES = Object.freeze(['monthly', 'yearly']);
export const METER_LABELS = Object.freeze({ dms: 'Automated DMs', whatsapp_messages: 'WhatsApp messages', ai_units: 'AI replies' });

/** The router's two plan refusals (403). Both come before any handler runs, so the server is the guard and the screen only explains. */
export const isFeatureOff = (error) => error?.status === 403 && error?.code === PLAN_OFF;
export const isLimitReached = (error) => error?.status === 403 && error?.code === LIMIT_REACHED;
export const isPlanProblem = (error) => isFeatureOff(error) || isLimitReached(error);
export const needsReauth = (error) => error?.code === 'reauth_required';

/** A key that makes a repeated tap the same change. One per opened sheet, so a double tap cannot charge twice. */
export function newRequestKey() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `rk-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const rankOf = (catalog, code) => catalog.plans.find((plan) => plan.code === code)?.rank ?? -1;
export const planNamed = (catalog, code) => catalog.plans.find((plan) => plan.code === code);

/** 'upgrade', 'downgrade' or 'same', by the server's own plan ranks. */
export function changeKind(catalog, from, to) {
  const diff = rankOf(catalog, to) - rankOf(catalog, from);
  return diff > 0 ? 'upgrade' : diff < 0 ? 'downgrade' : 'same';
}

/** What a business loses by moving to `to`: the add-ons its current plan includes that the new one does not. From the catalog, never typed. */
export function switchesOff(catalog, from, to) {
  const now = rankOf(catalog, from);
  const next = rankOf(catalog, to);
  return catalog.addons
    .filter((addon) => addon.includedFrom && rankOf(catalog, addon.includedFrom) <= now && rankOf(catalog, addon.includedFrom) > next)
    .map((addon) => addon.name);
}

/** The price a plan card shows for a cycle, and what the yearly choice saves, both worked out from the server's two prices. */
export const priceFor = (plan, cycle) => (cycle === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise);
export const yearlySaving = (plan) => Math.max(0, plan.monthlyPaise * 12 - plan.yearlyPaise);

/** One meter as the screen shows it. */
export function meterView(meter) {
  const label = METER_LABELS[meter.meter] ?? meter.meter;
  const unlimited = meter.allowance === null;
  const tone = meter.over || meter.percent >= 100 ? 'bad' : meter.percent >= 80 ? 'warn' : 'good';
  return {
    label,
    unlimited,
    tone,
    percent: Math.min(100, meter.percent),
    text: unlimited ? `${meter.used} used. No limit on your plan.` : `${meter.used} of ${meter.allowance} used`,
    left: unlimited ? null : meter.left,
  };
}

/** What an upgrade prompt says for a plan refusal, from the refusal's own fields. */
export function promptText(error, { planNameOf = (code) => code } = {}) {
  const higher = error?.plan ? planNameOf(error.plan) : '';
  if (isLimitReached(error)) {
    const used = typeof error.limit === 'number' ? `You have used all ${error.limit}. ` : '';
    return { title: PLAN_REFUSAL_TITLE, body: `${used}Upgrade: ${higher ? `${higher} gives you more.` : 'a higher plan gives you more.'}` };
  }
  return { title: PLAN_REFUSAL_TITLE, body: higher ? `Upgrade: ${higher} includes it.` : 'Upgrade: an add-on or a higher plan turns it on.' };
}

/** Only an https link, or this site's own path, is ever followed for a document. */
export const safeFileUrl = (url) => typeof url === 'string' && /^(https:\/\/|\/)/.test(url) && !url.startsWith('//');
