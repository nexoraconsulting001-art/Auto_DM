// PRD 8.11 and 8.12: the WhatsApp order button, share previews and the speed budget of a landing page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  TRAFFIC_PATHS, UA, VISITOR_COOKIE, addP3Shop, assertNoLiveMarkup, assertNoRedirect, gzipSize, hit, linksOf, need, noPlatformName, setTier, shareTags, shopperOf,
  tagsOf, textOf, unique, useP3World,
} from './kit.js';

const world = useP3World();

const NUMBER = '+91 93200 01717';
const waLinks = (html) => linksOf(html).filter((a) => /^https?:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\b/i.test(a.href) || /^whatsapp:/i.test(a.href));
const open = async (shop, landing, query = '') => need(await shop.open(`/r/${landing.slug}${query}`), 200, 'The landing page').text;

async function whatsappShop(options = {}) {
  const shop = await addP3Shop(world, options);
  await shop.whatsapp(NUMBER);
  const settings = await shop.must('PATCH', '/page-settings', { whatsappOrder: true });
  assert.equal(settings.whatsappAvailable, true, 'With a number saved the button is available');
  return shop;
}

/** The order button of one product: the wa.me link that names it. */
function orderLink(html, name) {
  const links = waLinks(html).filter((a) => /[?&]text=/.test(a.href));
  const found = links.find((a) => (new URL(a.href).searchParams.get('text') ?? '').includes(name));
  assert.ok(found, `No WhatsApp order button names "${name}". wa.me links: ${links.map((l) => l.href).join(' | ') || 'none'}`);
  return new URL(found.href);
}

// ---- K-35 ------------------------------------------------------------------------------------------------------------------

test('K-35: the WhatsApp button for "Steel Bottle ₹349" opens wa.me with the name, price and page link, and one click is counted', async () => {
  const shop = await whatsappShop();
  const bottle = await shop.product({ name: 'Steel Bottle', pricePaise: 34900 });
  const landing = await shop.page({ productIds: [bottle.id] });
  const query = '?utm_source=instagram&utm_medium=dm&utm_campaign=reel&utm_content=18000000000000001&t=secret-token';
  const shopper = shopperOf(world, shop, { ua: UA.instagram });
  const html = (await shopper.open(`/r/${landing.slug}${query}`)).text;
  const link = orderLink(html, 'Steel Bottle');
  assert.equal(link.origin, 'https://wa.me', 'Straight to wa.me');
  assert.equal(link.pathname, '/919320001717');
  assert.deepEqual([...link.searchParams.keys()], ['text'], 'Only the prefilled text: no UTM on a WhatsApp link');
  const text = link.searchParams.get('text');
  assert.ok(text.includes('Steel Bottle'), 'The name');
  assert.ok(text.includes('₹349'), 'The price');
  assert.ok(text.includes(`https://${shop.host}/r/${landing.slug}`), 'The landing page link');
  assert.doesNotMatch(text, /utm_|secret-token|[?&]t=/, 'The link in the message has no token or UTM');
  assert.equal(text, `Hi, I would like to order Steel Bottle (₹349). https://${shop.host}/r/${landing.slug}`, 'The default message, filled in');
  noPlatformName('The WhatsApp message', text);

  const before = (await shop.trafficEvents(['whatsapp_tap'])).length;
  const event = { name: 'whatsapp_tap', path: `/r/${landing.slug}`, pageKind: 'landing', pageRef: landing.slug, productId: bottle.id, eventId: `wa-${unique()}` };
  need(await shopper.beacon(event), [200, 201, 202, 204], 'The click beacon');
  need(await shopper.beacon(event), [200, 201, 202, 204], 'The same beacon again');
  const counted = await shop.trafficEvents(['whatsapp_tap']);
  assert.equal(counted.length - before, 1, 'One click');
  assert.equal(counted.at(-1).product_id, bottle.id, `Counted against wa-${bottle.id}`);
});

test('K-35: the owner\'s own message is used with {product}, {price} and {url} filled in; one without {product} is refused', async () => {
  const shop = await whatsappShop();
  const mug = await shop.product({ name: 'Blue Mug', pricePaise: 129950, mrpPaise: 150000 });
  const landing = await shop.page({ productIds: [mug.id] });
  await shop.must('PATCH', '/page-settings', { whatsappTemplate: 'Namaste! {product} @ {price} chahiye. {url} {name} {unknown}' });
  const text = orderLink(await open(shop, landing), 'Blue Mug').searchParams.get('text');
  assert.equal(text, `Namaste! Blue Mug @ ₹1,299.50 chahiye. https://${shop.host}/r/${landing.slug} {name} {unknown}`, 'Unknown {names} stay as written; the price is the card price');
  for (const bad of ['Order please', '', 'x'.repeat(501), '{price} only']) {
    assert.equal((await shop.send('PATCH', '/page-settings', { whatsappTemplate: bad })).status, 400, `Template "${bad.slice(0, 20)}"`);
  }
  await shop.must('PATCH', '/page-settings', { whatsappOrder: false });
  assert.deepEqual(waLinks(await open(shop, landing)).filter((a) => /text=/.test(a.href)), [], 'Switched off, there is no order button');
});

test('K-35: the button is per business and per product, only ever to the business\'s own number, and needs the plan', async () => {
  const shop = await whatsappShop();
  const other = await addP3Shop(world);
  await other.whatsapp('+91 98111 22334');
  await other.must('PATCH', '/page-settings', { whatsappOrder: true });
  const yes = await shop.product({ name: 'With button', pricePaise: 10000 });
  const no = await shop.product({ name: 'Without button', pricePaise: 20000, whatsappOrder: false });
  const landing = await shop.page({ productIds: [yes.id, no.id] });
  const html = await open(shop, landing, '?wa=919999999999&number=919999999999&phone=919999999999');
  const texts = waLinks(html).map((a) => new URL(a.href)).filter((u) => u.searchParams.has('text'));
  assert.ok(texts.some((u) => u.searchParams.get('text').includes('With button')));
  assert.ok(!texts.some((u) => u.searchParams.get('text').includes('Without button')), 'A product switched off has no button');
  for (const a of waLinks(html)) assert.match(a.href, /^https:\/\/wa\.me\/919320001717(\?|$)/, `Every WhatsApp link goes to the business's own number: ${a.href}`);
  assert.ok(!html.includes('919811122334') && !html.includes('919999999999'), 'Never another number');

  await setTier(world, shop, 't1');
  assert.equal((await shop.must('GET', '/page-settings')).whatsappAvailable, false, 'Tier 1 has no order button');
  assert.deepEqual(waLinks(await open(shop, landing)).filter((a) => /text=/.test(a.href)), []);
});

// ---- K-36 ------------------------------------------------------------------------------------------------------------------

test('K-36: the saved number "+91 93200 01717" is used as 919320001717', async () => {
  const shop = await whatsappShop();
  const product = await shop.product({ name: 'Number check', pricePaise: 5000 });
  const landing = await shop.page({ productIds: [product.id] });
  const link = orderLink(await open(shop, landing), 'Number check');
  assert.equal(`${link.origin}${link.pathname}`, 'https://wa.me/919320001717');
  assert.equal((await shop.must('GET', '/page-settings')).whatsappNumber.replace(/\D/g, ''), '919320001717');
  for (const written of ['+91-93200-01717', '(+91) 93200 01717', '91 9320001717', '+91.93200.01717']) {
    await shop.whatsapp(written);
    const again = orderLink(await open(shop, landing), 'Number check');
    assert.equal(again.pathname, '/919320001717', `"${written}" is used as digits`);
  }
});

test('K-36: a number that can\'t be one, or none at all, hides the button rather than making a broken link', async () => {
  const shop = await whatsappShop();
  const product = await shop.product({ name: 'No number', pricePaise: 5000 });
  const landing = await shop.page({ productIds: [product.id] });
  for (const written of ['', '12345', '0093200 01717', 'call me', '+', '<script>alert(1)</script>', '+91 93200 01717 ext 4']) {
    const res = await shop.send('PATCH', '/settings', { supportWhatsapp: written });
    assert.ok(res.status === 200 || res.status === 400, `Saving "${written}" answered ${res.status}`);
    if (res.status === 400) await shop.whatsapp('');
    const html = await open(shop, landing);
    const links = waLinks(html);
    for (const a of links) assert.match(a.href, /^https:\/\/wa\.me\/[1-9]\d{7,14}(\?|$)/, `"${written}" made a broken WhatsApp link: ${a.href}`);
    if (['', '12345', '0093200 01717', 'call me', '+'].includes(written)) {
      assert.deepEqual(links, [], `"${written}": no usable number, so no button`);
      assert.equal((await shop.must('GET', '/page-settings')).whatsappAvailable, false);
    }
    assertNoLiveMarkup(html, 'The landing page');
  }
});

// ---- K-37 ------------------------------------------------------------------------------------------------------------------

test('K-37: a product name with & and # is encoded in the WhatsApp text, so the whole message arrives', async () => {
  const shop = await whatsappShop();
  const names = ['Tom & Jerry #1 Mug', 'Salt+Pepper = 100% "pure"?', 'तांबे की बोतल ☕ 500ml', 'A&B=C#D%20E;F/G', "O'Brien's <b>bold</b> & co."];
  const ids = [];
  for (const name of names) ids.push((await shop.product({ name, pricePaise: 34900 })).id);
  const landing = await shop.page({ productIds: ids });
  const html = await open(shop, landing);
  assertNoLiveMarkup(html, 'The landing page');
  for (const name of names) {
    const link = orderLink(html, name);
    assert.deepEqual([...link.searchParams.keys()], ['text'], `"${name}": an unencoded & split the link`);
    assert.equal(link.hash, '', `"${name}": an unencoded # cut the message short`);
    const text = link.searchParams.get('text');
    assert.equal(text, `Hi, I would like to order ${name} (₹349). https://${shop.host}/r/${landing.slug}`);
    const raw = waLinks(html).find((a) => a.href.includes(encodeURIComponent(name).slice(0, 12)))?.href ?? link.href;
    assert.doesNotMatch(raw.split('?text=')[1] ?? '', /[ #&"<>]/, `"${name}": the text is not URL-encoded: ${raw}`);
  }
  assert.doesNotMatch(html, /href="https:\/\/wa\.me\/[^"]*<b>/, 'Markup in a name never sits raw in the link');
});

test('K-37: a template with URL characters of its own is encoded as well', async () => {
  const shop = await whatsappShop();
  const product = await shop.product({ name: 'Plain jar', pricePaise: 9900 });
  const landing = await shop.page({ productIds: [product.id] });
  await shop.must('PATCH', '/page-settings', { whatsappTemplate: 'Q&A? {product} #1 at {price} & more: {url}\nThanks 100%' });
  const link = orderLink(await open(shop, landing), 'Plain jar');
  assert.deepEqual([...link.searchParams.keys()], ['text']);
  assert.equal(link.hash, '');
  assert.equal(link.searchParams.get('text'), `Q&A? Plain jar #1 at ₹99 & more: https://${shop.host}/r/${landing.slug}\nThanks 100%`);
});

// ---- K-38 ------------------------------------------------------------------------------------------------------------------

test('K-38: a facebookexternalhit fetch gets all 7 share tags, early in <head>, and no visit is counted', async () => {
  const shop = await addP3Shop(world);
  const image = await shop.upload('#C8794E', { width: 1200, height: 1200 });
  const product = await shop.product({ name: 'Shared product', pricePaise: 49900, images: [image] });
  const landing = await shop.page({ productIds: [product.id], headline: 'Monsoon picks', description: 'Three things for the rain' });
  const query = '?utm_source=instagram&utm_medium=dm&utm_campaign=reel&fbclid=abc';
  const res = await shop.open(`/r/${landing.slug}${query}`, { ua: UA.facebookCrawler });
  assert.equal(res.status, 200);
  assertNoRedirect(res, 'The crawler\'s fetch');
  const tags = shareTags(res.text, 'The landing page');
  assert.equal(tags['og:url'], `https://${shop.host}/r/${landing.slug}`, 'og:url has no query');
  assert.ok(tags['og:title'].includes('Monsoon picks'), `og:title: ${tags['og:title']}`);
  assert.ok(tags['og:description'].length > 0);
  assert.match(tags['og:image'], /^https:\/\//, 'og:image is a full address');
  assert.ok(tags['og:image:width'] >= 1080, `The image is 1080 px or wider: ${tags['og:image:width']}`);
  assert.ok(['website', 'product'].includes(tags['og:type']));
  assert.ok(['summary_large_image', 'summary'].includes(tags['twitter:card']));
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(res.text)[1];
  assert.ok(head.indexOf('og:image') < head.search(/<style\b/i), 'The share tags come before the stylesheet');
  assert.ok(head.indexOf('og:image') < 4096, 'The share tags are in the first 4 KB');
  noPlatformName('The share tags', JSON.stringify(tags));
  const picture = new URL(tags['og:image']);
  assert.equal(picture.host, shop.host, 'The preview image is served from the business\'s own host');
  const file = need(await hit(world, `${picture.pathname}${picture.search}`, { host: shop.host, headers: { 'user-agent': UA.facebookCrawler } }), 200, 'The preview image');
  assert.match(file.headers['content-type'], /^image\/(png|jpeg|webp)/);

  assert.ok(!([res.headers['set-cookie'] ?? []].flat().join(';')).includes(`${VISITOR_COOKIE}=`), 'A crawler gets no visitor cookie');
  await shop.settle({ ms: 3000 });
  assert.equal((await shop.sessions()).length, 0, 'No visit is counted for a crawler');
  assert.equal((await shop.trafficEvents()).length, 0, 'And no event');

  const shopper = shopperOf(world, shop);
  await shopper.open(`/r/${landing.slug}${query}`);
  await shop.settle({ ms: 3000 });
  assert.ok((await shop.sessions()).length >= 1, 'A shopper\'s visit is counted, so the count works');
});

test('K-38: every preview crawler is treated the same, robots.txt lets facebookexternalhit in, and the page is noindex', async () => {
  const shop = await addP3Shop(world);
  const landing = await shop.page({ headline: '</title><script>alert(1)</script> "quoted" & co', description: '"><meta http-equiv="refresh" content="0;url=https://evil.example">' });
  for (const ua of [UA.whatsappCrawler, UA.googleBot, 'Twitterbot/1.0', 'meta-externalagent/1.1', 'LinkedInBot/1.0', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)']) {
    const res = await shop.open(`/r/${landing.slug}`, { ua });
    assert.equal(res.status, 200, ua);
    shareTags(res.text, `For ${ua}`);
    assertNoLiveMarkup(res.text, `For ${ua}`);
    assert.doesNotMatch(res.text, /http-equiv=["']?refresh/i, 'A description can\'t add a meta tag');
    assert.equal(tagsOf(res.text, 'title').length, 1);
  }
  const beacon = await hit(world, TRAFFIC_PATHS.event, { host: shop.host, method: 'POST', headers: { 'user-agent': UA.facebookCrawler, 'content-type': 'application/json' }, body: { name: 'page_view', path: `/r/${landing.slug}`, pageKind: 'landing' } });
  assert.ok(beacon.status < 500);
  await shop.settle({ ms: 2500 });
  assert.equal((await shop.sessions()).length, 0, 'No crawler made a visit');
  assert.equal((await shop.trafficEvents()).length, 0);

  const robots = need(await shop.open('/robots.txt'), 200, 'robots.txt');
  assert.match(robots.headers['content-type'], /text\/plain/);
  const blocks = robots.text.split(/\n\s*\n/).map((b) => b.trim());
  const fb = blocks.find((b) => /user-agent:\s*facebookexternalhit/i.test(b));
  assert.ok(fb, `robots.txt names facebookexternalhit: ${robots.text}`);
  assert.doesNotMatch(fb, /^disallow:\s*\/\s*$/im, 'facebookexternalhit is allowed');
  noPlatformName('robots.txt', robots.text);
  const page = await shop.open(`/r/${landing.slug}`);
  const robotsMeta = tagsOf(page.text, 'meta').find((t) => t.name === 'robots')?.content ?? page.headers['x-robots-tag'] ?? '';
  assert.match(robotsMeta, /noindex/, 'A landing page is noindex by default');
});

// ---- K-39 ------------------------------------------------------------------------------------------------------------------

const ogImage = async (shop, landing) => shareTags((await shop.open(`/r/${landing.slug}`, { ua: UA.facebookCrawler })).text, 'The page')['og:image'];
const expire = (shop, pageId) => shop.sql(`UPDATE reels SET posted_at = now() - interval '30 hours', expires_at = now() - interval '6 hours' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, pageId]);

test('K-39: when the thumbnail changes the og:image URL changes; when nothing changes it stays the same', async () => {
  const shop = await addP3Shop(world);
  const product = await shop.product({ name: 'Preview product', images: [await shop.upload('#225588', { width: 1200, height: 1200 })] });
  const storyId = await shop.story();
  const landing = await shop.page({ kind: 'story', mediaId: storyId, productIds: [product.id] });
  await shop.must('PATCH', `/pages/${landing.id}`, { coverUrl: await shop.upload('#AA2222', { width: 1080, height: 1920 }) });
  await expire(shop, landing.id);
  await shop.settle({ ms: 3000 });
  const first = await ogImage(shop, landing);
  assert.equal(await ogImage(shop, landing), first, 'The same thumbnail keeps the same address, so Meta\'s cache holds');

  await shop.must('PATCH', `/pages/${landing.id}`, { coverUrl: await shop.upload('#22AA22', { width: 1080, height: 1920 }) });
  await shop.settle({ ms: 3000 });
  const second = await ogImage(shop, landing);
  assert.notEqual(second, first, 'A new thumbnail has a new og:image URL');
  await shop.must('PATCH', `/pages/${landing.id}`, { coverUrl: '' });
  await shop.settle({ ms: 3000 });
  const third = await ogImage(shop, landing);
  assert.ok(third !== second && third !== first, 'Falling back to the product image is a new URL again');
  for (const url of [first, second, third]) noPlatformName('An og:image URL', url);
  const now = new URL(third);
  need(await hit(world, `${now.pathname}${now.search}`, { host: shop.host }), 200, 'The current preview image');
});

test('K-39: two pages never share a preview address, and a preview is only served on its own business\'s host', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const a = await shop.page({ productIds: [(await shop.product({ name: 'A', images: [await shop.upload('#111111', { width: 1200, height: 1200 })] })).id] });
  const b = await shop.page({ productIds: [(await shop.product({ name: 'B', images: [await shop.upload('#999999', { width: 1200, height: 1200 })] })).id] });
  const [ia, ib] = [await ogImage(shop, a), await ogImage(shop, b)];
  assert.notEqual(ia, ib);
  const url = new URL(ia);
  assert.equal((await hit(world, `${url.pathname}${url.search}`, { host: other.host })).status, 404, 'Another business\'s host doesn\'t serve it');
  const firstProduct = (await shop.must('GET', `/pages/${a.id}`)).products[0];
  await shop.must('PATCH', `/products/${firstProduct.id}`, { images: [await shop.upload('#00CCCC', { width: 1200, height: 1200 })] });
  await shop.settle({ ms: 3000 });
  assert.equal(await ogImage(shop, b), ib, 'Changing one page\'s picture leaves another\'s address alone');
});

// ---- K-40 ------------------------------------------------------------------------------------------------------------------

async function twentyProductPage(shop) {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await shop.product({ name: `Speed product number ${i + 1} with a fairly long name`, pricePaise: 49900 + i * 100, mrpPaise: 99900, images: [await shop.upload('#C8794E', { width: 800, height: 800 })], externalUrl: `https://${shop.siteHost}/p/speed-${i}` })).id);
  return shop.page({ productIds: ids, headline: 'Twenty things you asked about' });
}

test('K-40: a landing page with 20 products is under 50 KB gzipped, server-rendered with inline CSS and lazy images, and makes no outside call', async () => {
  const shop = await addP3Shop(world);
  await shop.whatsapp(NUMBER);
  await shop.must('PATCH', '/page-settings', { whatsappOrder: true });
  const landing = await twentyProductPage(shop);
  await shop.open(`/r/${landing.slug}`);
  const dials = world.dials.length;
  await world.meta.delete('/calls');
  const started = Date.now();
  const res = await hit(world, `/r/${landing.slug}?utm_source=instagram&utm_medium=dm`, { host: shop.host, headers: { 'user-agent': UA.instagram, 'accept-encoding': 'gzip' } });
  const took = Date.now() - started;
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip', 'The page is sent gzipped');
  assert.ok(res.raw.length < 50 * 1024, `The page is ${res.raw.length} bytes gzipped`);
  const html = zlib.gunzipSync(res.raw).toString('utf8');
  assert.ok(gzipSize(html) < 50 * 1024);
  assert.ok(took < 1000, `The server took ${took} ms`);
  assert.equal(world.dials.length, dials, 'Serving the page fetched nothing from outside');
  assert.deepEqual(await world.meta.calls(), [], 'Serving the page called Instagram for nothing');

  assert.equal((textOf(html).match(/Speed product number \d+/g) ?? []).length >= 20, true, 'All 20 products are in the HTML itself, not loaded by script');
  assert.ok(/<style\b/i.test(html), 'The CSS is inline');
  const blocking = tagsOf(html, 'link').filter((l) => l.rel === 'stylesheet' && !/fonts\.googleapis\.com/.test(l.href ?? ''));
  assert.deepEqual(blocking.map((l) => l.href), [], 'No stylesheet to wait for besides the fonts');
  const scripts = tagsOf(html, 'script').filter((s) => s.src);
  for (const s of scripts) assert.ok('defer' in s || 'async' in s || s.type === 'module', `Script ${s.src} blocks rendering`);
  for (const s of scripts) assert.ok(s.src.startsWith('/') && !s.src.startsWith('//'), `Script ${s.src} is from another site`);
  const images = tagsOf(html, 'img');
  const lazy = images.filter((i) => i.loading === 'lazy');
  assert.ok(images.length >= 20, `Every card has its photo: ${images.length} images`);
  assert.ok(lazy.length >= images.length - 4, `Images below the fold are lazy: ${lazy.length} of ${images.length}`);
  assert.ok(images.every((i) => i.width && i.height), 'Every image has its size, so nothing jumps');
  assert.ok(images.filter((i) => i.loading !== 'lazy').length >= 1, 'The first image is not lazy: it is the largest paint');
  const again = await hit(world, `/r/${landing.slug}`, { host: shop.host, headers: { 'user-agent': UA.instagram } });
  assert.ok(Buffer.byteLength(again.text) > res.raw.length, 'Without Accept-Encoding the page comes plain');
});

test('K-40: twenty hostile product names and a long headline still fit the budget and stay inert', async () => {
  const shop = await addP3Shop(world);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await shop.product({ name: `<script>alert(${i})</script>${'व'.repeat(80)}`.slice(0, 120), description: 'x'.repeat(5000), pricePaise: 100 })).id);
  const landing = await shop.page({ productIds: ids, headline: 'H'.repeat(200), description: 'D'.repeat(300) });
  const res = await hit(world, `/r/${landing.slug}`, { host: shop.host, headers: { 'user-agent': UA.phone, 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  const html = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.raw).toString('utf8') : res.text;
  assert.ok(gzipSize(html) < 50 * 1024, `${gzipSize(html)} bytes gzipped`);
  assertNoLiveMarkup(html, 'The landing page');
  assert.ok(!html.includes('x'.repeat(1000)), 'A 5,000-character description is not poured into a card');
});
