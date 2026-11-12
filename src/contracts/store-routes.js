import { z } from 'zod';
import { APP_PLATFORMS, DEVICE_ID, PKCE_VERIFIER } from './accounts.js';
import { BUYER_BLOCKS } from './buyer-pages.js';
import { PUSH_TOKEN } from './notifications.js';
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

// ---- the branded shopper app (Phase 6, PRD 10.7, 10.9 to 10.14) ----

/**
 * APP_ROUTES: what the seller's own shopper app calls, on the business's own host, beside the store's STORE_ROUTES. Each row is
 * { method, path, owner, kind, auth, body?, query?, response? }. kind is json, page (a browser route) or wellknown (the two
 * verified-link files). auth: none (no token needed), app (any app session, a guest one included), shopper (signed in), web (a
 * browser, not gated).
 *
 * Every app request carries X-App: shopper, X-App-Tenant (the business id written into the build), X-App-Version and
 * X-App-Platform, and Authorization: Shopper <access token> (SHOPPER_APP_HEADERS and SHOPPER_AUTH_SCHEME in src/contracts/apps.js).
 * The business comes from the host. A build-time id that does not match it is a 404 with nothing in the body; below the
 * business's minimum version the answer is 426 with the store link. The gate is src/modules/app-api/gate.js.
 *
 * Errors are { error, code, fields? } with the codes of src/contracts/api/errors.js. Every answer is Cache-Control: no-store
 * except the two well-known files. Everything a shopper sees is the seller's brand: no platform name in any answer, error,
 * header, push or host. No route takes a price, a total, a discount or a channel: the server works out every amount and sets
 * the order's channel from the session.
 *
 * Phase 4 JSON the app calls unchanged, with its app session: productsLookup, cartGet, cartPut, otpSend, otpVerify (purpose cod
 * only), addresses, addressCreate, addressUpdate, addressRemove, sharedConsentSave, sharedConsentRevoke, checkoutQuote,
 * checkoutPlace, paymentReturn, orderRetry, accountOrderCancel, serviceability, couponCheck, returnCreate, consentGet,
 * consentSave, dataRequest (kind access), reviewCreate, reviewList, wishlistGet, wishlistPut. Payment uses the hosted page
 * GET /order/:token in a browser tab.
 */
const DEVICE = z.string().regex(DEVICE_ID, 'Unknown device');
const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/, 'Unknown address');
const Cursor = z.string().max(512).regex(/^[\w-]+$/, 'Invalid cursor');
const pageOf = (item) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
const Limit = z.coerce.number().int().min(1).max(48).default(24);
const When = z.union([z.date().transform((d) => d.toISOString()), z.string()]);
/** The catalog's sorts, as SORTS in src/modules/storefront/catalog.js names them (a test keeps the two equal). */
export const APP_SORTS = Object.freeze(['popular', 'newest', 'price-asc', 'price-desc', 'discount']);
export const POLICY_KINDS = Object.freeze(['privacy', 'terms', 'refund', 'shipping']);
const HOME_BLOCKS = Object.keys(BUYER_BLOCKS).filter((key) => BUYER_BLOCKS[key].surfaces.includes('store_home'));

export const AppDevice = z.strictObject({ id: DEVICE, name: line(80).default('') });
export const AppSessionStart = z.discriminatedUnion('grant', [
  z.strictObject({ grant: z.literal('guest'), device: AppDevice }),
  z.strictObject({ grant: z.literal('otp'), device: AppDevice, phone: Phone, code: z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code') }),
  z.strictObject({ grant: z.literal('handoff'), device: AppDevice, code: z.string().min(1).max(200), codeVerifier: z.string().regex(PKCE_VERIFIER) }),
]);
export const AppRefresh = z.strictObject({ refreshToken: z.string().min(1).max(200) });
export const AppleSignInBody = z.strictObject({ identityToken: z.string().min(1).max(5000), nonce: z.string().min(1).max(200), name: line(80).optional(), device: AppDevice });
export const AppDeleteBody = z.strictObject({ confirm: z.literal(true, 'Confirm to delete your account') });
export const AppShopper = z.object({ id, name: z.string(), phoneMasked: z.string(), email: z.string(), phoneVerified: z.boolean(), hasGoogle: z.boolean(), hasApple: z.boolean() });
export const AppSession = z.object({ accessToken: z.string(), accessExpiresInSeconds: z.number().int(), refreshToken: z.string(), guest: z.boolean(), shopper: AppShopper.nullable() });
export const AppRefreshed = z.object({ accessToken: z.string(), accessExpiresInSeconds: z.number().int(), refreshToken: z.string() });
export const AppBootstrap = z.object({
  name: z.string(),
  minVersion: z.string(),
  storeUrl: z.string(),
  /** apple only on ios with a bundle id set. */
  signIn: z.object({ whatsapp: z.boolean(), google: z.boolean(), apple: z.boolean() }),
  features: z.object({ coupons: z.boolean(), loyalty: z.boolean(), reviews: z.boolean(), wishlist: z.boolean(), returns: z.boolean(), cod: z.boolean() }),
  /** app_configs over the brand kit. */
  theme: z.object({ colors: z.record(z.string(), z.string()), headingFont: z.string(), bodyFont: z.string(), logoUrl: z.string() }),
  links: z.object({ privacy: z.string(), terms: z.string(), refund: z.string(), shipping: z.string() }),
  supportEmail: z.string(),
  /** Whether the brand's own push credentials are set. */
  push: z.object({ android: z.boolean(), ios: z.boolean() }),
  noticeVersion: z.number().int().nullable(),
});
export const AppMe = z.object({ shopper: AppShopper.nullable(), sharedProfile: z.object({ available: z.boolean(), linked: z.boolean(), consented: z.boolean() }) });
export const AppDeletion = z.object({ status: z.enum(['completed', 'waiting']), signedOut: z.boolean(), message: z.string() });
export const AppProductCard = z.object({
  id, slug: z.string(), name: z.string(), pricePaise: z.number().int(), comparePaise: z.number().int().nullable(), image: z.string(), inStock: z.boolean(),
  rating: z.number().nullable(), ratingCount: z.number().int(),
});
export const AppReelCard = z.object({ slug: z.string(), title: z.string(), image: z.string(), videoUrl: z.string().nullable(), pinned: z.boolean(), productCount: z.number().int() });
export const AppCategoryCard = z.object({ slug: z.string(), name: z.string(), image: z.string() });
export const AppHome = z.object({
  blocks: z.array(z.object({ type: z.enum(HOME_BLOCKS), settings: z.record(z.string(), z.unknown()) })),
  categories: z.array(AppCategoryCard),
  reels: z.array(AppReelCard).max(12),
  products: z.array(AppProductCard).max(12),
});
export const AppCatalogQuery = z.strictObject({ q: z.string().max(80).regex(NO_NUL).optional(), category: SLUG.optional(), sort: z.enum(APP_SORTS).optional(), cursor: Cursor.optional(), limit: Limit });
export const AppPageQuery = z.strictObject({ cursor: Cursor.optional(), limit: Limit });
export const AppReelsQuery = z.strictObject({ category: SLUG.optional(), cursor: Cursor.optional(), limit: Limit });
export const AppProduct = AppProductCard.extend({
  description: z.string(),
  images: z.array(z.string()),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(z.object({ id, option: z.string(), pricePaise: z.number().int(), inStock: z.boolean(), image: z.string() })),
  maxQty: z.number().int(),
  reels: z.array(AppReelCard),
});
export const AppCategory = z.object({ category: AppCategoryCard, reels: z.array(AppReelCard), products: pageOf(AppProductCard) });
export const AppReels = z.object({ chips: z.array(AppCategoryCard), items: z.array(AppReelCard), nextCursor: z.string().nullable() });
/** A landing page read by slug only: nothing is recorded (no visit, tap or click: P-51). */
export const AppLanding = z.object({
  slug: z.string(),
  title: z.string(),
  media: z.object({ kind: z.enum(['video', 'image']), url: z.string(), poster: z.string() }),
  products: z.array(AppProductCard),
  moreReels: z.array(AppReelCard),
});
export const AppOrderSummary = z.object({
  orderNumber: z.string(), token: z.string(), placedAt: When, fulfilmentStatus: z.string(), paymentStatus: z.string(),
  totalPaise: z.number().int(), itemCount: z.number().int(), image: z.string(),
});
export const AppOrder = AppOrderSummary.extend({
  paymentMode: z.string(),
  lines: z.array(z.object({ name: z.string(), option: z.string(), qty: z.number().int(), unitPaise: z.number().int(), linePaise: z.number().int(), image: z.string(), productSlug: z.string() })),
  totals: z.object({
    subtotalPaise: z.number().int(), discountPaise: z.number().int(), loyaltyPaise: z.number().int(), shippingPaise: z.number().int(), codFeePaise: z.number().int(),
    taxPaise: z.number().int(), totalPaise: z.number().int(), advancePaise: z.number().int(), balancePaise: z.number().int(),
  }),
  address: z.object({ name: z.string(), line1: z.string(), line2: z.string(), city: z.string(), state: z.string(), pincode: z.string() }),
  timeline: z.array(z.object({ status: z.string(), at: When })),
  shipments: z.array(z.object({
    courier: z.string(), awb: z.string(), status: z.string(), expectedAt: When.nullable(), trackingPath: z.string(),
    scans: z.array(z.object({ at: When, text: z.string(), location: z.string() })),
  })),
  invoices: z.array(z.object({ number: z.string(), path: z.string() })),
  canCancel: z.boolean(),
  canReturn: z.boolean(),
  canReorder: z.boolean(),
});
/** An order by its unguessable token: no name, phone or address. */
export const AppOrderState = z.object({
  orderNumber: z.string(), fulfilmentStatus: z.string(), paymentStatus: z.string(), totalPaise: z.number().int(),
  next: z.enum(['pay', 'pending', 'done', 'failed']), payPath: z.string(),
});
/** Today's prices, through the cart's own pricing; what cannot be bought is named, never added. Writes the cart only. */
export const AppReorder = z.object({
  lines: z.array(PricedLine),
  added: z.number().int(),
  missing: z.array(z.object({ name: z.string(), option: z.string(), reason: z.enum(['inactive', 'sold_out', 'removed']) })),
  capped: z.array(z.object({ name: z.string(), qty: z.number().int() })),
  addressId: id.nullable(),
  notices: z.array(z.string()),
});
export const AppRewards = z.object({
  enabled: z.boolean(),
  pointsBalance: z.number().int(),
  pendingPoints: z.number().int(),
  valuePaise: z.number().int(),
  expiring: z.object({ points: z.number().int(), at: When }).nullable(),
  history: z.array(z.object({ at: When, points: z.number().int(), reason: z.string(), orderNumber: z.string().nullable() })).max(20),
  /** url is https://<this host>/refer/<code>: the business's own host, never a platform one. */
  referral: z.object({ code: z.string(), url: z.string(), text: z.string() }).nullable(),
});
export const AppPolicy = z.object({ kind: z.enum(POLICY_KINDS), title: z.string(), body: z.string(), updatedAt: When.nullable() });
const PushPermission = z.enum(['not_asked', 'granted', 'provisional', 'denied']);
export const PushDeviceBody = z.strictObject({ token: z.string().regex(PUSH_TOKEN).nullable(), permission: PushPermission });
export const PushPrefs = z.object({ permission: PushPermission, orderUpdates: z.boolean(), offers: z.boolean(), newReels: z.boolean(), configured: z.boolean() });
/** first_order_prompt may turn on order updates only; offers and new reels turn on only from settings, with an explicit true. */
export const PushPrefsSave = z.strictObject({
  orderUpdates: z.boolean().optional(),
  offers: z.boolean().optional(),
  newReels: z.boolean().optional(),
  source: z.enum(['first_order_prompt', 'settings']),
}).refine((b) => b.orderUpdates !== undefined || b.offers !== undefined || b.newReels !== undefined, 'Choose at least one notification');
export const PushFollowOrder = z.strictObject({ orderToken: z.string().min(1).max(100) });
export const AppHealthBody = z.strictObject({ updateId: z.string().max(120).nullable(), runtimeVersion: z.string().min(1).max(40), event: z.enum(['launch', 'crash']) });
export const AppPlatform = z.enum(APP_PLATFORMS);

const app = (method, path, owner, auth, extra = {}) => Object.freeze({ method, path, owner, kind: 'json', auth, ...extra });
const browser = (method, path, owner) => Object.freeze({ method, path, owner, kind: 'page', auth: 'web' });
const wellknown = (path, owner) => Object.freeze({ method: 'GET', path, owner, kind: 'wellknown', auth: 'web' });

export const APP_ROUTES = Object.freeze({
  // app-api: the gate, sessions, the feeds, the account
  appBootstrap: app('GET', '/api/store/app/bootstrap', 'app-api', 'none', { response: AppBootstrap }),
  appSessionStart: app('POST', '/api/store/app/session', 'app-api', 'none', { body: AppSessionStart, response: AppSession }),
  appSessionRefresh: app('POST', '/api/store/app/session/refresh', 'app-api', 'none', { body: AppRefresh, response: AppRefreshed }),
  /** Ends this sign-in and answers a new guest session for the same device. */
  appSessionEnd: app('POST', '/api/store/app/session/end', 'app-api', 'app', { response: AppSession }),
  appApple: app('POST', '/api/store/app/apple', 'app-api', 'none', { body: AppleSignInBody, response: AppSession }),
  /** Google in the system browser (no app headers): 302 to Google, then 303 to <url_scheme>://auth?code=... */
  appGoogleStart: browser('GET', '/auth/app/google', 'app-api'),
  appGoogleCallback: browser('GET', '/auth/app/google/callback', 'app-api'),
  appMe: app('GET', '/api/store/app/me', 'app-api', 'app', { response: AppMe }),
  /** The Phase 4 erasure flow (src/modules/consent/erasure.js), exactly as POST /api/store/data-requests runs it. */
  appAccountDelete: app('POST', '/api/store/app/account/delete', 'app-api', 'shopper', { body: AppDeleteBody, response: AppDeletion }),
  appHome: app('GET', '/api/store/app/home', 'app-api', 'app', { response: AppHome }),
  appCatalog: app('GET', '/api/store/app/catalog', 'app-api', 'app', { query: AppCatalogQuery, response: pageOf(AppProductCard) }),
  appProduct: app('GET', '/api/store/app/products/:slug', 'app-api', 'app', { response: AppProduct }),
  appCategories: app('GET', '/api/store/app/categories', 'app-api', 'app', { response: z.object({ items: z.array(AppCategoryCard) }) }),
  /** Pinned reels first, then the set order, hidden windows left out: the query the /c/:slug and /reels pages use (P-65). */
  appCategory: app('GET', '/api/store/app/categories/:slug', 'app-api', 'app', { query: AppPageQuery, response: AppCategory }),
  appReels: app('GET', '/api/store/app/reels', 'app-api', 'app', { query: AppReelsQuery, response: AppReels }),
  appLanding: app('GET', '/api/store/app/landing/:slug', 'app-api', 'app', { response: AppLanding }),
  appOrders: app('GET', '/api/store/app/orders', 'app-api', 'shopper', { query: AppPageQuery, response: pageOf(AppOrderSummary) }),
  appOrder: app('GET', '/api/store/app/orders/:orderNumber', 'app-api', 'shopper', { response: AppOrder }),
  appOrderByToken: app('GET', '/api/store/app/order/:token', 'app-api', 'app', { response: AppOrderState }),
  appReorder: app('POST', '/api/store/app/orders/:orderNumber/reorder', 'app-api', 'shopper', { response: AppReorder }),
  appRewards: app('GET', '/api/store/app/rewards', 'app-api', 'shopper', { response: AppRewards }),
  appPolicy: app('GET', '/api/store/app/policies/:kind', 'app-api', 'app', { response: AppPolicy }),
  // shopper-push: the device, its three toggles, and a guest's order
  pushDevice: app('PUT', '/api/store/app/push/device', 'shopper-push', 'app', { body: PushDeviceBody, response: PushPrefs }),
  pushDeviceRemove: app('DELETE', '/api/store/app/push/device', 'shopper-push', 'app', { response: null }),
  pushPrefsGet: app('GET', '/api/store/app/push/prefs', 'shopper-push', 'app', { response: PushPrefs }),
  pushPrefsSave: app('PUT', '/api/store/app/push/prefs', 'shopper-push', 'app', { body: PushPrefsSave, response: PushPrefs }),
  pushFollowOrder: app('POST', '/api/store/app/push/orders', 'shopper-push', 'app', { body: PushFollowOrder, response: null }),
  // ota: launches and crashes of the running update
  appHealth: app('POST', '/api/store/app/health', 'ota', 'app', { body: AppHealthBody, response: null }),
  // app-links: the verified-link files, per business host, built from app_configs (10.12)
  assetLinks: wellknown('/.well-known/assetlinks.json', 'app-links'),
  appleAppSite: wellknown('/.well-known/apple-app-site-association', 'app-links'),
});
