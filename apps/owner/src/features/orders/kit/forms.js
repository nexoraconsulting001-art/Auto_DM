/**
 * The store and account forms as the app holds them (text a person edits) and as the API takes them, both ways, with
 * no imports, so they are tested in Node as well as in jest. Each `...Body(form)` answers { body } or { problems }, where
 * a problem is a string key the screen shows in the person's language. Money is rupees in a form and integer paise in
 * the API; a percentage is a percent in a form and hundredths of a percent in the API. It imports only ./rules.js, which
 * imports nothing.
 *
 * The patterns and numbers are the server's (src/contracts/orders.js and the store route files). The app may import
 * nothing from src but the access rules, so they are written out here, and test/p5/app-store fails when one differs.
 */
import { MAX_PAISE, parseRupees, parseWhole, rupeesText } from './rules.js';

export const PINCODE = /^[1-9][0-9]{5}$/;
export const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const INVOICE_PREFIX = /^[A-Z0-9]{1,4}$/;
export const KEY_ID = /^rzp_(?:test|live)_[A-Za-z0-9]{6,40}$/;
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOCAL_PART = /^[a-z0-9._-]{1,40}$/;
export const HOLD_MINUTES = Object.freeze({ min: 5, max: 1440 });
export const RETURN_WINDOW_DAYS = Object.freeze({ min: 0, max: 90 });

export const BUSINESS_TYPES = Object.freeze(['individual', 'proprietorship', 'partnership', 'private_limited', 'llp', 'other']);
export const POLICY_KINDS = Object.freeze(['privacy', 'terms', 'refund', 'shipping']);
export const ALERT_EVENTS = Object.freeze(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);
export const ONLINE_METHODS = Object.freeze(['upi', 'card', 'netbanking', 'wallet']);
export const RETURN_PROOF = Object.freeze(['photo', 'video', 'either']);
export const TEAM_ROLES = Object.freeze(['owner', 'manager', 'staff']);

/** Indian states and union territories by GST state code. Names are proper nouns, the same in every language. */
export const INDIAN_STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam',
  19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
});

/** [code, name] by name, codes two digits. */
export const STATE_OPTIONS = Object.freeze(Object.entries(INDIAN_STATES).map(([code, name]) => [String(code).padStart(2, '0'), name]).sort((a, b) => a[1].localeCompare(b[1])));

const text = (value) => String(value ?? '').trim();
const done = (body, problems) => (Object.keys(problems).length ? { problems } : { body });

/** "12.5" percent to 1250 hundredths; '' is null; anything else NaN. */
export function percentToBp(value) {
  const clean = text(value).replace(/%$/, '');
  if (clean === '') return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
export const bpToPercent = (bp) => (bp === null || bp === undefined ? '' : String(bp / 100));

/** "411001, 411002\n560001" to the PIN codes, without repeats. */
export const splitPins = (value) => [...new Set(String(value ?? '').split(/[\s,]+/).map((pin) => pin.trim()).filter(Boolean))];

/** Money a person typed, where an empty field means `empty` (0 or null). Null `paise` with a problem when it isn't money. */
function money(value, { empty = 0 } = {}) {
  if (text(value) === '') return { paise: empty };
  const paise = parseRupees(value);
  return paise === null ? { problem: true } : { paise };
}

// ---- payments (9.5, 9.6) ----

export function paymentOptionsForm(options) {
  return {
    upi: Boolean(options?.upi), card: Boolean(options?.card), netbanking: Boolean(options?.netbanking), wallet: Boolean(options?.wallet),
    cod: Boolean(options?.cod),
    codFee: rupeesText(options?.codFeePaise ?? 0),
    codMax: rupeesText(options?.codMaxOrderPaise),
    codPins: (options?.codPincodes ?? []).join(', '),
    codBlock: options?.codBlockRtoCount === null || options?.codBlockRtoCount === undefined ? '' : String(options.codBlockRtoCount),
    partAdvance: Boolean(options?.partAdvance),
    advanceKind: options?.advanceKind === 'percent' ? 'percent' : 'fixed',
    advanceValue: options?.advanceKind === 'percent' ? bpToPercent(options?.advanceValue) : rupeesText(options?.advanceValue ?? 0),
    holdMinutes: String(options?.holdMinutes ?? 30),
  };
}

/** The ways shoppers pay, as PaymentOptionsUpdate. */
export function paymentOptionsBody(form) {
  const problems = {};
  const fee = money(form.codFee);
  if (fee.problem) problems.codFee = 'payments.problem.amount';
  const max = money(form.codMax, { empty: null });
  if (max.problem) problems.codMax = 'payments.problem.amount';
  const codPincodes = splitPins(form.codPins);
  if (codPincodes.some((pin) => !PINCODE.test(pin))) problems.codPins = 'payments.problem.pins';
  let codBlockRtoCount = null;
  if (text(form.codBlock) !== '') {
    codBlockRtoCount = parseWhole(form.codBlock, { min: 1, max: 20 });
    if (codBlockRtoCount === null) problems.codBlock = 'payments.problem.block';
  }
  const percent = form.advanceKind === 'percent';
  let advanceValue = 0;
  if (percent) {
    advanceValue = percentToBp(form.advanceValue) ?? 0;
    if (!Number.isInteger(advanceValue) || advanceValue > 10000) problems.advanceValue = 'payments.problem.percent';
  } else {
    const advance = money(form.advanceValue);
    if (advance.problem) problems.advanceValue = 'payments.problem.amount';
    else advanceValue = advance.paise;
  }
  if (form.partAdvance && !problems.advanceValue && advanceValue === 0) problems.advanceValue = 'payments.problem.advance';
  const holdMinutes = parseWhole(form.holdMinutes, HOLD_MINUTES);
  if (holdMinutes === null) problems.holdMinutes = 'payments.problem.hold';
  return done({
    upi: Boolean(form.upi), card: Boolean(form.card), netbanking: Boolean(form.netbanking), wallet: Boolean(form.wallet),
    cod: Boolean(form.cod), codFeePaise: fee.paise ?? 0, codMaxOrderPaise: max.paise ?? null, codPincodes, codBlockRtoCount,
    partAdvance: Boolean(form.partAdvance), advanceKind: percent ? 'percent' : 'fixed', advanceValue, holdMinutes,
  }, problems);
}

/** The managed account's KYC details (paymentAccount.startLinked). */
export function linkedAccountBody(form) {
  const problems = {};
  const body = { legalName: text(form.legalName), contactName: text(form.contactName), email: text(form.email), phone: text(form.phone).replace(/[^\d+]/g, ''), businessType: BUSINESS_TYPES.includes(form.businessType) ? form.businessType : 'proprietorship' };
  if (!body.legalName) problems.legalName = 'payments.problem.legalName';
  if (!body.contactName) problems.contactName = 'payments.problem.contactName';
  if (!EMAIL.test(body.email)) problems.email = 'payments.problem.email';
  if (body.phone.replace(/\D/g, '').length < 10) problems.phone = 'payments.problem.phone';
  return done(body, problems);
}

/** Own mode's Razorpay keys (settings.updatePayment). Both are needed; the secret is sent exactly as typed. */
export function razorpayKeysBody({ razorpayKeyId, razorpayKeySecret }) {
  const problems = {};
  const keyId = text(razorpayKeyId);
  if (!KEY_ID.test(keyId)) problems.razorpayKeyId = 'payments.problem.keyId';
  if (!razorpayKeySecret) problems.razorpayKeySecret = 'settings.secret.required';
  return done({ razorpayKeyId: keyId, razorpayKeySecret }, problems);
}

// ---- shipping (9.10) ----

export const PICKUP_FIELDS = Object.freeze(['pickupName', 'pickupPhone', 'pickupLine1', 'pickupLine2', 'pickupCity', 'pickupStateCode', 'pickupPincode']);
const PICKUP_REQUIRED = Object.freeze(['pickupName', 'pickupPhone', 'pickupLine1', 'pickupCity', 'pickupStateCode', 'pickupPincode']);

/** The settings as a form. The password is never part of what came back: its field starts empty, always. */
export function shippingForm(settings) {
  return {
    mode: settings?.mode === 'own' ? 'own' : 'managed',
    ...Object.fromEntries(PICKUP_FIELDS.map((name) => [name, settings?.[name] ?? ''])),
    ownEmail: settings?.ownEmail ?? '',
    chargeBilling: settings?.chargeBilling === 'monthly' ? 'monthly' : 'payout',
  };
}

/** ShippingSettingsUpdate. The pickup address goes all together or not at all; the password only when typed. */
export function shippingBody(form, { ownPassword = '' } = {}) {
  const problems = {};
  const body = { mode: form.mode === 'own' ? 'own' : 'managed', chargeBilling: form.chargeBilling === 'monthly' ? 'monthly' : 'payout' };
  const pickup = Object.fromEntries(PICKUP_FIELDS.map((name) => [name, text(form[name])]));
  if (PICKUP_FIELDS.some((name) => pickup[name])) {
    for (const name of PICKUP_REQUIRED) if (!pickup[name]) problems[name] = 'shipping.problem.required';
    if (pickup.pickupPincode && !PINCODE.test(pickup.pickupPincode)) problems.pickupPincode = 'shipping.problem.pincode';
    if (pickup.pickupStateCode && !/^[0-9]{2}$/.test(pickup.pickupStateCode)) problems.pickupStateCode = 'shipping.problem.required';
    if (pickup.pickupPhone && pickup.pickupPhone.replace(/\D/g, '').length < 10) problems.pickupPhone = 'shipping.problem.phone';
    Object.assign(body, pickup);
  }
  if (body.mode === 'own') {
    const email = text(form.ownEmail);
    if (email && !EMAIL.test(email)) problems.ownEmail = 'shipping.problem.email';
    body.ownEmail = email;
    if (ownPassword) body.ownPassword = ownPassword;
  }
  return done(body, problems);
}

// ---- general settings ----

const SETTING_TEXT = Object.freeze(['storeName', 'tagline', 'instagramHandle', 'supportWhatsapp', 'supportEmail', 'heroKicker', 'heroTitle', 'heroSubtitle', 'trustPoints', 'bulkTitle', 'bulkText', 'aboutText', 'gstin']);

export function storeSettingsForm(settings) {
  return {
    ...Object.fromEntries(SETTING_TEXT.map((name) => [name, settings?.[name] ?? ''])),
    shippingFee: rupeesText(settings?.shippingFeePaise ?? 0),
    freeShippingAbove: rupeesText(settings?.freeShippingAbovePaise ?? 0),
  };
}

/** SettingsUpdate. An empty amount is zero, which is what a seller means by it. */
export function storeSettingsBody(form) {
  const problems = {};
  const body = Object.fromEntries(SETTING_TEXT.map((name) => [name, text(form[name])]));
  if (!body.storeName) problems.storeName = 'settings.problem.storeName';
  body.instagramHandle = body.instagramHandle.replace(/^@/, '');
  body.supportWhatsapp = body.supportWhatsapp.replace(/\D/g, '');
  if (body.supportEmail && !EMAIL.test(body.supportEmail)) problems.supportEmail = 'settings.problem.email';
  for (const [field, key] of [['shippingFee', 'shippingFeePaise'], ['freeShippingAbove', 'freeShippingAbovePaise']]) {
    const amount = money(form[field]);
    if (amount.problem) problems[field] = 'settings.problem.amount';
    else body[key] = amount.paise;
  }
  return done(body, problems);
}

/** The Phase 0 payment QR: the UPI id and the payee name (settings.updatePayment, with no key). */
export function upiBody({ upiId, upiPayee }) {
  const problems = {};
  const body = { upiId: text(upiId), upiPayee: text(upiPayee) };
  if (body.upiId && !/^[\w.-]{2,}@[a-zA-Z][\w.-]*$/.test(body.upiId)) problems.upiId = 'payments.problem.upi';
  return done(body, problems);
}

// ---- invoices (9.13) ----

export function invoiceSettingsForm(settings) {
  return { legalName: settings?.legalName ?? '', gstin: settings?.gstin ?? '', stateCode: settings?.stateCode ?? '', address: settings?.address ?? '', invoicePrefix: settings?.invoicePrefix ?? '' };
}

export function invoiceSettingsBody(form) {
  const problems = {};
  const body = { legalName: text(form.legalName), gstin: text(form.gstin).toUpperCase(), stateCode: text(form.stateCode), address: text(form.address), invoicePrefix: text(form.invoicePrefix).toUpperCase() };
  if (body.gstin && !GSTIN.test(body.gstin)) problems.gstin = 'invoices.problem.gstin';
  if (body.gstin && body.stateCode && body.gstin.slice(0, 2) !== body.stateCode) problems.stateCode = 'invoices.problem.state';
  if (body.stateCode && !/^[0-9]{2}$/.test(body.stateCode)) problems.stateCode = 'invoices.problem.state';
  if (body.invoicePrefix && !INVOICE_PREFIX.test(body.invoicePrefix)) problems.invoicePrefix = 'invoices.problem.prefix';
  return done(body, problems);
}

// ---- returns (9.17) ----

export function returnSettingsBody(form) {
  const problems = {};
  const windowDays = parseWhole(form.windowDays, RETURN_WINDOW_DAYS);
  if (windowDays === null) problems.windowDays = 'returns.problem.window';
  return done({ enabled: Boolean(form.enabled), windowDays, eligibleCategoryIds: [...new Set((form.eligibleCategoryIds ?? []).map(Number))], proof: RETURN_PROOF.includes(form.proof) ? form.proof : 'either' }, problems);
}

// ---- loyalty (9.21) ----

export function loyaltySettingsForm(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    earnPoints: String(settings?.earnPoints ?? 1),
    earnPer: rupeesText(settings?.earnPerPaise ?? 10000),
    pointValue: rupeesText(settings?.pointValuePaise ?? 100),
    maxRedeemPoints: String(settings?.maxRedeemPoints ?? 0),
    expiryDays: settings?.expiryDays === null || settings?.expiryDays === undefined ? '' : String(settings.expiryDays),
    referralEnabled: Boolean(settings?.referralEnabled),
    friendReward: rupeesText(settings?.friendRewardPaise ?? 0),
    referrerPoints: String(settings?.referrerPoints ?? 0),
  };
}

export function loyaltySettingsBody(form) {
  const problems = {};
  const whole = (field, opts) => {
    const n = parseWhole(form[field], opts);
    if (n === null) problems[field] = 'loyalty.problem.count';
    return n;
  };
  const paise = (field, { min = 0 } = {}) => {
    const amount = money(form[field]);
    if (amount.problem || amount.paise < min) problems[field] = 'loyalty.problem.amount';
    return amount.paise ?? 0;
  };
  const body = {
    enabled: Boolean(form.enabled),
    earnPoints: whole('earnPoints', { min: 0, max: 1_000_000 }),
    earnPerPaise: paise('earnPer', { min: 1 }),
    pointValuePaise: paise('pointValue', { min: 1 }),
    maxRedeemPoints: whole('maxRedeemPoints', { min: 0, max: 1_000_000 }),
    expiryDays: text(form.expiryDays) === '' ? null : whole('expiryDays', { min: 1, max: 3650 }),
    referralEnabled: Boolean(form.referralEnabled),
    friendRewardPaise: paise('friendReward'),
    referrerPoints: whole('referrerPoints', { min: 0, max: 1_000_000 }),
  };
  return done(body, problems);
}

/** A hand adjustment of a member's points: a whole number, not zero, with a note (owner only). */
export function pointsAdjustBody({ points, note }) {
  const problems = {};
  const n = parseWhole(points, { min: -1_000_000, max: 1_000_000 });
  if (n === null || n === 0) problems.points = 'loyalty.problem.points';
  if (!text(note)) problems.note = 'loyalty.problem.note';
  return done({ points: n, note: text(note).slice(0, 200) }, problems);
}

// ---- stock (9.12) ----

export const ADJUST_WAYS = Object.freeze(['set', 'move', 'unlimited']);
const STOCK_LIMIT = 1_000_000;

export function stockForm(line) {
  return { way: line?.stock === null ? 'unlimited' : 'set', amount: line?.stock === null || line?.stock === undefined ? '' : String(line.stock), lowAt: line?.lowStockThreshold === null || line?.lowStockThreshold === undefined ? '' : String(line.lowStockThreshold), note: '' };
}

/**
 * StockAdjust for one line: set it, move it by an amount, or count it no more, with the low-stock level beside it.
 * Exactly one of stock and delta goes, or neither when only the level changes.
 */
export function stockBody(form, line) {
  const problems = {};
  const body = { productId: line.productId, variantId: line.variantId ?? null };
  const amount = text(form.amount).replace(/^\+/, '');
  if (form.way === 'set') {
    const n = parseWhole(amount, { min: 0, max: STOCK_LIMIT });
    if (n === null) problems.amount = 'inventory.problem.set';
    else body.stock = n;
  } else if (form.way === 'move') {
    const n = parseWhole(amount, { min: -STOCK_LIMIT, max: STOCK_LIMIT });
    if (n === null || n === 0) problems.amount = 'inventory.problem.move';
    else if (line.stock === null || line.stock === undefined) problems.amount = 'inventory.problem.uncounted';
    else if (line.stock + n < 0) problems.amount = 'inventory.problem.below';
    else body.delta = n;
  } else {
    body.stock = null;
  }
  const lowAt = text(form.lowAt);
  if (lowAt === '') {
    if (line.lowStockThreshold !== null && line.lowStockThreshold !== undefined) body.lowStockThreshold = null;
  } else {
    const n = parseWhole(lowAt, { min: 0, max: STOCK_LIMIT });
    if (n === null) problems.lowAt = 'inventory.problem.low';
    else if (n !== line.lowStockThreshold) body.lowStockThreshold = n;
  }
  if (text(form.note)) body.note = text(form.note).slice(0, 200);
  return done(body, problems);
}

/** "+3" or "−2". */
export const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

// ---- privacy (9.18) ----

export function grievanceBody(form) {
  const problems = {};
  const body = { grievanceName: text(form.grievanceName), grievanceEmail: text(form.grievanceEmail), grievancePhone: text(form.grievancePhone), grievanceAddress: text(form.grievanceAddress) };
  if (body.grievanceEmail && !EMAIL.test(body.grievanceEmail)) problems.grievanceEmail = 'privacy.problem.email';
  return done(body, problems);
}

export function noticeBody({ bodyEn, bodyHi }) {
  const problems = {};
  if (!text(bodyEn)) problems.bodyEn = 'privacy.problem.noticeEn';
  if (!text(bodyHi)) problems.bodyHi = 'privacy.problem.noticeHi';
  return done({ bodyEn: text(bodyEn), bodyHi: text(bodyHi) }, problems);
}

// ---- messages to shoppers (9.15, 9.16) ----

export function alertSettingsForm(settings) {
  const [local] = String(settings?.emailFromAddress ?? '').split('@');
  return { whatsapp: Boolean(settings?.whatsapp), email: Boolean(settings?.email), events: [...(settings?.events ?? [])], emailFrom: settings?.emailFrom === 'own' ? 'own' : 'neutral', emailFromLocal: local ?? '', emailReplyTo: settings?.emailReplyTo ?? '' };
}

export function alertSettingsBody(form) {
  const problems = {};
  const emailFromLocal = text(form.emailFromLocal).toLowerCase();
  if (!LOCAL_PART.test(emailFromLocal)) problems.emailFromLocal = 'store-settings.problem.local';
  const emailReplyTo = text(form.emailReplyTo);
  if (emailReplyTo && !EMAIL.test(emailReplyTo)) problems.emailReplyTo = 'store-settings.problem.email';
  const events = ALERT_EVENTS.filter((name) => (form.events ?? []).includes(name));
  return done({ whatsapp: Boolean(form.whatsapp), email: Boolean(form.email), events, emailFrom: form.emailFrom === 'own' ? 'own' : 'neutral', emailFromLocal, emailReplyTo }, problems);
}

// ---- integrations whose keys are written and never read back (P-17) ----

export function shopifyConnectBody({ shopDomain, accessToken, webhookSecret, mode }) {
  const problems = {};
  const domain = text(shopDomain).toLowerCase();
  if (!SHOP_DOMAIN.test(domain)) problems.shopDomain = 'shopify.problem.domain';
  if (!text(accessToken)) problems.accessToken = 'settings.secret.required';
  if (!text(webhookSecret)) problems.webhookSecret = 'settings.secret.required';
  return done({ shopDomain: domain, accessToken: text(accessToken), webhookSecret: text(webhookSecret), mode: mode === 'two_way' ? 'two_way' : 'source' }, problems);
}

export function whatsappConnectBody({ wabaId, phoneNumberId, accessToken, displayNumber }) {
  const problems = {};
  const body = { wabaId: text(wabaId), phoneNumberId: text(phoneNumberId), accessToken: text(accessToken) };
  if (!/^\d{5,40}$/.test(body.wabaId)) problems.wabaId = 'store-settings.problem.id';
  if (!/^\d{5,40}$/.test(body.phoneNumberId)) problems.phoneNumberId = 'store-settings.problem.id';
  if (!body.accessToken) problems.accessToken = 'settings.secret.required';
  if (text(displayNumber)) body.displayNumber = text(displayNumber);
  return done(body, problems);
}

// ---- the team (5.11) ----

/** An invitation: a phone number or an email, a role below owner, and for staff the permissions they get. */
export function inviteBody({ contact, role, permissions }) {
  const problems = {};
  const value = text(contact);
  const isEmail = value.includes('@');
  if (isEmail ? !EMAIL.test(value) : value.replace(/\D/g, '').length < 10) problems.contact = 'team.problem.contact';
  const chosen = TEAM_ROLES.includes(role) ? role : 'staff';
  const list = chosen === 'staff' ? [...new Set(permissions ?? [])] : [];
  if (chosen === 'staff' && list.length === 0) problems.permissions = 'team.problem.permissions';
  return done({ contact: isEmail ? value.toLowerCase() : value.replace(/[^\d+]/g, ''), role: chosen, permissions: list }, problems);
}

/** The money a coupon or a setting may hold at most, for a hint. */
export { MAX_PAISE };
