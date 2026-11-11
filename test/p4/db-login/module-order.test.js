// The order of MODULES in src/modules/index.js is behaviour: routes mount in that order, so an earlier module's
// route wins, traffic's page middleware only counts the pages mounted after it, and a later module's takesOver()
// replaces an earlier answer. This test holds the order still, so a reorder is always a decision and never an accident.
//
// Adding a module: put its name in ORDER at the same place you put it in MODULES. One name per line keeps merges simple.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../../../src/modules/index.js';

const ORDER = [
  'brand',
  'entitlements',
  'ig-accounts',
  'audit',
  'alerts',
  'gateway-keys',
  'accounts',
  'team',
  'demo-tenant',
  'api-auth',
  'platform-console',
  'ig-connect',
  'compliance',
  'automations',
  'links',
  'facebook',
  'domains',
  'insights',
  'reach-guard',
  'traffic',
  'reports',
  'catalog',
  'imports',
  'categories',
  'pages',
  'themes',
  'creator',
  'leads',
  'shoppers',
  'consent',
  'cart',
  'coupons',
  'inventory',
  'loyalty',
  'checkout',
  'orders',
  'payments',
  'refunds',
  'shipping',
  'invoices',
  'returns',
  'reviews',
  'wishlist',
  'order-alerts',
  'abandoned-cart',
  'shopify-sync',
  'storefront',
  'admin-console',
  'admin-api',
  'api-v1',
];

const names = MODULES.map((m) => m.name);
const before = (first, second) => names.indexOf(first) < names.indexOf(second);

test('the modules are listed in the locked order', () => {
  assert.deepEqual(names, ORDER, 'src/modules/index.js lists its modules in a different order from this test. If that is meant, change ORDER here to match.');
});

test('every module has a name, and no name is listed twice', () => {
  for (const module of MODULES) assert.match(String(module?.name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(new Set(names).size, names.length);
});

test('the rules the order stands for hold, wherever new modules are added', () => {
  // Buyer pages come after traffic, whose page middleware counts them.
  for (const pageModule of ['catalog', 'imports', 'categories', 'pages', 'themes', 'creator', 'leads']) {
    assert.ok(before('traffic', pageModule), `traffic comes before ${pageModule}`);
    // ...and before admin-api, whose routes they may take over.
    assert.ok(before(pageModule, 'admin-api'), `${pageModule} comes before admin-api`);
  }
  // Phase 5's accounts come before api-auth, which still answers the Phase 0 auth routes, and so before every module that reads who is signed in.
  for (const accountModule of ['accounts', 'team', 'demo-tenant']) assert.ok(before(accountModule, 'api-auth'), `${accountModule} comes before api-auth`);
  // The seller console, the Phase 0 API and the contract router stay last, in that order.
  assert.deepEqual(names.slice(-3), ['admin-console', 'admin-api', 'api-v1']);
});
