// PRD 8.10: the landing page for a reel, post or story. The DM links straight to it; it answers 200 with no redirect, shows
// the products in the owner's order, and every button on it opens the product's own address directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_LIMITS, HOSTILE_NAMES, HOUR, PLAN_REASON, UA, addP3Shop, assertBranded404, assertNoLiveMarkup, assertNoRedirect, hit, linksOf, need, noPlatformName,
  productIdsOf, reelSlugsOf, setTier, shopperOf, textOf, unique, useP3World,
} from './kit.js';

const world = useP3World();

const html = async (shop, landing, query = '') => need(await shop.open(`/r/${landing.slug}${query}`), 200, 'The landing page').text;
const taps = (shop) => shop.trafficEvents(['outbound_tap', 'product_tap', 'whatsapp_tap', 'link_tap']);
const DM_UTM = (mediaId) => `?utm_source=instagram&utm_medium=dm&utm_campaign=reel&utm_content=${mediaId}`;

async function three(shop) {
  const out = [];
  for (const n of [1, 2, 3]) out.push(await shop.product({ name: `Ordered product ${n}`, pricePaise: 10000 * n, externalUrl: `https://${shop.siteHost}/p/${n}-${unique()}` }));
  return out;
}

// ---- K-30 ------------------------------------------------------------------------------------------------------------------

test('K-30: the owner orders products 3, 1, 2 and cards 1 to 3 show them in that order', async () => {
  const shop = await addP3Shop(world);
  const [p1, p2, p3] = await three(shop);
  const landing = await shop.page({ productIds: [p3.id, p1.id, p2.id] });
  assert.deepEqual(landing.products.map((p) => p.id), [p3.id, p1.id, p2.id]);
  assert.deepEqual(landing.products.map((p) => p.position), [0, 1, 2]);
  const page = await html(shop, landing);
  assert.deepEqual(productIdsOf(page), [p3.id, p1.id, p2.id]);
  const text = textOf(page);
  const at = [p3, p1, p2].map((p) => text.indexOf(p.name));
  assert.ok(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2], 'The names appear in the owner\'s order');
  const numbers = [...page.matchAll(/<span class="num">([^<]*)<\/span>/g)].map((m) => m[1].trim());
  assert.deepEqual(numbers.slice(0, 3).map(Number), [1, 2, 3], 'The cards are numbered 1 to 3');

  const reordered = await shop.must('PATCH', `/pages/${landing.id}`, { productIds: [p2.id, p3.id, p1.id] });
  assert.deepEqual(reordered.products.map((p) => p.id), [p2.id, p3.id, p1.id]);
  assert.deepEqual(productIdsOf(await html(shop, landing)), [p2.id, p3.id, p1.id], 'A new order shows on the next load');
  const rows = await shop.sql('SELECT product_id FROM reel_products WHERE tenant_id = $1 ORDER BY position', [shop.tenantId]);
  assert.deepEqual(rows.map((r) => r.product_id), [p2.id, p3.id, p1.id], 'One stored order');
});

test('K-30: 20 products keep their order; a 21st, a repeated one or another business\'s product is refused', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await shop.product({ name: `Many ${i + 1}`, pricePaise: 1000 + i })).id);
  const shuffled = ids.slice(0, 20).reverse();
  const landing = await shop.page({ productIds: shuffled });
  assert.equal(landing.productLimit, CATALOG_LIMITS.landingProducts);
  assert.deepEqual(productIdsOf(await html(shop, landing)), shuffled);
  assert.equal((await shop.send('PATCH', `/pages/${landing.id}`, { productIds: ids })).status, 400, '21 products');
  const twice = await shop.send('PATCH', `/pages/${landing.id}`, { productIds: [ids[0], ids[0], ids[1]] });
  assert.ok(twice.status === 400 || new Set(twice.json().products.map((p) => p.id)).size === twice.json().products.length, 'A product is never on a page twice');
  const theirs = await other.product({ name: 'Not yours' });
  const foreign = await shop.send('PATCH', `/pages/${landing.id}`, { productIds: [ids[0], theirs.id] });
  assert.ok([400, 404].includes(foreign.status), `Another business's product answered ${foreign.status}`);
  const mediaId = await shop.reel();
  const created = await shop.send('POST', '/pages', { kind: 'reel', mediaId, productIds: [theirs.id] });
  assert.ok([400, 404].includes(created.status), `A page of another business's product answered ${created.status}`);
  assert.ok(!textOf(await html(shop, landing)).includes('Not yours'));
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM reel_products WHERE tenant_id = $1 AND product_id = $2', [shop.tenantId, theirs.id]))[0].n, 0);
  for (const [method, route, body] of [['GET', `/pages/${landing.id}`], ['PATCH', `/pages/${landing.id}`, { headline: 'Hijacked' }], ['DELETE', `/pages/${landing.id}`]]) {
    assert.equal((await other.send(method, route, body)).status, 404, `Another business ${method} ${route}`);
  }
  assert.equal((await shop.must('GET', `/pages/${landing.id}`)).products.length, 20);
});

test('K-30: an archived product drops off the page; hostile names and captions show as text', async () => {
  const shop = await addP3Shop(world);
  const ids = [];
  for (const name of HOSTILE_NAMES) ids.push((await shop.product({ name, description: '<img src=x onerror=alert(1)>' })).id);
  const hidden = await shop.product({ name: 'Archived one', active: false });
  const mediaCaption = '<script>alert(1)</script> "caption" </title><svg onload=alert(1)>';
  const landing = await shop.page({ productIds: [...ids, hidden.id], headline: '<script>alert(1)</script>Headline & more', description: '"><script>alert(1)</script>', caption: mediaCaption });
  const page = await html(shop, landing);
  assertNoLiveMarkup(page, 'The landing page');
  assert.doesNotMatch(page, /<svg onload/i);
  assert.equal((page.match(/<title\b/gi) ?? []).length, 1, 'One <title>');
  assert.deepEqual(productIdsOf(page), ids.filter((id) => page.includes(`data-product="${id}"`)), 'Only cards with a link carry ids');
  assert.ok(!textOf(page).includes('Archived one'), 'An archived product is not shown');
  assert.ok(textOf(page).includes('Headline & more'), 'The ampersand shows as written');
  assert.ok(textOf(page).includes('{{7*7}}${7*7}'), 'Template text is shown, not evaluated');
});

// ---- K-31 ------------------------------------------------------------------------------------------------------------------

const expire = (shop, pageId) => shop.sql(`UPDATE reels SET posted_at = now() - interval '30 hours', expires_at = now() - interval '6 hours' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, pageId]);

test('K-31: a story link opened 30 h after posting shows the owner\'s cover image, and no story media was ever stored', async () => {
  const shop = await addP3Shop(world);
  const productImage = await shop.upload('#AA5522');
  const product = await shop.product({ name: 'Story product', images: [productImage] });
  const mediaBefore = (await shop.mediaRows()).length;
  const storyId = await shop.story({ caption: 'Today only' });
  const landing = await shop.page({ kind: 'story', mediaId: storyId, productIds: [product.id] });
  assert.equal(landing.kind, 'story');
  assert.ok(landing.expiresAt, 'A story page knows when the story ends');
  assert.ok(Math.abs(new Date(landing.expiresAt) - new Date(landing.postedAt) - 24 * HOUR) < HOUR, 'A story lasts 24 hours');
  const cover = await shop.upload('#3355AA', { width: 1080, height: 1920, filename: 'cover.png' });
  await shop.must('PATCH', `/pages/${landing.id}`, { coverUrl: cover });
  assert.equal((await shop.mediaRows()).length, mediaBefore + 1, 'Only the cover the owner uploaded was stored');
  await expire(shop, landing.id);

  const page = await html(shop, landing, DM_UTM(storyId));
  assert.ok(page.includes(cover), 'The owner\'s cover is shown');
  const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
  assert.ok(hero.includes(cover), 'The cover is the page\'s main image');
  assert.ok(!page.includes(`media.invalid/${storyId}`), 'The expired story\'s own media is not shown');
  assert.doesNotMatch(hero, /<video/i, 'No story video after it expired');
  assert.ok(textOf(page).includes('Story product'), 'The products still show');
  assert.equal((await shop.mediaRows()).length, mediaBefore + 1, 'No story media was copied when the page was opened');
  const [row] = await shop.sql('SELECT media_url, thumbnail_url, cover_media_id FROM reels WHERE tenant_id = $1 AND id = $2', [shop.tenantId, landing.id]);
  assert.ok(row.cover_media_id, 'The cover is kept as the business\'s own file');
  const stored = await shop.sql(`SELECT count(*)::int AS n FROM media WHERE tenant_id = $1 AND created_at > now() - interval '1 hour' AND size > 0`, [shop.tenantId]);
  assert.ok(stored[0].n <= mediaBefore + 1);
});

test('K-31: with no cover, the first product image is shown; with neither, the page still answers with nothing of the story', async () => {
  const shop = await addP3Shop(world);
  const first = await shop.upload('#118833');
  const second = await shop.upload('#883311');
  const a = await shop.product({ name: 'First product', images: [first] });
  const b = await shop.product({ name: 'Second product', images: [second] });
  const storyId = await shop.story();
  const landing = await shop.page({ kind: 'story', mediaId: storyId, productIds: [a.id, b.id] });
  await expire(shop, landing.id);
  const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(await html(shop, landing))?.[0] ?? '';
  assert.ok(hero.includes(first), 'The first product\'s image stands in');
  assert.ok(!hero.includes(second));
  assert.ok(!hero.includes('media.invalid'), 'Not the story');

  const bare = await shop.product({ name: 'No photo' });
  const otherStory = await shop.story();
  const plain = await shop.page({ kind: 'story', mediaId: otherStory, productIds: [bare.id] });
  await expire(shop, plain.id);
  const res = await shop.open(`/r/${plain.slug}`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(`media.invalid/${otherStory}`));
  const theirs = await (await addP3Shop(world)).upload('#000000');
  const steal = await shop.send('PATCH', `/pages/${plain.id}`, { coverUrl: theirs });
  assert.ok(steal.status < 500);
  if (steal.status === 200) assert.ok(!(await shop.open(`/r/${plain.slug}`)).text.includes(theirs) || (await shop.open(theirs)).status === 404, 'Another business\'s file is never a cover here');
});

// ---- K-32 ------------------------------------------------------------------------------------------------------------------

test('K-32: the DM link answers 200 with no redirect; a product tap opens the product address directly, and one click is counted', async () => {
  const shop = await addP3Shop(world);
  const [p1, p2] = await three(shop);
  const mediaId = await shop.reel({ caption: 'Brunch look' });
  const landing = await shop.must('POST', '/pages', { kind: 'reel', mediaId, productIds: [p1.id, p2.id] }, 201);
  const link = new URL(landing.url);
  assert.equal(link.host, shop.host, 'The DM link is on the business\'s own host');
  assert.equal(link.pathname, `/r/${landing.slug}`);
  assert.doesNotMatch(landing.url, /\/(go|l)\//, 'No redirect hop in the link');
  noPlatformName('The DM link', landing.url);

  const target = `${link.pathname}${DM_UTM(mediaId)}`;
  for (const method of ['HEAD', 'GET']) {
    const res = await hit(world, target, { host: shop.host, method, headers: { 'user-agent': UA.instagram } });
    assert.equal(res.status, 200, `${method} the DM link answered ${res.status}`);
    assertNoRedirect(res, `${method} the DM link`);
  }
  const bare = await shop.open(link.pathname);
  assert.equal(bare.status, 200, 'Without UTM tags it is still the page');
  assertNoRedirect(bare, 'The bare link');

  const shopper = shopperOf(world, shop, { ua: UA.instagram });
  const page = (await shopper.open(target)).text;
  const cards = linksOf(page).filter((a) => a.product);
  assert.deepEqual(cards.map((a) => a.product), [p1.id, p2.id]);
  for (const [card, product] of [[cards[0], p1], [cards[1], p2]]) {
    const href = new URL(card.href);
    assert.equal(`${href.origin}${href.pathname}`, product.externalUrl, 'The button opens the product\'s own address');
    assert.ok(href.searchParams.get('utm_source'), 'With UTM tags');
    assert.notEqual(href.host, shop.host, 'Not a hop through this host');
    noPlatformName('A product link', card.href);
    assert.doesNotMatch(card.href, /bit\.ly|\/go\/|\/l\/|redirect|[?&](url|u|to|target)=http/i, 'No redirect or shortener in the link');
  }
  assert.doesNotMatch(page, /http-equiv=["']?refresh|window\.location\s*=|location\.replace\(/i, 'The page sends nobody anywhere by itself');

  assert.equal((await taps(shop)).length, 0, 'Opening the page is not a click');
  const beacon = { name: 'outbound_tap', path: target, pageKind: 'landing', pageRef: landing.slug, productId: p1.id, mediaId, outboundHost: new URL(p1.externalUrl).host, eventId: `tap-${unique()}` };
  need(await shopper.beacon(beacon), [200, 201, 202, 204], 'The click beacon');
  need(await shopper.beacon(beacon), [200, 201, 202, 204], 'The same beacon again');
  const counted = await taps(shop);
  assert.equal(counted.length, 1, 'One click is counted, however often the beacon arrives');
  assert.equal(counted[0].product_id, p1.id);
  assert.equal(counted[0].outbound_host, new URL(p1.externalUrl).host);
});

test('K-32: the retired /go/ and /l/ hops and unknown links are the branded 404, never a redirect', async () => {
  const shop = await addP3Shop(world);
  const [p1] = await three(shop);
  const landing = await shop.page({ productIds: [p1.id] });
  for (const path of [`/go/${p1.id}?r=${landing.slug}`, `/go/${p1.id}`, `/l/${landing.slug}`, `/l/${landing.slug}?u=https://evil.example`, '/r/no-such-page', `/r/${landing.slug}x`, '/r/', `/r/${landing.slug}/p/no-such-product`, '/r/%3Cscript%3Ealert(1)%3C%2Fscript%3E', `/r/${'a'.repeat(500)}`, '/r/..%2F..%2Fadmin']) {
    const res = await shop.open(path);
    assertNoRedirect(res, path);
    assertBranded404(res, shop, path);
    assertNoLiveMarkup(res.text, path);
  }
  for (const path of [`/r/${landing.slug}?next=https://evil.example`, `/r/${landing.slug}?url=//evil.example`, `/r/${landing.slug}/?redirect=https://evil.example`]) {
    const res = await shop.open(path);
    assertNoRedirect(res, path);
    assert.ok(!linksOf(res.text).some((a) => /evil\.example/.test(a.href)), `${path}: an address from the query string became a link`);
  }
  await shop.must('PATCH', `/pages/${landing.id}`, { active: false });
  assertBranded404(await shop.open(`/r/${landing.slug}`), shop, 'A page turned off');
  assert.equal((await taps(shop)).length, 0);
});

// ---- K-33 ------------------------------------------------------------------------------------------------------------------

test('K-33: a link-out to another business\'s product is the branded 404, and no click is counted for anyone', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const mine = await a.product({ name: 'Mine', externalUrl: `https://${a.siteHost}/p/mine` });
  const theirs = await b.product({ name: 'Theirs', externalUrl: `https://${b.siteHost}/p/theirs` });
  const landingA = await a.page({ productIds: [mine.id] });
  const landingB = await b.page({ productIds: [theirs.id] });

  for (const path of [`/r/${landingA.slug}/p/${theirs.slug}`, `/r/${landingB.slug}`, `/r/${landingB.slug}/p/${theirs.slug}`, `/go/${theirs.id}?r=${landingA.slug}`, `/p/${theirs.slug}`]) {
    const res = await a.open(path);
    assertNoRedirect(res, path);
    assertBranded404(res, a, `${path} on another business's host`);
    assert.ok(!res.text.includes('Theirs') && !res.text.includes(b.name) && !res.text.includes(b.siteHost), `${path} leaks the other business`);
  }
  const shopper = shopperOf(world, a);
  await shopper.open(`/r/${landingA.slug}`);
  const res = await shopper.beacon({ name: 'outbound_tap', path: `/r/${landingA.slug}`, pageKind: 'landing', pageRef: landingA.slug, productId: theirs.id, outboundHost: b.siteHost, eventId: `x-${unique()}` });
  assert.ok(res.status < 500, `A beacon naming another business's product answered ${res.status}`);
  const wa = await shopper.beacon({ name: 'whatsapp_tap', path: `/r/${landingA.slug}`, pageKind: 'landing', pageRef: landingB.slug, productId: theirs.id, eventId: `y-${unique()}` });
  assert.ok(wa.status < 500);
  const counted = [...await taps(a), ...await taps(b)];
  assert.deepEqual(counted.filter((e) => e.product_id === theirs.id), [], 'No click is counted against the other business\'s product');
  assert.equal((await taps(b)).length, 0, 'Nothing at all is counted for the other business');
  assert.ok(!(await html(a, landingA)).includes(b.siteHost));
});

// ---- K-34 ------------------------------------------------------------------------------------------------------------------

test('K-34: without a custom domain the page is served on <slug>.<neutral domain>, with no platform name in the HTML or headers', async () => {
  const shop = await addP3Shop(world, { slug: `leafy-${unique()}`.toLowerCase(), name: 'Leafy Corner' });
  assert.equal(shop.host, `${shop.slug}.shops.example`);
  const [p1] = await three(shop);
  const landing = await shop.page({ productIds: [p1.id] });
  assert.equal(new URL(landing.url).host, shop.host);
  const res = await shop.open(`/r/${landing.slug}`);
  assert.equal(res.status, 200);
  noPlatformName('The page source', res.text);
  noPlatformName('The response headers', res.headers);
  assert.equal(res.headers['x-powered-by'], undefined, 'No server banner');
  assert.ok(res.text.includes('Leafy Corner'), 'The seller\'s own name shows');
  for (const asset of [...res.text.matchAll(/<(?:link|script|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1])) {
    noPlatformName(`The address of ${asset}`, asset);
    if (asset.startsWith('/') && !asset.startsWith('//')) {
      const file = await hit(world, asset, { host: shop.host });
      noPlatformName(`The headers of ${asset}`, file.headers);
      if (/javascript|css|json|html|svg/.test(file.headers['content-type'] ?? '')) noPlatformName(`The body of ${asset}`, file.text);
    }
  }
  for (const cookie of [res.headers['set-cookie'] ?? []].flat()) noPlatformName('A cookie', cookie);
  for (const path of ['/robots.txt', '/r/missing', '/favicon.ico', `/r/${landing.slug}/p/${p1.slug}`]) {
    const other = await shop.open(path);
    noPlatformName(`${path} body`, other.text);
    noPlatformName(`${path} headers`, other.headers);
  }
  const wrongHost = await hit(world, `/r/${landing.slug}`, { host: `nobody-${unique()}.shops.example` });
  assert.ok([404, 421].includes(wrongHost.status), `A host with no business answered ${wrongHost.status}`);
  noPlatformName('The unknown-host answer', wrongHost.text);
});

test('K-34: an error on a buyer page is still the seller\'s page: no stack trace, no platform name', async () => {
  const shop = await addP3Shop(world);
  const landing = await shop.page();
  for (const path of [`/r/${landing.slug}?utm_content=${'9'.repeat(5000)}`, `/r/${landing.slug}?utm_source[]=a&utm_source[]=b`, `/r/${landing.slug}?%E0%A4%A`, `/r/${landing.slug}%00`, `/r/${landing.slug}?utm_campaign=<script>alert(1)</script>`]) {
    const res = await shop.open(path);
    assert.ok(res.status < 500, `${path.slice(0, 60)} answered ${res.status}`);
    noPlatformName(path.slice(0, 40), res.text);
    assert.doesNotMatch(res.text, /at \w+ \(.*:\d+:\d+\)|node_modules|Error:/, 'No stack trace');
    assertNoLiveMarkup(res.text, path.slice(0, 40));
  }
});

// ---- K-41 ------------------------------------------------------------------------------------------------------------------

test('K-41: on tier 1 a second product on a reel is blocked with an upgrade note; on tier 2 the same reel accepts up to 20', async () => {
  // The products are made before the plan is set, so this is only about linking them to a reel.
  const shop = await addP3Shop(world);
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await shop.product({ name: `Tiered ${i + 1}` })).id);
  await setTier(world, shop, 't1');
  const mediaId = await shop.reel();
  const two = await shop.send('POST', '/pages', { kind: 'reel', mediaId, productIds: ids.slice(0, 2) });
  assert.equal(two.status, 403, `Two products on tier 1 answered ${two.status}: ${two.text.slice(0, 200)}`);
  assert.equal(two.json().reason, PLAN_REASON);
  assert.match(two.json().error, /upgrade|plan/i, `An upgrade note: ${two.json().error}`);
  const landing = await shop.must('POST', '/pages', { kind: 'reel', mediaId, productIds: [ids[0]] }, 201, 'One product on tier 1');
  assert.equal(landing.productLimit, 1);
  const second = await shop.send('PATCH', `/pages/${landing.id}`, { productIds: [ids[0], ids[1]] });
  assert.equal(second.status, 403);
  assert.equal(second.json().reason, PLAN_REASON);
  assert.deepEqual((await shop.must('GET', `/pages/${landing.id}`)).products.map((p) => p.id), [ids[0]], 'Nothing changed');
  assert.deepEqual(productIdsOf(await html(shop, landing)).length <= 1, true);

  await setTier(world, shop, 't2');
  const twenty = await shop.must('PATCH', `/pages/${landing.id}`, { productIds: ids.slice(0, 20) }, 200, 'Twenty products on tier 2');
  assert.equal(twenty.products.length, 20);
  assert.equal(twenty.productLimit, 20);
  assert.equal((await shop.send('PATCH', `/pages/${landing.id}`, { productIds: ids })).status, 400, 'Twenty-one is too many on any plan');
  assert.equal(textOf(await html(shop, landing)).match(/Tiered \d+/g).length >= 20, true);

  await setTier(world, shop, 't1');
  const back = await shop.open(`/r/${landing.slug}`);
  assert.equal(back.status, 200, 'After a downgrade the link in old DMs still opens');
  assert.equal((await shop.send('PATCH', `/pages/${landing.id}`, { productIds: ids.slice(0, 3) })).status, 403, 'But the page can\'t be given several products again');
});

test('K-41: the limit is the plan\'s, for the free plan too, and can\'t be talked around', async () => {
  const shop = await addP3Shop(world);
  const a = await shop.product({ name: 'Free one' });
  const b = await shop.product({ name: 'Free two' });
  await setTier(world, shop, 'free');
  const mediaId = await shop.reel();
  for (const body of [{ kind: 'reel', mediaId, productIds: [a.id, b.id] }, { kind: 'reel', mediaId, productIds: [a.id, b.id], productLimit: 20 }, { kind: 'post', mediaId, productIds: [a.id, b.id], plan: 't5' }]) {
    const res = await shop.send('POST', '/pages', body);
    assert.ok([400, 403].includes(res.status), `Free plan, two products: ${res.status}`);
  }
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM reels WHERE tenant_id = $1', [shop.tenantId]))[0].n, 0);
});

// ---- K-42 ------------------------------------------------------------------------------------------------------------------

test('K-42: a reel in "Bottles", whose order is X, Y, Z, shows More reels as X, Y, Z without itself, in that order', async () => {
  const shop = await addP3Shop(world);
  const bottles = await shop.category('Bottles');
  const [x, y, z, current] = [await shop.page({ headline: 'Reel X' }), await shop.page({ headline: 'Reel Y' }), await shop.page({ headline: 'Reel Z' }), await shop.page({ headline: 'Current reel' })];
  await shop.addToCategory(bottles.id, [current.id, z.id, x.id, y.id]);
  await shop.setOrder(bottles.id, [x.id, current.id, y.id, z.id]);
  const page = await html(shop, current);
  assert.deepEqual(reelSlugsOf(page, { exclude: [current.slug] }), [x.slug, y.slug, z.slug]);
  assert.ok(!reelSlugsOf(page).includes(current.slug), 'The current reel is not in its own strip');
  for (const a of linksOf(page).filter((l) => /\/r\//.test(l.href))) {
    const url = new URL(a.href, `https://${shop.host}`);
    assert.equal(url.host, shop.host, 'Each tile opens its own page directly, on this host');
    assert.doesNotMatch(a.href, /\/go\/|\/l\//);
  }
  assert.deepEqual(reelSlugsOf(await html(shop, x), { exclude: [x.slug] }), [current.slug, y.slug, z.slug], 'Every reel in the category sees the same order, minus itself');

  await shop.setOrder(bottles.id, [z.id, y.id, current.id, x.id]);
  assert.deepEqual(reelSlugsOf(await html(shop, current), { exclude: [current.slug] }), [z.slug, y.slug, x.slug], 'A new order shows on the next load');
});

test('K-42: the strip uses the reel\'s first category, shows at most 6 live reels, and falls back to newest first with no category', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const first = await shop.category('First');
  const second = await shop.category('Second');
  const pages = [];
  for (let i = 0; i < 9; i++) pages.push(await shop.page({ headline: `Strip ${i}` }));
  const current = pages[0];
  await shop.addToCategory(first.id, pages.slice(0, 9).map((p) => p.id));
  await shop.addToCategory(second.id, [pages[8].id, current.id]);
  await shop.setOrder(first.id, pages.map((p) => p.id).reverse());
  const off = pages[7];
  await shop.must('PATCH', `/pages/${off.id}`, { active: false });
  const strip = reelSlugsOf(await html(shop, current), { exclude: [current.slug] });
  assert.equal(strip.length, CATALOG_LIMITS.moreReels, 'At most 6');
  assert.deepEqual(strip, [pages[8], pages[6], pages[5], pages[4], pages[3], pages[2]].map((p) => p.slug), 'The first category\'s order, live reels only');
  assert.ok(!strip.includes(off.slug), 'A reel turned off is not listed');

  const loner = await shop.page({ headline: 'No category' });
  const newer = await shop.page({ headline: 'Newest' });
  const fallback = reelSlugsOf(await html(shop, loner), { exclude: [loner.slug] });
  assert.equal(fallback[0], newer.slug, 'With no category, newest first');
  assert.ok(fallback.length <= 6);
  const theirs = await other.page({ headline: 'Other business' });
  assert.ok(!fallback.includes(theirs.slug) && !strip.includes(theirs.slug), 'Never another business\'s reel');
  await shop.must('PATCH', '/page-settings', { moreReels: false });
  assert.deepEqual(reelSlugsOf(await html(shop, current), { exclude: [current.slug] }), [], 'Switched off, there is no strip');
});
