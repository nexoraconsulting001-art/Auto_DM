// PRD 8.14: the creator page. One per business at /<slug> on its own host, with a shelf per category, a search of this business
// only, direct links everywhere, its own share previews, indexable, and white-label on every paid plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIO_UTM, CATALOG_LIMITS, RESERVED_PATHS, UA, addP3Shop, assertBranded404, assertNoLiveMarkup, assertNoRedirect, creatorPage, eventually, hit, linksOf, need,
  noPlatformName, reelSlugsOf, sectionsOf, setTier, shareTags, shopperOf, tagsOf, textOf, titleOf, unique, useP3World,
} from './kit.js';

const world = useP3World();

const page = async (shop, creator, rest = '') => need(await shop.open(`/${creator.slug}${rest}`), 200, 'The creator page').text;
const shelves = (html) => sectionsOf(html).filter((s) => s.slugs.length);

async function reels(shop, names) {
  const out = {};
  for (const name of names) out[name] = await shop.page({ headline: `Reel ${name}` });
  return out;
}

async function categoryWith(shop, name, pages, fields = {}) {
  const category = await shop.category(name, fields);
  await shop.addToCategory(category.id, pages.map((p) => p.id));
  return category;
}

// ---- K-49 ------------------------------------------------------------------------------------------------------------------

test('K-49: with 3 categories and 12 live reels, shelves follow the category order and each shelf follows its own sequence', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'c1', 'c2', 'c3', 'c4']);
  const kitchen = await categoryWith(shop, 'Kitchen', [r.a1, r.a2, r.a3, r.a4]);
  const bottles = await categoryWith(shop, 'Bottles', [r.b1, r.b2, r.b3, r.b4]);
  const garden = await categoryWith(shop, 'Garden', [r.c1, r.c2, r.c3, r.c4]);
  await shop.must('PUT', '/categories/order', { ids: [garden.id, kitchen.id, bottles.id] }, 204);
  await shop.setOrder(kitchen.id, [r.a3, r.a1, r.a4, r.a2].map((p) => p.id));
  await shop.setOrder(bottles.id, [r.b4, r.b3, r.b2, r.b1].map((p) => p.id));
  const creator = await creatorPage(shop);
  assert.equal(creator.url, `https://${shop.host}/${creator.slug}`);

  const html = await page(shop, creator);
  const found = shelves(html);
  assert.deepEqual(found.map((s) => s.heading), ['Garden', 'Kitchen', 'Bottles'], 'Shelves follow the category order');
  assert.deepEqual(found[0].slugs, [r.c1, r.c2, r.c3, r.c4].map((p) => p.slug));
  assert.deepEqual(found[1].slugs, [r.a3, r.a1, r.a4, r.a2].map((p) => p.slug), 'Kitchen follows its sequence');
  assert.deepEqual(found[2].slugs, [r.b4, r.b3, r.b2, r.b1].map((p) => p.slug), 'Bottles follows its sequence');
  assert.equal(reelSlugsOf(html).length, 12, 'All 12 are in the page as served');

  await shop.must('PUT', '/categories/order', { ids: [bottles.id, garden.id, kitchen.id] }, 204);
  await shop.setOrder(garden.id, [r.c4, r.c1, r.c2, r.c3].map((p) => p.id));
  const again = await eventually(shop, async () => {
    const now = shelves(await page(shop, creator));
    return JSON.stringify(now.map((s) => s.heading)) === JSON.stringify(['Bottles', 'Garden', 'Kitchen']) && now[1].slugs[0] === r.c4.slug ? now : null;
  }, { ms: 60_000, every: 2_000, settle: false });
  assert.ok(again, 'A new category order and a new sequence reach the creator page within 60 seconds');
});

test('K-49: a reel in two categories is on both shelves; reels with no category go last on "More reels", newest first; empty shelves don\'t show', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const r = await reels(shop, ['both', 'k1', 'b1', 'loose-old', 'loose-new']);
  await categoryWith(shop, 'Kitchen', [r.both, r.k1]);
  await categoryWith(shop, 'Bottles', [r.b1, r.both]);
  await shop.category('Empty one');
  const hidden = await categoryWith(shop, 'Hidden one', [r.k1], { visible: false });
  const theirs = await other.page({ headline: 'Other business' });
  await categoryWith(other, 'Kitchen', [theirs]);
  const creator = await creatorPage(shop, { moreShelfTitle: 'Everything else' });
  const html = await page(shop, creator);
  const found = shelves(html);
  assert.deepEqual(found.map((s) => s.heading), ['Kitchen', 'Bottles', 'Everything else']);
  assert.deepEqual(found[0].slugs, [r.both.slug, r.k1.slug]);
  assert.deepEqual(found[1].slugs, [r.b1.slug, r.both.slug], 'The reel is on both shelves');
  assert.deepEqual(found[2].slugs, [r['loose-new'].slug, r['loose-old'].slug], 'No category: last, newest first');
  assert.ok(!textOf(html).includes('Empty one'), 'A shelf with nothing on it is not drawn');
  assert.ok(!textOf(html).includes(hidden.name), 'A hidden category has no shelf');
  assert.ok(!html.includes(theirs.slug), 'Never another business\'s reel');
});

test('K-49: the first 12 tiles are in the page; the rest come from the page\'s own tiles address, in order', async () => {
  const shop = await addP3Shop(world);
  const names = Array.from({ length: 15 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const r = await reels(shop, names);
  await categoryWith(shop, 'Long shelf', names.map((n) => r[n]));
  const creator = await creatorPage(shop);
  const html = await page(shop, creator);
  const served = reelSlugsOf(html);
  assert.equal(served.length, CATALOG_LIMITS.creatorFirstTiles, 'Exactly the first 12 are server-rendered');
  assert.deepEqual(served, names.slice(0, 12).map((n) => r[n].slug));
  const more = new RegExp(`/${creator.slug}/_tiles[^"'\\s<>]*`).exec(html.replace(/&amp;/g, '&'))?.[0];
  assert.ok(more, 'The page says where the rest of its tiles load from');
  const rest = need(await shop.open(more), 200, 'The next tiles');
  noPlatformName('The tiles fragment', rest.text);
  const seen = [...served];
  let fragment = rest.text;
  for (let i = 0; i < 5; i++) {
    for (const slug of reelSlugsOf(fragment)) if (!seen.includes(slug)) seen.push(slug);
    const next = new RegExp(`/${creator.slug}/_tiles[^"'\\s<>]*`).exec(fragment.replace(/&amp;/g, '&'))?.[0];
    if (!next || seen.length >= 15) break;
    fragment = need(await shop.open(next), 200, 'More tiles').text;
  }
  assert.deepEqual(seen, names.map((n) => r[n].slug), 'Scrolling brings the other three, in the shelf\'s order');
  for (const path of [`/${creator.slug}/_tiles?offset=-1`, `/${creator.slug}/_tiles?offset=99999999999999999999`, `/${creator.slug}/_tiles?offset=abc&shelf=<script>alert(1)</script>`, `/${creator.slug}/_tiles?limit=100000`]) {
    const res = await shop.open(path);
    assert.ok(res.status < 500, `${path} answered ${res.status}`);
    assertNoLiveMarkup(res.text, path);
    assert.ok(reelSlugsOf(res.text).length <= 40, 'A fragment never dumps everything');
  }
});

// ---- K-50 ------------------------------------------------------------------------------------------------------------------

test('K-50: a reel the owner turns off is gone from the creator page within 60 seconds, and returns to its place when turned on', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C']);
  await categoryWith(shop, 'Shelf', [r.A, r.B, r.C]);
  const creator = await creatorPage(shop);
  assert.deepEqual(reelSlugsOf(await page(shop, creator)), [r.A.slug, r.B.slug, r.C.slug]);
  const started = Date.now();
  await shop.must('PATCH', `/pages/${r.B.id}`, { active: false });
  const gone = await eventually(shop, async () => !reelSlugsOf(await page(shop, creator)).includes(r.B.slug), { ms: 60_000, every: 1_000, settle: false });
  assert.ok(gone, 'Still on the creator page after 60 seconds');
  assert.ok(Date.now() - started <= 61_000);
  assert.deepEqual(reelSlugsOf(await page(shop, creator)), [r.A.slug, r.C.slug]);
  assert.deepEqual(reelSlugsOf(await page(shop, creator, '?q=Reel')).filter((s) => s === r.B.slug), [], 'Search doesn\'t find it either');
  for (const res of [await shop.open(`/${creator.slug}/_tiles`), await shop.open(`/${creator.slug}/shelf`)]) assert.ok(!res.text.includes(r.B.slug));

  await shop.must('PATCH', `/pages/${r.B.id}`, { active: true });
  const back = await eventually(shop, async () => JSON.stringify(reelSlugsOf(await page(shop, creator))) === JSON.stringify([r.A.slug, r.B.slug, r.C.slug]), { ms: 60_000, every: 1_000, settle: false });
  assert.ok(back, 'Turned on again, it is back in its place');
});

test('K-50: a reel whose only product is archived, and a creator page switched off, leave within 60 seconds too', async () => {
  const shop = await addP3Shop(world);
  const product = await shop.product({ name: 'Only product' });
  const lonely = await shop.page({ productIds: [product.id], headline: 'One product reel' });
  const fine = await shop.page({ headline: 'Fine reel' });
  await categoryWith(shop, 'Shelf', [lonely, fine]);
  const creator = await creatorPage(shop);
  await shop.must('PATCH', `/products/${product.id}`, { active: false });
  const gone = await eventually(shop, async () => !reelSlugsOf(await page(shop, creator)).includes(lonely.slug), { ms: 60_000, every: 1_000, settle: false });
  assert.ok(gone, 'A reel with no active product is not live (8.13)');
  await shop.must('PATCH', '/creator-page', { enabled: false });
  const off = await eventually(shop, async () => (await shop.open(`/${creator.slug}`)).status === 404, { ms: 60_000, every: 1_000, settle: false });
  assert.ok(off, 'A creator page switched off stops answering');
  assertBranded404(await shop.open(`/${creator.slug}`), shop, 'The switched-off creator page');
});

// ---- K-51 ------------------------------------------------------------------------------------------------------------------

test('K-51: a reel tile opens its landing page directly, with no redirect, and one visit is counted with source bio', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B']);
  await categoryWith(shop, 'Shelf', [r.A, r.B]);
  const creator = await creatorPage(shop);
  const html = await page(shop, creator);
  const tile = linksOf(html).find((a) => a.href.includes(`/r/${r.A.slug}`));
  assert.ok(tile, 'The tile links to the reel\'s landing page');
  const url = new URL(tile.href, `https://${shop.host}`);
  assert.equal(url.host, shop.host);
  assert.equal(url.pathname, `/r/${r.A.slug}`, 'Straight to the landing page: no hop in between');
  assert.equal(url.searchParams.get('utm_medium'), BIO_UTM.utm_medium, 'Tagged as coming from the bio');
  assert.equal(url.searchParams.get('utm_source'), BIO_UTM.utm_source);
  noPlatformName('A tile link', tile.href);

  assert.equal((await shop.sessions()).length, 0);
  const shopper = shopperOf(world, shop, { ua: UA.instagram });
  const landed = await shopper.open(`${url.pathname}${url.search}`, { referer: `https://${shop.host}/${creator.slug}` });
  assert.equal(landed.status, 200);
  assertNoRedirect(landed, 'The tile\'s target');
  await shop.settle({ ms: 3000 });
  const sessions = await shop.sessions();
  assert.equal(sessions.length, 1, 'One visit');
  assert.equal(sessions[0].utm_medium, 'bio');
  assert.match(sessions[0].source, /bio/, `Its source is the bio: ${sessions[0].source}`);
  await shopper.open(`${url.pathname}${url.search}`);
  await shop.settle({ ms: 3000 });
  assert.equal((await shop.sessions()).length, 1, 'A reload is the same visit');
});

test('K-51: the creator page itself is a bio visit, every link on it is direct, and a second shopper is a second visit', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A']);
  await categoryWith(shop, 'Shelf', [r.A]);
  const creator = await creatorPage(shop, { websiteUrl: 'https://example.com/my-shop' });
  const first = shopperOf(world, shop, { ua: UA.instagram });
  const html = (await first.open(`/${creator.slug}`, { referer: 'https://l.instagram.com/' })).text;
  for (const a of linksOf(html)) {
    assert.doesNotMatch(a.href, /\/go\/|\/l\/|[?&](url|u|to|target|redirect)=/i, `A link on the creator page hops: ${a.href}`);
    noPlatformName('A link on the creator page', a.href);
  }
  assert.ok(linksOf(html).some((a) => a.href.startsWith('https://example.com/my-shop')), 'The website button opens the website itself');
  await first.open(`/r/${r.A.slug}?utm_source=instagram&utm_medium=bio`, { referer: `https://${shop.host}/${creator.slug}` });
  const second = shopperOf(world, shop);
  await second.open(`/r/${r.A.slug}?utm_source=instagram&utm_medium=bio`);
  await shop.settle({ ms: 3000 });
  const sessions = await shop.sessions();
  assert.equal(sessions.length, 2, 'One visit per shopper, not one per page');
  assert.ok(sessions.every((s) => /bio/.test(s.source) || s.utm_medium === 'bio'), `Both count as bio: ${sessions.map((s) => `${s.source}/${s.utm_medium}`)}`);
});

// ---- K-52 ------------------------------------------------------------------------------------------------------------------

test('K-52: on tier 1 the page source and response headers carry the seller\'s name and logo only: no platform name, no badge', async () => {
  const shop = await addP3Shop(world, { name: 'Priya Picks' });
  const logo = await shop.upload('#774411', { width: 300, height: 300, filename: 'logo.png' });
  await shop.must('PATCH', '/brand-kit', { logoUrl: logo });
  const r = await reels(shop, ['A', 'B']);
  const kitchen = await categoryWith(shop, 'Kitchen', [r.A, r.B]);
  const creator = await creatorPage(shop, { displayName: 'Priya Picks', bio: 'Things I actually use' });
  await setTier(world, shop, 't1');
  assert.equal((await shop.must('GET', '/creator-page')).badge, false);
  for (const path of [`/${creator.slug}`, `/${creator.slug}/${kitchen.slug}`, `/${creator.slug}?q=reel`, `/${creator.slug}/_tiles`, `/${creator.slug}/no-such-shelf`, '/robots.txt']) {
    const res = await shop.open(path);
    assert.ok(res.status < 500);
    noPlatformName(`${path} source`, res.text);
    noPlatformName(`${path} headers`, res.headers);
    assert.doesNotMatch(res.text, /made with|powered by/i, `${path} has a badge`);
    for (const asset of [...res.text.matchAll(/<(?:link|script|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1])) {
      noPlatformName(`An asset address on ${path}`, asset);
      if (asset.startsWith('/') && !asset.startsWith('//')) {
        const file = await hit(world, asset, { host: shop.host });
        noPlatformName(`The headers of ${asset}`, file.headers);
        if (/javascript|css|json|svg|html/.test(file.headers['content-type'] ?? '')) noPlatformName(`The body of ${asset}`, file.text);
      }
    }
  }
  const html = await page(shop, creator);
  assert.ok(textOf(html).includes('Priya Picks'), 'The seller\'s name');
  assert.ok(html.includes(logo), 'The seller\'s logo');
  noPlatformName('The title', titleOf(html));
  assert.ok(textOf(html).includes('Things I actually use'));
});

test('K-52: the creator\'s own name, bio and shelf title show as text, whatever they contain', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A']);
  await categoryWith(shop, '<img src=x onerror=alert(1)> Shelf', [r.A]);
  const creator = await creatorPage(shop, { displayName: '<script>alert(1)</script>Priya', bio: '"><svg onload=alert(1)> & co </title>', moreShelfTitle: '<b>More</b>' });
  const loose = await shop.page({ headline: '</h2><script>alert(1)</script>' });
  const html = await page(shop, creator);
  assertNoLiveMarkup(html, 'The creator page');
  assert.doesNotMatch(html, /<svg onload|<b>More<\/b>/i);
  assert.equal(tagsOf(html, 'title').length, 1);
  assert.ok(html.includes(loose.slug));
  for (const websiteUrl of ['javascript:alert(1)', 'http://example.com', 'https://exa mple.com', 'data:text/html,x', '//evil.example']) {
    assert.equal((await shop.send('PATCH', '/creator-page', { websiteUrl })).status, 400, `Website "${websiteUrl}"`);
  }
});

// ---- K-53 ------------------------------------------------------------------------------------------------------------------

test('K-53: a facebookexternalhit fetch of the creator page gets every Open Graph tag, and no visit is counted', async () => {
  const shop = await addP3Shop(world, { name: 'Priya Picks' });
  const photo = await shop.upload('#553399', { width: 1200, height: 1200 });
  const r = await reels(shop, ['A']);
  await categoryWith(shop, 'Kitchen', [r.A]);
  const creator = await creatorPage(shop, { displayName: 'Priya Picks', bio: 'Kitchen things I actually use', photoUrl: photo });
  const res = await shop.open(`/${creator.slug}?utm_source=instagram&utm_medium=bio&fbclid=xyz`, { ua: UA.facebookCrawler });
  assert.equal(res.status, 200);
  assertNoRedirect(res, 'The crawler\'s fetch');
  const tags = shareTags(res.text, 'The creator page');
  assert.equal(tags['og:url'], `https://${shop.host}/${creator.slug}`, 'og:url has no query');
  assert.ok(tags['og:title'].includes('Priya Picks'));
  assert.ok(tags['og:description'].includes('Kitchen things I actually use'));
  assert.ok(tags['og:image:width'] >= 1080);
  noPlatformName('The share tags', JSON.stringify(tags));
  const canonical = tagsOf(res.text, 'link').find((l) => l.rel === 'canonical')?.href;
  assert.equal(canonical, `https://${shop.host}/${creator.slug}`);
  assert.ok(!([res.headers['set-cookie'] ?? []].flat().join(';')).includes('_vid='), 'A crawler gets no visitor cookie');
  for (const ua of [UA.whatsappCrawler, UA.googleBot]) await shop.open(`/${creator.slug}`, { ua });
  await shop.settle({ ms: 3000 });
  assert.equal((await shop.sessions()).length, 0, 'No visit');
  assert.equal((await shop.trafficEvents()).length, 0, 'No event');
  await shopperOf(world, shop).open(`/${creator.slug}`);
  await shop.settle({ ms: 3000 });
  assert.ok((await shop.sessions()).length >= 1, 'A shopper is counted, so the count works');
});

// ---- K-60 ------------------------------------------------------------------------------------------------------------------

async function searchable(shop, { product = 'Steel Bottle', tags = ['insulated'], caption = 'Keeps chai hot all day' } = {}) {
  const item = await shop.product({ name: product, tags, pricePaise: 34900, externalUrl: `https://${shop.siteHost}/p/${unique()}` });
  const reel = await shop.page({ productIds: [item.id], headline: 'My daily carry', caption });
  return { item, reel };
}

test('K-60: searching "steel bottle" on the creator page shows the matching product and its reels, and nothing from another business', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const mine = await searchable(shop);
  const second = await shop.page({ productIds: [mine.item.id], headline: 'Another reel with the bottle' });
  const unrelated = await searchable(shop, { product: 'Cotton Towel', tags: ['bath'], caption: 'Soft and quick to dry' });
  const theirs = await searchable(other, { product: 'Steel Bottle Deluxe' });
  const creator = await creatorPage(shop);
  await creatorPage(other, { slug: creator.slug });

  const html = await page(shop, creator, '?q=steel+bottle');
  const text = textOf(html);
  assert.ok(text.includes('Steel Bottle'), 'The matching product shows');
  const found = reelSlugsOf(html);
  assert.ok(found.includes(mine.reel.slug) && found.includes(second.slug), `Its reels show: ${found}`);
  assert.ok(!found.includes(unrelated.reel.slug), 'A reel that doesn\'t match is not listed');
  assert.ok(!text.includes('Cotton Towel'));
  assert.ok(!text.includes('Steel Bottle Deluxe') && !found.includes(theirs.reel.slug) && !html.includes(other.siteHost), 'Nothing from the other business');
  assert.ok((await page(other, { slug: creator.slug }, '?q=steel+bottle')).includes(theirs.reel.slug), 'The other business\'s own page finds its own');

  assert.ok(reelSlugsOf(await page(shop, creator, '?q=INSULATED')).includes(mine.reel.slug), 'Product tags are searched, whatever the case');
  assert.ok(reelSlugsOf(await page(shop, creator, '?q=chai')).includes(mine.reel.slug), 'Reel captions are searched');
  assert.ok(reelSlugsOf(await page(shop, creator, '?q=daily+carry')).includes(mine.reel.slug), 'Reel titles are searched');
  assert.deepEqual(reelSlugsOf(await page(shop, creator, '?q=zzzznothing')), [], 'No match, no results');
  await shop.must('PATCH', `/products/${mine.item.id}`, { active: false });
  assert.ok(!textOf(await page(shop, creator, '?q=steel+bottle')).includes('Steel Bottle'), 'An archived product is not found');
});

test('K-60: the search box can\'t be turned against the page: wildcards, SQL, markup and huge input find only what they say', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  for (let i = 0; i < 45; i++) await shop.page({ headline: `Findable reel ${i}` });
  const secret = await searchable(other, { product: 'Secret Thing' });
  const creator = await creatorPage(shop);
  const queries = ['%', '_', '%25', '\' OR 1=1 --', '"; DROP TABLE reels; --', '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '\\', 'a'.repeat(5000), '\u0000', '%00', '{{7*7}}', '../../etc/passwd', 'Secret', '*', '.*', 'q[]=a'];
  for (const q of queries) {
    const res = await shop.open(`/${creator.slug}?q=${encodeURIComponent(q)}`);
    assert.ok(res.status < 500, `Searching ${JSON.stringify(q).slice(0, 30)} answered ${res.status}`);
    assertNoLiveMarkup(res.text, `Search ${JSON.stringify(q).slice(0, 20)}`);
    noPlatformName('A search result page', res.text);
    assert.ok(!res.text.includes(secret.reel.slug) && !textOf(res.text).includes('Secret Thing'), `${JSON.stringify(q).slice(0, 20)} found another business's item`);
    if (['%', '_', '*', '.*', '\\'].includes(q)) assert.deepEqual(reelSlugsOf(res.text), [], `"${q}" is a literal, not a wildcard`);
  }
  const many = reelSlugsOf(await page(shop, creator, '?q=Findable'));
  assert.ok(many.length >= 1 && many.length <= CATALOG_LIMITS.creatorSearchResults, `A search shows at most 40: ${many.length}`);
  const arr = await shop.open(`/${creator.slug}?q[]=a&q[]=b`);
  assert.ok(arr.status < 500);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM reels WHERE tenant_id = $1', [shop.tenantId]))[0].n, 45, 'Nothing was dropped');
});

// ---- K-61 ------------------------------------------------------------------------------------------------------------------

test('K-61: a shared /<creator>/kitchen link opens the creator page on the Kitchen shelf', async () => {
  const shop = await addP3Shop(world, { name: 'Priya Picks' });
  const r = await reels(shop, ['k1', 'k2', 'b1']);
  await categoryWith(shop, 'Bottles', [r.b1]);
  const kitchen = await categoryWith(shop, 'Kitchen', [r.k2, r.k1]);
  const creator = await creatorPage(shop, { slug: `priya-${unique()}`.toLowerCase(), displayName: 'Priya Picks' });
  const res = await shop.open(`/${creator.slug}/${kitchen.slug}`);
  assert.equal(res.status, 200);
  assertNoRedirect(res, 'The shelf link');
  const html = res.text;
  assert.ok(textOf(html).includes('Priya Picks'), 'It is the creator page');
  const found = shelves(html);
  assert.equal(found[0]?.heading, 'Kitchen', `The page opens on the Kitchen shelf: ${found.map((s) => s.heading)}`);
  assert.deepEqual(found[0].slugs, [r.k2.slug, r.k1.slug], 'In Kitchen\'s own order');
  const links = linksOf(await page(shop, creator)).map((a) => a.href);
  assert.ok(links.some((h) => new URL(h, `https://${shop.host}`).pathname === `/${creator.slug}/${kitchen.slug}`), 'The creator page gives each shelf its own shareable link');
  for (const path of [`/${creator.slug}/no-such-shelf`, `/${creator.slug}/${kitchen.slug}/extra`, `/${creator.slug}/%3Cscript%3E`, `/${creator.slug}x`, `/${creator.slug}/..%2F..%2Fadmin`]) {
    const bad = await shop.open(path);
    assertBranded404(bad, shop, path);
    assertNoLiveMarkup(bad.text, path);
  }
});

test('K-61: a creator page can\'t take a name the store already uses, and a name is per business', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  for (const slug of ['admin', 'api', 'r', 'c', 'reels', 'lead', 'media', 'robots.txt', 'login', 'bhava', 'ADMIN', 'has space', '-dash', 'dash-', 'x'.repeat(41), '<script>', '../x', 'म']) {
    const res = await shop.send('PATCH', '/creator-page', { slug, enabled: true });
    assert.equal(res.status, 400, `The name "${slug}" answered ${res.status}`);
  }
  for (const reserved of RESERVED_PATHS.slice(0, 12)) {
    const check = await shop.must('GET', `/creator-page/slug?slug=${encodeURIComponent(reserved)}`);
    assert.equal(check.available, false, `"${reserved}" is reserved`);
  }
  const mine = await creatorPage(shop, { slug: 'priya' });
  const theirs = await creatorPage(other, { slug: 'priya' });
  assert.equal(mine.slug, theirs.slug, 'Two businesses can both be /priya: each on its own host');
  assert.ok((await shop.open('/priya')).text.includes(shop.name));
  assert.ok((await other.open('/priya')).text.includes(other.name));
  assert.ok(!(await shop.open('/priya')).text.includes(other.name));
  const category = await shop.category('Kitchen');
  assert.equal((await other.open(`/priya/${category.slug}`)).status, 404, 'One business\'s shelf is not on another\'s page');
  assert.equal((await shop.open('/admin')).status === 200 && (await shop.open('/admin')).text.includes('Reel '), false, 'A reserved path is never a creator page');
});

// ---- K-62 ------------------------------------------------------------------------------------------------------------------

test('K-62: a search engine crawler gets /<creator>/kitchen as a 200, indexable, titled with the creator and the shelf, with that shelf\'s preview', async () => {
  const shop = await addP3Shop(world, { name: 'Priya Picks' });
  const r = await reels(shop, ['k1', 'b1']);
  const shelfImage = await shop.upload('#886611', { width: 1200, height: 1200 });
  const kitchen = await categoryWith(shop, 'Kitchen', [r.k1], { imageUrl: shelfImage, description: 'Pots, pans and a good knife' });
  const bottles = await categoryWith(shop, 'Bottles', [r.b1]);
  const creator = await creatorPage(shop, { slug: `priya-${unique()}`.toLowerCase(), displayName: 'Priya' });
  const res = await shop.open(`/${creator.slug}/${kitchen.slug}?utm_source=x`, { ua: UA.googleBot });
  assert.equal(res.status, 200);
  assertNoRedirect(res, 'The crawler\'s fetch');
  const robots = tagsOf(res.text, 'meta').find((t) => t.name === 'robots')?.content ?? '';
  assert.doesNotMatch(robots, /noindex/, 'The shelf is indexable');
  assert.doesNotMatch(String(res.headers['x-robots-tag'] ?? ''), /noindex/);
  const title = titleOf(res.text);
  assert.ok(title.includes('Priya') && title.includes('Kitchen'), `The title names Priya and Kitchen: "${title}"`);
  noPlatformName('The title', title);
  const tags = shareTags(res.text, 'The shelf');
  assert.ok(tags['og:title'].includes('Kitchen'), 'The preview shows the shelf\'s title');
  assert.equal(tags['og:url'], `https://${shop.host}/${creator.slug}/${kitchen.slug}`);
  assert.equal(tagsOf(res.text, 'link').find((l) => l.rel === 'canonical')?.href, `https://${shop.host}/${creator.slug}/${kitchen.slug}`, 'Its own canonical URL');
  const description = tagsOf(res.text, 'meta').find((t) => t.name === 'description')?.content ?? '';
  assert.ok(description.length > 0, 'Its own description');

  const whole = await shop.open(`/${creator.slug}`, { ua: UA.googleBot });
  const other = await shop.open(`/${creator.slug}/${bottles.slug}`, { ua: UA.googleBot });
  const [wholeTags, otherTags] = [shareTags(whole.text, 'The page'), shareTags(other.text, 'Bottles')];
  assert.notEqual(tags['og:image'], wholeTags['og:image'], 'The shelf\'s preview image is its own, not the page\'s');
  assert.notEqual(tags['og:image'], otherTags['og:image'], 'Nor another shelf\'s');
  assert.notEqual(titleOf(other.text), title);
  assert.doesNotMatch(tagsOf(whole.text, 'meta').find((t) => t.name === 'robots')?.content ?? '', /noindex/, 'The creator page is indexable too');
  const landing = await shop.open(`/r/${r.k1.slug}`, { ua: UA.googleBot });
  assert.match(tagsOf(landing.text, 'meta').find((t) => t.name === 'robots')?.content ?? String(landing.headers['x-robots-tag'] ?? ''), /noindex/, 'A landing page stays noindex');
  const robotsTxt = need(await shop.open('/robots.txt'), 200, 'robots.txt').text;
  assert.doesNotMatch(robotsTxt, new RegExp(`Disallow:\\s*/${creator.slug}\\b`, 'i'), 'robots.txt doesn\'t shut the creator page out');
  assert.doesNotMatch(robotsTxt, /^User-agent:\s*\*\s*\n(?:.*\n)*?Disallow:\s*\/\s*$/im, 'robots.txt doesn\'t shut everything out');
  await shop.settle({ ms: 2500 });
  assert.equal((await shop.sessions()).length, 0, 'A crawler\'s fetch is not a visit');
});

// ---- K-63 ------------------------------------------------------------------------------------------------------------------

test('K-63: an Amazon product link opens the Amazon URL itself, with the creator\'s own tag untouched, and one click is counted', async () => {
  const shop = await addP3Shop(world);
  const amazon = 'https://www.amazon.in/dp/B0TESTSPEC1?tag=priyapicks-21&th=1';
  const product = await shop.product({ name: 'Steel Tiffin Box', pricePaise: 89900, externalUrl: amazon, tags: ['lunch'] });
  const reel = await shop.page({ productIds: [product.id], headline: 'Lunch box haul' });
  await categoryWith(shop, 'Kitchen', [reel]);
  const creator = await creatorPage(shop);
  const shopper = shopperOf(world, shop, { ua: UA.instagram });
  const pages = [(await shopper.open(`/${creator.slug}?q=tiffin`)).text, (await shopper.open(`/r/${reel.slug}?utm_source=instagram&utm_medium=bio`)).text];
  const links = pages.flatMap((html) => linksOf(html)).filter((a) => /amazon\./.test(a.href));
  assert.ok(links.length >= 1, 'The product\'s Amazon link is on the page');
  for (const a of links) {
    const url = new URL(a.href);
    assert.equal(`${url.origin}${url.pathname}`, 'https://www.amazon.in/dp/B0TESTSPEC1', `The real Amazon address: ${a.href}`);
    assert.deepEqual(url.searchParams.getAll('tag'), ['priyapicks-21'], 'The creator\'s own tag, once, unchanged');
    assert.equal(url.searchParams.get('th'), '1', 'The rest of the address is kept');
    noPlatformName('The Amazon link', a.href);
    assert.doesNotMatch(a.href, /[?&]tag=(?!priyapicks-21)/, 'No other affiliate tag is added');
  }
  for (const html of pages) {
    assert.ok(!linksOf(html).some((a) => new URL(a.href, `https://${shop.host}`).host === shop.host && /amazon/i.test(a.href)), 'No link on this host stands in front of Amazon');
    assert.doesNotMatch(html, /http-equiv=["']?refresh|location\.(replace|assign)\(|window\.location\s*=/i, 'No automatic redirect');
  }
  const event = { name: 'outbound_tap', path: `/${creator.slug}`, pageKind: 'creator', pageRef: creator.slug, productId: product.id, outboundHost: 'www.amazon.in', eventId: `amz-${unique()}` };
  need(await shopper.beacon(event), [200, 201, 202, 204], 'The click beacon');
  need(await shopper.beacon(event), [200, 201, 202, 204], 'The same beacon again');
  const taps = await shop.trafficEvents(['outbound_tap']);
  assert.equal(taps.length, 1, 'One click');
  assert.deepEqual([taps[0].product_id, taps[0].outbound_host], [product.id, 'www.amazon.in']);
  const saved = await shop.getProduct(product.id);
  assert.equal(saved.externalUrl, amazon, 'The stored address was never rewritten');
});

// ---- K-64 ------------------------------------------------------------------------------------------------------------------

test('K-64: the Free plan shows "Made with Bhava" in the footer; after an upgrade to tier 1 the badge is gone', async () => {
  const shop = await addP3Shop(world, { name: 'Free Creator' });
  const r = await reels(shop, ['A']);
  await categoryWith(shop, 'Shelf', [r.A]);
  const creator = await creatorPage(shop);
  await setTier(world, shop, 'free');
  assert.equal((await shop.must('GET', '/creator-page')).badge, true);
  const free = await eventually(shop, async () => {
    const html = (await shop.open(`/${creator.slug}`)).text;
    return /Made with Bhava/.test(html) ? html : null;
  }, { ms: 60_000, every: 1_000, settle: false });
  assert.ok(free, 'The Free plan\'s creator page shows "Made with Bhava"');
  const footer = /<footer\b[\s\S]*?<\/footer>/i.exec(free)?.[0] ?? '';
  assert.ok(footer.includes('Made with Bhava'), 'The badge is in the footer');
  assert.equal((free.match(/bhava/gi) ?? []).length - (footer.match(/bhava/gi) ?? []).length, 0, 'The badge is the only place the name appears');
  assert.ok(footer.length < 2500 && (footer.match(/Made with Bhava/g) ?? []).length === 1, 'One small badge');
  noPlatformName('The title on the Free plan', titleOf(free));
  assert.ok(textOf(free).includes('Free Creator'));

  await setTier(world, shop, 't1');
  assert.equal((await shop.must('GET', '/creator-page')).badge, false);
  const paid = await eventually(shop, async () => {
    const res = await shop.open(`/${creator.slug}`);
    return /bhava/i.test(res.text) ? null : res;
  }, { ms: 60_000, every: 1_000, settle: false });
  assert.ok(paid, 'On tier 1 the badge is gone');
  noPlatformName('The tier 1 headers', paid.headers);
  assert.equal(paid.status, 200);
  for (const plan of ['t2', 't3', 't5']) {
    await setTier(world, shop, plan);
    assert.equal((await shop.must('GET', '/creator-page')).badge, false, `No badge on ${plan}`);
  }
});

test('K-64: the badge is the plan\'s doing: a seller can\'t switch it off on Free, and it never shows on a landing page', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A']);
  const creator = await creatorPage(shop);
  await setTier(world, shop, 'free');
  for (const body of [{ badge: false }, { enabled: true, badge: false }, { showBadge: false }]) {
    const res = await shop.send('PATCH', '/creator-page', body);
    assert.ok(res.status < 500);
  }
  assert.equal((await shop.must('GET', '/creator-page')).badge, true);
  const html = await eventually(shop, async () => {
    const text = (await shop.open(`/${creator.slug}`)).text;
    return /Made with Bhava/.test(text) ? text : null;
  }, { ms: 60_000, every: 1_000, settle: false });
  assert.ok(html, 'Still badged');
  const landing = await shop.open(`/r/${r.A.slug}`);
  if (landing.status === 200) noPlatformName('A landing page on the Free plan', landing.text.replace(/<footer\b[\s\S]*?<\/footer>/i, ''));
  noPlatformName('Free plan headers', (await shop.open(`/${creator.slug}`)).headers);
});
