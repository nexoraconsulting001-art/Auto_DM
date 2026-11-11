// PRD 9.1: the storefront on each business's own host, the reel order of 8.13 on the store's pages, the home-screen app,
// and 9.18's policy pages. S-01 to S-03, S-61, S-62, S-65 to S-67.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP4Shop, assertBranded404, assertBuyerPageClean, assertNoLiveMarkup, buyer, hit, need, noCrash, noPlatformName, productIdsOf, reelSlugsOf, textOf, unique, useP4World } from './kit.js';

const world = useP4World();
const plain = { whatsapp: false, pay: false, pickup: false, notice: false };

test('S-01: each store shows only its own brand and products, and neither names the platform', async () => {
  const a = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const b = await addP4Shop(world, { ...plain, name: 'Brass Bazaar' });
  const pa = await a.item({ name: 'Monstera in clay pot' });
  const pb = await b.item({ name: 'Temple bell large' });
  for (const path of ['/', '/shop', '/about', '/search?q=bell', '/reels', '/cart', '/wishlist', '/login', '/offline']) {
    const ra = await assertBuyerPageClean(world, a, path);
    const rb = await assertBuyerPageClean(world, b, path);
    assert.ok(!ra.text.includes('Brass Bazaar') && !ra.text.includes('Temple bell'), `${path} on A shows B`);
    assert.ok(!rb.text.includes('Leafy Corner') && !rb.text.includes('Monstera'), `${path} on B shows A`);
  }
  const shopA = await a.open('/shop');
  assert.ok(shopA.text.includes('Leafy Corner') && shopA.text.includes('Monstera in clay pot'));
  assert.deepEqual(productIdsOf(shopA.text).filter((id) => id === pb.id && pb.id !== pa.id), [], 'B product card on A');
  await assertBuyerPageClean(world, a, `/p/${pa.slug}`);
});

test('S-01: another business product address answers this store’s own 404, and the lookup call never returns it', async () => {
  const a = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const b = await addP4Shop(world, { ...plain, name: 'Brass Bazaar' });
  const pa = await a.item({ name: 'Monstera only at A' });
  await b.item({ name: 'Bell only at B' });
  assertBranded404(await b.open(`/p/${pa.slug}`), b, 'A product slug on B');
  const lookup = noCrash(await buyer(world, b).api('GET', `/api/store/products?ids=${pa.id}`), 'Looking up another business product');
  assert.ok(!lookup.text.includes('Monstera only at A'), 'The lookup returned another business’s product');
});

test('S-01: an inactive product is not shown, and a sold-out one cannot be put in the bag', async () => {
  const shop = await addP4Shop(world, plain);
  const off = await shop.item({ name: 'Hidden lamp', active: false });
  const gone = await shop.item({ name: 'Last season kurta', stock: 0 });
  const page = need(await shop.open('/shop'), 200, 'The shop page');
  assert.ok(!page.text.includes('Hidden lamp'), 'An inactive product is listed');
  assertBranded404(await shop.open(`/p/${off.slug}`), shop, 'An inactive product page');
  const b = buyer(world, shop);
  const quote = noCrash(await b.quote({ lines: [{ productId: gone.id, qty: 1 }], address: undefined }), 'Quoting a sold-out product');
  if (quote.status === 200) assert.equal(quote.data.lines[0].state, 'sold_out');
  const placed = await b.place(b.checkoutBody({ lines: [{ productId: gone.id, qty: 1 }] }));
  assert.ok(placed.status >= 400 && placed.status < 500, `A sold-out product was ordered: ${placed.status}`);
  assert.equal((await shop.orders()).length, 0);
});

test('S-02: search matches a SKU, a name and a tag, inside one business', async () => {
  const shop = await addP4Shop(world, plain);
  const other = await addP4Shop(world, plain);
  const bySku = await shop.item({ name: 'Cotton tunic', options: [{ name: 'Size', values: ['M'] }], variants: [{ optionValues: ['M'], sku: 'KURTI-12', pricePaise: 49900 }] });
  const byTag = await shop.item({ name: 'Festive set', tags: ['kurti'] });
  const byName = await shop.item({ name: 'Blue Kurti' });
  await shop.item({ name: 'Brass lamp' });
  await other.item({ name: 'Kurti from another store' });
  for (const q of ['kurti', 'KURTI', 'kurti-12']) {
    const res = need(await shop.open(`/search?q=${encodeURIComponent(q)}`), 200, `Searching ${q}`);
    assert.ok(productIdsOf(res.text).includes(bySku.id), `"${q}" did not find the product whose SKU is KURTI-12`);
    assert.ok(!res.text.includes('Kurti from another store'), 'Another business’s product is in the results');
    assert.ok(!res.text.includes('Brass lamp'), 'A product that matches nothing is in the results');
  }
  const res = await shop.open('/search?q=kurti');
  assert.ok(productIdsOf(res.text).includes(byTag.id), 'A tag match is missing');
  assert.ok(productIdsOf(res.text).includes(byName.id), 'A name match is missing');
});

test('S-02: the query is capped at 80 characters and never breaks the page or its markup', async () => {
  const shop = await addP4Shop(world, plain);
  await shop.item({ name: 'Cotton tunic' });
  const long = `${'k'.repeat(80)}ZZZTAIL`;
  const capped = need(await shop.open(`/search?q=${long}`), 200, 'A query over 80 characters');
  assert.ok(!capped.text.includes('ZZZTAIL'), 'Characters past the 80th were used or shown');
  for (const q of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' OR 1=1 --", '%', '_', '\\', '%00', '😀'.repeat(50)]) {
    const res = noCrash(await shop.open(`/search?q=${encodeURIComponent(q)}`), `Searching ${q}`);
    assertNoLiveMarkup(res.text, `Search for ${q}`);
  }
  const all = await shop.open(`/search?q=${encodeURIComponent('%')}`);
  assert.ok(!all.text.includes('Cotton tunic'), 'A % in the query matched everything');
});

test('S-03: a hidden category answers the store’s own 404, and comes back when shown again', async () => {
  const shop = await addP4Shop(world, plain);
  const product = await shop.item({ name: 'Linen kurta' });
  const category = await shop.category('Kurtis');
  await shop.must('PATCH', `/products/${product.id}`, { categoryIds: [category.id] });
  need(await shop.open(`/c/${category.slug}`), 200, 'A visible category');
  await shop.must('PATCH', `/categories/${category.id}`, { visible: false });
  assertBranded404(await shop.open(`/c/${category.slug}`), shop, 'A hidden category');
  const reels = need(await shop.open(`/reels?c=${category.slug}`), [200, 404], 'The Reels tab filtered by a hidden category');
  assert.ok(!textOf((await shop.open('/reels')).text).includes('Kurtis'), 'A hidden category still has a chip on the Reels tab');
  noPlatformName('Reels tab for a hidden category', reels.text);
  const only = await shop.item({ name: 'Only in the hidden category' });
  await shop.must('PATCH', `/products/${only.id}`, { categoryIds: [category.id] });
  assert.ok(!(await shop.open('/shop')).text.includes('Only in the hidden category'), 'A product whose only category is hidden is listed in the shop');
  await shop.must('PATCH', `/categories/${category.id}`, { visible: true });
  need(await shop.open(`/c/${category.slug}`), 200, 'The category shown again');
});

test('S-03: another business category slug is a 404 here', async () => {
  const a = await addP4Shop(world, plain);
  const b = await addP4Shop(world, plain);
  const category = await a.category(`Only A ${unique()}`);
  assertBranded404(await b.open(`/c/${category.slug}`), b, 'A category of another business');
});

async function threeReels(shop) {
  const category = await shop.category('Kurtis');
  const pages = [];
  for (const caption of ['Reel A', 'Reel B', 'Reel C']) pages.push(await shop.page({ caption }));
  const [a, b, c] = pages;
  return { category, a, b, c };
}

test('S-65: the category page and the Reels tab filter follow the set reel order', async () => {
  const shop = await addP4Shop(world, plain);
  const { category, a, b, c } = await threeReels(shop);
  await shop.addToCategory(category.id, [a.id, b.id, c.id]);
  await shop.setOrder(category.id, [c.id, a.id, b.id]);
  const want = [c.slug, a.slug, b.slug];
  const onCategory = reelSlugsOf(need(await shop.open(`/c/${category.slug}`), 200, 'The category page').text);
  assert.deepEqual(onCategory.filter((s) => want.includes(s)), want, 'Category page order');
  const onTab = reelSlugsOf(need(await shop.open(`/reels?c=${category.slug}`), 200, 'The Reels tab filter').text);
  assert.deepEqual(onTab.filter((s) => want.includes(s)), want, 'Reels tab order');
  await shop.setOrder(category.id, [b.id, c.id, a.id]);
  assert.deepEqual(reelSlugsOf((await shop.open(`/c/${category.slug}`)).text).filter((s) => want.includes(s)), [b.slug, c.slug, a.slug], 'A changed order shows at once');
});

test('S-66: moving a reel to the top of one category leaves its place in the others', async () => {
  const shop = await addP4Shop(world, plain);
  const { category: kurtis, a, b, c } = await threeReels(shop);
  const sale = await shop.category('Sale');
  await shop.addToCategory(kurtis.id, [b.id, c.id, a.id]);
  await shop.addToCategory(sale.id, [b.id, c.id, a.id]);
  await shop.setOrder(kurtis.id, [a.id, b.id, c.id]);
  const mine = [a.slug, b.slug, c.slug];
  assert.deepEqual(reelSlugsOf((await shop.open(`/c/${kurtis.slug}`)).text).filter((s) => mine.includes(s)), [a.slug, b.slug, c.slug]);
  assert.deepEqual(reelSlugsOf((await shop.open(`/c/${sale.slug}`)).text).filter((s) => mine.includes(s)), [b.slug, c.slug, a.slug], 'The other category changed too');
  assert.deepEqual(reelSlugsOf((await shop.open(`/reels?c=${sale.slug}`)).text).filter((s) => mine.includes(s)), [b.slug, c.slug, a.slug]);
});

test('S-67: the home-screen app carries the seller’s name, icon and colours, per business', async () => {
  const a = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const b = await addP4Shop(world, { ...plain, name: 'Brass Bazaar' });
  const logo = await a.upload('#17694A', { width: 512, height: 512 });
  await a.must('PATCH', '/brand-kit', { logoUrl: logo });
  const home = need(await a.open('/'), 200, 'Home');
  assert.match(home.text, /<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest/i, 'Home does not link its manifest');
  const res = need(await a.open('/manifest.webmanifest'), 200, 'The manifest');
  assert.match(res.headers['content-type'] ?? '', /manifest\+json|application\/json/);
  const manifest = JSON.parse(res.text);
  assert.equal(manifest.name, 'Leafy Corner');
  assert.ok(manifest.short_name && manifest.short_name.length <= 12 + 'Leafy Corner'.length);
  assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), 'The app does not open on its own');
  assert.match(manifest.theme_color ?? '', /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color ?? '', /^#[0-9a-f]{6}$/i, 'No splash colour');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length, 'No icons');
  for (const icon of manifest.icons) {
    noPlatformName('Icon address', icon.src);
    const file = await hit(world, new URL(icon.src, `https://${a.host}`).pathname, { host: a.host });
    assert.equal(file.status, 200, `Icon ${icon.src} does not load`);
    assert.match(file.headers['content-type'] ?? '', /^image\//);
  }
  assert.ok(manifest.icons.some((i) => /512/.test(i.sizes ?? '')), 'No 512px icon for the splash screen');
  assert.ok((manifest.start_url ?? '/').startsWith('/'), 'start_url leaves this domain');
  noPlatformName('Manifest', res.text);
  noPlatformName('Manifest headers', res.headers);
  const other = JSON.parse(need(await b.open('/manifest.webmanifest'), 200, 'B manifest').text);
  assert.equal(other.name, 'Brass Bazaar');
  assert.notEqual(other.id ?? other.start_url ?? other.name, undefined);
  assert.ok(!JSON.stringify(other).includes('Leafy'), 'B’s manifest carries A');
});

test('S-67: the service worker and the offline page are served per business, in the seller’s brand', async () => {
  const shop = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const sw = need(await shop.open('/sw.js'), 200, 'The service worker');
  assert.match(sw.headers['content-type'] ?? '', /javascript/);
  assert.ok(sw.text.includes('/offline'), 'The service worker never shows the offline page');
  noPlatformName('Service worker', sw.text);
  const offline = await assertBuyerPageClean(world, shop, '/offline');
  assert.ok(offline.text.includes('Leafy Corner'));
  assert.doesNotMatch(sw.headers['service-worker-allowed'] ?? '/', /^https?:/, 'The worker’s scope leaves the domain');
});

test('S-61: privacy, terms, refund and shipping pages load logged out on the business’s own domain', async () => {
  const shop = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const other = await addP4Shop(world, { ...plain, name: 'Brass Bazaar' });
  for (const kind of ['privacy', 'terms', 'refund', 'shipping']) {
    await shop.must('PUT', '/policies', { kind, body: `Leafy Corner ${kind} policy, clause ${unique()}.` });
    const res = await assertBuyerPageClean(world, shop, `/policies/${kind}`);
    assert.ok(res.text.includes(`Leafy Corner ${kind} policy`), `${kind} page does not show its text`);
    assert.equal(res.headers.location, undefined);
    const elsewhere = await other.open(`/policies/${kind}`);
    assert.ok(!elsewhere.text.includes('Leafy Corner'), `${kind} page of A shows on B`);
  }
  assertBranded404(await shop.open('/policies/secret'), shop, 'An unknown policy page');
});

test('S-61: policy text is shown as text, never run as markup', async () => {
  const shop = await addP4Shop(world, plain);
  await shop.must('PUT', '/policies', { kind: 'refund', body: 'Refunds in 7 days. <script>alert(1)</script><img src=x onerror=alert(1)>' });
  const res = need(await shop.open('/policies/refund'), 200, 'Refund policy');
  assertNoLiveMarkup(res.text, 'Refund policy');
  assert.ok(textOf(res.text).includes('Refunds in 7 days'));
});

test('S-62: the privacy page shows this business’s grievance contact, and only this business’s', async () => {
  const shop = await addP4Shop(world, { ...plain, name: 'Leafy Corner' });
  const other = await addP4Shop(world, { ...plain, name: 'Brass Bazaar' });
  await shop.must('PATCH', '/privacy', { grievanceName: 'Kavita Menon', grievanceEmail: 'grievance@leafy.example', grievancePhone: '02012345678', grievanceAddress: '4 Mill Lane, Pune' });
  await other.must('PATCH', '/privacy', { grievanceName: 'Someone Else', grievanceEmail: 'help@brass.example' });
  const res = await assertBuyerPageClean(world, shop, '/policies/privacy');
  const text = textOf(res.text);
  for (const part of ['Kavita Menon', 'grievance@leafy.example', '02012345678', '4 Mill Lane, Pune']) assert.ok(text.includes(part), `The privacy page does not show ${part}`);
  assert.ok(!text.includes('Someone Else') && !text.includes('brass.example'));
  const manager = await shop.manager();
  need(await manager.send('PATCH', '/privacy', { grievanceName: 'Set by manager' }), 200, 'A manager saving the grievance contact');
  const b = buyer(world, shop);
  await b.signIn().catch(() => {});
  const asShopper = await b.api('PATCH', '/api/v1/privacy', { grievanceName: 'Set by a shopper' });
  assert.ok([401, 403, 404].includes(asShopper.status), `A shopper changed the grievance contact: ${asShopper.status}`);
});
