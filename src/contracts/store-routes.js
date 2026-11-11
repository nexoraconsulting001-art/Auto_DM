import { z } from 'zod';
import { PINCODE_MESSAGE, STORE_LIMITS } from './orders.js';

/**
 * The buyer's store in Phase 4 (PRD 9.1 to 9.5, 9.17 to 9.22), on each business's own host: every page and every JSON call,
 * with the module that owns it. Pages render with the shared buyer layout (src/views/buyer) in the seller's brand only: no
 * platform name in any page, title, meta tag, header, manifest, email or message. The single exception is `sharedConsent`,
 * the shared-profile consent screen (9.22, S-101).
 *
 * Mount each in the owner module's routes(app, ctx). The storefront's browsing pages go in its lastRoutes(app, ctx), after
 * every other module, ending with the store's own 404. Paths the Phase 0 store answered are marked `replaces`: the owner
 * removes that path from its module's legacy.js when its own page is ready.
 *
 * JSON calls live under /api/store and answer errors as { error, code, fields? } with the codes of src/contracts/api/errors.js.
 * They take a shopper session cookie (SHOPPER_COOKIE) or none, never a seller session, and a POST from a cookie session
 * needs the CSRF token like every other.
 *
 * Money: no call takes a price, a total, a discount or a shipping fee. A cart line is a product, a variant and a
 * quantity; a checkout is lines, an address, a way of paying and optional codes. The server prices everything from the
 * database, inside the order's transaction, and answers with what it worked out (S-05).
 *
 *   id                method  path                                 owner           replaces (Phase 0)
 */
const page = (method, path, owner, extra = {}) => Object.freeze({ method, path, owner, kind: 'page', ...extra });
const call = (method, path, owner, extra = {}) => Object.freeze({ method, path, owner, kind: 'json', ...extra });

export const STORE_ROUTES = Object.freeze({
  // 9.1 storefront
  home: page('GET', '/', 'storefront', { replaces: true }),
  shop: page('GET', '/shop', 'storefront', { replaces: true }),
  product: page('GET', '/p/:productSlug', 'storefront', { replaces: true }),
  search: page('GET', '/search', 'storefront'),
  about: page('GET', '/about', 'storefront', { replaces: true }),
  /** Per business domain, so two stores on one phone stay separate (S-67). Name, icon and colours from the brand kit. */
  manifest: call('GET', '/manifest.webmanifest', 'storefront'),
  serviceWorker: call('GET', '/sw.js', 'storefront'),
  offline: page('GET', '/offline', 'storefront'),
  /** Names, prices and photos again when a bag moves browsers; inactive items come back flagged (9.2). */
  productsLookup: call('GET', '/api/store/products', 'storefront', { replaces: '/api/products' }),

  // 9.2 cart
  cartPage: page('GET', '/cart', 'cart'),
  cartGet: call('GET', '/api/store/cart', 'cart'),
  /** The browser's bag, mirrored to the server once signed in. Lines merge, 10 per line, 50 lines (S-04). */
  cartPut: call('PUT', '/api/store/cart', 'cart'),
  /** A cart reminder's link: restores the cart and counts the click (9.15). */
  cartRestore: page('GET', '/cart/restore/:token', 'abandoned-cart'),

  // 9.3 shopper sign-in, 9.17 account, 9.22 shared sign-in
  signIn: page('GET', '/login', 'shoppers', { replaces: true }),
  otpSend: call('POST', '/api/store/otp/send', 'shoppers'),
  otpVerify: call('POST', '/api/store/otp/verify', 'shoppers'),
  googleStart: page('GET', '/auth/google', 'shoppers'),
  googleCallback: page('GET', '/auth/google/callback', 'shoppers'),
  signOut: call('POST', '/logout', 'shoppers', { replaces: true }),
  account: page('GET', '/account', 'shoppers', { replaces: true }),
  accountOrders: page('GET', '/account/orders', 'shoppers'),
  accountOrder: page('GET', '/account/orders/:orderNumber', 'shoppers'),
  /** Before shipment only (S-56). */
  accountOrderCancel: call('POST', '/api/store/orders/:orderNumber/cancel', 'orders'),
  addresses: call('GET', '/api/store/addresses', 'shoppers'),
  addressCreate: call('POST', '/api/store/addresses', 'shoppers'),
  addressUpdate: call('PUT', '/api/store/addresses/:id', 'shoppers'),
  addressRemove: call('DELETE', '/api/store/addresses/:id', 'shoppers'),
  /** The one buyer page that may name the platform: the shared-profile consent screen (9.22, S-97, S-101). */
  sharedConsent: page('GET', '/account/shared-profile', 'shoppers', { platformNamed: true }),
  sharedConsentSave: call('POST', '/api/store/shared-profile', 'shoppers'),
  sharedConsentRevoke: call('DELETE', '/api/store/shared-profile', 'shoppers'),

  // 9.5 checkout, 9.6 payment pages
  checkout: page('GET', '/checkout', 'checkout', { replaces: true }),
  /** Lines, address, way of paying and codes in; every amount out. Changes nothing. */
  checkoutQuote: call('POST', '/api/store/checkout/quote', 'checkout'),
  /** Places the order. The idempotency key makes a second tap the same order (S-15). */
  checkoutPlace: call('POST', '/api/store/checkout', 'checkout', { replaces: '/api/orders' }),
  /** The gateway's checkout came back: the signature is checked on the server before anything is marked paid (S-19, S-20). */
  paymentReturn: call('POST', '/api/store/payments/return', 'payments'),
  /** The order's own page by its unguessable token: pay, retry, success, pending and failure are all states of it (S-71, S-74). */
  order: page('GET', '/order/:token', 'checkout', { replaces: true }),
  orderRetry: call('POST', '/api/store/orders/:token/retry', 'payments'),
  invoiceFile: page('GET', '/order/:token/invoice/:number', 'invoices'),

  // 9.10 tracking
  /** The seller's own tracking page; a message's tracking link points here, never at the courier (S-78). */
  tracking: page('GET', '/track/:token', 'shipping'),
  serviceability: call('GET', '/api/store/serviceability', 'shipping'),

  // 9.14 coupons, 9.21 loyalty
  couponCheck: call('POST', '/api/store/coupons/check', 'coupons'),
  points: page('GET', '/account/points', 'loyalty'),
  referralLanding: page('GET', '/refer/:code', 'loyalty'),

  // 9.17 returns
  returnStart: page('GET', '/account/orders/:orderNumber/return', 'returns'),
  /** Multipart: at least one photo or short video, or it is refused (S-80). */
  returnCreate: call('POST', '/api/store/orders/:orderNumber/returns', 'returns'),

  // 9.18 consent and policy pages
  policy: page('GET', '/policies/:kind', 'consent'),
  consentGet: call('GET', '/api/store/consent', 'consent'),
  consentSave: call('POST', '/api/store/consent', 'consent'),
  /** One tap from a message, no sign-in: taking consent back is as easy as giving it. */
  unsubscribe: page('GET', '/unsubscribe/:token', 'consent'),
  dataRequest: call('POST', '/api/store/data-requests', 'consent'),

  // 9.19 reviews, 9.20 wishlist
  reviewCreate: call('POST', '/api/store/reviews', 'reviews'),
  reviewList: call('GET', '/api/store/products/:id/reviews', 'reviews'),
  wishlistPage: page('GET', '/wishlist', 'wishlist'),
  wishlistGet: call('GET', '/api/store/wishlist', 'wishlist'),
  /** Add, remove, or merge the browser's saved items after sign-in (S-84). */
  wishlistPut: call('PUT', '/api/store/wishlist', 'wishlist'),
});

/**
 * What providers call, before any business is known. Mount in beforeTenant. Every one verifies its signature on the raw body
 * before parsing, stores the event in provider_webhook_events before answering 2xx, and does its work from the queue (9.7).
 * A bad signature is 401 and nothing is stored (S-25, S-38). Sellers never set up a webhook themselves.
 */
export const STORE_PROVIDER_PATHS = Object.freeze({
  /** Bhava's own Razorpay account: one address for every business in managed mode, routed by linked account and gateway order (9.7). */
  razorpayManaged: Object.freeze({ method: 'POST', path: '/webhooks/razorpay', owner: 'payments' }),
  /** A business's own gateway: the key in the address names the business (payment_settings.webhook_key), and its secret verifies it. */
  razorpayOwn: Object.freeze({ method: 'POST', path: '/webhooks/razorpay/:key', owner: 'payments' }),
  cashfreeOwn: Object.freeze({ method: 'POST', path: '/webhooks/cashfree/:key', owner: 'payments' }),
  /** Partner OAuth comes back here with the business in `state`. */
  razorpayOauth: Object.freeze({ method: 'GET', path: '/oauth/razorpay/callback', owner: 'payments' }),
  /** Tracking. The courier refuses a webhook address with its own name in it, so this one has none. */
  courier: Object.freeze({ method: 'POST', path: '/webhooks/courier', owner: 'shipping' }),
  shopify: Object.freeze({ method: 'POST', path: '/webhooks/shopify', owner: 'shopify-sync' }),
  /** WhatsApp delivery reports and STOP replies. */
  whatsapp: Object.freeze({ method: 'POST', path: '/webhooks/whatsapp', owner: 'order-alerts' }),
  whatsappVerify: Object.freeze({ method: 'GET', path: '/webhooks/whatsapp', owner: 'order-alerts' }),
});

/** Header names each provider signs with. */
export const SIGNATURE_HEADERS = Object.freeze({
  razorpay: 'x-razorpay-signature',
  razorpayEventId: 'x-razorpay-event-id',
  cashfree: 'x-webhook-signature',
  cashfreeTimestamp: 'x-webhook-timestamp',
  courier: 'x-api-key',
  shopify: 'x-shopify-hmac-sha256',
  shopifyWebhookId: 'x-shopify-webhook-id',
  shopifyShop: 'x-shopify-shop-domain',
  shopifyTopic: 'x-shopify-topic',
  whatsapp: 'x-hub-signature-256',
});

/** The shopper's session cookie, on the seller's own domain. Separate from the seller session, so neither can act as the other. */
export const SHOPPER_COOKIE = '_sid';

// ---- bodies of the JSON calls ----
const id = z.number().int().positive().max(2147483647);
const Pincode = z.string().regex(/^[1-9][0-9]{5}$/, PINCODE_MESSAGE);
const Phone = z.string().trim().min(8).max(20);
const NO_NUL = /^[^\0]*$/;
const line = (max) => z.string().trim().max(max).regex(NO_NUL);

/** A line of a bag. There is no price field, and an unknown field is refused rather than ignored. */
export const CartLine = z.strictObject({ productId: id, variantId: id.nullable().default(null), qty: z.number().int().min(1).max(1000) });
export const CartPut = z.strictObject({ lines: z.array(CartLine).max(200) });
/** What the server answers for a cart or a quote: its own prices, with what changed since the bag was filled. */
export const PricedLine = z.object({
  productId: id,
  variantId: id.nullable(),
  name: z.string(),
  option: z.string(),
  image: z.string(),
  qty: z.number().int(),
  unitPaise: z.number().int(),
  linePaise: z.number().int(),
  /** ok, or why it can't be bought: inactive, sold_out, capped (qty was cut to what is allowed or left). */
  state: z.enum(['ok', 'inactive', 'sold_out', 'capped']),
});

export const AddressInput = z.strictObject({
  name: line(80).min(2, 'Enter your full name'),
  phone: Phone,
  line1: line(200).min(3, 'Enter your address'),
  line2: line(200).default(''),
  landmark: line(120).default(''),
  city: line(60).min(1, 'Enter your city'),
  stateCode: z.string().regex(/^[0-9]{2}$/, 'Pick your state'),
  pincode: Pincode,
  kind: z.enum(['home', 'work', 'other']).default('home'),
  isDefault: z.boolean().default(false),
});

export const OtpSend = z.strictObject({ phone: Phone, purpose: z.enum(['sign_in', 'cod']), checkoutKey: z.string().max(80).optional() });
export const OtpVerify = z.strictObject({ phone: Phone, purpose: z.enum(['sign_in', 'cod']), code: z.string().regex(new RegExp(`^[0-9]{${STORE_LIMITS.otp.digits}}$`), 'Enter the 6-digit code'), checkoutKey: z.string().max(80).optional() });

/** What a shopper agrees to at checkout or sign-in (9.18). Fulfilment is needed to take the order; the rest are separate choices, off unless ticked. */
export const ConsentChoices = z.strictObject({
  noticeVersion: z.number().int().min(1),
  orderUpdates: z.strictObject({ whatsapp: z.boolean().default(false), email: z.boolean().default(false) }).default({ whatsapp: false, email: false }),
  marketing: z.strictObject({ whatsapp: z.boolean().default(false), email: z.boolean().default(false) }).default({ whatsapp: false, email: false }),
  analyticsAds: z.boolean().optional(),
});

const checkoutFields = {
  lines: z.array(CartLine).min(1, 'Your bag is empty').max(STORE_LIMITS.maxCartLines),
  /** A saved address by id, or a new one typed in. */
  addressId: id.optional(),
  address: AddressInput.optional(),
  email: z.union([z.literal(''), z.email('Enter a valid email')]).default(''),
  paymentMode: z.enum(['prepaid', 'cod', 'part_advance']),
  couponCode: z.string().trim().max(40).default(''),
  /** Points to use; the server caps it at what is allowed and says so (S-88). */
  redeemPoints: z.number().int().min(0).max(100000000).default(0),
  referralCode: z.string().trim().max(12).default(''),
};
export const CheckoutQuote = z.strictObject({ ...checkoutFields, paymentMode: checkoutFields.paymentMode.optional() });
export const CheckoutPlace = z.strictObject({
  ...checkoutFields,
  /** Made by the page once per attempt, and sent again on a retry. */
  idempotencyKey: z.string().min(8).max(80).regex(/^[\w-]+$/),
  /** The tenant's terms, refund and shipping pages, accepted before paying (9.5). */
  acceptTerms: z.literal(true, 'Please accept the terms to place your order'),
  consent: ConsentChoices,
  /** Save these details to the account, and across stores only if the shared-profile box was ticked (9.22: unticked by default). */
  saveDetails: z.boolean().default(false),
  /** Where the visit came from, as the page saw it: the server checks each against its own records before trusting any (9.5). */
  pageSlug: z.string().max(120).optional(),
  utm: z.record(z.string().max(40), z.string().max(200)).optional(),
});
/** Every amount, worked out by the server. `notices` are plain sentences for the shopper: a capped line, points cut to the cap, why COD is hidden (S-22). */
export const Quote = z.object({
  lines: z.array(PricedLine),
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  loyaltyPaise: z.number().int(),
  shippingPaise: z.number().int(),
  codFeePaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
  advancePaise: z.number().int(),
  balancePaise: z.number().int(),
  paymentModes: z.array(z.object({ mode: z.enum(['prepaid', 'cod', 'part_advance']), available: z.boolean(), reason: z.string() })),
  serviceable: z.boolean(),
  coupon: z.object({ code: z.string(), applied: z.boolean(), message: z.string() }).nullable(),
  pointsUsed: z.number().int(),
  notices: z.array(z.string()),
});
/** `next` says what the page does now: open the gateway's checkout with `gateway`, or show the order page. No amount in `gateway` is the page's to change: the gateway order holds it. */
export const PlacedOrder = z.object({
  orderNumber: z.string(),
  token: z.string(),
  next: z.enum(['pay', 'done', 'verify_phone']),
  gateway: z.object({ provider: z.enum(['razorpay', 'cashfree']), keyId: z.string(), gatewayOrderId: z.string(), amountPaise: z.number().int(), display: z.object({ name: z.string(), image: z.string(), color: z.string() }) }).nullable(),
});
/** What the gateway's checkout hands the page. The server verifies the signature with the account's secret. */
export const PaymentReturn = z.strictObject({ orderToken: z.string().max(100), gatewayOrderId: z.string().max(80), gatewayPaymentId: z.string().max(80), signature: z.string().max(200) });

export const ReviewCreate = z.strictObject({ orderNumber: z.string().max(40), productId: id, rating: z.number().int().min(1).max(5), body: line(STORE_LIMITS.review.textChars).default('') });
export const WishlistPut = z.strictObject({ add: z.array(id).max(STORE_LIMITS.wishlistItems).default([]), remove: z.array(id).max(STORE_LIMITS.wishlistItems).default([]) });
export const ConsentSave = z.strictObject({ choices: ConsentChoices.partial().required({ noticeVersion: true }) });
