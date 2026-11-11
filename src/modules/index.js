import { abandonedCart } from './abandoned-cart/index.js';
import { accounts } from './accounts/index.js';
import { adminApi } from './admin-api/index.js';
import { adminConsole } from './admin-console/index.js';
import { alerts } from './alerts/index.js';
import { apiAuth } from './api-auth/index.js';
import { apiV1 } from './api-v1/index.js';
import { audit } from './audit/index.js';
import { automations } from './automations/index.js';
import { brand } from './brand/index.js';
import { cart } from './cart/index.js';
import { catalog } from './catalog/index.js';
import { categories } from './categories/index.js';
import { checkout } from './checkout/index.js';
import { compliance } from './compliance/index.js';
import { consent } from './consent/index.js';
import { coupons } from './coupons/index.js';
import { creator } from './creator/index.js';
import { demoTenant } from './demo-tenant/index.js';
import { domains } from './domains/index.js';
import { entitlements } from './entitlements/index.js';
import { facebook } from './facebook/index.js';
import { gatewayKeys } from './gateway-keys/index.js';
import { igAccounts } from './ig-accounts/index.js';
import { igConnect } from './ig-connect/index.js';
import { imports } from './imports/index.js';
import { insights } from './insights/index.js';
import { inventory } from './inventory/index.js';
import { invoices } from './invoices/index.js';
import { leads } from './leads/index.js';
import { links } from './links/index.js';
import { loyalty } from './loyalty/index.js';
import { notifications } from './notifications/index.js';
import { orderAlerts } from './order-alerts/index.js';
import { orders } from './orders/index.js';
import { pages } from './pages/index.js';
import { payments } from './payments/index.js';
import { platformConsole } from './platform-console/index.js';
import { reachGuard } from './reach-guard/index.js';
import { refunds } from './refunds/index.js';
import { reports } from './reports/index.js';
import { returns } from './returns/index.js';
import { reviews } from './reviews/index.js';
import { shipping } from './shipping/index.js';
import { shopifySync } from './shopify-sync/index.js';
import { shoppers } from './shoppers/index.js';
import { storefront } from './storefront/index.js';
import { team } from './team/index.js';
import { themes } from './themes/index.js';
import { traffic } from './traffic/index.js';
import { wishlist } from './wishlist/index.js';

/**
 * Every feature area that plugs into the app. To add one, create src/modules/<name>/index.js and list it
 * here; createApp, createRepos and registerJobs pick it up, so nothing else needs editing. A module is an
 * object with a name and any of these:
 *
 *   repos(db, { storage, secrets })       -> { repoName: repo }. Merged into createRepos(). Business repos call tenantId().
 *   beforeTenant(app, ctx)                Routes with no business yet: provider webhooks and callbacks, the platform host.
 *   setup(ctx)                            Runs once when the app or the worker starts, in both: register order event listeners
 *                                         (ctx.orderEvents.on), the consent provider (ctx.platform.consent.use). No routes, no jobs.
 *   routes(app, ctx)                      Routes inside one business, after sign-in and CSRF, before the store's 404.
 *   lastRoutes(app, ctx)                  Mounted after every module's routes: the store's own pages and its 404 for what nothing answered.
 *   platformRoutes(router, ctx)           Platform Console routes; guard them with requirePlatformRole from src/auth.js.
 *   api(ctx)                              -> { 'products.list': handler }. Answers routes of the /api/v1 contract (src/contracts/api).
 *   takesOver(ctx)                        -> { id: handler } for ids admin-api answers (Phase 0): replaces its handler there.
 *   jobs({ db, repos, platform, config, ig, meta, google, providers, compliance, shopperMessages, notify, modules }) Calls platform.queue.work(...). May return an async schedule(), run every minute.
 *   onMetaCall(call, ctx)                 Told about every call to Meta, ids and numbers only. See meta-calls.js.
 *
 * ctx is { db, repos, ig, meta, google, apple, providers, compliance, shopperMessages, notify, orderEvents, auth, config, platform, modules }. meta is src/adapters/meta; google is
 * src/adapters/google (ga4, and signIn for sellers); apple is src/adapters/apple (signIn); providers is src/adapters/store.js (razorpay, shiprocket, shopify, whatsapp, email). compliance is the only path to Meta for a message, and
 * shopperMessages the only path to WhatsApp or email for one to a shopper. notify is the only path to a seller (PRD 5.13, 10.5): owner push,
 * Bhava's own WhatsApp number and Bhava's own email sender, and the in-app list. notify.emit({ event, tenantId, key, data }, t) writes an outbox
 * row, inside your transaction when you pass it; notify.sendCode({ to, code, purpose }) sends a seller's login code; notify.prefs and
 * notify.deliveries are the preferences and the delivery log (src/modules/notifications, src/contracts/notifications.js).
 * orderEvents is the order event bus (src/modules/orders/events.js).
 * platform.fetcher is safeFetch and platform.images is sharp (src/platform).
 *
 * Phase 3's buyer pages (catalog to leads) come after traffic, so traffic's page middleware counts them, and before admin-api,
 * whose routes they may take over.
 *
 * Phase 4's store (PRD 9) follows them, one folder per track. Sign-in and the account come first, as they did in Phase 0, then what
 * checkout calls (consent, cart, coupons, inventory, loyalty), checkout itself, and what follows an order. storefront is last of them:
 * its browsing pages and the store's 404 mount in lastRoutes, after everything.
 *
 * Phase 5's seller accounts (PRD 5.11, 10.2, 10.3, 10.6) sit just before api-auth, which still answers the Phase 0 auth routes:
 * accounts (sign-in without passwords, tokens, devices, re-auth, deletion, the review login, minimum versions), team and demo-tenant.
 * Their browser routes (AUTH_PATHS) mount in beforeTenant, on the host that belongs to no business.
 *
 * notifications (PRD 5.13, 10.5) comes right after alerts, which it drains: it answers notifications.* and push.*, and listens to the
 * order event bus for new orders.
 */
export const MODULES = [
  brand, entitlements, igAccounts, audit, alerts, notifications, gatewayKeys, accounts, team, demoTenant, apiAuth, platformConsole, igConnect, compliance, automations, links, facebook, domains,
  insights, reachGuard, traffic, reports,
  catalog, imports, categories, pages, themes, creator, leads,
  shoppers, consent, cart, coupons, inventory, loyalty, checkout, orders, payments, refunds, shipping, invoices, returns, reviews, wishlist,
  orderAlerts, abandonedCart, shopifySync, storefront,
  adminConsole, adminApi, apiV1,
];
