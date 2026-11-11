/**
 * Every part of the owner app registers itself, so work in parallel never meets in a shared routes file. A feature is a
 * folder here whose index.js default-exports:
 *
 *   {
 *     name: 'orders',                          // the folder's name
 *     access: staffWith('orders'),             // from '@bhava/app-core/access': the same rules as the console and the server
 *     feature: 'store.checkout',               // the entitlement the plan must include, or null
 *     routeIds: ['orders.list', 'orders.get', 'console:/orders', 'console:/orders/:id'],
 *     screens: [
 *       { name: 'index', path: 'orders', title: 'orders.title', component: OrdersScreen },
 *       { name: 'detail', path: 'orders/:id', title: 'orders.title', component: OrderScreen },
 *     ],
 *     nav: { label: 'orders.title', order: 10, icon: ShoppingBag, primary: true },   // null for no menu entry
 *     strings: { en: { 'orders.title': 'Orders' }, hi: { 'orders.title': 'ऑर्डर' } },
 *   }
 *
 * routeIds   every /api/v1 route id this feature's screens call, and every console page they stand in for, written
 *            'console:/path' as the console registers it. A plain list of quoted strings: `npm run parity` reads it
 *            from the file. A route or page that no feature lists fails that check by name (PRD 10.4).
 * screens    `name` is unique within the feature; the navigator knows the screen as '<feature>.<name>'
 *            (`screenName(feature, screen)` in ../shell/menu.js). `path` is what a deep link or a push opens
 *            ("/orders/12"). The first screen is the one the menu opens. `title` is a string key.
 * nav        `primary` puts it in the tab bar (the first four by `order`); the rest are listed under More. Import an
 *            icon by itself, `import ShoppingBag from 'lucide-react-native/icons/shopping-bag'`, so the app carries
 *            only the icons it draws.
 * strings    this feature's own lines by key, in English and Hindi. Keys start with the feature's name.
 *
 * The shell hides a feature that the person's role, permissions or plan do not allow; the server refuses it again.
 * To add a feature: create the folder, then add its import and its name to the list below. Nothing else changes.
 */
import home from './home/index.js';
import orders from './orders/index.js';
import returns from './returns/index.js';
import refunds from './refunds/index.js';
import invoices from './invoices/index.js';
import products from './products/index.js';
import imports from './imports/index.js';
import pages from './pages/index.js';
import creator from './creator/index.js';
import inventory from './inventory/index.js';
import coupons from './coupons/index.js';
import reviews from './reviews/index.js';
import reels from './reels/index.js';
import automations from './automations/index.js';
import inbox from './inbox/index.js';
import insights from './insights/index.js';
import traffic from './traffic/index.js';
import reachGuard from './reach-guard/index.js';
import reports from './reports/index.js';
import categories from './categories/index.js';
import customers from './customers/index.js';
import leads from './leads/index.js';
import loyalty from './loyalty/index.js';
import privacy from './privacy/index.js';
import activity from './activity/index.js';
import alerts from './alerts/index.js';
import notifications from './notifications/index.js';
import links from './links/index.js';
import compliance from './compliance/index.js';
import connect from './connect/index.js';
import settings from './settings/index.js';
import payments from './payments/index.js';
import storeSettings from './store-settings/index.js';
import shipping from './shipping/index.js';
import shopify from './shopify/index.js';
import domains from './domains/index.js';
import team from './team/index.js';
import devices from './devices/index.js';
import account from './account/index.js';
import themes from './themes/index.js';
import brandKit from './brand-kit/index.js';
import auditLog from './audit-log/index.js';
import appPublishing from './app-publishing/index.js';
import billing from './billing/index.js';
import setup from './setup/index.js';
import signup from './signup/index.js';
import aiReplies from './ai-replies/index.js';
import whatsapp from './whatsapp/index.js';
import teamFeed from './team-feed/index.js';
import referrals from './referrals/index.js';

const all = [
  home, orders, returns, refunds, invoices, products, imports, pages, creator, inventory,
  coupons, reviews, reels, automations, inbox, insights, traffic, reachGuard, reports, categories,
  customers, leads, loyalty, privacy, activity, alerts, notifications, links, compliance, connect,
  settings, payments, storeSettings, shipping, shopify, domains, team, devices, account, themes,
  brandKit, auditLog, appPublishing, billing, setup, signup, aiReplies, whatsapp, teamFeed, referrals,
];

export const features = Object.freeze([...all].sort((a, b) => (a.nav?.order ?? 999) - (b.nav?.order ?? 999)));

export const featureByName = Object.freeze(Object.fromEntries(features.map((feature) => [feature.name, feature])));

/** What the shell itself calls: sign-in, the session, the switcher and this device's push token. Counted by the parity check. */
export const shell = Object.freeze({
  name: 'shell',
  routeIds: [
    'app.requirements', 'auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'auth.me', 'auth.logout', 'auth.businesses',
    'push.register', 'push.unregister',
  ],
});
