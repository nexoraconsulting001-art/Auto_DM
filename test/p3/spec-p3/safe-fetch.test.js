// PRD 8.2: safeFetch, seen from the outside: what pasting a link (8.3) or reading a website's look (8.9) does with hostile
// addresses, redirects, DNS answers, slow and huge pages. Every connection the fetcher makes is recorded with the address it
// pinned, so "nothing connects there" is checked, not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { IMPORT_REASONS, SITE_ADDRESSES, addP3Shop, isPrivateAddress, need, plain, png, useP3World } from './support.js';

const world = useP3World();

const MB = 1024 * 1024;
const page = (head, body = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/** What pasting `url` gave: the import result, or a refusal of the address itself as a 400. Never a server error. */
async function outcome(shop, url) {
  const started = Date.now();
  const res = await shop.send('POST', '/imports/link', { url });
  const took = Date.now() - started;
  assert.ok(res.status < 500, `Pasting ${url} answered ${res.status}: ${res.text.slice(0, 300)}`);
  if (res.status === 200) return { ...res.json(), took, http: 200, raw: res.text };
  assert.equal(res.status, 400, `Pasting ${url} answered ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json();
  return { status: 'rejected', reason: body.reason ?? null, message: `${body.error} ${Object.values(body.fields ?? {}).join(' ')}`, draft: null, took, http: 400, raw: res.text };
}

function assertRefusedAs(result, code, what) {
  assert.ok(!['draft', 'existing'].includes(result.status), `${what}: expected a refusal (${code}), got ${result.status}: ${result.raw.slice(0, 300)}`);
  if (result.http === 200) assert.equal(result.reason, code, `${what}: ${result.raw.slice(0, 300)}`);
  assert.ok(plain(result.message).includes(plain(IMPORT_REASONS[code])), `${what}: the owner is told "${IMPORT_REASONS[code]}", got "${result.message}"`);
  assert.equal(result.draft?.pricePaise ?? null, null, `${what}: nothing was read`);
}

const noPrivateDials = (mark, what) => {
  const bad = world.dialsSince(mark).filter((d) => isPrivateAddress(d.address));
  assert.deepEqual(bad, [], `${what}: safeFetch connected to a private address`);
};

// ---- K-04 ------------------------------------------------------------------------------------------------------------------

test('K-04: http://127.0.0.1/admin is refused: "That address isn\'t a public website", and nothing connects', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  const result = await outcome(shop, 'http://127.0.0.1/admin');
  assertRefusedAs(result, 'blocked', '127.0.0.1');
  assert.ok(plain(result.message).includes("That address isn't a public website"), 'The PRD\'s wording');
  assert.deepEqual(world.dialsSince(mark), [], 'No connection at all');
  assert.equal((await shop.productRows()).length, 0);
});

test('K-04: a URL that redirects to 10.0.0.5 is refused at that hop; only the public first hop is connected', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  assertRefusedAs(await outcome(shop, 'https://toprivate.example/'), 'blocked', 'Redirect to 10.0.0.5');
  const dials = world.dialsSince(mark);
  assert.deepEqual(dials.map((d) => [d.host, d.address]), [['toprivate.example', SITE_ADDRESSES.public]]);
});

test('K-04: every private, loopback, link-local, CGNAT, multicast and metadata form of an address is refused', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  const urls = [
    'http://localhost/admin', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/', 'http://224.0.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
    'http://[fe80::1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/',
    'https://internal.example/products/x', 'https://toprivate.example/meta', 'https://toprivate.example/internal', 'https://toprivate.example/loopback',
  ];
  for (const url of urls) assertRefusedAs(await outcome(shop, `${url}${url.endsWith('/') ? 'products/lamp' : ''}`), 'blocked', url);
  noPrivateDials(mark, 'Private addresses');
  assert.ok(world.dialsSince(mark).every((d) => d.host === 'toprivate.example'), `Only the public first hops were connected: ${JSON.stringify(world.dialsSince(mark))}`);
});

test('K-04: a name with one public and one private answer never connects to the private one', async () => {
  const shop = await addP3Shop(world);
  world.sites.page('mixed.example', '/products/lamp', { body: page('<title>Mixed lamp</title><meta property="og:title" content="Mixed lamp"><meta property="product:price:amount" content="120">') });
  const mark = world.dials.length;
  await outcome(shop, 'https://mixed.example/products/lamp');
  noPrivateDials(mark, 'mixed.example');
});

test('K-04: ftp, javascript, data and file links, and a redirect to ftp, are never fetched', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  for (const url of ['ftp://shop.example/file', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'gopher://shop.example/']) {
    const result = await outcome(shop, url);
    assert.ok(!['draft', 'existing'].includes(result.status), `${url} gave ${result.status}`);
  }
  assert.deepEqual(world.dialsSince(mark), [], 'None of them was fetched');
  const ftp = await outcome(shop, 'https://toprivate.example/ftp');
  assert.ok(!['draft', 'existing'].includes(ftp.status), `A redirect to ftp gave ${ftp.status}`);
  assert.equal(world.dialsSince(mark).length, 1, 'Only the first hop was fetched');
});

test('K-04: reading a website\'s look from a private address, or through a redirect to one, is refused too', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  for (const website of ['http://10.0.0.5/', 'https://toprivate.example/', 'https://internal.example/', 'http://169.254.169.254/']) {
    const res = await shop.send('POST', '/theme/site-reads', { website });
    assert.ok(res.status < 500, `Reading ${website} answered ${res.status}: ${res.text.slice(0, 200)}`);
    if (res.status === 201) assert.equal(res.json().status, 'blocked', `${website}: ${res.text.slice(0, 200)}`);
    else assert.equal(res.status, 400, `${website}: ${res.text.slice(0, 200)}`);
  }
  noPrivateDials(mark, 'Theme reads');
  const kit = await shop.must('GET', '/theme', undefined, 200, 'The theme');
  assert.equal(kit.source, 'preset', 'A refused read changes nothing');
});

// ---- K-05 ------------------------------------------------------------------------------------------------------------------

test('K-05: a DNS answer that flips from public to 169.254.169.254 between lookups: only the checked IP is used', async () => {
  const shop = await addP3Shop(world);
  world.sites.site('rebind2.example', {
    dns: { sequence: [[SITE_ADDRESSES.public], [SITE_ADDRESSES.metadata]] },
    pages: { '/products/lamp': { body: page('<title>Rebind lamp</title><meta property="og:title" content="Rebind lamp"><meta property="og:image" content="https://rebind2.example/lamp.png"><meta property="product:price:amount" content="120">') }, '/lamp.png': { type: 'image/png', body: png({ width: 400, height: 400 }) } },
  });
  const mark = world.dials.length;
  const first = await outcome(shop, 'https://rebind2.example/products/lamp');
  const second = await outcome(shop, 'https://rebind2.example/products/lamp');
  const dials = world.dialsSince(mark).filter((d) => d.host === 'rebind2.example');
  assert.ok(dials.length >= 1, 'The first import connected');
  assert.ok(dials.every((d) => d.address === SITE_ADDRESSES.public), `Connected to: ${dials.map((d) => d.address).join(', ')}`);
  assert.equal(first.status, 'draft', `The first read, on the public answer, works: ${first.raw.slice(0, 300)}`);
  assertRefusedAs(second, 'blocked', 'The second read, once DNS points at the metadata address');
});

test('K-05: a redirect to a name that resolves privately is caught at that hop, after a fresh lookup', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  assertRefusedAs(await outcome(shop, 'https://toprivate.example/internal'), 'blocked', 'Redirect to internal.example');
  assert.deepEqual(world.dialsSince(mark).map((d) => d.host), ['toprivate.example'], 'internal.example was never connected');
});

test('K-05: every outside request carries a neutral User-Agent and no cookie, credentials or referrer', async () => {
  const shop = await addP3Shop(world);
  await world.sites.delete('/calls');
  world.sites.page('shop.example', '/products/cookie-jar', { headers: { 'set-cookie': 'session=abc; Path=/' }, redirect: 'https://shop.example/products/brass-planter' });
  await outcome(shop, 'https://shop.example/products/cookie-jar');
  await outcome(shop, 'https://user:secret@shop.example/products/macrame');
  await shop.send('POST', '/theme/site-reads', { website: 'https://brand.example' });
  const calls = await world.sites.calls();
  assert.ok(calls.length >= 2, 'The outside sites were called');
  for (const call of calls) {
    const ua = call.headers['user-agent'] ?? '';
    assert.ok(ua, `${call.path} was fetched with no User-Agent`);
    assert.doesNotMatch(ua, /bhava|github|auto.?dm|gitlab|\.git\b/i, `The User-Agent names the platform or its repo: ${ua}`);
    assert.equal(call.headers.cookie, undefined, `${call.path} was sent a cookie`);
    assert.equal(call.headers.authorization, undefined, `${call.path} was sent credentials`);
    assert.doesNotMatch(String(call.headers.referer ?? ''), /shops\.example|bhava/i, `${call.path} was sent a referrer`);
  }
});

// ---- K-06 ------------------------------------------------------------------------------------------------------------------

test('K-06: four redirects in a chain stop with "Too many redirects"', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  assertRefusedAs(await outcome(shop, 'https://loop.example/hops/4'), 'too_many_redirects', '4 redirects');
  assert.ok(world.dialsSince(mark).length <= 4, `The fetcher made ${world.dialsSince(mark).length} connections for 3 allowed redirects`);
});

test('K-06: exactly three redirects are followed and the page is read', async () => {
  const shop = await addP3Shop(world);
  const result = await outcome(shop, 'https://loop.example/hops/3');
  assert.equal(result.status, 'draft', result.raw.slice(0, 300));
  assert.equal(result.draft.name, 'Arrived');
  assert.equal(result.draft.pricePaise, 1000);
});

test('K-06: an endless redirect loop stops after 3 redirects', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  assertRefusedAs(await outcome(shop, 'https://loop.example/r/0'), 'too_many_redirects', 'Endless redirects');
  assert.ok(world.dialsSince(mark).length <= 4, `${world.dialsSince(mark).length} connections`);
});

// ---- K-07 ------------------------------------------------------------------------------------------------------------------

test('K-07: a page that takes 12 s stops at 8 s, and the owner is sent to the manual form', async () => {
  const shop = await addP3Shop(world);
  world.sites.page('slow.example', '/products/kettle', { delayMs: 12_000, body: page('<title>Kettle</title><meta property="og:title" content="Kettle"><meta property="product:price:amount" content="999">') });
  const result = await outcome(shop, 'https://slow.example/products/kettle');
  assertRefusedAs(result, 'timeout', 'A 12 s page');
  assert.ok(result.took >= 7_000 && result.took < 9_800, `Stopped after ${result.took} ms`);
  assert.ok(/add the details yourself/i.test(result.message), `The owner is told to fill it in: ${result.message}`);
  if (result.draft) assert.equal(result.draft.externalUrl, 'https://slow.example/products/kettle', 'The manual form is prefilled with the link');
  assert.equal((await shop.productRows()).length, 0);
});

test('K-07: a page that never answers, or drips its body slowly, is stopped at 8 s in total', async () => {
  const shop = await addP3Shop(world);
  for (const path of ['/hang', '/drip']) {
    const result = await outcome(shop, `https://slow.example${path}`);
    assertRefusedAs(result, 'timeout', path);
    assert.ok(result.took < 9_800, `${path} took ${result.took} ms`);
  }
});

test('K-07: a slow site holds up neither another business\'s import nor a shopper\'s page', async () => {
  const slow = await addP3Shop(world);
  const fast = await addP3Shop(world);
  const product = await fast.product({ name: 'Quick mug' });
  const landing = await fast.page({ productIds: [product.id] });
  world.sites.page('slow.example', '/products/teapot', { delayMs: 12_000, body: page('<title>Teapot</title>') });
  const waiting = outcome(slow, 'https://slow.example/products/teapot').catch((err) => err);
  await new Promise((r) => setTimeout(r, 300));
  let started = Date.now();
  need(await fast.open(`/r/${landing.slug}`), 200, 'The shopper\'s page');
  assert.ok(Date.now() - started < 2_000, `The shopper waited ${Date.now() - started} ms`);
  started = Date.now();
  const quick = await outcome(fast, 'https://shop.example/products/macrame');
  assert.equal(quick.status, 'draft', quick.raw.slice(0, 300));
  assert.ok(Date.now() - started < 5_000, `Another import waited ${Date.now() - started} ms behind the slow one`);
  const slowResult = await waiting;
  if (slowResult instanceof Error) throw slowResult;
  assertRefusedAs(slowResult, 'timeout', 'The slow one');
});

// ---- K-08 ------------------------------------------------------------------------------------------------------------------

test('K-08: a 5 MB page, the same streamed, and a compressed bomb are refused; nothing is stored', async () => {
  const shop = await addP3Shop(world);
  world.sites.page('huge.example', '/products/big', { body: Buffer.concat([Buffer.from(page('<title>Big</title><meta property="og:title" content="Big"><meta property="product:price:amount" content="10">')), Buffer.alloc(5 * MB, 'a')]) });
  world.sites.page('huge.example', '/products/stream', { stream: { bytes: 5 * MB } });
  world.sites.page('huge.example', '/products/gzip', { headers: { 'content-encoding': 'gzip' }, body: () => zlib.gzipSync(Buffer.concat([Buffer.from(page('<title>Bomb</title><meta property="og:title" content="Bomb"><meta property="product:price:amount" content="10">')), Buffer.alloc(20 * MB, ' ')])) });
  const mediaBefore = (await shop.mediaRows()).length;
  for (const path of ['/products/big', '/products/stream', '/products/gzip']) {
    const result = await outcome(shop, `https://huge.example${path}`);
    assertRefusedAs(result, 'too_large', path);
  }
  assert.equal((await shop.productRows()).length, 0, 'No product');
  assert.equal((await shop.mediaRows()).length, mediaBefore, 'No file');
  const drafts = await shop.sql(`SELECT draft FROM import_items WHERE tenant_id = $1 AND draft IS NOT NULL AND draft::text <> 'null'`, [shop.tenantId]);
  assert.ok(drafts.every((d) => !JSON.stringify(d.draft).includes('aaaaaaaaaa')), 'None of the page was kept');
});

test('K-08: port 8080 is refused before any connection, and so is a redirect to it', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  assertRefusedAs(await outcome(shop, 'https://shop.example:8080/products/brass-planter'), 'blocked', 'Port 8080');
  assert.deepEqual(world.dialsSince(mark), [], 'No connection to port 8080');
  for (const url of ['http://shop.example:22/', 'https://shop.example:6379/products/x']) assertRefusedAs(await outcome(shop, url), 'blocked', url);
  assertRefusedAs(await outcome(shop, 'https://toprivate.example/port'), 'blocked', 'A redirect to :8080');
  assert.ok(world.dialsSince(mark).every((d) => !d.port || ['80', '443'].includes(String(d.port))), `Connected to: ${JSON.stringify(world.dialsSince(mark))}`);
  assert.equal((await shop.productRows()).length, 0);
});

test('K-08: an oversized or fake product photo is not stored; the product keeps the original address', async () => {
  const shop = await addP3Shop(world);
  world.sites.page('shop.example', '/products/big-photo', { body: page('<title>Big photo vase</title><meta property="og:title" content="Big photo vase"><meta property="og:image" content="https://huge.example/big.png"><meta property="product:price:amount" content="499">') });
  world.sites.page('shop.example', '/products/fake-photo', { body: page('<title>Fake photo vase</title><meta property="og:title" content="Fake photo vase"><meta property="og:image" content="https://wrongtype.example/image.png"><meta property="product:price:amount" content="599">') });
  const mediaBefore = (await shop.mediaRows()).length;
  for (const [path, image] of [['/products/big-photo', 'https://huge.example/big.png'], ['/products/fake-photo', 'https://wrongtype.example/image.png']]) {
    const productId = await shop.importAndSave(`https://shop.example${path}`);
    const saved = await shop.getProduct(productId);
    const first = saved.gallery[0];
    if (first) {
      assert.doesNotMatch(first.url, /^\/media\//, `${path}: a bad photo was copied into the business's files`);
      assert.equal(first.sourceUrl, image, `${path}: the original address is kept`);
    }
  }
  assert.equal((await shop.mediaRows()).length, mediaBefore, 'No file was stored');
});

test('K-08: a page served as the wrong type is not read as a product', async () => {
  const shop = await addP3Shop(world);
  for (const path of ['/product', '/html-as-image']) {
    const result = await outcome(shop, `https://wrongtype.example${path}`);
    assert.ok(!['draft', 'existing'].includes(result.status), `${path} gave ${result.status}`);
    if (result.http === 200 && result.reason) assert.ok(['wrong_type', 'no_title', 'title_only'].includes(result.reason), `${path}: ${result.reason}`);
  }
});
