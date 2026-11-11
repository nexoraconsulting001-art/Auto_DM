import { z } from 'zod';
import { MANAGERS, OWNER_ONLY, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, PaiseInput, Quantity, Timestamp, page, required, text } from './common.js';

/**
 * The rest of the Phase 4 console (PRD 9.11, 9.14 to 9.22): coupons, reviews, saves, loyalty, shopper alerts, cart
 * reminders, Shopify sync, shoppers and privacy. Each group is answered by the module named beside it.
 * No path or id here contains "raw" or "export" (a seller takes data away as a download, and consent is "revoked").
 */
const orders = staffWith('orders');
const catalog = staffWith('catalog');
const customers = staffWith('customers');
const analytics = staffWith('analytics');

// ---- coupons (src/modules/coupons) ----
const CouponCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, 'Use 2 to 40 letters, digits, - or _');
export const Coupon = z.object({
  id: Id,
  code: z.string(),
  kind: z.enum(['percent', 'flat', 'free_shipping']),
  /** Hundredths of a percent: 10% is 1000. */
  percentBp: z.number().int().nullable(),
  amountPaise: Paise.nullable(),
  maxDiscountPaise: Paise.nullable(),
  minOrderPaise: Paise,
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  maxUses: z.number().int().nullable(),
  maxUsesPerCustomer: z.number().int().nullable(),
  usedCount: Count,
  firstOrderOnly: z.boolean(),
  scope: z.enum(['all', 'products', 'categories']),
  scopeIds: z.array(Id),
  /** The reel or post it was made for (7.4). */
  pageId: Id.nullable(),
  active: z.boolean(),
  createdAt: Timestamp,
});
const couponFields = {
  code: CouponCode,
  kind: z.enum(['percent', 'flat', 'free_shipping']),
  percentBp: z.number().int().min(1).max(10000).nullable(),
  amountPaise: PaiseInput.nullable(),
  maxDiscountPaise: PaiseInput.nullable(),
  minOrderPaise: PaiseInput,
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  maxUses: z.number().int().min(1).max(10000000).nullable(),
  maxUsesPerCustomer: z.number().int().min(1).max(1000).nullable(),
  firstOrderOnly: z.boolean(),
  scope: z.enum(['all', 'products', 'categories']),
  scopeIds: z.array(Id).max(500),
  pageId: Id.nullable(),
  active: z.boolean(),
};
export const CouponCreate = z.object(couponFields).partial().required({ code: true, kind: true });
/** The code and kind of a coupon that has been used can't change; the server refuses. */
export const CouponUpdate = z.object(couponFields).partial();
export const CouponStats = z.object({ couponId: Id, orders: Count, discountPaise: Paise, revenuePaise: Paise });

export const couponRoutes = {
  'coupons.list': { method: 'GET', path: '/coupons', access: MANAGERS, query: ListQuery.extend({ search: text(40).optional(), show: z.enum(['all', 'active', 'ended']).default('all') }), response: page(Coupon) },
  'coupons.create': { method: 'POST', path: '/coupons', access: MANAGERS, body: CouponCreate, status: 201, response: Coupon },
  'coupons.get': { method: 'GET', path: '/coupons/:id', access: MANAGERS, params: IdParams, response: Coupon },
  'coupons.update': { method: 'PATCH', path: '/coupons/:id', access: MANAGERS, params: IdParams, body: CouponUpdate, response: Coupon },
  'coupons.remove': { method: 'DELETE', path: '/coupons/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
  'coupons.stats': { method: 'GET', path: '/coupons/:id/stats', access: MANAGERS, params: IdParams, response: CouponStats },
};

// ---- reviews (src/modules/reviews) ----
export const Review = z.object({
  id: Id,
  productId: Id,
  productName: z.string(),
  orderId: Id,
  rating: z.number().int().min(1).max(5),
  /** The shopper's words: the seller can approve, hide and reply, never edit them. */
  body: z.string(),
  displayName: z.string(),
  photos: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'hidden']),
  reply: z.string(),
  repliedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export const ReviewReply = z.object({ reply: required(1000, 'Write a reply first') });

export const reviewRoutes = {
  'reviews.list': { method: 'GET', path: '/reviews', access: catalog, query: ListQuery.extend({ status: z.enum(['all', 'pending', 'approved', 'hidden']).default('all'), productId: z.coerce.number().int().positive().optional() }), response: page(Review) },
  'reviews.approve': { method: 'POST', path: '/reviews/:id/approve', access: catalog, params: IdParams, response: Review },
  'reviews.hide': { method: 'POST', path: '/reviews/:id/hide', access: catalog, params: IdParams, response: Review },
  /** One public reply per review. */
  'reviews.reply': { method: 'PUT', path: '/reviews/:id/reply', access: catalog, params: IdParams, body: ReviewReply, response: Review },
};

// ---- wishlist (src/modules/wishlist) ----
/** How many shoppers saved each product. Never who (S-86). */
export const SaveCount = z.object({ productId: Id, name: z.string(), saves: Count });
export const wishlistRoutes = {
  'wishlist.counts': { method: 'GET', path: '/wishlist/counts', access: analytics, query: ListQuery, response: page(SaveCount) },
};

// ---- loyalty and referrals (src/modules/loyalty); 403 without the `loyalty` feature (S-91) ----
export const LoyaltySettings = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  earnPoints: Count,
  earnPerPaise: Paise,
  pointValuePaise: Paise,
  maxRedeemPoints: Count,
  expiryDays: z.number().int().nullable(),
  referralEnabled: z.boolean(),
  friendRewardPaise: Paise,
  referrerPoints: Count,
});
export const LoyaltySettingsUpdate = z.object({
  enabled: z.boolean(),
  earnPoints: Quantity,
  earnPerPaise: PaiseInput.refine((n) => n > 0, 'Must be more than zero'),
  pointValuePaise: PaiseInput.refine((n) => n > 0, 'Must be more than zero'),
  maxRedeemPoints: Quantity,
  expiryDays: z.number().int().min(1).max(3650).nullable(),
  referralEnabled: z.boolean(),
  friendRewardPaise: PaiseInput,
  referrerPoints: Quantity,
}).partial();
export const LoyaltyMember = z.object({ shopperId: Id, name: z.string(), balance: Count, pending: Count, updatedAt: Timestamp });
export const LoyaltyEntry = z.object({ id: Id, kind: z.enum(['earn', 'redeem', 'reverse', 'restore', 'expire', 'referral', 'adjust']), points: z.number().int(), status: z.enum(['pending', 'posted', 'void']), orderId: Id.nullable(), availableAt: Timestamp.nullable(), expiresAt: Timestamp.nullable(), at: Timestamp });
export const LoyaltyAdjust = z.object({ points: z.number().int().min(-1000000).max(1000000).refine((n) => n !== 0, 'Enter points to add or take away'), note: required(200, 'Say why') });
export const Referral = z.object({ id: Id, referrerShopperId: Id, status: z.enum(['pending', 'rewarded', 'blocked', 'void']), blockReason: z.string(), orderId: Id.nullable(), createdAt: Timestamp });

export const loyaltyRoutes = {
  'loyaltySettings.get': { method: 'GET', path: '/loyalty/settings', access: MANAGERS, response: LoyaltySettings },
  'loyaltySettings.update': { method: 'PATCH', path: '/loyalty/settings', access: MANAGERS, body: LoyaltySettingsUpdate, response: LoyaltySettings },
  'loyalty.members': { method: 'GET', path: '/loyalty/members', access: customers, query: ListQuery, response: page(LoyaltyMember) },
  'loyalty.ledger': { method: 'GET', path: '/loyalty/members/:id/ledger', access: customers, params: IdParams, query: ListQuery, response: page(LoyaltyEntry) },
  'loyalty.adjust': { method: 'POST', path: '/loyalty/members/:id/adjust', access: OWNER_ONLY, params: IdParams, body: LoyaltyAdjust, response: LoyaltyMember },
  'loyalty.referrals': { method: 'GET', path: '/loyalty/referrals', access: customers, query: ListQuery, response: page(Referral) },
};

// ---- shopper alerts (src/modules/order-alerts): WhatsApp and email only, no SMS (S-96) ----
export const AlertSettings = z.object({
  channels: z.array(z.enum(['whatsapp', 'email'])),
  whatsapp: z.boolean(),
  email: z.boolean(),
  events: z.array(z.enum(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'])),
  emailFrom: z.enum(['own', 'neutral']),
  /** The address order emails come from: on the seller's domain, or the neutral sending domain. Never the platform's name. */
  emailFromAddress: z.string(),
  emailReplyTo: z.string(),
  /** What WhatsApp charges per message by category, at cost with no markup; null when not known. */
  whatsappCostPaise: z.object({ utility: Paise.nullable(), authentication: Paise.nullable(), marketing: Paise.nullable() }),
});
export const AlertSettingsUpdate = z.object({
  whatsapp: z.boolean(),
  email: z.boolean(),
  events: z.array(z.enum(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'])).max(6),
  emailFrom: z.enum(['own', 'neutral']),
  emailFromLocal: z.string().regex(/^[a-z0-9._-]{1,40}$/, 'Use letters, digits, dot, dash or underscore'),
  emailReplyTo: z.union([z.literal(''), z.email('Enter a valid email')]),
}).partial();
export const WhatsappAccount = z.object({ connected: z.boolean(), displayNumber: z.string(), status: z.enum(['none', 'active', 'reconnect', 'disabled']) });
export const WhatsappConnect = z.object({ wabaId: required(40), phoneNumberId: required(40), accessToken: z.string().min(1).max(1000), displayNumber: text(20).optional() });
export const WhatsappTemplate = z.object({ id: Id, purpose: z.string(), category: z.enum(['utility', 'authentication', 'marketing']), name: z.string(), language: z.string(), status: z.enum(['pending', 'approved', 'rejected', 'paused']), checkedAt: Timestamp.nullable() });
export const OrderAlert = z.object({
  id: Id,
  orderId: Id,
  orderNumber: z.string(),
  event: z.string(),
  channel: z.enum(['whatsapp', 'email']),
  status: z.enum(['queued', 'sent', 'delivered', 'failed', 'skipped']),
  /** 'template_pending' shows as "Template pending" (S-53). */
  skipReason: z.string(),
  attempts: Count,
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});

export const orderAlertRoutes = {
  'alertSettings.get': { method: 'GET', path: '/alert-settings', access: MANAGERS, response: AlertSettings },
  'alertSettings.update': { method: 'PATCH', path: '/alert-settings', access: MANAGERS, body: AlertSettingsUpdate, response: AlertSettings },
  'whatsappAccount.get': { method: 'GET', path: '/whatsapp-account', access: MANAGERS, response: WhatsappAccount },
  'whatsappAccount.connect': { method: 'PUT', path: '/whatsapp-account', access: OWNER_ONLY, body: WhatsappConnect, response: WhatsappAccount },
  'whatsappAccount.disconnect': { method: 'DELETE', path: '/whatsapp-account', access: OWNER_ONLY, status: 204, response: null },
  'whatsappTemplates.all': { method: 'GET', path: '/whatsapp-templates', access: MANAGERS, response: z.object({ items: z.array(WhatsappTemplate) }) },
  /** Reads each template's review status again from WhatsApp, and submits any that are missing. */
  'whatsappTemplates.sync': { method: 'POST', path: '/whatsapp-templates/sync', access: MANAGERS, response: z.object({ items: z.array(WhatsappTemplate) }) },
  'orderAlerts.list': { method: 'GET', path: '/order-alerts', access: orders, query: ListQuery.extend({ status: z.enum(['all', 'failed', 'skipped', 'sent']).default('all'), orderId: z.coerce.number().int().positive().optional() }), response: page(OrderAlert) },
  'orderAlerts.retry': { method: 'POST', path: '/order-alerts/:id/retry', access: orders, params: IdParams, response: OrderAlert },
};

// ---- cart reminders (src/modules/abandoned-cart) ----
export const CartReminderSettings = z.object({ enabled: z.boolean(), channels: z.array(z.enum(['whatsapp', 'email'])), templateStatus: z.enum(['none', 'pending', 'approved', 'rejected', 'paused']) });
export const CartReminderStats = z.object({ days: Count, sent: Count, clicked: Count, ordered: Count, revenuePaise: Paise });
export const cartReminderRoutes = {
  'cartReminders.get': { method: 'GET', path: '/cart-reminders', access: MANAGERS, response: CartReminderSettings },
  'cartReminders.update': { method: 'PATCH', path: '/cart-reminders', access: MANAGERS, body: z.object({ enabled: z.boolean() }), response: CartReminderSettings },
  'cartReminders.stats': { method: 'GET', path: '/cart-reminders/stats', access: analytics, query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), response: CartReminderStats },
};

// ---- Shopify sync (src/modules/shopify-sync) ----
export const ShopifyConnection = z.object({
  connected: z.boolean(),
  shopDomain: z.string(),
  mode: z.enum(['source', 'two_way']),
  status: z.enum(['none', 'active', 'reconnect', 'paused']),
  lastReconciledAt: Timestamp.nullable(),
  pendingOrders: Count,
  failedOrders: Count,
  /** The address Shopify's webhooks are sent to. Bhava receives them. */
  webhookUrl: z.string().nullable(),
});
/** Each business connects its own Shopify app: its Admin API token and the secret its webhooks are signed with. Both are stored encrypted and never returned. */
export const ShopifyConnect = z.object({
  shopDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/, 'Use your store’s myshopify.com address'),
  accessToken: z.string().min(1).max(500),
  webhookSecret: z.string().min(1).max(500),
  mode: z.enum(['source', 'two_way']).default('source'),
});
export const ShopifyConflict = z.object({ id: Id, kind: z.string(), localId: Id, shopifyId: z.string(), field: z.string(), localValue: z.string(), remoteValue: z.string(), winner: z.enum(['local', 'remote']), at: Timestamp });

export const shopifyRoutes = {
  'shopify.get': { method: 'GET', path: '/shopify', access: MANAGERS, response: ShopifyConnection },
  'shopify.connect': { method: 'PUT', path: '/shopify', access: OWNER_ONLY, body: ShopifyConnect, response: ShopifyConnection },
  'shopify.setMode': { method: 'PATCH', path: '/shopify', access: OWNER_ONLY, body: z.object({ mode: z.enum(['source', 'two_way']).optional(), paused: z.boolean().optional() }), response: ShopifyConnection },
  'shopify.disconnect': { method: 'DELETE', path: '/shopify', access: OWNER_ONLY, status: 204, response: null },
  /** Runs the reconcile now, in the background. */
  'shopify.reconcile': { method: 'POST', path: '/shopify/reconcile', access: MANAGERS, status: 202, response: ShopifyConnection },
  'shopify.conflicts': { method: 'GET', path: '/shopify/conflicts', access: MANAGERS, query: ListQuery, response: page(ShopifyConflict) },
};

// ---- shoppers (src/modules/shoppers): this business's own customers only (9.17, 9.22) ----
export const Shopper = z.object({
  /** A shopper's id, or null for a guest known only by their orders. */
  id: Id.nullable(),
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  signedIn: z.boolean(),
  orders: Count,
  spentPaise: Paise,
  lastOrderAt: Timestamp.nullable(),
  /** Per channel: has this shopper said yes to marketing here. A yes at another store never shows or counts (S-104). */
  marketing: z.object({ whatsapp: z.boolean(), email: z.boolean() }),
});
export const ShopperDownload = z.object({ id: Id, format: z.enum(['csv', 'xlsx']), status: z.enum(['queued', 'ready', 'failed', 'expired']), rowCount: Count, fileUrl: z.string().nullable(), createdAt: Timestamp, expiresAt: Timestamp.nullable() });

export const shopperRoutes = {
  'shoppers.list': { method: 'GET', path: '/shoppers', access: customers, query: ListQuery.extend({ search: text(80).optional() }), response: page(Shopper) },
  'shoppers.get': { method: 'GET', path: '/shoppers/:id', access: customers, params: IdParams, response: Shopper },
  /** Only the owner takes the customer list away (9.17), and every download is in the audit log. */
  'shopperDownloads.list': { method: 'GET', path: '/shopper-downloads', access: OWNER_ONLY, query: ListQuery, response: page(ShopperDownload) },
  'shopperDownloads.create': { method: 'POST', path: '/shopper-downloads', access: OWNER_ONLY, body: z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx') }), status: 201, response: ShopperDownload },
  'shopperDownloads.get': { method: 'GET', path: '/shopper-downloads/:id', access: OWNER_ONLY, params: IdParams, response: ShopperDownload },
};

// ---- privacy (src/modules/consent): 9.18 ----
export const POLICY_KINDS = Object.freeze(['privacy', 'terms', 'refund', 'shipping']);
export const PrivacySettings = z.object({ grievanceName: z.string(), grievanceEmail: z.string(), grievancePhone: z.string(), grievanceAddress: z.string() });
export const PrivacySettingsUpdate = z.object({ grievanceName: text(120), grievanceEmail: z.union([z.literal(''), z.email('Enter a valid email')]), grievancePhone: text(20), grievanceAddress: text(400) }).partial();
export const PolicyPage = z.object({ kind: z.enum(POLICY_KINDS), body: z.string(), url: z.string(), updatedAt: Timestamp.nullable() });
export const PolicyPageUpdate = z.object({ kind: z.enum(POLICY_KINDS), body: text(40000) });
/** The notice shoppers see at sign-in and checkout, in English and Hindi, naming the business. Publishing makes a new version; old ones stay. */
export const ConsentNotice = z.object({ version: z.number().int().min(0), bodyEn: z.string(), bodyHi: z.string(), createdAt: Timestamp.nullable() });
export const ConsentNoticePublish = z.object({ bodyEn: required(4000), bodyHi: required(4000) });
export const DataRequest = z.object({
  id: Id,
  shopperId: Id.nullable(),
  kind: z.enum(['erasure', 'access']),
  status: z.enum(['requested', 'processing', 'completed', 'rejected']),
  source: z.enum(['account', 'seller', 'grievance']),
  /** Counts of what was erased or masked. Numbers only. */
  summary: z.record(z.string(), z.number()),
  requestedAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export const DataRequestCreate = z.object({ shopperId: Id, kind: z.enum(['erasure', 'access']) });

export const privacyRoutes = {
  'privacy.get': { method: 'GET', path: '/privacy', access: MANAGERS, response: PrivacySettings },
  'privacy.update': { method: 'PATCH', path: '/privacy', access: MANAGERS, body: PrivacySettingsUpdate, response: PrivacySettings },
  'policies.all': { method: 'GET', path: '/policies', access: MANAGERS, response: z.object({ items: z.array(PolicyPage) }) },
  'policies.save': { method: 'PUT', path: '/policies', access: MANAGERS, body: PolicyPageUpdate, response: PolicyPage },
  'consentNotice.get': { method: 'GET', path: '/consent-notice', access: MANAGERS, response: ConsentNotice },
  'consentNotice.publish': { method: 'POST', path: '/consent-notice', access: OWNER_ONLY, body: ConsentNoticePublish, status: 201, response: ConsentNotice },
  'dataRequests.list': { method: 'GET', path: '/data-requests', access: customers, query: ListQuery.extend({ status: z.enum(['all', 'open', 'completed']).default('all') }), response: page(DataRequest) },
  /** The seller acting on a request a shopper made some other way. Erasure masks tax records and removes the rest (S-63). */
  'dataRequests.create': { method: 'POST', path: '/data-requests', access: OWNER_ONLY, body: DataRequestCreate, status: 201, response: DataRequest },
  'dataRequests.get': { method: 'GET', path: '/data-requests/:id', access: customers, params: IdParams, response: DataRequest },
};
