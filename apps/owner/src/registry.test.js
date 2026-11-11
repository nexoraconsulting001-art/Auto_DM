import fs from 'node:fs';
import path from 'node:path';
import { checkCatalogue } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY, PUBLIC, SIGNED_IN, staffWith } from '@bhava/app-core/access';
import { features, featureByName, shell } from './features/index.js';
import { TABS, buildNavigation, linkTarget, registryProblems, screenName } from './shell/menu.js';
import { APP_NAME, catalogue } from './strings.js';

const { readAppFeatures } = require('../../../tools/parity-read.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const FOLDERS = fs.readdirSync(path.join(__dirname, 'features'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

const EXPECTED = [
  'home', 'automations', 'inbox', 'connect', 'compliance', 'links', 'alerts', 'activity', 'insights', 'reach-guard', 'traffic', 'reports', 'products',
  'imports', 'categories', 'pages', 'themes', 'brand-kit', 'creator', 'leads', 'reels', 'orders', 'payments', 'refunds', 'shipping', 'inventory',
  'coupons', 'invoices', 'returns', 'reviews', 'loyalty', 'customers', 'privacy', 'store-settings', 'shopify', 'settings', 'team', 'devices',
  'notifications', 'audit-log', 'account', 'domains', 'app-publishing', 'billing', 'setup', 'signup', 'ai-replies', 'whatsapp', 'team-feed', 'referrals',
];

const owner = { id: 1, role: 'owner', permissions: [] };
const manager = { id: 2, role: 'manager', permissions: [] };
const ordersStaff = { id: 3, role: 'staff', permissions: ['orders'] };

test('every feature folder is registered, and every registered feature has its folder', () => {
  expect(features.map((f) => f.name).sort()).toEqual(FOLDERS);
  expect(FOLDERS).toEqual([...EXPECTED].sort());
  for (const name of FOLDERS) expect(featureByName[name].name).toBe(name);
});

test('every feature has the registry’s shape: access, entitlement, route ids, a screen and strings', () => {
  expect(registryProblems(features)).toEqual([]);
  for (const feature of features) expect(Object.keys(feature).sort()).toEqual(['access', 'feature', 'name', 'nav', 'routeIds', 'screens', 'strings']);
});

test('the registry check names what is wrong with a feature', () => {
  const Screen = () => null;
  const good = { name: 'widgets', access: SIGNED_IN, feature: null, routeIds: [], screens: [{ name: 'index', path: 'widgets', title: 'widgets.title', component: Screen }], nav: null, strings: {} };
  expect(registryProblems([good])).toEqual([]);
  const problems = registryProblems([
    good,
    { ...good, screens: [{ name: 'index', path: 'widgets', title: 'widgets.title', component: Screen }] },
    { ...good, name: 'Other', access: { anyone: true }, feature: '', routeIds: ['a', 'a'], screens: [], nav: { label: 'x' }, strings: { en: { 'wrong.key': 'x' } } },
  ]).join('\n');
  for (const expected of ['two features have this name', 'path "widgets" is also', 'name must be the folder', 'access must come from', 'entitlement name or null', 'lists something twice', 'at least one screen', 'nav is null, or has', 'must start with "Other."']) {
    expect(problems).toContain(expected);
  }
});

test('features use the console’s access rules for the same area', () => {
  expect(featureByName.orders.access).toEqual(staffWith('orders'));
  expect(featureByName.products.access).toEqual(staffWith('catalog'));
  expect(featureByName.automations.access).toEqual(staffWith('automations'));
  expect(featureByName.inbox.access).toEqual(staffWith('inbox'));
  expect(featureByName.insights.access).toEqual(staffWith('analytics'));
  expect(featureByName.customers.access).toEqual(staffWith('customers'));
  expect(featureByName.payments.access).toBe(MANAGERS);
  expect(featureByName.team.access).toBe(OWNER_ONLY);
  expect(featureByName['audit-log'].access).toBe(OWNER_ONLY);
  expect(featureByName.home.access).toBe(SIGNED_IN);
  expect(featureByName.signup.access).toBe(PUBLIC);
});

test('what the parity check reads from the files is what the app registers', () => {
  const read = readAppFeatures(ROOT);
  expect(read.problems).toEqual([]);
  const fromFiles = Object.fromEntries(read.features.map((f) => [f.name, f.routeIds]));
  for (const feature of features) expect([feature.name, fromFiles[feature.name]]).toEqual([feature.name, feature.routeIds]);
  expect(fromFiles.shell).toEqual(shell.routeIds);
  expect(Object.keys(fromFiles).sort()).toEqual([...FOLDERS, 'shell'].sort());
});

test('every menu label and screen title has a line in English and in Hindi', () => {
  expect(checkCatalogue(catalogue)).toEqual([]);
  for (const feature of features) {
    for (const key of [feature.nav?.label, ...feature.screens.map((s) => s.title)].filter(Boolean)) {
      expect([key, typeof catalogue.en[key], typeof catalogue.hi[key]]).toEqual([key, 'string', 'string']);
    }
  }
  expect(APP_NAME).toBe('Bhava for Business');
});

test('an owner gets four tabs and the rest under More; later-phase features have no menu entry', () => {
  const nav = buildNavigation(features, { user: owner, entitlements: null });
  expect(nav.tabs.map((f) => f.name)).toEqual(['home', 'orders', 'products', 'reels']);
  const more = nav.more.map((f) => f.name);
  for (const name of ['automations', 'inbox', 'insights', 'payments', 'team', 'settings', 'audit-log']) expect(more).toContain(name);
  for (const name of ['billing', 'app-publishing', 'signup', 'setup', 'ai-replies', 'whatsapp', 'team-feed', 'referrals']) expect(more).not.toContain(name);
  expect(nav.screens.map((s) => s.name)).toContain('billing.index'); // registered, so a deep link can open it once built
});

test('staff see only what their permissions allow, and a plan can hide a feature', () => {
  const nav = buildNavigation(features, { user: ordersStaff, entitlements: null });
  expect(nav.tabs.map((f) => f.name)).toEqual(['home', 'orders']);
  const all = [...nav.tabs, ...nav.more].map((f) => f.name);
  for (const name of ['returns', 'refunds', 'invoices', 'alerts', 'notifications', 'devices', 'account']) expect(all).toContain(name);
  for (const name of ['products', 'automations', 'payments', 'team', 'settings', 'insights', 'customers', 'audit-log']) expect(all).not.toContain(name);
  expect(nav.screens.some((s) => s.feature === 'payments')).toBe(false);

  const managerNav = buildNavigation(features, { user: manager, entitlements: { automations: false, 'store.payments': false } });
  const managerAll = [...managerNav.tabs, ...managerNav.more].map((f) => f.name);
  expect(managerAll).not.toContain('automations');
  expect(managerAll).not.toContain('payments');
  expect(managerAll).not.toContain('team'); // owner only
  expect(managerAll).toContain('settings');
});

test('a link opens the screen with that path, only for someone who may open it', () => {
  const nav = buildNavigation(features, { user: owner, entitlements: null });
  expect(linkTarget('/orders', nav)).toEqual([TABS, { screen: 'orders.index', params: {} }]);
  expect(linkTarget('/', nav)).toEqual([TABS, { screen: 'home.index', params: {} }]);
  expect(linkTarget('/payments', nav)).toEqual(['payments.index', {}]);
  expect(linkTarget('/nothing-here', nav)).toBeNull();
  const staffNav = buildNavigation(features, { user: ordersStaff, entitlements: null });
  expect(linkTarget('/payments', staffNav)).toBeNull();
  expect(screenName(featureByName.orders, featureByName.orders.screens[0])).toBe('orders.index');
});

test('a new feature with a record screen is reachable by link without touching the shell', () => {
  const List = () => null;
  const Detail = () => null;
  const widgets = {
    name: 'widgets', access: SIGNED_IN, feature: null, routeIds: [], nav: { label: 'widgets.title', order: 5 }, strings: {},
    screens: [{ name: 'index', path: 'widgets', title: 'widgets.title', component: List }, { name: 'detail', path: 'widgets/:id', title: 'widgets.title', component: Detail }],
  };
  const nav = buildNavigation([...features, widgets], { user: ordersStaff, entitlements: null });
  expect(linkTarget('/widgets/12', nav)).toEqual(['widgets.detail', { id: '12' }]);
  expect(nav.more.map((f) => f.name)).toContain('widgets');
});
