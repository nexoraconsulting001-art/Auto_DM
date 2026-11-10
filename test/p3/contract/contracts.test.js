// What the Phase 3 tracks build against: the requirement list, the module folders, the API contract and the shared rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@bhava/api-client';
import { BulkImport, CreatorPageUpdate, PageBlocksSave, PageCreate, ProductCreate, ProductUpdate, ThemeChoose, platformRouteList, routeList } from '../../../src/contracts/api/index.js';
import { BUYER_ROUTES, RESERVED_PATHS, isReservedPath } from '../../../src/contracts/buyer-pages.js';
import {
  CatalogRuleError, IMPORT_REASONS, canonicalProductUrl, checkMrp, discountPercent, displayPrice, fillWhatsappText, formatRupees, isSiteRoot, parseRupees,
  whatsappDigits, whatsappOrderLink, whatsappTarget,
} from '../../../src/contracts/catalog.js';
import { FALLBACK_SLOTS, PresetSlots, resolveSlots } from '../../../src/contracts/themes.js';
import { MODULES } from '../../../src/modules/index.js';
import { OWNER, setup, startApp } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p3.json'), 'utf8'));
const signIn = async (base, who = OWNER) => (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })).json()).token;

const PHASE3_OWNERS = {
  catalogSettings: 'catalog', imports: 'imports', importItems: 'imports', pages: 'pages', pageSettings: 'pages', pageBlocks: 'pages',
  themes: 'themes', categoryRules: 'categories', creator: 'creator', leads: 'leads', leadForms: 'leads', leadDownloads: 'leads',
};
const PHASE3_IDS_IN_OLD_GROUPS = { 'products.recheck': 'catalog', 'categories.reorder': 'categories', 'categories.reels': 'categories', 'categories.setReels': 'categories', 'categories.addReel': 'categories', 'categories.removeReel': 'categories', 'categories.pin': 'categories', 'categories.unpin': 'categories', 'categories.schedule': 'categories', 'categories.rules': 'categories', 'categories.addRule': 'categories' };

test('requirements/p3.json lists every K scenario of PRD 8 and F-96 to F-107 once, with a short title', () => {
  const ids = requirements.map((r) => r.id);
  assert.equal(ids.length, 76);
  assert.equal(new Set(ids).size, 76);
  const k = Array.from({ length: 64 }, (_, i) => `K-${String(i + 1).padStart(2, '0')}`);
  const f = Array.from({ length: 12 }, (_, i) => `F-${96 + i}`);
  assert.deepEqual([...ids].sort(), [...k, ...f].sort());
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.ok(r.title.length > 0 && r.title.length <= 80, r.id);
  }
  const p0 = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p0.json'), 'utf8')).map((r) => r.id);
  assert.deepEqual(ids.filter((id) => p0.includes(id)), [], 'brand kit ids stay in p0.json');
});

test('each Phase 3 track has its module folder, listed after traffic and before admin-api', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of ['catalog', 'imports', 'pages', 'themes', 'categories', 'creator', 'leads']) {
    assert.ok(names.includes(name), name);
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(names.indexOf(name) > names.indexOf('traffic'), `${name} after traffic, so its pages are counted`);
    assert.ok(names.indexOf(name) < names.indexOf('admin-api'), `${name} before admin-api`);
  }
  assert.equal(new Set(names).size, names.length);
});

test('every Phase 3 route belongs to the module named for it', () => {
  const answers = new Map(MODULES.flatMap((m) => Object.keys(m.api?.({ repos: {}, config: {}, ig: {}, auth: {} }) ?? {}).map((id) => [id, m.name])));
  const phase3 = routeList.filter((r) => PHASE3_OWNERS[r.id.split('.')[0]] || PHASE3_IDS_IN_OLD_GROUPS[r.id]);
  assert.equal(phase3.length, 55, `found ${phase3.length}`);
  for (const route of phase3) assert.equal(answers.get(route.id), PHASE3_OWNERS[route.id.split('.')[0]] ?? PHASE3_IDS_IN_OLD_GROUPS[route.id], route.id);
  for (const id of ['products.list', 'products.create', 'products.get', 'products.update', 'products.remove', 'categories.list', 'categories.get']) {
    assert.equal(answers.get(id), 'admin-api', `${id} stays with admin-api; Phase 3 replaces it through takesOver`);
  }
});

test('the client has every Phase 3 route with its method and path', async () => {
  const calls = [];
  const client = createApiClient({ fetch: async (url, options) => { calls.push({ url, ...options }); return new Response(options.method === 'DELETE' ? null : '{}', { status: options.method === 'DELETE' ? 204 : 200 }); } });
  for (const route of routeList.filter((r) => PHASE3_OWNERS[r.id.split('.')[0]] || PHASE3_IDS_IN_OLD_GROUPS[r.id])) {
    const [group, name] = route.id.split('.');
    assert.equal(typeof client[group]?.[name], 'function', route.id);
  }
  await client.imports.csv(new Blob(['title,url\n']));
  assert.ok(calls[0].body instanceof FormData);
});

test('a Phase 3 route not built yet answers 501, and the Phase 0 catalog still answers', async () => {
  const app = await startApp();
  try {
    const token = await signIn(app.base);
    const headers = { authorization: `Bearer ${token}` };
    for (const path of ['/pages', '/theme', '/leads', '/creator-page', '/catalog/settings', '/imports']) {
      const res = await fetch(`${app.base}/api/v1${path}`, { headers });
      assert.equal(res.status, 501, path);
      assert.equal((await res.json()).code, 'not_implemented', path);
    }
    const created = await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Brass pot', pricePaise: 49900, mrpPaise: 59900 }) });
    assert.equal(created.status, 201);
    const product = await created.json();
    assert.equal(product.inStock, true, 'Phase 3 fields come back with their defaults from the Phase 0 handler');
    assert.equal(product.fetchStatus, 'none');
    const refused = await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pot', pricePaise: 129900, mrpPaise: 99900 }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).fields.mrpPaise, 'MRP can’t be lower than the price', 'K-02');
  } finally {
    app.close();
  }
});

test('takesOver replaces an admin-api handler, and refuses an id admin-api lacks or two takers', async () => {
  const probe = (name, ids) => ({ name, takesOver: () => Object.fromEntries(ids.map((id) => [id, () => ({ items: [], nextCursor: null })])) });
  const app = await startApp({ modules: [...MODULES.filter((m) => m.name !== 'catalog'), probe('catalog', ['products.list'])] });
  try {
    const token = await signIn(app.base);
    await app.repos.products.create({ name: 'Hidden', price: '10', active: 'on' });
    const res = await fetch(`${app.base}/api/v1/products`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await res.json()).items, [], 'the taker answered');
  } finally {
    app.close();
  }
  await assert.rejects(() => startApp({ modules: [...MODULES, probe('stray', ['imports.link'])] }), /doesn't answer/);
  await assert.rejects(() => startApp({ modules: [...MODULES, probe('one', ['products.get']), probe('two', ['products.get'])] }), /both take over/);
});

test('Platform Console routes for Phase 3 are the same kind of thing as the others', () => {
  const ids = platformRouteList.map((r) => r.id);
  for (const id of ['platform.siteAdapters', 'platform.setSiteAdapter', 'platform.themePresets', 'platform.saveThemePreset', 'platform.customisationRequests', 'platform.createCustomisationRequest', 'platform.decideCustomisationRequest']) assert.ok(ids.includes(id), id);
});

test('money: rupees as people write them become paise exactly; negatives and junk are refused', () => {
  const cases = [[1299, 129900], ['1299', 129900], ['1,299', 129900], ['₹1,299.00', 129900], ['₹ 1,299', 129900], ['Rs. 1,299', 129900], ['INR 499', 49900], ['499/-', 49900], ['1,29,900.50', 12990050], ['0.1', 10], ['19.99', 1999], ['﻿349', 34900], [0, 0]];
  for (const [input, paise] of cases) assert.equal(parseRupees(input), paise, String(input));
  assert.equal(parseRupees(''), null);
  assert.equal(parseRupees(null), null);
  for (const bad of ['-5', '₹-10', '(10)', -1]) assert.throws(() => parseRupees(bad), (e) => e instanceof CatalogRuleError && e.code === 'negative_price', String(bad));
  for (const bad of ['abc', '1.234', '1e5', '12,,3', NaN, Infinity, '99999999999999999999']) assert.throws(() => parseRupees(bad), (e) => e.code === 'bad_price', String(bad));
  assert.equal(formatRupees(129900), '₹1,299');
  assert.equal(formatRupees(12990050), '₹1,29,900.50');
  assert.equal(formatRupees(34900), '₹349');
});

test('K-02 and K-03: an MRP below the price is refused, an equal one is not kept, and a card shows the lowest in-stock variant', () => {
  assert.throws(() => checkMrp(129900, 99900), (e) => e.message === 'MRP can’t be lower than the price');
  assert.equal(checkMrp(129900, 129900), null);
  assert.equal(checkMrp(129900, 199900), 199900);
  assert.equal(discountPercent(489900, 749900), 35);
  assert.equal(discountPercent(100, null), null);
  const shown = displayPrice({ price_paise: 1, mrp_paise: null }, [{ price_paise: 49900, mrp_paise: null, in_stock: false }, { price_paise: 59900, mrp_paise: 79900, in_stock: true }]);
  assert.deepEqual(shown, { pricePaise: 59900, mrpPaise: 79900, soldOut: false });
  assert.equal(displayPrice({}, [{ price_paise: 500, in_stock: false }]).soldOut, true);
  assert.equal(ProductCreate.safeParse({ name: 'x', pricePaise: 129900, mrpPaise: 99900 }).success, false);
  assert.equal(ProductUpdate.safeParse({ variants: [{ pricePaise: 500, mrpPaise: 400 }] }).success, false);
});

test('K-11: one product page pasted two ways is one address; a site root is recognised', () => {
  assert.equal(canonicalProductUrl('https://WWW.Shop.example/products/pot/?utm_source=ig&fbclid=x#reviews'), 'https://shop.example/products/pot');
  assert.equal(canonicalProductUrl('https://shop.example/products/pot?variant=123'), 'https://shop.example/products/pot');
  assert.equal(canonicalProductUrl('https://shop.example/p?id=2&b=1'), 'https://shop.example/p?b=1&id=2');
  assert.equal(canonicalProductUrl('javascript:alert(1)'), null);
  assert.equal(canonicalProductUrl('https://u:p@shop.example/'), null);
  assert.equal(isSiteRoot('https://shop.example/'), true);
  assert.equal(isSiteRoot('https://shop.example/products/pot'), false);
});

test('K-35 to K-37: the WhatsApp button goes straight to wa.me with the name, price and link, encoded', () => {
  assert.equal(whatsappDigits('+91 93200 01717'), '919320001717');
  assert.equal(whatsappDigits('12'), null);
  const link = whatsappOrderLink({ number: '+91 93200 01717', template: 'Hi, I would like {product} ({price}). {url} {constructor}', productName: 'Steel & Brass #2', pricePaise: 34900, url: 'https://shop.example/r/bottles' });
  assert.ok(link.startsWith('https://wa.me/919320001717?text='));
  const text = decodeURIComponent(link.split('?text=')[1]);
  assert.equal(text, 'Hi, I would like Steel & Brass #2 (₹349). https://shop.example/r/bottles {constructor}');
  assert.doesNotMatch(link.split('?text=')[1], /[&#\s]/, 'every & # and space is encoded');
  assert.equal(whatsappOrderLink({ number: '', template: '{product}', productName: 'x', pricePaise: 1, url: '' }), null);
  assert.equal(fillWhatsappText('{toString} {product}', { product: 'Pot' }), '{toString} Pot');
  assert.equal(whatsappTarget(12), 'wa-12');
});

test('K-20: a paste of 26 links is refused with the limit message', () => {
  const urls = Array.from({ length: 26 }, (_, i) => `https://shop.example/p/${i}`);
  const parsed = BulkImport.safeParse({ urls });
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.issues[0].message, IMPORT_REASONS.too_many_links);
  assert.equal(BulkImport.safeParse({ urls: urls.slice(0, 25) }).success, true);
  for (const bad of ['https://x.example/\uD800', 'https://x.example/a\u0000b', 'https://x.example/a b']) {
    assert.equal(BulkImport.safeParse({ urls: [bad] }).success, false, JSON.stringify(bad));
    assert.equal(ProductCreate.safeParse({ name: 'Pot', pricePaise: 100, externalUrl: bad }).success, false, JSON.stringify(bad));
  }
});

test('preset slots are names, never CSS, and every seeded preset passes the schema', async () => {
  const { db } = await setup();
  const presets = await db.query('SELECT code, slots FROM theme_presets ORDER BY position');
  assert.deepEqual(presets.map((p) => p.code), ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti']);
  for (const p of presets) assert.equal(PresetSlots.safeParse(p.slots).success, true, p.code);
  assert.equal(PresetSlots.safeParse({ ...presets[0].slots, reelFrame: 'border:0;}</style><script>' }).success, false);
  assert.equal(PresetSlots.safeParse({ ...presets[0].slots, sealText: 'x</style>' }).success, false);
  const resolved = resolveSlots({ reelFrame: 'nonsense', cardStyle: 'panel' }, { sealText: 'Handmade in Kutch' });
  assert.equal(resolved.reelFrame, FALLBACK_SLOTS.reelFrame);
  assert.equal(resolved.cardStyle, 'panel');
  assert.equal(resolved.sealText, 'Handmade in Kutch');
  assert.equal(ThemeChoose.safeParse({ preset: 'x;drop' }).success, false);
});

test('buyer routes are listed with their owners, and no creator page can take a path the app uses', () => {
  for (const [id, route] of Object.entries(BUYER_ROUTES)) {
    assert.ok(['pages', 'categories', 'creator', 'leads'].includes(route.owner), id);
    assert.match(route.path, /^\//, id);
    assert.doesNotMatch(route.path, /bhava|\/go\/|^\/l\//i, id);
    const first = route.path.split('/')[1];
    if (!first.startsWith(':')) assert.ok(isReservedPath(first), `${first} is reserved`);
  }
  for (const segment of ['admin', 'api', 'r', 'c', 'p', 'reels', 'shop', 'lead', 'media', '_t', 'go', 'l', 'bhava']) assert.ok(RESERVED_PATHS.includes(segment), segment);
  assert.equal(CreatorPageUpdate.safeParse({ slug: 'admin' }).success, false);
  assert.equal(CreatorPageUpdate.safeParse({ slug: 'Priya' }).data.slug, 'priya');
  assert.equal(PageCreate.safeParse({ kind: 'reel', mediaId: '1789', productIds: [] }).success, false, 'a page needs a product');
  assert.equal(PageBlocksSave.safeParse({ surface: 'creator', blocks: [{ block: 'products' }] }).success, false, 'a block only where it may go');
});
