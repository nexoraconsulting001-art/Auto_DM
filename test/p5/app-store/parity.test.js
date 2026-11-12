// The owner app's store and account screens cover their part of the web (PRD 10.4; P-14, P-16): every route and console
// page of orders, payments, refunds, shipping, stock, coupons, invoices, returns, reviews, loyalty, customers, privacy,
// store setup, Shopify, settings, the team and the audit log is in some feature's routeIds, every key entry is mapped,
// and the code of those features keeps the rules no screen may break. Read from the files, as `npm run parity` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { routeList, routes } from '../../../src/contracts/api/index.js';
import { checkParity, readPending } from '../../../tools/parity-check.mjs';

const require = createRequire(import.meta.url);
const { readAppFeatures, readConsolePages } = require('../../../tools/parity-read.cjs');
const ROOT = path.resolve(import.meta.dirname, '../../..');

export const TRACK = Object.freeze([
  'orders', 'payments', 'refunds', 'shipping', 'inventory', 'coupons', 'invoices', 'returns', 'reviews', 'loyalty', 'customers', 'privacy', 'store-settings',
  'shopify', 'settings', 'team', 'audit-log',
]);
/** The console features whose pages these app features stand in for. */
const CONSOLE_AREAS = Object.freeze(['orders', 'payments', 'shipping', 'inventory', 'coupons', 'invoices', 'returns', 'reviews', 'loyalty', 'customers', 'store-settings', 'settings', 'audit-log']);
/** The route groups that belong to these screens and to no other feature. */
const GROUPS = Object.freeze([
  'orders', 'orderDownloads', 'orderAlerts', 'shipments', 'payments', 'paymentAccount', 'paymentSettings', 'settlements', 'refunds', 'shippingSettings', 'shipping',
  'inventory', 'inventorySettings', 'coupons', 'invoices', 'invoiceSettings', 'returns', 'returnSettings', 'reviews', 'wishlist', 'loyalty', 'loyaltySettings',
  'customers', 'shoppers', 'shopperDownloads', 'dataRequests', 'privacy', 'policies', 'consentNotice', 'alertSettings', 'whatsappAccount', 'whatsappTemplates',
  'cartReminders', 'shopify', 'settings', 'apiKeys', 'team', 'audit',
]);

const app = readAppFeatures(ROOT);
const consolePages = readConsolePages(ROOT);
const mine = app.features.filter((feature) => TRACK.includes(feature.name));
const covered = new Set(app.features.flatMap((feature) => feature.routeIds));
const ownerCanReach = (access) => Boolean(access?.public || access?.signedIn || access?.roles?.includes('owner'));

test('the files read cleanly, and every id these features list is a real route or console page', () => {
  assert.deepEqual([...app.problems, ...consolePages.problems], []);
  assert.equal(mine.length, TRACK.length);
  const pages = new Set(consolePages.pages.map((page) => page.id));
  for (const feature of mine) {
    assert.ok(feature.routeIds.length > 0, `${feature.name} lists nothing`);
    for (const id of feature.routeIds) assert.ok(id in routes || pages.has(id), `${feature.name} lists "${id}", which is neither`);
  }
});

test('P-14 every route of these areas and every console page they stand in for has an app screen', () => {
  const groupOf = (id) => id.split('.')[0];
  const owed = routeList.filter((route) => GROUPS.includes(groupOf(route.id)) && ownerCanReach(route.access) && !route.consoleOnly).map((route) => route.id);
  assert.ok(owed.length > 100, 'the groups name the store and account routes');
  assert.deepEqual(owed.filter((id) => !covered.has(id)), []);
  const areaPages = consolePages.pages.filter((page) => CONSOLE_AREAS.includes(page.feature)).map((page) => page.id);
  assert.deepEqual(areaPages.filter((id) => !covered.has(id)), []);
});

test('P-16 every key entry is mapped: payment, courier, Shopify and WhatsApp keys, API keys, and every fresh route of these areas', () => {
  for (const id of ['settings.updatePayment', 'paymentAccount.connectUrl', 'shippingSettings.update', 'shopify.connect', 'whatsappAccount.connect', 'apiKeys.create', 'team.invite']) {
    assert.ok(covered.has(id), `${id} has no app screen`);
  }
  const fresh = routeList.filter((route) => route.fresh && GROUPS.includes(route.id.split('.')[0]));
  assert.ok(fresh.length >= 10);
  assert.deepEqual(fresh.map((route) => route.id).filter((id) => !covered.has(id)), []);
});

test('once tools/parity-pending.json is pruned of what is now mapped, the parity check passes', async () => {
  const pending = readPending(ROOT);
  const pruned = { ...pending, routes: pending.routes.filter((id) => !covered.has(id)), pages: pending.pages.filter((id) => !covered.has(id)) };
  const contract = routeList.map((route) => ({ ...route }));
  const result = checkParity({ routes: contract, pages: consolePages.pages, features: app.features, pending: pruned });
  assert.deepEqual(result.problems, []);
  // What this track maps and the pending file still lists: `node tools/parity-check.mjs --prune` deletes exactly these.
  const stale = [...pending.routes, ...pending.pages].filter((id) => mine.some((feature) => feature.routeIds.includes(id)));
  const areaPages = new Set(consolePages.pages.filter((page) => CONSOLE_AREAS.includes(page.feature)).map((page) => page.id));
  // The pickers of coupons and return rules, and the API keys page, which the console keeps with its reports.
  const borrowed = ['products.list', 'categories.list', 'console:/settings/api-keys'];
  assert.deepEqual(stale.filter((id) => !(GROUPS.includes(id.split('.')[0]) || areaPages.has(id) || borrowed.includes(id))), [], 'this track maps only its own areas');
  assert.ok(stale.length > 100, `${stale.length} ids to prune`);
});

// ---- the code itself ----

function sources(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(rel);
    return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) && entry.name !== 'testing.js' ? [rel] : [];
  });
}
const files = TRACK.flatMap((name) => sources(`apps/owner/src/features/${name}`));
const code = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no log, no AsyncStorage, no queued write, and nothing from the server’s code but the access rules', () => {
  assert.ok(files.length > 30);
  for (const file of files) {
    const text = code(file);
    assert.doesNotMatch(text, /\bconsole\.(log|info|warn|error|debug)\b/, `${file} logs`);
    assert.doesNotMatch(text, /AsyncStorage|async-storage/, `${file} uses AsyncStorage`);
    assert.doesNotMatch(text, /from 'expo-secure-store'/, `${file} touches SecureStore itself`);
    assert.doesNotMatch(text, /\buseMutation\b/, `${file} uses a react-query mutation, whose variables (a typed key) would sit in its cache`);
    for (const [, spec] of text.matchAll(/from '([^']+)'/g)) {
      if (spec.includes('/src/') && !spec.startsWith('.')) assert.fail(`${file} imports ${spec}`);
      if (/^(\.\.\/){3,}src\//.test(spec)) assert.fail(`${file} reaches into the server's src: ${spec}`);
    }
  }
});

test('P-17 every field a key is typed into is a write-only one, and nothing fills it from an answer', () => {
  const keyFields = ['razorpayKeySecret', 'accessToken', 'webhookSecret'];
  for (const file of files) {
    const text = code(file);
    for (const name of keyFields) {
      for (const match of text.matchAll(new RegExp(`\\{ name: '${name}'[^}]*\\}`, 'g'))) assert.match(match[0], /secret: true/, `${file}: ${name} is not a secret field`);
    }
  }
  const shipping = code('apps/owner/src/features/shipping/ShippingScreen.js');
  assert.match(shipping, /<SecretField testID="shipping-own-password"[^>]*value=\{password\}/);
  assert.doesNotMatch(shipping, /setPassword\(settings/);
  const ui = code('apps/owner/src/features/orders/kit/ui.js');
  assert.match(ui, /secret\s*\n?\s*error=/, 'SecretField hands `secret` to the field');
  assert.match(ui, /contextMenuHidden/);
  assert.match(ui, /setValues\(blank\);[\s\S]*setValues\(blank\);/, 'KeyForm empties every field on success and on failure');
  assert.match(ui, /runFresh\(\(\) => save\(body\)\)/, 'KeyForm asks for a fresh check before it sends');
});

test('the app never sends an amount for an order: order calls carry a move, a reason or a note, and money only on a refund', () => {
  const orderCalls = files.flatMap((file) => [...code(file).matchAll(/api\.orders\.(advance|cancel|releaseHold|setStatus|reinstate|addNote)\(([^)]*)\)/g)].map((m) => `${file}: ${m[0]}`));
  assert.ok(orderCalls.length >= 6);
  for (const call of orderCalls) assert.doesNotMatch(call, /paise|amount|total/i, call);
  const moneyBodies = files.flatMap((file) => [...code(file).matchAll(/amountPaise\s*[:,]/g)].map(() => file));
  assert.deepEqual([...new Set(moneyBodies)], ['apps/owner/src/features/orders/kit/rules.js'], 'only refundBody puts an amount in a body');
});
