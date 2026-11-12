import { z } from 'zod';
import { PAYMENT_ATTEMPT_STATUSES, REFUND_STATUSES } from '../orders.js';
import { MANAGERS, OWNER_ONLY, staffWith } from './access.js';
import { Id, IdParams, ListQuery, Paise, PaiseInput, Timestamp, page, required, text } from './common.js';

/**
 * Payments, the settlement statement and refunds (PRD 9.6 to 9.8), answered by src/modules/payments and src/modules/refunds.
 * No route takes a card number, and none takes an order amount: the server works every total out from the database.
 * A refund's amount is the one amount a person types, and the server and the database both hold it inside what was captured (S-28).
 */
const reader = staffWith('orders');

export const PaymentOptions = z.object({
  upi: z.boolean(),
  card: z.boolean(),
  netbanking: z.boolean(),
  wallet: z.boolean(),
  cod: z.boolean(),
  partAdvance: z.boolean(),
  codFeePaise: Paise,
  codMaxOrderPaise: Paise.nullable(),
  /** PINs cash on delivery is offered to; empty means wherever the courier offers it. */
  codPincodes: z.array(z.string()),
  codBlockRtoCount: z.number().int().nullable(),
  advanceKind: z.enum(['fixed', 'percent']),
  /** Paise when fixed; hundredths of a percent when percent. */
  advanceValue: z.number().int().min(0),
  holdMinutes: z.number().int(),
  /** False until the gateway account can take money (managed: KYC verified; own: connected): only cash on delivery shows, if on. */
  onlineReady: z.boolean(),
});
export const PaymentOptionsUpdate = z.object({
  upi: z.boolean(),
  card: z.boolean(),
  netbanking: z.boolean(),
  wallet: z.boolean(),
  cod: z.boolean(),
  partAdvance: z.boolean(),
  codFeePaise: PaiseInput,
  codMaxOrderPaise: PaiseInput.nullable(),
  codPincodes: z.array(z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit PIN code')).max(20000),
  codBlockRtoCount: z.number().int().min(1).max(20).nullable(),
  advanceKind: z.enum(['fixed', 'percent']),
  advanceValue: z.number().int().min(0).max(2147483647),
  holdMinutes: z.number().int().min(5).max(1440),
}).partial();

/** How the business takes money: Bhava-managed (Route, split settlement) or its own gateway account. Ids are masked. */
export const PaymentAccount = z.object({
  mode: z.enum(['managed', 'own']),
  provider: z.enum(['razorpay', 'cashfree']),
  kycStatus: z.enum(['not_started', 'pending', 'verified', 'rejected']),
  linkedAccount: z.string(),
  ownConnection: z.enum(['none', 'oauth', 'keys']),
  ownAccount: z.string(),
  /** The address the seller gives its own gateway for webhooks (own mode only). Bhava receives them; the seller sets up nothing else. */
  webhookUrl: z.string().nullable(),
});
export const LinkedAccountStart = z.object({ legalName: required(200), contactName: required(80), email: z.email('Enter a valid email'), phone: required(16), businessType: z.enum(['individual', 'proprietorship', 'partnership', 'private_limited', 'llp', 'other']) });
export const PaymentModeUpdate = z.object({ mode: z.enum(['managed', 'own']) });
export const ConnectUrl = z.object({ url: z.string() });

export const Payment = z.object({
  id: Id,
  orderId: Id,
  purpose: z.enum(['full', 'advance', 'cod']),
  provider: z.enum(['razorpay', 'cashfree', 'cod']),
  mode: z.enum(['managed', 'own', 'cod']),
  status: z.enum(PAYMENT_ATTEMPT_STATUSES),
  method: z.string(),
  amountPaise: Paise,
  feePaise: Paise,
  feeTaxPaise: Paise,
  refundedPaise: Paise,
  transferStatus: z.enum(['none', 'created', 'processed', 'settled', 'failed', 'reversed']),
  transferPaise: Paise,
  reversedPaise: Paise,
  needsReview: z.boolean(),
  gatewayPaymentId: z.string().nullable(),
  createdAt: Timestamp,
  capturedAt: Timestamp.nullable(),
});

/** One line of the statement (9.6): each charge at cost, with no markup. A credit is owed to the seller, a debit is taken from it; one of the two is zero. */
export const SettlementLine = z.object({
  id: Id,
  orderId: Id,
  orderNumber: z.string(),
  kind: z.enum(['sale', 'gateway_fee', 'gateway_fee_tax', 'shipping_charge', 'refund', 'transfer', 'transfer_reversal', 'cod_remittance', 'adjustment']),
  creditPaise: Paise,
  debitPaise: Paise,
  status: z.enum(['ok', 'review']),
  at: Timestamp,
});
export const SettlementQuery = ListQuery.extend({ from: z.iso.date().optional(), to: z.iso.date().optional(), orderId: z.coerce.number().int().positive().optional() });
export const SettlementSummary = z.object({
  from: z.string(),
  to: z.string(),
  salesPaise: Paise,
  gatewayFeesPaise: Paise,
  shippingChargesPaise: Paise,
  refundsPaise: Paise,
  /** What the seller is paid for the period, or, when refunds and charges were more than sales, what is recovered from it. One of the two is zero. */
  payablePaise: Paise,
  recoverablePaise: Paise,
  inReview: z.number().int().min(0),
});

export const Refund = z.object({
  id: Id,
  orderId: Id,
  paymentId: Id,
  amountPaise: Paise,
  status: z.enum(REFUND_STATUSES),
  method: z.enum(['gateway', 'manual']),
  reference: z.string(),
  reason: z.string(),
  reversalStatus: z.enum(['none', 'pending', 'reversed', 'failed', 'recover']),
  reversalPaise: Paise,
  createdAt: Timestamp,
  processedAt: Timestamp.nullable(),
});
/**
 * Owner only, after a fresh re-auth: `password` is the owner's own, checked on this call (5.11). `idempotencyKey` makes a
 * repeated tap the same refund. A cash-on-delivery refund is 'manual' and needs the reference of how it was paid back.
 */
export const RefundCreate = z.object({
  amountPaise: PaiseInput.refine((n) => n > 0, 'Enter an amount to refund'),
  reason: text(300).default(''),
  paymentId: Id.optional(),
  reference: text(100).optional(),
  returnId: Id.optional(),
  idempotencyKey: z.string().min(8).max(80).regex(/^[\w-]+$/),
  password: z.string().min(1).max(200),
});

export const paymentRoutes = {
  'paymentSettings.get': { method: 'GET', path: '/payment-settings', access: MANAGERS, response: PaymentOptions },
  'paymentSettings.update': { method: 'PATCH', path: '/payment-settings', access: MANAGERS, body: PaymentOptionsUpdate, response: PaymentOptions },
  'paymentAccount.get': { method: 'GET', path: '/payment-account', access: MANAGERS, response: PaymentAccount },
  /** Managed mode: starts the Route linked account and its KYC. */
  'paymentAccount.startLinked': { feature: 'store.payments', method: 'POST', path: '/payment-account/linked', access: OWNER_ONLY, fresh: true, body: LinkedAccountStart, response: PaymentAccount },
  /** Own mode: where to send the owner to connect their own gateway account (Partner OAuth). Keys can instead be saved through repos.gatewayKeys (5.15). */
  'paymentAccount.connectUrl': { feature: 'store.payments', method: 'POST', path: '/payment-account/connect', access: OWNER_ONLY, fresh: true, response: ConnectUrl },
  /** Applies to new orders only: an order keeps the mode it was placed in (S-72). */
  'paymentAccount.setMode': { feature: 'store.payments', method: 'PUT', path: '/payment-account/mode', access: OWNER_ONLY, fresh: true, body: PaymentModeUpdate, response: PaymentAccount },
  'paymentAccount.disconnect': { method: 'DELETE', path: '/payment-account/own', access: OWNER_ONLY, fresh: true, status: 204, response: null },
  /** Not paged: an order has a handful. */
  'payments.forOrder': { method: 'GET', path: '/orders/:id/payments', access: reader, params: IdParams, response: z.object({ items: z.array(Payment) }) },
  'settlements.list': { method: 'GET', path: '/settlements', access: MANAGERS, query: SettlementQuery, response: page(SettlementLine) },
  'settlements.summary': { method: 'GET', path: '/settlements/summary', access: MANAGERS, query: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }), response: SettlementSummary },
};

export const refundRoutes = {
  'refunds.forOrder': { method: 'GET', path: '/orders/:id/refunds', access: reader, params: IdParams, response: z.object({ items: z.array(Refund) }) },
  /** A manager gets 403 (S-29). */
  'refunds.create': { method: 'POST', path: '/orders/:id/refunds', access: OWNER_ONLY, params: IdParams, body: RefundCreate, status: 201, response: Refund },
  'refunds.get': { method: 'GET', path: '/refunds/:id', access: reader, params: IdParams, response: Refund },
  /** Tries a failed refund again at the gateway. */
  'refunds.retry': { method: 'POST', path: '/refunds/:id/retry', access: OWNER_ONLY, params: IdParams, response: Refund },
};
