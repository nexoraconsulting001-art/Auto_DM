/**
 * The shopper app's browsing screens against the server's contract, and the rules they must keep that a source check can
 * prove: the client reads answers shaped exactly as the contract's schemas say; every deep link the screens take is one the
 * server lists; nothing the browsing code owns names the platform, asks for sign-in or notifications, or runs seller text
 * as markup. The rendered screens are tested with jest beside the code (apps/shopper/src/shell/browse.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_LINK_PATHS, isAppLinkPath } from '../../../src/contracts/apps.js';
import { AppCatalogQuery, AppCategory, AppHome, AppPolicy, AppProduct, AppReels, AppLanding, STORE_ROUTES, APP_ROUTES } from '../../../src/contracts/store-routes.js';
import { ROUTES, createBrowse, createStoreClient, formatPaise } from '../../../packages/store-client/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNED = ['apps/shopper/src/shell', 'apps/shopper/src/features/home', 'apps/shopper/src/features/catalog', 'apps/shopper/src/features/reels', 'apps/shopper/src/features/category',
  'apps/shopper/src/features/product', 'apps/shopper/src/features/search', 'apps/shopper/src/features/legal', 'packages/store-client/src'];
const SKIP = /(\.test\.js|menu\.js)$/;

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith('.js') && !SKIP.test(rel)) out.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
    }
  };
  OWNED.forEach(walk);
  return out.filter((f) => !f.rel.endsWith('routes.js'));
}

const card = (slug, over = {}) => ({ id: 1, slug, name: `Item ${slug}`, pricePaise: 129900, comparePaise: null, image: `/media/${slug}.jpg`, inStock: true, rating: null, ratingCount: 0, ...over });
const reel = (slug, over = {}) => ({ slug, title: `Reel ${slug}`, image: `/media/${slug}.jpg`, videoUrl: null, pinned: false, productCount: 1, ...over });
const cat = { slug: 'pots', name: 'Pots', image: '' };

const ANSWERS = {
  '/api/store/app/home': { schema: AppHome, body: { blocks: [{ type: 'hero', settings: {} }, { type: 'shelves', settings: {} }], categories: [cat], reels: [reel('a'), reel('b', { pinned: true })], products: [card('p1')] } },
  '/api/store/app/categories/pots': { schema: AppCategory, body: { category: cat, reels: [reel('x'), reel('y', { pinned: true })], products: { items: [card('p1')], nextCursor: 'c2' } } },
  '/api/store/app/reels': { schema: AppReels, body: { chips: [cat], items: [reel('a'), reel('b', { pinned: true })], nextCursor: null } },
  '/api/store/app/landing/a': { schema: AppLanding, body: { slug: 'a', title: 'A', media: { kind: 'video', url: 'https://cdn.example/a.mp4', poster: '/media/a.jpg' }, products: [card('p1')], moreReels: [reel('b')] } },
  '/api/store/app/products/p1': { schema: AppProduct, body: { ...card('p1'), description: 'Text', images: ['/m/1.jpg'], options: [{ name: 'Size', values: ['S', 'L'] }], variants: [{ id: 5, option: 'S', pricePaise: 100, inStock: true, image: '' }], maxQty: 5, reels: [] } },
  '/api/store/app/policies/refund': { schema: AppPolicy, body: { kind: 'refund', title: 'Refunds', body: 'Seven days.', updatedAt: null } },
};

function browseOver(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ pathname, headers: init.headers });
    const found = answers[pathname];
    return found ? { ok: true, status: 200, json: async () => found.body } : { ok: false, status: 404, json: async () => ({ error: 'Not found', code: 'not_found' }) };
  };
  return { browse: createBrowse(createStoreClient({ origin: 'https://shop.example', tenantId: 4, version: '1.0.0', platform: 'ios', fetch })), calls };
}

test('the answers the screens read are shaped as the contract says, and the client reads them', async () => {
  for (const [route, { schema, body }] of Object.entries(ANSWERS)) assert.ok(schema.safeParse(body).success, `${route} fixture matches the contract`);
  assert.ok(AppCatalogQuery.safeParse({ q: 'pot', sort: 'price-asc', limit: 24 }).success);
  const { browse, calls } = browseOver(ANSWERS);
  const home = await browse.home();
  assert.deepEqual(home.reels.map((r) => r.slug), ['b', 'a']);
  assert.equal(home.products[0].image, 'https://shop.example/media/p1.jpg');
  const category = await browse.category('pots');
  assert.deepEqual(category.reels.map((r) => r.slug), ['y', 'x']);
  assert.equal(category.products.nextCursor, 'c2');
  assert.equal((await browse.landing('a')).media.url, 'https://cdn.example/a.mp4');
  assert.equal((await browse.product('p1')).pricePaise, 129900);
  assert.equal((await browse.policy('refund')).body, 'Seven days.');
  assert.ok(calls.every((c) => !c.headers.authorization), 'browsing sends no token');
  assert.ok(calls.every((c) => c.headers['x-app-tenant'] === '4'));
});

test('every route the browse client calls is in the contract and in the client’s own table', () => {
  const needed = ['appBootstrap', 'appHome', 'appCatalog', 'appCategories', 'appCategory', 'appReels', 'appLanding', 'appProduct', 'appPolicy'];
  for (const id of needed) {
    assert.ok(APP_ROUTES[id] ?? STORE_ROUTES[id], `${id} in the contract`);
    assert.equal(ROUTES[id].path, (APP_ROUTES[id] ?? STORE_ROUTES[id]).path);
  }
});

test('a price is only formatted: the paise the server sent are what is shown', () => {
  assert.equal(formatPaise(49900), '₹499');
  assert.equal(formatPaise(129999), '₹1,299.99');
  assert.equal(formatPaise(4.5), '');
});

test('every screen a link opens is on the server’s list, and every link screen is one the browsing code registered', () => {
  const found = [];
  for (const name of ['home', 'catalog', 'reels', 'category', 'product', 'search', 'legal']) {
    const text = fs.readFileSync(path.join(ROOT, `apps/shopper/src/features/${name}/index.js`), 'utf8');
    for (const m of text.matchAll(/path: '([^']*)'[^}]*?(link: true)?\s*\}/g)) found.push({ name, path: m[1], link: Boolean(m[2]) });
  }
  assert.ok(found.length >= 8);
  for (const screen of found.filter((s) => s.link)) {
    const url = `/${screen.path.split('/').map((part) => (part.startsWith(':') ? 'sample' : part)).join('/')}`;
    assert.ok(isAppLinkPath(url), `${screen.name}: ${url} is a path the server lists`);
  }
  for (const screen of found.filter((s) => !s.link)) {
    const url = `/${screen.path.split('/').map((part) => (part.startsWith(':') ? 'sample' : part)).join('/')}`;
    assert.ok(!isAppLinkPath(url) || screen.path === 'search', `${screen.name}: ${url} is opened from inside the app`);
  }
  assert.ok(APP_LINK_PATHS.open.includes('/shop') && APP_LINK_PATHS.open.includes('/reels'));
});

test('nothing the browsing code owns names the platform, in a line, an error or a host', () => {
  for (const { rel, text } of sources()) {
    const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !/from '@bhava\//.test(line)).join('\n');
    assert.ok(!/bhava/i.test(code.replace(/@bhava\/[a-z-]+(\/[a-z-]+)?/g, '')), `${rel} spells the platform’s name`);
  }
});

test('browsing never asks for sign-in or notification permission, shows no web page and runs no seller text as markup', () => {
  for (const { rel, text } of sources()) {
    const client = rel === 'packages/store-client/src/index.js'; // the generic client: it carries a token only when a session gives one
    assert.ok(!/expo-notifications|requestPermissions|registerForPush|react-native-webview|WebView|dangerouslySetInnerHTML|innerHTML|\beval\(|new Function\(/.test(text), `${rel} uses something browsing must not`);
    assert.ok(client || !/features\/sign-in|SecureStore|getAccessToken/.test(text), `${rel} reaches for a session`);
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(text), `${rel} logs`);
    assert.ok(client || !/\bfetch\(/.test(text), `${rel} calls the network directly`);
  }
});

test('no link the browsing code builds goes through a redirect or shortener', () => {
  for (const { rel, text } of sources()) assert.ok(!/['"`]\/(go|l|click|redirect)\//.test(text), rel);
});
