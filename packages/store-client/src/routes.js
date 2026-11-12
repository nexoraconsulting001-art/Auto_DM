/**
 * Every call the shopper app makes to a store's own API, written from src/contracts/store-routes.js: the app's own routes
 * (APP_ROUTES, kind json) and the store's JSON calls the app uses unchanged with its app session (STORE_APP_CALLS below, from
 * STORE_ROUTES). A test (test/p6/shopper-app-workspace) keeps this table equal to the contract, so a route added, moved or
 * removed there fails until it is the same here. Plain data, with no imports, so the app carries nothing of the server.
 *
 * auth: none (no token needed), app (any app session, a guest one included), shopper (signed in).
 */
const route = (method, path, auth) => Object.freeze({ method, path, auth });

export const ROUTES = Object.freeze({
  // the app's own routes
  appBootstrap: route('GET', '/api/store/app/bootstrap', 'none'),
  appSessionStart: route('POST', '/api/store/app/session', 'none'),
  appSessionRefresh: route('POST', '/api/store/app/session/refresh', 'none'),
  appSessionEnd: route('POST', '/api/store/app/session/end', 'app'),
  appApple: route('POST', '/api/store/app/apple', 'none'),
  appMe: route('GET', '/api/store/app/me', 'app'),
  appAccountDelete: route('POST', '/api/store/app/account/delete', 'shopper'),
  appHome: route('GET', '/api/store/app/home', 'app'),
  appCatalog: route('GET', '/api/store/app/catalog', 'app'),
  appProduct: route('GET', '/api/store/app/products/:slug', 'app'),
  appCategories: route('GET', '/api/store/app/categories', 'app'),
  appCategory: route('GET', '/api/store/app/categories/:slug', 'app'),
  appReels: route('GET', '/api/store/app/reels', 'app'),
  appLanding: route('GET', '/api/store/app/landing/:slug', 'app'),
  appOrders: route('GET', '/api/store/app/orders', 'shopper'),
  appOrder: route('GET', '/api/store/app/orders/:orderNumber', 'shopper'),
  appOrderByToken: route('GET', '/api/store/app/order/:token', 'app'),
  appReorder: route('POST', '/api/store/app/orders/:orderNumber/reorder', 'shopper'),
  appRewards: route('GET', '/api/store/app/rewards', 'shopper'),
  appPolicy: route('GET', '/api/store/app/policies/:kind', 'app'),
  pushDevice: route('PUT', '/api/store/app/push/device', 'app'),
  pushDeviceRemove: route('DELETE', '/api/store/app/push/device', 'app'),
  pushPrefsGet: route('GET', '/api/store/app/push/prefs', 'app'),
  pushPrefsSave: route('PUT', '/api/store/app/push/prefs', 'app'),
  pushFollowOrder: route('POST', '/api/store/app/push/orders', 'app'),
  appHealth: route('POST', '/api/store/app/health', 'app'),
  // the store's calls, used unchanged
  productsLookup: route('GET', '/api/store/products', 'app'),
  cartGet: route('GET', '/api/store/cart', 'app'),
  cartPut: route('PUT', '/api/store/cart', 'app'),
  otpSend: route('POST', '/api/store/otp/send', 'app'),
  otpVerify: route('POST', '/api/store/otp/verify', 'app'),
  addresses: route('GET', '/api/store/addresses', 'app'),
  addressCreate: route('POST', '/api/store/addresses', 'app'),
  addressUpdate: route('PUT', '/api/store/addresses/:id', 'app'),
  addressRemove: route('DELETE', '/api/store/addresses/:id', 'app'),
  sharedConsentSave: route('POST', '/api/store/shared-profile', 'app'),
  sharedConsentRevoke: route('DELETE', '/api/store/shared-profile', 'app'),
  checkoutQuote: route('POST', '/api/store/checkout/quote', 'app'),
  checkoutPlace: route('POST', '/api/store/checkout', 'app'),
  paymentReturn: route('POST', '/api/store/payments/return', 'app'),
  orderRetry: route('POST', '/api/store/orders/:token/retry', 'app'),
  accountOrderCancel: route('POST', '/api/store/orders/:orderNumber/cancel', 'app'),
  serviceability: route('GET', '/api/store/serviceability', 'app'),
  couponCheck: route('POST', '/api/store/coupons/check', 'app'),
  returnCreate: route('POST', '/api/store/orders/:orderNumber/returns', 'app'),
  consentGet: route('GET', '/api/store/consent', 'app'),
  consentSave: route('POST', '/api/store/consent', 'app'),
  dataRequest: route('POST', '/api/store/data-requests', 'app'),
  reviewCreate: route('POST', '/api/store/reviews', 'app'),
  reviewList: route('GET', '/api/store/products/:id/reviews', 'app'),
  wishlistGet: route('GET', '/api/store/wishlist', 'app'),
  wishlistPut: route('PUT', '/api/store/wishlist', 'app'),
});

/** The ids above that come from STORE_ROUTES rather than APP_ROUTES. */
export const STORE_APP_CALLS = Object.freeze([
  'productsLookup', 'cartGet', 'cartPut', 'otpSend', 'otpVerify', 'addresses', 'addressCreate', 'addressUpdate',
  'addressRemove', 'sharedConsentSave', 'sharedConsentRevoke', 'checkoutQuote', 'checkoutPlace', 'paymentReturn',
  'orderRetry', 'accountOrderCancel', 'serviceability', 'couponCheck', 'returnCreate', 'consentGet',
  'consentSave', 'dataRequest', 'reviewCreate', 'reviewList', 'wishlistGet', 'wishlistPut',
]);

/** Pages the app opens in a system browser tab, on the store's own address: the order's hosted payment page and Google sign-in. */
export const PAGES = Object.freeze({
  order: '/order/:token',
  googleStart: '/auth/app/google',
});

/** What every app request carries (SHOPPER_APP_HEADERS and SHOPPER_AUTH_SCHEME in src/contracts/apps.js). */
export const HEADERS = Object.freeze({ app: 'x-app', tenant: 'x-app-tenant', version: 'x-app-version', platform: 'x-app-platform' });
export const APP_NAME = 'shopper';
export const AUTH_SCHEME = 'Shopper';
