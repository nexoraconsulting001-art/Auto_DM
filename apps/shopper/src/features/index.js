/**
 * Every part of the shopper app registers itself, so work in parallel never meets in a shared routes file. A feature is a
 * folder here whose index.js default-exports:
 *
 *   {
 *     name: 'product',                          // the folder's name
 *     screens: [
 *       { name: 'index', path: 'p/:slug', title: 'product.title', component: ProductScreen, link: true },
 *     ],
 *     nav: { label: 'catalog.title', order: 20, icon: LayoutGrid },   // a tab; null for none
 *     strings: { en: { 'product.title': 'Product' }, hi: { 'product.title': 'प्रोडक्ट' } },
 *     service: (services) => ({ ... }),         // optional: something other features use, kept as services.<name> (sign-in: services.session)
 *   }
 *
 * screens    `name` is unique within the feature; the navigator knows the screen as '<feature>.<name>' (`screenName` in
 *            ../shell/menu.js). The first screen is the one a tab opens. `title` is a string key. `path` is the screen's
 *            address inside the app; with `link: true` it is also a path of the store's own website that opens this
 *            screen, and it must then be one the server lists (APP_LINK_PATHS: a test checks it).
 * nav        the tabs, in `order`; at most five. Import an icon by itself, so the app carries only the icons it draws.
 * strings    this feature's own lines by key, in English and Hindi. Keys start with the feature's name. No line names a
 *            business or the platform: a brand's name comes from the build's brand (useServices().config.brand).
 * service    built once when the app starts, after the shell's own services (config, client, pay, strings, theme).
 *
 * There are no admin screens here and no seller API: the only server this app talks to is the store's own, through
 * @bhava/store-client. To add a feature: create the folder, then add its import and its name to the list below.
 */
import home from './home/index.js';
import catalog from './catalog/index.js';
import reels from './reels/index.js';
import category from './category/index.js';
import product from './product/index.js';
import search from './search/index.js';
import cart from './cart/index.js';
import checkout from './checkout/index.js';
import payment from './payment/index.js';
import orders from './orders/index.js';
import tracking from './tracking/index.js';
import account from './account/index.js';
import signIn from './sign-in/index.js';
import notifications from './notifications/index.js';
import rewards from './rewards/index.js';
import wishlist from './wishlist/index.js';
import reviews from './reviews/index.js';
import returns from './returns/index.js';
import addresses from './addresses/index.js';
import legal from './legal/index.js';

const all = [
  home, catalog, reels, category, product, search, cart, checkout, payment, orders,
  tracking, account, signIn, notifications, rewards, wishlist, reviews, returns, addresses, legal,
];

export const features = Object.freeze([...all]);

export const featureByName = Object.freeze(Object.fromEntries(features.map((feature) => [feature.name, feature])));
