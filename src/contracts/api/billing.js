import { z } from 'zod';
import { ACCOUNT_TYPES, BILLING_CYCLES, ITEM_CYCLES, ITEM_KINDS, METERS, PLANS, REFERRAL_STATES, SIGNUP_MODES, SIGNUP_STEPS, SUBSCRIPTION_STATUSES } from '../billing.js';
import { OWNER_ONLY, PUBLIC, SIGNED_IN } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, Timestamp, page, required, text } from './common.js';

/**
 * Phase 7: the plan, billing, usage, referrals and self-serve sign-up (PRD 3, 5.7, 5.12, 5.20).
 *
 * No route takes an amount: the server prices every plan, add-on and pack from plan_prices and addons, applies the offer
 * and works out the tax. No card data ever reaches Bhava: billing.paymentMethod, and a change that needs a payment,
 * answer with the provider's hosted page. Billing routes are OWNER_ONLY, and `fresh` where they change money.
 * An operator who is impersonating may not call any of them (5.10).
 *
 * The sign-up routes are PUBLIC and answered with no business, on PLATFORM_APP_HOST: the person has signed in there
 * (auth.start, auth.verify, Google) and has no business yet. Each handler finds the person from that session itself and
 * answers 401 without one.
 */
const Plan = z.enum(PLANS);
const Cycle = z.enum(BILLING_CYCLES);
/** Makes a repeated request the same change: sent by the client, unique per business. */
const RequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, 'Send a request key');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AddonCode = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Choose an add-on');

export const BillingItem = z.object({
  id: Id,
  code: z.string(),
  name: z.string(),
  kind: z.enum(ITEM_KINDS),
  cycle: z.enum(ITEM_CYCLES),
  quantity: Count,
  unitPricePaise: Paise,
  startsAt: Timestamp,
  endsAt: Timestamp.nullable(),
});
export const BillingOffer = z.object({ code: z.string(), name: z.string(), percentOff: z.number().int().min(1).max(100), forLife: z.boolean() });
export const BillingPlan = z.object({
  plan: Plan,
  planName: z.string(),
  cycle: Cycle,
  status: z.enum(SUBSCRIPTION_STATUSES),
  /** What the next charge will be before tax, after the offer; 0 on Free. */
  nextChargePaise: Paise,
  periodEnd: Timestamp.nullable(),
  graceUntil: Timestamp.nullable(),
  /** A downgrade or cycle change waiting for the period to end. */
  nextPlan: Plan.nullable(),
  nextCycle: Cycle.nullable(),
  offer: BillingOffer.nullable(),
  hasPaymentMethod: z.boolean(),
  items: z.array(BillingItem),
});

export const CatalogPlan = z.object({
  code: Plan,
  name: z.string(),
  rank: z.number().int().min(0),
  monthlyPaise: Paise,
  yearlyPaise: Paise,
  /** Included DMs a month; null is no limit. */
  includedDms: Count.nullable(),
  current: z.boolean(),
});
export const CatalogAddon = z.object({
  code: z.string(),
  name: z.string(),
  kind: z.enum(ITEM_KINDS),
  pricePaise: Paise,
  cycle: z.enum(ITEM_CYCLES),
  feature: z.string().nullable(),
  minPlan: Plan,
  includedFrom: Plan.nullable(),
  meter: z.enum(METERS).nullable(),
  units: Count.nullable(),
  many: z.boolean(),
  /** Whether this business may buy it now, and when not, why: 'included', 'needs_plan', 'already_has'. */
  available: z.boolean(),
  unavailable: z.enum(['included', 'needs_plan', 'already_has']).nullable(),
});
export const BillingCatalog = z.object({
  plans: z.array(CatalogPlan),
  addons: z.array(CatalogAddon),
  taxRateBp: z.number().int().min(0).max(10000),
  /** The offer a new paying account would get now, while places are left. */
  offer: BillingOffer.nullable(),
});

export const BillingChange = z.object({ plan: Plan, cycle: Cycle.optional(), requestKey: RequestKey });
export const BillingChangeResult = z.object({
  plan: BillingPlan,
  /** 'now' for an upgrade; 'period_end' for a downgrade or a cycle change that waits. */
  effective: z.enum(['now', 'period_end']),
  /** The provider's hosted page, when a payment or a payment method is needed first. */
  checkoutUrl: z.string().nullable(),
});
export const BillingItemAdd = z.object({ code: AddonCode, quantity: z.number().int().min(1, 'At least one').max(1000).default(1), requestKey: RequestKey });
export const BillingItemAdded = z.object({ item: BillingItem, checkoutUrl: z.string().nullable() });

export const UsageMeter = z.object({
  meter: z.enum(METERS),
  used: Count,
  included: Count.nullable(),
  packUnits: Count,
  allowance: Count.nullable(),
  left: Count.nullable(),
  percent: Count,
  over: z.boolean(),
});
export const BillingUsage = z.object({
  month: Day,
  resetsAt: Timestamp,
  meters: z.array(UsageMeter),
  /** Automated DMs waiting because the month's DMs are used up (held.dm_limit). */
  heldDms: Count,
  /** Whether a pack can be bought on this plan. */
  canBuyPacks: z.boolean(),
});

export const BhavaInvoiceLine = z.object({
  kind: z.string(),
  code: z.string(),
  description: z.string(),
  quantity: Count,
  unitPaise: Paise,
  grossPaise: Paise,
  discountPaise: Paise,
  taxablePaise: Paise,
  rateBp: z.number().int(),
  cgstPaise: Paise,
  sgstPaise: Paise,
  igstPaise: Paise,
});
export const BhavaInvoice = z.object({
  id: Id,
  docType: z.enum(['invoice', 'credit_note']),
  number: z.string(),
  issuedAt: Timestamp,
  periodStart: Day.nullable(),
  periodEnd: Day.nullable(),
  originalInvoiceId: Id.nullable(),
  taxablePaise: Paise,
  cgstPaise: Paise,
  sgstPaise: Paise,
  igstPaise: Paise,
  totalPaise: Paise,
  paid: z.boolean(),
  hasFile: z.boolean(),
  lines: z.array(BhavaInvoiceLine),
});
/** A private file, by a link that expires. */
export const BillingFile = z.object({ fileUrl: z.string(), fileName: z.string(), expiresAt: Timestamp });

/** A balance is never a negative amount: it says which way it is owed. The database keeps it signed, positive when owed to the business. */
export const StatementBalance = z.object({ amountPaise: Paise, owedTo: z.enum(['business', 'bhava']) });
export const SettlementStatement = z.object({
  id: Id,
  month: Day,
  openingBalance: StatementBalance,
  salesPaise: Paise,
  refundsPaise: Paise,
  gatewayFeesPaise: Paise,
  shippingPaise: Paise,
  /** Always 0: Bhava takes no share of sales. */
  commissionPaise: z.literal(0),
  payoutsPaise: Paise,
  closingBalance: StatementBalance,
  counts: z.object({ orders: Count, refunds: Count, shipments: Count }),
  payouts: z.array(z.object({ transferId: z.string(), amountPaise: Paise, at: Timestamp })),
  reconciliation: z.enum(['pending', 'matched', 'mismatch']),
  hasPdf: z.boolean(),
  hasCsv: z.boolean(),
  sentAt: Timestamp.nullable(),
});
export const StatementFileQuery = z.object({ format: z.enum(['pdf', 'csv']).default('pdf') });

export const PaymentMethodPage = z.object({ url: z.string(), expiresAt: Timestamp.nullable() });

/** What this business has, for the console and the owner app to hide what it has not. The server still checks every call. */
export const PlanFeatures = z.object({
  plan: Plan,
  features: z.record(z.string(), z.object({ on: z.boolean(), limit: Count.nullable() })),
});

export const SellerReferrals = z.object({
  code: z.string(),
  /** The link to share, on the sign-up page. Never put inside a DM. */
  link: z.string(),
  rewardPaise: Paise,
  counts: z.object(Object.fromEntries(REFERRAL_STATES.map((state) => [state, Count]))),
  creditedPaise: Paise,
});

// ---- Sign-up ----

const SignupStep = z.enum(SIGNUP_STEPS);
export const SignupStart = z.object({
  accountType: z.enum(ACCOUNT_TYPES),
  name: required(120, 'Enter a name'),
  inviteCode: text(80).default(''),
  referralCode: text(40).default(''),
  /** The run this page opened with, from signup.status; a new run starts without one. */
  runToken: text(120).default(''),
});
export const SignupStarted = z.object({ tenantId: Id, slug: z.string(), host: z.string(), runToken: z.string(), next: SignupStep });
export const SignupStatus = z.object({
  mode: z.enum(SIGNUP_MODES),
  signedIn: z.boolean(),
  /** Whether this person may start: false when sign-up is closed, or by invite and no valid code was given. */
  open: z.boolean(),
  runToken: z.string(),
  tenantId: Id.nullable(),
  accountType: z.enum(ACCOUNT_TYPES).nullable(),
  steps: z.array(z.object({ step: SignupStep, at: Timestamp })),
  next: SignupStep.nullable(),
});
export const SignupStatusQuery = z.object({ runToken: text(120).optional(), inviteCode: text(80).optional(), ref: text(40).optional() });
export const SignupFirstAutomation = z.object({
  runToken: required(120),
  mediaId: z.string().regex(/^\d{1,40}$/, 'Pick a reel'),
  keyword: required(40, 'Enter a keyword'),
  link: required(1000, 'Enter the link to send'),
});
export const SignupAutomationResult = z.object({
  automationId: Id.nullable(),
  live: z.boolean(),
  /** Why it is not live yet, by field: the link rules of 4.11 and the template rules of 4.10. */
  problems: z.array(z.object({ field: z.string(), reason: z.string(), message: z.string() })),
});
export const SignupFinish = z.object({ runToken: required(120) });
export const SignupFinished = z.object({ tenantId: Id, host: z.string(), elapsedMs: Count, withinTarget: z.boolean() });

export const billingRoutes = {
  'billing.plan': { method: 'GET', path: '/billing', access: OWNER_ONLY, response: BillingPlan },
  'billing.catalog': { method: 'GET', path: '/billing/catalog', access: OWNER_ONLY, response: BillingCatalog },
  'billing.change': { method: 'POST', path: '/billing/change', access: OWNER_ONLY, fresh: true, body: BillingChange, response: BillingChangeResult },
  'billing.addItem': { method: 'POST', path: '/billing/items', access: OWNER_ONLY, fresh: true, body: BillingItemAdd, status: 201, response: BillingItemAdded },
  'billing.removeItem': { method: 'DELETE', path: '/billing/items/:id', access: OWNER_ONLY, fresh: true, params: IdParams, status: 204, response: null },
  'billing.usage': { method: 'GET', path: '/billing/usage', access: OWNER_ONLY, response: BillingUsage },
  'billing.invoices': { method: 'GET', path: '/billing/invoices', access: OWNER_ONLY, query: ListQuery, response: page(BhavaInvoice) },
  'billing.invoiceFile': { method: 'GET', path: '/billing/invoices/:id/file', access: OWNER_ONLY, params: IdParams, response: BillingFile },
  'billing.statements': { method: 'GET', path: '/billing/statements', access: OWNER_ONLY, query: ListQuery, response: page(SettlementStatement) },
  'billing.statementFile': { method: 'GET', path: '/billing/statements/:id/file', access: OWNER_ONLY, params: IdParams, query: StatementFileQuery, response: BillingFile },
  'billing.paymentMethod': { method: 'POST', path: '/billing/payment-method', access: OWNER_ONLY, fresh: true, response: PaymentMethodPage },
  'billing.features': { method: 'GET', path: '/billing/features', access: SIGNED_IN, response: PlanFeatures },
};

export const referralRoutes = {
  'referrals.get': { method: 'GET', path: '/referrals', access: OWNER_ONLY, response: SellerReferrals },
};

export const signupRoutes = {
  'signup.status': { method: 'GET', path: '/signup', access: PUBLIC, noBusiness: true, query: SignupStatusQuery, response: SignupStatus },
  'signup.start': { method: 'POST', path: '/signup', access: PUBLIC, noBusiness: true, body: SignupStart, status: 201, response: SignupStarted },
  'signup.firstAutomation': { method: 'POST', path: '/signup/first-automation', access: PUBLIC, noBusiness: true, body: SignupFirstAutomation, response: SignupAutomationResult },
  'signup.finish': { method: 'POST', path: '/signup/finish', access: PUBLIC, noBusiness: true, body: SignupFinish, response: SignupFinished },
};

/** Which module answers each Phase 7 route (test/p7/contract keeps this and the modules in step). */
export const BILLING_ROUTE_OWNERS = Object.freeze({
  billing: Object.freeze(['billing.plan', 'billing.catalog', 'billing.change', 'billing.addItem', 'billing.removeItem', 'billing.invoices', 'billing.invoiceFile', 'billing.statements', 'billing.statementFile', 'billing.paymentMethod']),
  usage: Object.freeze(['billing.usage']),
  entitlements: Object.freeze(['billing.features']),
  referrals: Object.freeze(['referrals.get']),
  signup: Object.freeze(['signup.status', 'signup.start', 'signup.firstAutomation', 'signup.finish']),
});
