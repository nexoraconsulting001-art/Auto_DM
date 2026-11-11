// How the Phase 4 store screens are wired: their routes, who may open what and press what, the states every screen has, and the
// rules every console file keeps. Read from the source, so it needs no build and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGERS, OWNER_ONLY, PERMISSIONS, isAllowed, routeList, routes, staffWith } from '../../../src/contracts/api/index.js';
import { createApiClient } from '../../../shared/api-client/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const featuresDir = path.join(repoRoot, 'console/src/features');
const FEATURES = ['orders', 'inventory', 'coupons', 'payments', 'shipping', 'invoices', 'returns', 'reviews', 'loyalty', 'customers', 'store-settings'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = FEATURES.flatMap((feature) => walk(path.join(featuresDir, feature))).map((file) => ({ name: path.relative(featuresDir, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const code = files.filter(({ name }) => /\.jsx?$/.test(name));
const pages = code.filter(({ name }) => /Page\.jsx$/.test(name));
const source = (name) => {
  const found = files.find((file) => file.name === name);
  assert.ok(found, `no file ${name}`);
  return found.text;
};

const ROUTES = {
  orders: ['orders', 'orders/files', 'orders/:id'],
  inventory: ['inventory', 'inventory/movements'],
  coupons: ['coupons', 'coupons/new', 'coupons/:id'],
  payments: ['payments', 'payments/statement'],
  shipping: ['shipping'],
  invoices: ['invoices', 'invoices/settings'],
  returns: ['returns', 'returns/settings', 'returns/:id'],
  reviews: ['reviews', 'reviews/saves'],
  loyalty: ['loyalty', 'loyalty/settings', 'loyalty/members/:id'],
  customers: ['customers', 'customers/shoppers', 'customers/shoppers/:id', 'customers/data-requests'],
  'store-settings': ['store-settings', 'store-settings/messages', 'store-settings/policies', 'store-settings/notice', 'store-settings/shopify'],
};

const ACCESS = {
  orders: "staffWith('orders')",
  inventory: "staffWith('catalog')",
  coupons: 'MANAGERS',
  payments: 'MANAGERS',
  shipping: 'MANAGERS',
  invoices: "staffWith('orders')",
  returns: "staffWith('orders')",
  reviews: "staffWith('catalog')",
  loyalty: "staffWith('customers')",
  customers: "staffWith('customers')",
  'store-settings': 'MANAGERS',
};
const accessValue = (text) => (text === 'MANAGERS' ? MANAGERS : text === 'OWNER_ONLY' ? OWNER_ONLY : staffWith(/'(\w+)'/.exec(text)[1]));

/** Everyone the console might be signed in as: owner, manager, and staff with each permission alone and with all of them. */
const PEOPLE = [{ role: 'owner' }, { role: 'manager' }, { role: 'staff', permissions: [...PERMISSIONS] }, ...PERMISSIONS.map((p) => ({ role: 'staff', permissions: [p] }))];
/** True when everyone `outer` lets in is also let in by `inner`. */
const covers = (outer, inner) => PEOPLE.every((person) => !isAllowed(person, outer) || isAllowed(person, inner));

// Which API route each client method calls, found by calling it against a recording fetch.
const calls = [];
const client = createApiClient({
  fetch: async (url, init) => {
    calls.push({ method: init.method, path: new URL(url, 'http://x').pathname.replace(/^\/api\/v1/, '') });
    return { ok: true, status: 200, json: async () => ({}) };
  },
});
async function routeOf(group, method) {
  calls.length = 0;
  await client[group][method](1, {});
  const call = calls[0];
  const found = routeList.find((route) => route.method === call.method && new RegExp(`^${route.path.replace(/:\w+/g, '[^/]+')}$`).test(call.path));
  assert.ok(found, `api.${group}.${method}: no route for ${call.method} ${call.path}`);
  return found;
}
const apiCalls = (text) => [...new Set([...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`))];

test('each screen has its route, and loads only when opened', () => {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    const index = source(`${feature}/index.jsx`);
    for (const route of paths) assert.ok(index.includes(`path: '${route}'`), `${feature}: ${route}`);
    assert.equal([...index.matchAll(/\bpath: '/g)].length, paths.length, `${feature}: a route this test doesn't know`);
    assert.match(index, /lazy\(\(\) => import\(/, feature);
    assert.doesNotMatch(index, /^import \w+Page from/m, `${feature}: a page imported directly`);
  }
});

test('a fixed path comes before the :id route that would swallow it', () => {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    const index = source(`${feature}/index.jsx`);
    for (const dynamic of paths.filter((route) => route.includes(':'))) {
      const parent = dynamic.slice(0, dynamic.lastIndexOf('/'));
      for (const fixed of paths.filter((route) => !route.includes(':') && route.startsWith(`${parent}/`) && route.split('/').length === dynamic.split('/').length)) {
        assert.ok(index.indexOf(`path: '${fixed}'`) < index.indexOf(`path: '${dynamic}'`), `${feature}: ${fixed} after ${dynamic}`);
      }
    }
  }
});

test('no route of the console names a raw export', () => {
  for (const paths of Object.values(ROUTES)) for (const route of paths) assert.doesNotMatch(route, /raw|export/i, route);
});

test('each area asks for the access its own list asks for, and the menu shows only the areas a seller starts from', () => {
  const lists = { orders: 'orders.list', inventory: 'inventory.list', coupons: 'coupons.list', payments: 'paymentSettings.get', shipping: 'shippingSettings.get', invoices: 'invoices.list', returns: 'returns.list', reviews: 'reviews.list', loyalty: 'loyalty.members', customers: 'customers.list', 'store-settings': 'alertSettings.get' };
  for (const [feature, access] of Object.entries(ACCESS)) {
    assert.ok(source(`${feature}/index.jsx`).includes(`access: ${access}`), `${feature}: ${access}`);
    assert.deepEqual(routes[lists[feature]].access, accessValue(access), `${feature}: ${lists[feature]}`);
  }
  const entry = (feature) => /nav: \{ to: '([^']+)', label: '([^']+)'/.exec(source(`${feature}/index.jsx`))?.slice(1) ?? null;
  assert.deepEqual(entry('orders'), ['/orders', 'Orders']);
  assert.deepEqual(entry('returns'), ['/returns', 'Returns']);
  assert.deepEqual(entry('inventory'), ['/inventory', 'Stock']);
  assert.deepEqual(entry('coupons'), ['/coupons', 'Coupons']);
  assert.deepEqual(entry('reviews'), ['/reviews', 'Reviews']);
  assert.deepEqual(entry('payments'), ['/payments', 'Payments']);
  assert.deepEqual(entry('customers'), ['/customers', 'Customers']);
  assert.deepEqual(entry('store-settings'), ['/store-settings', 'Store setup']);
  for (const feature of ['shipping', 'invoices', 'loyalty']) assert.equal(entry(feature), null, `${feature} is reached from its area, not the menu`);
  assert.doesNotMatch(source('orders/index.jsx'), /primary: true[^}]*primary/, 'one tab-bar entry');
  for (const feature of FEATURES.filter((f) => f !== 'orders')) assert.doesNotMatch(source(`${feature}/index.jsx`), /primary: true/, `${feature} would push a Phase 0 tab out of the phone's tab bar`);
});

test('the console calls only methods the shared client has', () => {
  for (const { name, text } of code) {
    for (const call of apiCalls(text)) {
      const [group, method] = call.split('.');
      assert.equal(typeof client[group]?.[method], 'function', `${name}: api.${call}`);
    }
  }
});

test('nothing is offered to someone the API would refuse: a call wider than its screen\'s area is behind the same check', async () => {
  // The order panels live in other folders but are drawn on the order page.
  const contextOf = (name) => (/\/Order[A-Z]\w*\.jsx$/.test(name) ? "staffWith('orders')" : ACCESS[name.split('/')[0]]);
  let checked = 0;
  for (const { name, text } of code) {
    const context = contextOf(name);
    if (!context) continue;
    for (const call of apiCalls(text)) {
      const route = await routeOf(...call.split('.'));
      if (covers(accessValue(context), route.access)) continue;
      checked += 1;
      // Some check in the file lets in no one the route refuses.
      const gates = [...text.matchAll(/allowed\((OWNER_ONLY|MANAGERS|staffWith\('\w+'\))\)/g)].map((m) => accessValue(m[1]));
      assert.ok(gates.some((gate) => covers(gate, route.access)), `${name}: api.${call} (${route.id}) needs ${route.access === OWNER_ONLY ? 'OWNER_ONLY' : route.access === MANAGERS ? 'MANAGERS' : `staffWith('${route.access.permission}')`}, wider than ${context}`);
    }
  }
  assert.ok(checked >= 15, `only ${checked} gated calls found`);
});

test('S-29: the refund button is offered to the owner only, wherever it appears', () => {
  assert.equal(routes['refunds.create'].access, OWNER_ONLY);
  assert.equal(routes['refunds.retry'].access, OWNER_ONLY);
  const money = source('payments/OrderMoney.jsx');
  assert.match(money, /const isOwner = allowed\(OWNER_ONLY\)/);
  assert.match(money, /action=\{isOwner && canRefund \? <RefundButton order=\{order\} \/> : null\}/);
  assert.match(money, /\{isOwner && refund\.status === 'failed'/);
  assert.match(money, /password: form\.values\.password/, 'the owner\'s password goes with every refund (5.11)');
  assert.match(money, /idempotencyKey: key/);
  const order = source('orders/OrderPage.jsx');
  assert.match(order, /\{isOwner && <RefundButton order=\{order\} suggestedPaise=\{order\.refundDuePaise\}/, 'S-31: the refund prompt');
  assert.match(source('returns/ReturnPage.jsx'), /\{allowed\(OWNER_ONLY\)\s*\? <><RefundForReturn/);
  for (const { name, text } of code) {
    if (/<RefundButton\b/.test(text)) assert.ok(['payments/OrderMoney.jsx', 'orders/OrderPage.jsx', 'returns/ReturnPage.jsx'].includes(name), `${name}: a refund button nobody checked`);
  }
});

test('S-30, 9.9: the order page offers exactly the moves the server says are next, and a checkout order never has its status set', () => {
  const order = source('orders/OrderPage.jsx');
  assert.match(order, /const moves = HAND_MOVES\.filter\(\(move\) => \(order\.nextFulfilment \?\? \[\]\)\.includes\(move\)\)/);
  assert.match(order, /\{order\.canCancel && <Button/);
  assert.match(order, /data\.flow === 'checkout' \? <CheckoutOrder order=\{data\} \/> : <ManualOrder order=\{data\} \/>/);
  const manual = order.slice(order.indexOf('function ManualOrder'), order.indexOf('export default'));
  const checkout = order.slice(order.indexOf('function CheckoutOrder'), order.indexOf('function ManualOrder'));
  assert.match(manual, /<StatusForm /, 'a Phase 0 order still moves by its status');
  assert.doesNotMatch(checkout, /StatusForm/);
  assert.equal([...order.matchAll(/api\.orders\.setStatus/g)].length, 1);
});

test('no screen sends an order amount: only a refund\'s amount and settings are typed', () => {
  for (const { name, text } of code) {
    for (const match of text.matchAll(/api\.(orders|shipments|returns)\.\w+\(([^;]*?)\)\)?[,;]/g)) {
      assert.doesNotMatch(match[2], /Paise/, `${name}: ${match[0]}`);
    }
    assert.doesNotMatch(text, /parseFloat|\/ 100\)\.toFixed/, `${name}: rupees become paise only through rupeesToPaise`);
    // A form.js may turn a percent into hundredths; a screen turns nothing into paise itself.
    if (name.endsWith('.jsx')) assert.doesNotMatch(text, /\* 100\b/, `${name}: rupees become paise only through rupeesToPaise`);
  }
});

test('S-96: messages to shoppers go by WhatsApp and email only, and WhatsApp\'s price shows at cost', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /['"`]sms['"`]/i, `${name}: an SMS value`);
    assert.doesNotMatch(text, />[^<]*\bSMS\b[^<]*</, `${name}: SMS offered on screen`);
  }
  const messages = source('store-settings/MessagesPage.jsx');
  assert.match(messages, /<Toggle label="WhatsApp" \{\.\.\.form\.toggle\('whatsapp'\)\} \/>/);
  assert.match(messages, /<Toggle label="Email" \{\.\.\.form\.toggle\('email'\)\} \/>/);
  assert.match(messages, /<Costs cost=\{data\.whatsappCostPaise\} \/>/);
  assert.match(messages, /passed on at cost with no markup/);
});

test('S-91: the loyalty screens have no menu entry and show in Customers only when the add-on answers', () => {
  assert.doesNotMatch(source('loyalty/index.jsx'), /nav:/);
  const probe = source('loyalty/useLoyalty.js');
  assert.match(probe, /retry: false/);
  // Asked only where the add-on is possible; plans that include it show it without asking (migration 004: loyalty from rank 4).
  const plans = fs.readFileSync(path.join(repoRoot, 'src/db/migrations/004_plan_features.sql'), 'utf8');
  assert.match(plans, /\('loyalty', 4\)/);
  assert.match(plans, /\('t3', 3\), \('t4', 4\), \('t5', 5\)/);
  assert.match(probe, /LOYALTY_PLANS = Object\.freeze\(\['t4', 't5'\]\)/);
  assert.match(probe, /LOYALTY_ADD_ON_PLAN = 't3'/);
  assert.match(probe, /enabled: plan === LOYALTY_ADD_ON_PLAN && allowed\(staffWith\('customers'\)\)/);
  for (const file of ['customers/CustomersPage.jsx', 'customers/ShoppersPage.jsx', 'customers/DataRequestsPage.jsx']) {
    assert.match(source(file), /tabs=\{loyaltyOn \? \[\.\.\.CUSTOMER_AREA, LOYALTY_TAB\] : CUSTOMER_AREA\}/, file);
  }
  assert.match(source('store-settings/StoreSettingsPage.jsx'), /const links = loyaltyOn \?/);
  assert.match(source('orders/shared/ui.jsx'), /if \(isPlanRefusal\(query\.error\)\) return <PlanState/);
});

test('S-86: the saves screen reads counts only', () => {
  const saves = source('reviews/SavesPage.jsx');
  assert.deepEqual(apiCalls(saves), ['wishlist.counts']);
  assert.match(saves, /never who/);
});

test('every screen says when it is loading, when it failed, and when there is nothing', () => {
  // Forms about one thing have nothing to be empty of.
  const withoutEmpty = new Set(['payments/PaymentsPage.jsx', 'shipping/ShippingPage.jsx', 'coupons/CouponFormPage.jsx', 'store-settings/StoreSettingsPage.jsx', 'store-settings/PoliciesPage.jsx', 'store-settings/NoticePage.jsx', 'orders/OrderPage.jsx', 'returns/ReturnSettingsPage.jsx', 'loyalty/LoyaltySettingsPage.jsx', 'invoices/InvoiceSettingsPage.jsx', 'customers/ShopperPage.jsx']);
  for (const { name, text } of pages) {
    const states = [...text.matchAll(/<(StoreScreen|Loadable)\b[^>]*>/g)];
    assert.ok(states.length > 0, `${name}: loading and error`);
    for (const match of states) assert.match(match[0], /\blabel=(?:"[^"]+"|\{[^}]+\})[^>]*\berrorTitle=(?:"[^"]+"|\{[^}]+\})/, `${name}: ${match[0]}`);
    if (!withoutEmpty.has(name)) assert.ok(text.includes('<EmptyState'), `${name}: empty`);
  }
  assert.ok(pages.length >= 28, `only ${pages.length} pages found`);
  for (const page of ['orders/OrderPage.jsx', 'returns/ReturnPage.jsx', 'coupons/CouponFormPage.jsx', 'customers/ShopperPage.jsx', 'loyalty/MemberPage.jsx']) {
    assert.match(source(page), /<(StoreScreen|Loadable) query=\{\w+\} detail/, `${page}: a missing thing reads as missing`);
  }
  for (const panel of ['payments/OrderMoney.jsx', 'shipping/OrderShipments.jsx', 'invoices/OrderInvoices.jsx', 'store-settings/OrderMessages.jsx', 'orders/OrderTimeline.jsx']) {
    const text = source(panel);
    assert.match(text, /<StoreScreen query=\{\w+\} label="[^"]+" errorTitle="[^"]+">/, panel);
    assert.ok(text.includes('<EmptyState'), `${panel}: empty`);
  }
});

test('the store screens import nothing the build doesn\'t copy, and reach nothing past the API client', () => {
  for (const { name, text } of code) {
    for (const [, target] of text.matchAll(/from '([^']+)'/g)) {
      if (target.startsWith('@contracts/')) assert.equal(target, '@contracts/access.js', `${name}: importing the rest of the contract would pull zod into the page`);
      else if (target.startsWith('.')) assert.ok(path.resolve(featuresDir, path.dirname(name), target).startsWith(path.join(repoRoot, 'console', 'src')), `${name}: ${target}`);
    }
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|axios|localStorage|sessionStorage/, name);
  }
});

test('no personal detail goes into a console address', () => {
  // Phase 0's "3 orders" link on an account searches the orders by that account's number; it is kept as it was.
  const PHASE_0 = '/orders?search=${encodeURIComponent(customer.phone)}';
  for (const { name, text } of code) {
    for (const match of text.matchAll(/\bto=\{`([^`]*)`\}/g)) {
      if (name === 'customers/CustomersPage.jsx' && match[1] === PHASE_0) continue;
      assert.doesNotMatch(match[1], /phone|email|customerName|\.name\b|displayName/, `${name}: ${match[1]}`);
    }
  }
  assert.match(source('loyalty/LoyaltyPage.jsx'), /state=\{\{ name: member\.name \}\}/, 'a member\'s name travels in history state, not the address');
});

test('every Phase 0 promise of the orders and customers screens holds', () => {
  const list = source('orders/OrdersPage.jsx');
  for (const mark of ['<SearchField label="Order no., name or phone"', '<Chip pressed={!status} onClick={() => setFilter(\'status\', \'\')}>All</Chip>', '<OrderStatusBadge status={order.status} />', 'title={filtered ? \'No orders match\' : \'No orders yet\'}']) assert.ok(list.includes(mark), mark);
  const order = source('orders/OrderPage.jsx');
  for (const mark of ['<SelectField label="Status"', '<TextAreaField label="Internal note"', '<Button type="submit" block loading={form.busy}>Save</Button>', 'toast(\'Order updated.\')', 'Message on WhatsApp', 'className="totals"']) assert.ok(order.includes(mark), mark);
  const customers = source('customers/CustomersPage.jsx');
  for (const mark of ['label="Loading your customers"', 'errorTitle="We couldn’t load your customers"', 'Reset password for', 'Search by name or number']) assert.ok(customers.includes(mark), mark);
});
