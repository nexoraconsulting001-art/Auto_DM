// safeFetch's import profiles (PRD 8.2) against the site simulator's hostile fixture sites. Each rule is checked through the
// real fetcher: only where the socket goes is replaced, by the simulator's transport.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedAddressError, FETCH_PROFILES, SafeFetchError, createSafeFetch, memoryHostGate, pgHostGate } from '../../../src/platform/safe-fetch.js';
import { createImages } from '../../../src/platform/images.js';
import { createSites } from '../../../tools/sim/sites/index.mjs';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { openTestDb } from '../../helpers.js';

async function world(t, options = {}) {
  const sites = createSites();
  await sites.start();
  t.after(() => sites.close());
  const fetcher = createSafeFetch({ ...sites.transport(), hostGate: memoryHostGate({ gapMs: 0 }), ...options });
  return { sites, fetcher };
}

const refusedWith = (code) => (err) => err instanceof SafeFetchError && err.code === code;

test('the profiles hold the PRD 8.2 numbers', () => {
  for (const name of ['page', 'json', 'feed', 'stylesheet']) {
    assert.equal(FETCH_PROFILES[name].maxRedirects, 3, name);
    assert.equal(FETCH_PROFILES[name].timeoutMs, 8000, name);
    assert.equal(FETCH_PROFILES[name].maxBytes, 2_000_000, name);
  }
  assert.equal(FETCH_PROFILES.image.maxBytes, 3_000_000);
  assert.deepEqual([FETCH_PROFILES.linkCheck.maxRedirects, FETCH_PROFILES.linkCheck.timeoutMs], [1, 5000]);
});

test('a product page is read through the simulator under its own name, with nothing of ours in the request', async (t) => {
  const { sites, fetcher } = await world(t);
  const page = await fetcher.page('https://shop.example/products/brass-planter');
  assert.match(page.html, /Brass planter/);
  assert.equal(page.contentType, 'text/html');
  const [call] = await sites.calls({ path: '/products/brass-planter' });
  assert.equal(call.headers.host, 'shop.example');
  assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers.authorization, undefined);
  assert.doesNotMatch(call.headers['user-agent'], /bhava|github|node/i);
});

test('private addresses, before or after DNS or a redirect, are refused without connecting there', async (t) => {
  const { sites, fetcher } = await world(t);
  for (const url of ['http://127.0.0.1/admin', 'http://10.0.0.5/', 'http://[::1]/', 'https://internal.example/', 'https://mixed.example/', 'http://localhost/', 'https://shop.example:8080/', 'ftp://shop.example/']) {
    await assert.rejects(() => fetcher.page(url), BlockedAddressError, url);
  }
  for (const path of ['/', '/meta', '/internal', '/port', '/ftp', '/loopback']) {
    await assert.rejects(() => fetcher.page(`https://toprivate.example${path}`), BlockedAddressError, path);
  }
  assert.deepEqual(sites.dials.filter((d) => d.host !== 'toprivate.example'), [], 'never connected anywhere but the redirecting site');
  assert.equal(new BlockedAddressError().message, 'That address isn’t a public website');
});

test('a DNS answer that flips to the metadata address after the check changes nothing: the checked address is the one used', async (t) => {
  const { sites, fetcher } = await world(t);
  await fetcher.page('https://rebind.example/');
  assert.deepEqual(sites.dials, [{ host: 'rebind.example', address: '93.184.216.34' }]);
  assert.equal(sites.lookups.get('rebind.example'), 1, 'looked up once per hop');
  await assert.rejects(() => fetcher.page('https://rebind.example/'), BlockedAddressError, 'the next fetch sees the new answer and refuses it');
});

test('three redirects are followed and a fourth stops with Too many redirects', async (t) => {
  const { fetcher } = await world(t);
  const page = await fetcher.page('https://loop.example/hops/3');
  assert.match(page.html, /Arrived/);
  assert.equal(page.url, 'https://loop.example/hops/0');
  await assert.rejects(() => fetcher.page('https://loop.example/hops/4'), (err) => refusedWith('too_many_redirects')(err) && err.message === 'Too many redirects');
  await assert.rejects(() => fetcher.page('https://loop.example/r/1'), refusedWith('too_many_redirects'));
});

test('pages over 2 MB are refused whether declared, streamed or compressed', async (t) => {
  const { fetcher } = await world(t);
  for (const path of ['/', '/stream', '/gzip']) await assert.rejects(() => fetcher.page(`https://huge.example${path}`), refusedWith('too_large'), path);
  await assert.rejects(() => fetcher.image('https://huge.example/big.png'), refusedWith('too_large'));
});

test('the wrong content type is refused, and an image must really be one', async (t) => {
  const { fetcher } = await world(t);
  await assert.rejects(() => fetcher.page('https://wrongtype.example/product'), refusedWith('wrong_type'));
  await assert.rejects(() => fetcher.page('https://wrongtype.example/no-type'), refusedWith('wrong_type'));
  await assert.rejects(() => fetcher.json('https://wrongtype.example/products.json'), refusedWith('wrong_type'));
  await assert.rejects(() => fetcher.image('https://wrongtype.example/image.png'), refusedWith('wrong_type'));
  await assert.rejects(() => fetcher.image('https://wrongtype.example/html-as-image'), refusedWith('wrong_type'));
  const logo = await fetcher.image('https://shop.example/logo.png');
  assert.equal(logo.contentType, 'image/png');
});

test('a site error is reported with its status, and 404 and 410 count as gone', async (t) => {
  const { fetcher } = await world(t);
  await assert.rejects(() => fetcher.page('https://gone.example/products/missing'), (err) => err.code === 'http_status' && err.status === 404 && err.gone && !err.retryable);
  await assert.rejects(() => fetcher.page('https://gone.example/products/removed'), (err) => err.status === 410 && err.gone);
  await assert.rejects(() => fetcher.page('https://gone.example/products/flaky'), (err) => err.status === 500 && !err.gone && err.retryable);
  await assert.rejects(() => fetcher.page('https://nowhere.example/'), refusedWith('network'));
});

test('a page that never answers is stopped at the profile limit', async (t) => {
  const { fetcher } = await world(t);
  const started = Date.now();
  await assert.rejects(() => fetcher.page('https://slow.example/hang'), refusedWith('timeout'));
  const took = Date.now() - started;
  assert.ok(took >= 7900 && took < 9500, `took ${took} ms`);
});

test('malformed pages are read as text without error; parsing them is the importer\'s job', async (t) => {
  const { fetcher } = await world(t);
  for (const path of ['/', '/deep', '/unclosed']) assert.equal(typeof (await fetcher.page(`https://malformed.example${path}`)).html, 'string', path);
});

test('one host gets at most one request per gap, across callers, and a long wait is refused as busy', async () => {
  let now = 0;
  const gate = memoryHostGate({ gapMs: 1000, now: () => now });
  assert.equal(await gate.reserve('a.example'), 0);
  assert.equal(await gate.reserve('a.example'), 1000);
  assert.equal(await gate.reserve('b.example'), 0, 'another host is not held up');
  assert.equal(await gate.reserve('a.example', { maxWaitMs: 1500 }), null);
  now = 2500;
  assert.equal(await gate.reserve('a.example'), 0);

  const db = await openTestDb();
  const shared = pgHostGate(db, { gapMs: 1000 });
  const waits = await Promise.all([1, 2, 3].map(() => shared.reserve('c.example', { maxWaitMs: 5000 })));
  assert.deepEqual([...waits].sort((x, y) => x - y).map((w) => Math.round(w / 1000)), [0, 1, 2]);
  assert.equal(await shared.reserve('c.example', { maxWaitMs: 100 }), null);
  await db.close();
});

test('the test transport is refused in production', () => {
  assert.throws(() => createSafeFetch({ dial: () => ({ host: '127.0.0.1', port: 1 }), env: { NODE_ENV: 'production' } }), /production/);
});

test('a Shopify storefront mounted under a name serves its public feed, product JSON and pages', async (t) => {
  const { sites, fetcher } = await world(t);
  const shopify = createShopify();
  await shopify.start();
  t.after(() => shopify.close());
  sites.mount('plants.example', shopify);
  await shopify.post('/storefront/generate', { count: 312 });
  const first = await fetcher.json('https://plants.example/products.json?limit=250&page=1', { profile: 'feed' });
  const second = await fetcher.json('https://plants.example/products.json?limit=250&page=2', { profile: 'feed' });
  const third = await fetcher.json('https://plants.example/products.json?limit=250&page=3', { profile: 'feed' });
  assert.deepEqual([first.data.products.length, second.data.products.length, third.data.products.length], [250, 62, 0]);
  const product = first.data.products[0];
  assert.match(product.variants[0].price, /^\d+\.\d{2}$/);
  assert.equal(typeof product.variants[0].available, 'boolean');
  assert.match(product.images[0].src, /^https:\/\/plants\.example\/cdn\//);
  const one = await fetcher.json(`https://plants.example/products/${product.handle}.json`);
  assert.equal(one.data.product.handle, product.handle);
  assert.equal(typeof one.data.product.tags, 'string');
  const page = await fetcher.page(`https://plants.example/products/${product.handle}`);
  assert.match(page.html, /"@type":"ProductGroup"/);
  const image = await fetcher.image(product.images[0].src);
  assert.equal((await createImages().inspect(image.buffer)).width, 1200);
  await shopify.post('/storefront', { feedStatus: 401 });
  await assert.rejects(() => fetcher.json('https://plants.example/products.json'), (err) => err.status === 401);
  await shopify.post('/storefront', { feedStatus: 404 });
  await assert.rejects(() => fetcher.json('https://plants.example/products.json'), (err) => err.status === 404);
});

test('images are stored only as a clean re-encoded copy, and share previews are 1200 x 630', async (t) => {
  const { fetcher } = await world(t);
  const images = createImages();
  const { buffer } = await fetcher.image('https://brand.example/brand-logo.png');
  const clean = await images.ingest(buffer);
  assert.equal(clean.contentType, 'image/webp');
  assert.deepEqual([clean.width, clean.height], [600, 200]);
  const preview = await images.sharePreview({ image: buffer, background: '#FBF6EE' });
  assert.deepEqual([preview.width, preview.height, preview.contentType], [1200, 630, 'image/jpeg']);
  await assert.rejects(() => images.ingest(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /isn’t an image/);
});
