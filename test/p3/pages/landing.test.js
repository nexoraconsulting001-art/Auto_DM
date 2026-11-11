// Landing pages (PRD 8.10 to 8.12): the DM link itself, the products in the owner's order, direct links, the WhatsApp order
// button, share previews, and what a phone downloads. Everything goes through the real app over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRAFFIC_PATHS } from '../../../src/contracts/analytics.js';
import { createImages } from '../../../src/platform/images.js';
import { FACEBOOK_CRAWLER, HOUR, addProduct, cards, decode, metaTag, open, openCompressed, photo, scriptedIg, secondShop, setPlan, shop, upload, waitFor } from './support.js';

const visitCount = async (app, tenant) => (await app.db.platform.query('SELECT count(*)::int AS n FROM visits WHERE tenant_id = $1', [tenant.id]))[0].n;
const mediaCount = async (app, tenant) => (await app.db.platform.query('SELECT count(*)::int AS n FROM media WHERE tenant_id = $1', [tenant.id]))[0].n;

async function threeProducts(s, { external = true } = {}) {
  const out = [];
  for (const [i, name] of ['Steel Bottle', 'Copper Mug', 'Brass Planter'].entries()) {
    out.push(await addProduct(s.app, s.repos, s.tenant, { name, price: String(349 + i * 100), externalUrl: external ? `https://shop.example/products/item-${i + 1}` : '' }));
  }
  return out;
}

test('K-30, K-32: the DM link answers 200 with no redirect, shows the products in the owner\'s order, and each button opens the product directly', async (t) => {
  const s = await shop(t);
  const [one, two, three] = await threeProducts(s);
  const made = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000001', headline: 'Kitchen edit', productIds: [three.id, one.id, two.id] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.url, 'https://shop.test/r/kitchen-edit', 'the DM link is the page itself, with nothing in between');
  assert.deepEqual(made.body.products.map((p) => p.id), [three.id, one.id, two.id]);

  const page = await open(s.app, '/r/kitchen-edit?utm_source=instagram&utm_medium=dm&utm_campaign=autumn-drop&utm_content=17900000000000001');
  assert.equal(page.status, 200);
  assert.equal(page.headers.location, undefined, 'no redirect');
  const shown = cards(page.text);
  assert.deepEqual(shown.map((c) => c.name), ['Brass Planter', 'Steel Bottle', 'Copper Mug']);
  assert.deepEqual(shown.map((c) => c.number), ['1', '2', '3']);
  assert.match(page.text, /Visit website/);

  // Every button is the product's own address: its own host, the 6.6 tags, and no hop of ours.
  for (const [i, card] of shown.entries()) {
    const url = new URL(card.href);
    assert.equal(url.host, 'shop.example');
    assert.equal(url.pathname, `/products/item-${[3, 1, 2][i]}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'autumn-drop', utm_content: '17900000000000001' });
    assert.equal(card.productId, String([three, one, two][i].id), 'the tap is counted against the product');
  }
  assert.doesNotMatch(page.text, /href="\/(go|l)\//, 'no redirect or short link');
  assert.ok(page.text.includes(`<script src="${TRAFFIC_PATHS.script}"`), 'the click beacon is on the page');
  assert.match(page.text, /data-k="landing" data-r="kitchen-edit"/);

  // A new order is what the page shows next.
  const moved = await s.api('PATCH', `/pages/${made.body.id}`, { productIds: [two.id, three.id, one.id] });
  assert.equal(moved.status, 200);
  assert.deepEqual(cards((await open(s.app, '/r/kitchen-edit')).text).map((c) => c.name), ['Copper Mug', 'Brass Planter', 'Steel Bottle']);

  // The retired hops are gone, and an unknown link is the branded 404.
  for (const path of ['/r/no-such-page', '/r/' + 'x'.repeat(300)]) {
    const missing = await open(s.app, path);
    assert.equal(missing.status, 404, path);
    assert.match(missing.text, /Not found/);
    assert.match(missing.text, /My store/);
  }
});

test('8.10: a product sold here opens its page on this shop; one with no price read shows none; hidden products are left out', async (t) => {
  const s = await shop(t);
  const here = await addProduct(s.app, s.repos, s.tenant, { name: 'Linen Apron', price: '599', mrp: '799' });
  const noPrice = await addProduct(s.app, s.repos, s.tenant, { name: 'Clay Pot', price: '0', externalUrl: 'https://shop.example/products/og-only' });
  const broken = await addProduct(s.app, s.repos, s.tenant, { name: 'Gone Lamp', externalUrl: 'https://gone.example/lamp', fetchStatus: 'broken' });
  const off = await addProduct(s.app, s.repos, s.tenant, { name: 'Paused Tray', externalUrl: 'https://shop.example/tray', active: '' });
  const sold = await addProduct(s.app, s.repos, s.tenant, { name: 'Sold Jar', externalUrl: 'https://shop.example/jar', inStock: false });
  const made = await s.api('POST', '/pages', { kind: 'post', mediaId: '17900000000000002', headline: 'Home things', description: 'Made slowly, by hand.', productIds: [here.id, noPrice.id, broken.id, off.id, sold.id] });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const page = await open(s.app, '/r/home-things');
  const shown = cards(page.text);
  assert.deepEqual(shown.map((c) => c.name), ['Linen Apron', 'Clay Pot', 'Sold Jar']);
  assert.equal(shown[0].href, '/r/home-things/p/linen-apron');
  assert.match(page.text, /View product/);
  assert.match(page.text, /<span class="mrp">₹799<\/span><span class="off">-25%<\/span>/);
  assert.equal(shown[1].price, '', 'no price is shown for a product whose page gave none');
  assert.match(page.text, /Sold out/);
  assert.match(page.text, /Made slowly, by hand\./);
  assert.match(page.text, /Shop the post/);

  // Its product page is still the store's; a product this page doesn't show is the branded 404.
  assert.equal((await open(s.app, '/r/home-things/p/linen-apron')).status, 200);
  for (const slug of ['gone-lamp', 'paused-tray', 'nothing']) assert.equal((await open(s.app, `/r/home-things/p/${slug}`)).status, 404, slug);

  // Switched off, the page is the branded 404 and counts nothing.
  await s.api('PATCH', `/pages/${made.body.id}`, { active: false });
  const before = await visitCount(s.app, s.tenant);
  assert.equal((await open(s.app, '/r/home-things')).status, 404);
  assert.equal(await visitCount(s.app, s.tenant), before);
});

test('K-31: a story link opened after the story has expired shows the cover, or the first product photo, and no story media is kept', async (t) => {
  const posted = new Date(Date.now() - 30 * HOUR).toISOString();
  const ig = scriptedIg({
    '18000000000000001': { media_product_type: 'STORY', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.example/story-one.jpg', timestamp: posted },
    '18000000000000002': { media_product_type: 'STORY', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.example/story-two.jpg', timestamp: posted },
    '18000000000000003': { media_product_type: 'STORY', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.example/story-live.jpg', timestamp: new Date(Date.now() - HOUR).toISOString() },
  });
  const s = await shop(t, { ig });
  const productPhoto = await upload(s, '#2F6B3A');
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Fern', externalUrl: 'https://shop.example/fern', image: productPhoto });
  const cover = await upload(s, '#7A1F3D');
  const filesBefore = await mediaCount(s.app, s.tenant);

  const withCover = await s.api('POST', '/pages', { kind: 'story', mediaId: '18000000000000001', headline: 'Story one', productIds: [product.id], coverUrl: cover });
  assert.equal(withCover.status, 201, JSON.stringify(withCover.body));
  assert.equal(withCover.body.kind, 'story');
  assert.equal(new Date(withCover.body.expiresAt).getTime(), new Date(posted).getTime() + 24 * HOUR);
  const noCover = await s.api('POST', '/pages', { kind: 'story', mediaId: '18000000000000002', headline: 'Story two', productIds: [product.id] });
  assert.equal(noCover.status, 201);

  const first = await open(s.app, '/r/story-one');
  assert.equal(first.status, 200);
  assert.ok(first.text.includes(`<img src="${cover}/hero"`), 'the owner\'s cover is the picture, at the size the page shows it');
  assert.doesNotMatch(first.text, /cdninstagram/, 'the story itself is not shown');
  const second = await open(s.app, '/r/story-two');
  assert.match(second.text, new RegExp(`<div class="frame">\\s*<img src="${productPhoto}/hero"`), 'with no cover, the first product\'s photo');
  assert.doesNotMatch(second.text, /cdninstagram/);

  // After the visit the address of the expired story is dropped too; nothing of the story was ever downloaded.
  const cleared = await waitFor(async () => {
    const rows = await s.app.db.platform.query(`SELECT media_url, thumbnail_url, video_url FROM reels WHERE tenant_id = $1 AND ig_media_id IN ('18000000000000001', '18000000000000002')`, [s.tenant.id]);
    return rows.every((r) => !r.media_url && !r.thumbnail_url && !r.video_url);
  });
  assert.ok(cleared, 'the expired stories keep no media address');
  assert.deepEqual(s.sites.dials, [], 'no story media was fetched');
  // The only new files are the two share previews, drawn from the cover and the product photo.
  assert.equal(await mediaCount(s.app, s.tenant), filesBefore + 2);

  // A story still up is shown from Instagram's own address, by reference.
  const live = await s.api('POST', '/pages', { kind: 'story', mediaId: '18000000000000003', headline: 'Story live', productIds: [product.id] });
  assert.equal(live.status, 201);
  assert.match((await open(s.app, '/r/story-live')).text, /<img src="https:\/\/scontent\.cdninstagram\.example\/story-live\.jpg"/);
  assert.deepEqual(s.sites.dials, [], 'and still not downloaded');
});

test('K-33, K-34: one business can never link to, show or open another\'s products or pages, and a page on the shared domain never names the platform', async (t) => {
  const s = await shop(t, { overrides: { platformDomain: 'shops.example', publicBaseUrl: '' } });
  const other = await secondShop(s.app, { slug: 'zari', name: 'Zari and Co', domain: 'shops.example' });
  const mine = await addProduct(s.app, s.repos, s.tenant, { name: 'My Bottle', externalUrl: 'https://shop.example/bottle' });
  const theirs = await addProduct(s.app, other.repos, other.tenant, { name: 'Their Saree', price: '4999' });

  // Linking another business's product is refused, and nothing is created.
  const refused = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000010', headline: 'Mixed', productIds: [mine.id, theirs.id] });
  assert.equal(refused.status, 400);
  assert.equal((await s.api('GET', '/pages')).body.items.length, 0);

  const page = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000010', headline: 'Mine', productIds: [mine.id] });
  assert.equal(page.status, 201);
  const theirPage = await other.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000011', headline: 'Festive', productIds: [theirs.id] });
  assert.equal(theirPage.status, 201, JSON.stringify(theirPage.body));
  assert.equal(theirPage.body.url, 'https://zari.shops.example/r/festive');

  // A post one business has a page for is simply not found for the other, and their ids mean nothing here.
  assert.equal((await other.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000010', productIds: [theirs.id] })).status, 404);
  assert.equal((await other.api('GET', `/pages/${page.body.id}`)).status, 404);
  assert.equal((await other.api('PATCH', `/pages/${page.body.id}`, { headline: 'Taken' })).status, 404);
  assert.equal((await other.api('DELETE', `/pages/${page.body.id}`)).status, 404);
  assert.equal((await s.api('PATCH', `/pages/${page.body.id}`, { productIds: [theirs.id] })).status, 400);
  assert.equal((await s.api('GET', `/pages/${page.body.id}`)).body.headline, 'Mine');

  // Each page opens only on its own business's address.
  const onTheirs = await open(s.app, '/r/festive', { host: other.host });
  assert.equal(onTheirs.status, 200);
  assert.match(onTheirs.text, /Zari and Co/);
  assert.match(onTheirs.text, /Their Saree/);
  const wrongHost = await open(s.app, '/r/mine', { host: other.host });
  assert.equal(wrongHost.status, 404);
  assert.match(wrongHost.text, /Zari and Co/, 'the 404 is in the brand of the shop that was asked');
  assert.doesNotMatch(wrongHost.text, /My Bottle/);
  // A link-out to the other business's product from this page: the branded 404, and nothing is counted.
  const visits = await visitCount(s.app, other.tenant);
  const crossProduct = await open(s.app, '/r/festive/p/my-bottle', { host: other.host });
  assert.equal(crossProduct.status, 404);
  assert.match(crossProduct.text, /Zari and Co/);
  assert.equal(await visitCount(s.app, other.tenant), visits);

  // K-34: on <slug>.<neutral domain>, with nothing of the platform's in the page or its headers.
  assert.equal(metaTag(onTheirs.text, 'og:url'), 'https://zari.shops.example/r/festive');
  for (const res of [onTheirs, wrongHost, crossProduct, await open(s.app, '/robots.txt', { host: other.host })]) {
    assert.doesNotMatch(res.text, /bhava/i);
    assert.doesNotMatch(JSON.stringify(res.headers), /bhava/i);
  }
});

test('K-35 to K-37: the WhatsApp button names the product, its price and the page, goes straight to wa.me, and follows the plan and the saved number', async (t) => {
  const s = await shop(t, { whatsapp: '+91 93200 01717' });
  const bottle = await addProduct(s.app, s.repos, s.tenant, { name: 'Steel Bottle', price: '349', externalUrl: 'https://shop.example/bottle' });
  const odd = await addProduct(s.app, s.repos, s.tenant, { name: 'Salt & Pepper #2', price: '1299.50', externalUrl: 'https://shop.example/salt' });
  const never = await addProduct(s.app, s.repos, s.tenant, { name: 'No Chat Jar', externalUrl: 'https://shop.example/jar', whatsappOrder: false });
  const page = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000020', headline: 'Bottle day', productIds: [bottle.id, odd.id, never.id] });
  assert.equal(page.status, 201);

  // Off until the owner turns it on.
  assert.deepEqual(cards((await open(s.app, '/r/bottle-day')).text).map((c) => c.wa), ['', '', '']);
  const settings = await s.api('GET', '/page-settings');
  assert.deepEqual({ on: settings.body.whatsappOrder, available: settings.body.whatsappAvailable, number: settings.body.whatsappNumber }, { on: false, available: true, number: '919320001717' });
  assert.equal((await s.api('PATCH', '/page-settings', { whatsappTemplate: 'Hello there' })).status, 400, 'the message must keep {product}');
  assert.equal((await s.api('PATCH', '/page-settings', { whatsappOrder: true })).status, 200);

  const shown = cards((await open(s.app, '/r/bottle-day?utm_source=instagram&utm_medium=dm')).text);
  const link = new URL(shown[0].wa);
  assert.equal(`${link.origin}${link.pathname}`, 'https://wa.me/919320001717', 'K-36: the saved number as digits, straight to wa.me');
  assert.equal(link.searchParams.get('text'), 'Hi, I would like to order Steel Bottle (₹349). https://shop.test/r/bottle-day', 'K-35: name, price and the page, with no tracking');
  assert.deepEqual([...link.searchParams.keys()], ['text'], 'no UTM on a WhatsApp link');
  assert.equal(shown[0].productId, String(bottle.id));
  // K-37: & and # are encoded, so the whole name arrives.
  assert.ok(shown[1].wa.includes('Salt%20%26%20Pepper%20%232'), shown[1].wa);
  assert.equal(new URL(shown[1].wa).searchParams.get('text'), 'Hi, I would like to order Salt & Pepper #2 (₹1,299.50). https://shop.test/r/bottle-day');
  assert.equal(shown[2].wa, '', 'a product switched off for WhatsApp has no button');

  // The owner's own words.
  await s.api('PATCH', '/page-settings', { whatsappTemplate: 'Order: {product} at {price} from {url} {other}' });
  assert.equal(new URL(cards((await open(s.app, '/r/bottle-day')).text)[0].wa).searchParams.get('text'), 'Order: Steel Bottle at ₹349 from https://shop.test/r/bottle-day {other}');

  // No number saved: no button anywhere.
  await s.repos.settings.update({ support_whatsapp: '' });
  assert.deepEqual(cards((await open(s.app, '/r/bottle-day')).text).map((c) => c.wa), ['', '', '']);
  assert.equal((await s.api('GET', '/page-settings')).body.whatsappAvailable, false);
  await s.repos.settings.update({ support_whatsapp: '+91 93200 01717' });

  // Below tier 2 the button isn't part of the plan: it leaves the page and can't be turned on.
  await setPlan(s.app, s.tenant, 't1');
  assert.deepEqual(cards((await open(s.app, '/r/bottle-day')).text).map((c) => c.wa), ['', '', '']);
  const blocked = await s.api('PATCH', '/page-settings', { whatsappOrder: true });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.reason, 'plan.not_included');
  // F-96, F-101: switched on for this one business as data, it works there with no code change, and nowhere else.
  await s.repos.entitlements.setOverride('whatsapp_order', { enabled: true });
  assert.notEqual(cards((await open(s.app, '/r/bottle-day')).text)[0].wa, '');
  const other = await secondShop(s.app, { plan: 't1' });
  await other.repos.settings.update({ support_whatsapp: '919000000009' });
  assert.equal((await other.api('PATCH', '/page-settings', { whatsappOrder: true })).status, 403);
});

test('K-38, K-39: a preview crawler gets every share tag and counts no visit, and a changed picture changes the og:image address', async (t) => {
  const s = await shop(t);
  const first = await upload(s, '#2F6B3A');
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Fern', price: '249', externalUrl: 'https://shop.example/fern', image: first });
  const made = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000030', headline: 'Green corner', description: 'Plants that forgive you.', productIds: [product.id] });
  assert.equal(made.status, 201);

  const crawl = await open(s.app, '/r/green-corner?utm_source=instagram&fbclid=abc', { ua: FACEBOOK_CRAWLER });
  assert.equal(crawl.status, 200);
  const head = crawl.text.slice(0, crawl.text.indexOf('<style>'));
  const tags = Object.fromEntries(['og:url', 'og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:type', 'twitter:card'].map((name) => [name, metaTag(head, name)]));
  assert.equal(tags['og:url'], 'https://shop.test/r/green-corner', 'no query string');
  assert.equal(tags['og:title'], 'Green corner');
  assert.equal(tags['og:description'], 'Plants that forgive you.');
  assert.match(tags['og:image'], /^https:\/\/shop\.test\/media\/[0-9a-f-]{36}$/);
  assert.deepEqual([tags['og:image:width'], tags['og:image:height'], tags['og:type'], tags['twitter:card']], ['1200', '630', 'website', 'summary_large_image']);
  assert.equal(metaTag(head, 'robots'), 'noindex,follow', 'noindex by default');
  assert.equal(crawl.headers['x-robots-tag'], 'noindex');
  assert.equal(await visitCount(s.app, s.tenant), 0, 'a crawler\'s fetch is not a visit');
  assert.ok(!crawl.text.includes(TRAFFIC_PATHS.script), 'and it isn\'t handed the counter');
  assert.deepEqual(crawl.setCookie, [], 'nor a visitor cookie');

  // The image is a real, sized picture on the shop's own address.
  const imagePath = new URL(tags['og:image']).pathname;
  const image = await fetch(`${s.app.base}${imagePath}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await createImages().inspect(Buffer.from(await image.arrayBuffer())), { type: 'image/jpeg', width: 1200, height: 630 });

  // A shopper's visit does count, once per open.
  await open(s.app, '/r/green-corner?src=dm');
  assert.equal(await visitCount(s.app, s.tenant), 1);
  await open(s.app, '/r/green-corner?preview=1');
  assert.equal(await visitCount(s.app, s.tenant), 1, 'the owner\'s preview does not');

  // K-39: a new picture is a new file at a new address, and the old one is gone.
  const cover = await upload(s, '#7A1F3D');
  assert.equal((await s.api('PATCH', `/pages/${made.body.id}`, { coverUrl: cover })).status, 200);
  const after = metaTag((await open(s.app, '/r/green-corner', { ua: FACEBOOK_CRAWLER })).text, 'og:image');
  assert.notEqual(after, tags['og:image']);
  assert.equal((await fetch(`${s.app.base}${imagePath}`)).status, 404, 'the old preview is no longer served');
  // The same picture again keeps its address.
  await s.api('PATCH', `/pages/${made.body.id}`, { headline: 'Green corner' });
  assert.equal(metaTag((await open(s.app, '/r/green-corner', { ua: FACEBOOK_CRAWLER })).text, 'og:image'), after);

  // Indexing can be allowed, per business.
  await s.api('PATCH', '/page-settings', { landingNoindex: false });
  const indexable = await open(s.app, '/r/green-corner');
  assert.equal(metaTag(indexable.text, 'robots'), 'index,follow');
  assert.equal(indexable.headers['x-robots-tag'], undefined);

  // robots.txt lets the preview crawler in, by name.
  const robots = await open(s.app, '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers['content-type'], /text\/plain/);
  assert.match(robots.text, /User-agent: facebookexternalhit\nAllow: \/\n/);
  assert.match(robots.text, /User-agent: \*\nDisallow: \/admin/);

  // Removing the page removes its preview file too.
  const files = await mediaCount(s.app, s.tenant);
  assert.equal((await s.api('DELETE', `/pages/${made.body.id}`)).status, 204);
  assert.equal(await mediaCount(s.app, s.tenant), files - 1);
  assert.equal((await open(s.app, '/r/green-corner')).status, 404);
});

test('8.12: a reel\'s own thumbnail is read once through safeFetch for the preview, in the background, and a refreshed thumbnail gives a new address', async (t) => {
  const ig = scriptedIg({ '17900000000000035': { media_type: 'VIDEO', media_url: 'https://shop.example/img/reel.mp4', thumbnail_url: 'https://shop.example/img/thumb-a.png' } });
  const s = await shop(t, { ig });
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Fern', externalUrl: 'https://shop.example/fern' });
  const made = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000035', headline: 'Thumb', productIds: [product.id] });
  assert.equal(made.status, 201);
  assert.equal(s.sites.dials.filter((d) => d.host === 'shop.example').length, 1, 'the thumbnail was read when the page was saved');
  const page = await open(s.app, '/r/thumb');
  const before = metaTag(page.text, 'og:image');
  assert.ok(before);
  assert.match(page.text, /<video src="https:\/\/shop\.example\/img\/reel\.mp4" poster="https:\/\/shop\.example\/img\/thumb-a\.png" controls playsinline preload="none"/);
  assert.equal(s.sites.dials.length, 1, 'opening the page fetched nothing');

  // Six hours on, Instagram has a new thumbnail: the visit shows what is stored and refreshes behind it.
  ig.media['17900000000000035'].thumbnail_url = 'https://shop.example/img/thumb-b.png';
  const lookups = ig.mediaCalls.length;
  await open(s.app, '/r/thumb');
  assert.equal(ig.mediaCalls.length, lookups, 'within 6 hours nothing is read again');
  await s.app.db.platform.query(`UPDATE reels SET media_checked_at = now() - interval '7 hours' WHERE tenant_id = $1`, [s.tenant.id]);
  const stale = await open(s.app, '/r/thumb');
  assert.match(stale.text, /thumb-a\.png/, 'the shopper never waits for Instagram');
  const refreshed = await waitFor(async () => (await open(s.app, '/r/thumb')).text.includes('thumb-b.png'));
  assert.ok(refreshed, 'the next visit has the new thumbnail');
  assert.equal(ig.mediaCalls.length, lookups + 1, 'read once');
  const changed = await waitFor(async () => {
    const now = metaTag((await open(s.app, '/r/thumb', { ua: FACEBOOK_CRAWLER })).text, 'og:image');
    return now && now !== before ? now : null;
  });
  assert.ok(changed, 'K-39: the og:image address changed with the thumbnail');
});

test('K-41: below tier 2 a page links one product; on tier 2 the same page takes up to 20', async (t) => {
  const s = await shop(t, { plan: 't1' });
  const products = [];
  for (let i = 0; i < 21; i++) products.push(await addProduct(s.app, s.repos, s.tenant, { name: `Thing ${i + 1}`, externalUrl: `https://shop.example/thing-${i + 1}` }));
  const ids = products.map((p) => p.id);

  const two = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000040', headline: 'Things', productIds: ids.slice(0, 2) });
  assert.equal(two.status, 403);
  assert.equal(two.body.reason, 'plan.not_included');
  assert.match(two.body.error, /Upgrade/);
  const one = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000040', headline: 'Things', productIds: ids.slice(0, 1) });
  assert.equal(one.status, 201);
  assert.equal(one.body.productLimit, 1);
  const second = await s.api('PATCH', `/pages/${one.body.id}`, { productIds: ids.slice(0, 2) });
  assert.equal(second.status, 403);
  assert.equal(second.body.reason, 'plan.not_included');
  assert.equal(cards((await open(s.app, '/r/things')).text).length, 1);

  await setPlan(s.app, s.tenant, 't2');
  const twenty = await s.api('PATCH', `/pages/${one.body.id}`, { productIds: ids.slice(0, 20) });
  assert.equal(twenty.status, 200, JSON.stringify(twenty.body));
  assert.equal(twenty.body.productLimit, 20);
  assert.equal(cards((await open(s.app, '/r/things')).text).length, 20);
  assert.equal((await s.api('PATCH', `/pages/${one.body.id}`, { productIds: ids })).status, 400, '21 is past the limit on every plan');
  assert.equal((await s.api('PATCH', `/pages/${one.body.id}`, { productIds: [] })).status, 400, 'a page keeps at least one product');
});

test('K-42: "More reels" lists the other live reels of this reel\'s first category in that category\'s order, or the newest when it has none', async (t) => {
  const s = await shop(t);
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Bottle', externalUrl: 'https://shop.example/bottle' });
  const bottles = await s.repos.categories.save(null, { name: 'Bottles', position: 1, visible: true });
  const other = await s.repos.categories.save(null, { name: 'Other', position: 2, visible: true });
  const page = async (n, headline, extra = {}) => {
    const res = await s.api('POST', '/pages', { kind: 'reel', mediaId: `1790000000000005${n}`, headline, productIds: [product.id], ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const current = await page(0, 'Current', { categoryIds: [bottles.id] });
  const z = await page(1, 'Zed', { categoryIds: [bottles.id] });
  const x = await page(2, 'Ex', { categoryIds: [bottles.id, other.id] });
  const y = await page(3, 'Why', { categoryIds: [bottles.id] });
  await page(4, 'Loner');
  const off = await page(5, 'Switched off', { categoryIds: [bottles.id], active: false });
  assert.deepEqual(current.categoryIds, [bottles.id]);

  // The owner's order for Bottles is X, Y, Z (8.13 sets it; here it is put in place directly).
  for (const [position, id] of [x.id, y.id, z.id, current.id, off.id].entries()) {
    await s.app.db.platform.query('UPDATE category_reels SET position = $3 WHERE tenant_id = $1 AND page_id = $2 AND category_id = $4', [s.tenant.id, id, 100 + position, bottles.id]);
  }
  const strip = (html) => [...(/<div class="strip">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '').matchAll(/<a href="([^"]+)">[\s\S]*?<\/span>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
  const shown = await open(s.app, '/r/current');
  assert.deepEqual(strip(shown.text), [['/r/ex', 'Ex'], ['/r/why', 'Why'], ['/r/zed', 'Zed']]);
  assert.match(shown.text, /More from Bottles/);

  // A reel with no category falls back to the newest first, without itself and without anything switched off.
  const loner = strip((await open(s.app, '/r/loner')).text);
  assert.deepEqual(loner.map(([href]) => href), ['/r/why', '/r/ex', '/r/zed', '/r/current']);
  assert.match((await open(s.app, '/r/loner')).text, /More reels/);

  // Never more than six.
  for (let n = 6; n <= 9; n++) await page(n, `Extra ${n}`);
  for (let n = 10; n <= 12; n++) {
    const res = await s.api('POST', '/pages', { kind: 'reel', mediaId: `17900000000000${n}00`, headline: `Extra ${n}`, productIds: [product.id] });
    assert.equal(res.status, 201);
  }
  assert.equal(strip((await open(s.app, '/r/loner')).text).length, 6);

  // The owner can switch the strip off.
  await s.api('PATCH', '/page-settings', { moreReels: false });
  assert.deepEqual(strip((await open(s.app, '/r/current')).text), []);
});

test('K-40 (the part a server can show): 20 products come gzipped in well under 50 KB, images load lazily, nothing outside is called, and no pixel loads without consent', async (t) => {
  const s = await shop(t, { whatsapp: '919320001717' });
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await addProduct(s.app, s.repos, s.tenant, { name: `Handwoven cotton kurta in indigo, size ${i + 1}`, price: String(999 + i), mrp: '1999', externalUrl: `https://shop.example/products/kurta-${i + 1}?ref=home`, image: await upload(s, '#3B2FC9') })).id);
  await s.api('PATCH', '/page-settings', { whatsappOrder: true });
  // The seller has a Meta pixel switched on; shoppers haven't been asked yet, so the answer is no.
  await s.repos.tagSettings.save({ meta: { enabled: true, pixelId: '123456789012345' } }, { actor: 'user:1', userId: null });
  assert.equal((await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000060', headline: 'The big kurta edit', productIds: ids })).status, 201);

  const dialsBefore = s.sites.dials.length;
  const res = await openCompressed(s.app, '/r/the-big-kurta-edit?utm_source=instagram&utm_medium=dm');
  assert.equal(res.status, 200);
  assert.equal(res.encoding, 'gzip');
  assert.ok(res.declaredLength < 50 * 1024, `the page is ${res.declaredLength} bytes gzipped`);
  assert.equal(s.sites.dials.length, dialsBefore, 'no outside call was made to draw the page');
  assert.equal(cards(res.text).length, 20);

  const images = [...res.text.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.match(images.find((tag) => /fetchpriority="high"/.test(tag)) ?? '', /width="290" height="380"/, 'the hero image is sized and loads first');
  const cardImages = images.filter((tag) => /width="96"/.test(tag));
  assert.equal(cardImages.length, 20);
  assert.equal(cardImages.filter((tag) => /loading="lazy"/.test(tag)).length, 20, 'every product image is lazy, so the picture at the top loads first');
  assert.ok(cardImages.every((tag) => /src="\/media\/[0-9a-f-]{36}\/card"/.test(tag)), 'and is asked for at the size a card shows');
  assert.ok(images.every((tag) => /width="\d+" height="\d+"/.test(tag)), 'every image is sized, so nothing shifts');

  // The only script is the shop's own counter. The pixel waits for consent, which nobody has given.
  const scripts = [...res.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], new RegExp(`^<script src="${TRAFFIC_PATHS.script}" defer `));
  assert.doesNotMatch(res.text, /fbevents|fbq\(|googletagmanager|gtag\(/);
  assert.doesNotMatch(res.text, /bhava/i);

  // A client that can't take gzip still gets the page.
  const plain = await open(s.app, '/r/the-big-kurta-edit');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(cards(plain.text).length, 20);
});

test('the seller\'s list, the post picker and the page\'s own details', async (t) => {
  const ig = scriptedIg({
    '17900000000000070': { caption: 'Monsoon sale #rain', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/a/', thumbnail_url: 'https://shop.example/img/a.png', timestamp: '2026-11-01T10:00:00+0000' },
    '17900000000000071': { caption: 'A photo', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/b/', media_url: 'https://shop.example/img/b.png', timestamp: '2026-11-02T10:00:00+0000' },
    '17900000000000072': null,
  }, { stories: [{ id: '18000000000000070', media_type: 'IMAGE', media_url: 'https://shop.example/img/s.png', timestamp: new Date().toISOString() }] });
  const s = await shop(t, { ig });
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Umbrella', externalUrl: 'https://shop.example/umbrella' });

  // Instagram refuses a post that isn't this account's: no page.
  const notMine = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000072', productIds: [product.id] });
  assert.equal(notMine.status, 400);
  assert.match(notMine.body.fields.mediaId, /from your account/);

  const reel = await s.api('POST', '/pages', { kind: 'post', mediaId: '17900000000000070', productIds: [product.id] });
  assert.equal(reel.status, 201, JSON.stringify(reel.body));
  assert.equal(reel.body.kind, 'reel', 'Instagram says what the media is');
  assert.equal(reel.body.slug, 'monsoon-sale-rain', 'with no headline the link name comes from the caption');
  assert.equal(reel.body.mediaType, 'VIDEO');
  assert.equal(reel.body.postedAt, '2026-11-01T10:00:00.000Z');
  assert.equal((await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000070', productIds: [product.id] })).status, 409, 'one page per post');
  const post = await s.api('POST', '/pages', { kind: 'post', mediaId: '17900000000000071', headline: 'Photo', slug: 'photo-day', productIds: [product.id], active: false });
  assert.equal(post.status, 201);
  const taken = await s.api('POST', '/pages', { kind: 'story', mediaId: '18000000000000070', slug: 'photo-day', productIds: [product.id] });
  assert.equal(taken.status, 400);
  assert.match(taken.body.fields.slug, /already used/);
  assert.equal((await s.api('PATCH', `/pages/${reel.body.id}`, { slug: 'photo-day' })).status, 400);
  assert.equal((await s.api('PATCH', `/pages/${reel.body.id}`, { coverUrl: '/media/00000000-0000-4000-8000-000000000000' })).status, 400, 'a cover must be this business\'s own upload');

  await open(s.app, '/r/monsoon-sale-rain');
  const list = await s.api('GET', '/pages');
  assert.deepEqual(list.body.items.map((p) => [p.slug, p.kind, p.active, p.productCount]).sort(), [['monsoon-sale-rain', 'reel', true, 1], ['photo-day', 'post', false, 1]]);
  assert.equal(list.body.items.find((p) => p.slug === 'monsoon-sale-rain').visits, 1);
  assert.deepEqual((await s.api('GET', '/pages?kind=post')).body.items.map((p) => p.slug), ['photo-day']);
  assert.deepEqual((await s.api('GET', '/pages?status=active')).body.items.map((p) => p.slug), ['monsoon-sale-rain']);
  assert.deepEqual((await s.api('GET', '/pages?search=PHOTO')).body.items.map((p) => p.slug), ['photo-day']);
  const firstPage = await s.api('GET', '/pages?limit=1');
  assert.equal(firstPage.body.items.length, 1);
  const nextPage = await s.api('GET', `/pages?limit=1&cursor=${firstPage.body.nextCursor}`);
  assert.equal(nextPage.body.items.length, 1);
  assert.notEqual(nextPage.body.items[0].id, firstPage.body.items[0].id);
  assert.equal(nextPage.body.nextCursor, null);

  // The picker: posts, reels and live stories, each knowing whether it already has a page.
  const picker = await s.api('GET', '/page-media');
  assert.equal(picker.status, 200, JSON.stringify(picker.body));
  assert.deepEqual(picker.body.items.map((m) => [m.mediaId, m.kind, m.pageId]), [
    ['18000000000000070', 'story', null],
    ['17900000000000070', 'reel', reel.body.id],
    ['17900000000000071', 'post', post.body.id],
  ]);
  assert.deepEqual((await s.api('GET', '/page-media?kind=story')).body.items.map((m) => m.mediaId), ['18000000000000070']);

  // Every change is in the business's audit log, by id only.
  const audit = await s.app.db.platform.query(`SELECT action, target, details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'page.%' ORDER BY id`, [s.tenant.id]);
  assert.deepEqual(audit.map((a) => a.action), ['page.created', 'page.created']);
  assert.doesNotMatch(JSON.stringify(audit), /Monsoon|Umbrella/);

  // Nobody signed out can reach any of it.
  for (const [method, path] of [['GET', '/pages'], ['POST', '/pages'], ['GET', '/page-settings'], ['PUT', '/page-blocks'], ['GET', '/page-media']]) {
    const res = await fetch(`${s.app.base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a headline or product name carrying markup is shown as text, in the page and in its share tags', async (t) => {
  const s = await shop(t, { whatsapp: '919320001717' });
  const evil = await addProduct(s.app, s.repos, s.tenant, { name: '"><script>alert(1)</script>', externalUrl: 'https://shop.example/x?a=1&b="><script>alert(2)</script>' });
  await s.api('PATCH', '/page-settings', { whatsappOrder: true, whatsappTemplate: '{product} </a><script>alert(3)</script>' });
  const made = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000080', headline: '<img src=x onerror=alert(4)>', slug: 'odd', description: '</title><script>alert(5)</script>', productIds: [evil.id] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const page = await open(s.app, '/r/odd');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<script>alert|<img src=x/);
  assert.equal([...page.text.matchAll(/<script\b/g)].length, 1, 'only the shop\'s own counter');
  const [card] = cards(page.text);
  assert.equal(decode(card.name), '"><script>alert(1)</script>');
  assert.equal(card.href, '', 'an address that could break out of its attribute is not linked at all');
  assert.equal(new URL(card.wa).host, 'wa.me');
});

test('8.12: a business\'s own images are served at the size the page shows them, as WebP, and only to that business', async (t) => {
  const s = await shop(t);
  const other = await secondShop(s.app);
  const original = await s.api.upload(photo('#2F6B3A', 1600, 1200));
  const images = createImages();
  const sizes = {};
  for (const variant of ['hero', 'card', 'tile']) {
    const res = await fetch(`${s.app.base}${original}/${variant}`);
    assert.equal(res.status, 200, variant);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.match(res.headers.get('cache-control'), /immutable/);
    sizes[variant] = await images.inspect(Buffer.from(await res.arrayBuffer()));
  }
  assert.deepEqual([sizes.hero.width, sizes.card.width, sizes.tile.width], [640, 240, 160]);
  assert.deepEqual([sizes.hero.height, sizes.card.height], [480, 180], 'the shape is kept');
  // The second request is the stored copy.
  const again = await fetch(`${s.app.base}${original}/card`);
  assert.deepEqual(await images.inspect(Buffer.from(await again.arrayBuffer())), sizes.card);
  // A small image is never blown up.
  const small = await s.api.upload(photo('#2F6B3A', 100, 80));
  assert.equal((await images.inspect(Buffer.from(await (await fetch(`${s.app.base}${small}/hero`)).arrayBuffer()))).width, 100);

  // Only the three sizes exist, only for real files, and only on the owner's own address.
  for (const path of [`${original}/huge`, `${original}/9999`, '/media/00000000-0000-4000-8000-000000000000/card', '/media/not-an-id/card']) {
    assert.equal((await fetch(`${s.app.base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${s.app.base}${original}/card`, { headers: { 'x-forwarded-host': other.host } })).status, 404, 'another business can\'t read it');
  assert.equal((await fetch(`${s.app.base}${original}`)).status, 200, 'the original is still served as before');
});
