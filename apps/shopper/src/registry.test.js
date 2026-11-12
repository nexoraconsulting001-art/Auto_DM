/** The feature registry: twenty folders, each registered, each in the registry's shape, with no admin screen among them. */
import fs from 'node:fs';
import path from 'node:path';
import { featureByName, features } from './features/index.js';
import { MAX_TABS, checkFeature, linkPathsOf, linkPattern, linkingOf, screenName, tabsOf } from './shell/menu.js';
import { catalogueOf, shellStrings } from './strings.js';

const FOLDERS = ['home', 'catalog', 'reels', 'category', 'product', 'search', 'cart', 'checkout', 'payment', 'orders', 'tracking', 'account', 'sign-in', 'notifications', 'rewards', 'wishlist', 'reviews', 'returns', 'addresses', 'legal'];
const DIR = path.join(__dirname, 'features');

test('every feature folder is registered, and every registered feature has its folder', () => {
  const folders = fs.readdirSync(DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  expect(folders).toEqual([...FOLDERS].sort());
  expect(features.map((feature) => feature.name).sort()).toEqual(folders);
  expect(Object.keys(featureByName).sort()).toEqual(folders);
});

test('every feature exports { name, screens, nav } in the registry’s shape', () => {
  for (const feature of features) {
    expect(checkFeature(feature)).toEqual([]);
    expect(feature).toEqual(expect.objectContaining({ name: expect.any(String), screens: expect.any(Array) }));
    expect('nav' in feature).toBe(true);
  }
});

test('the registry check names what is wrong with a feature', () => {
  const Screen = () => null;
  expect(checkFeature({ name: 'Bad Name', screens: [], nav: null })).toEqual(['a feature has no usable name (Bad Name)']);
  expect(checkFeature({ name: 'x', screens: [], nav: null })).toEqual(['x: needs at least one screen']);
  const problems = checkFeature({
    name: 'x',
    screens: [{ name: 'index', path: '/x', title: 'x.title', component: Screen }, { name: 'index', path: 'x', title: '', component: null, link: 'yes' }],
    nav: { label: 'x.title' },
    strings: { en: { 'y.title': 'Y' } },
    service: 1,
  });
  expect(problems).toEqual([
    "x.index: path must look like 'p/:slug'", 'x: two screens are named index', 'x.index: needs a title key', 'x.index: needs a component', 'x.index: link is true or false',
    'x: nav is null, or { label, order, icon }', 'x: the string key y.title must start with "x."', 'x: service is a function',
  ]);
});

test('screen names are unique across the app', () => {
  const names = features.flatMap((feature) => feature.screens.map((screen) => screenName(feature, screen)));
  expect(new Set(names).size).toBe(names.length);
});

test('the tabs are home, shop, reels, cart and account, in that order', () => {
  expect(tabsOf(features).map((feature) => feature.name)).toEqual(['home', 'catalog', 'reels', 'cart', 'account']);
  expect(tabsOf(features).length).toBeLessThanOrEqual(MAX_TABS);
});

test('there are no admin screens and no seller words in the registry', () => {
  for (const feature of features) {
    expect(feature.access).toBeUndefined();
    expect(feature.routeIds).toBeUndefined();
    for (const screen of feature.screens) expect(screen.path).not.toMatch(/admin|console|settings\/payment|team/);
  }
});

test('every menu label and screen title has a line in English and in Hindi', () => {
  const catalogue = catalogueOf(features);
  const keys = [...features.flatMap((feature) => [feature.nav?.label, ...feature.screens.map((screen) => screen.title)]).filter(Boolean), ...Object.keys(shellStrings.en)];
  for (const key of keys) {
    expect(catalogue.en[key]).toEqual(expect.any(String));
    expect(catalogue.hi[key]).toEqual(expect.any(String));
  }
  expect(Object.keys(catalogue.en).sort()).toEqual(Object.keys(catalogue.hi).sort());
});

test('a feature’s lines never replace the shell’s', () => {
  const catalogue = catalogueOf([{ name: 'pending', strings: { en: { 'pending.body': 'replaced' }, hi: {} } }]);
  expect(catalogue.en['pending.body']).toBe(shellStrings.en['pending.body']);
});

test('link patterns are the server’s: params become *, home is /', () => {
  expect(linkPattern('')).toBe('/');
  expect(linkPattern('p/:slug')).toBe('/p/*');
  expect(linkPattern('account/orders/:orderNumber')).toBe('/account/orders/*');
  const paths = linkPathsOf(features);
  expect(new Set(paths).size).toBe(paths.length);
  expect([...paths].sort()).toEqual(['/', '/account/orders/*', '/c/*', '/cart', '/order/*', '/p/*', '/r/*', '/reels', '/refer/*', '/shop', '/track/*']);
  for (const hidden of ['/checkout', '/sign-in', '/account', '/account/delete']) expect(paths).not.toContain(hidden);
});

test('links open on the brand’s scheme and its own hosts, and only screens marked link are reachable', () => {
  const linking = linkingOf(features, { scheme: 'shopone', linkHosts: ['shop.one.example', 'www.one.example'] });
  expect(linking.prefixes).toEqual(['shopone://', 'https://shop.one.example', 'https://www.one.example']);
  expect(linking.config.screens.tabs.screens).toEqual({ 'home.index': '', 'catalog.index': 'shop', 'reels.index': 'reels', 'cart.index': 'cart' });
  expect(linking.config.screens['product.index']).toBe('p/:slug');
  expect(linking.config.screens['orders.byToken']).toBe('order/:token');
  expect(linking.config.screens['checkout.index']).toBeUndefined();
  expect(linking.config.screens['account.delete']).toBeUndefined();
});
