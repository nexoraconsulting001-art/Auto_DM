// PRD 8.2 as far as PRD 5.5 needs it: reading a business's own website can't be turned against us.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BlockedAddressError, assertFetchable, isPublicAddress, requestOnce, safeFetch } from '../../../src/modules/platform-console/safe-fetch.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const answer = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('private, loopback, link-local, carrier-grade and metadata addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001:0:1::1', 'nonsense']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});

test('only plain web addresses on the usual ports can be fetched', () => {
  assert.equal(assertFetchable('https://shop.example/a').hostname, 'shop.example');
  assert.equal(assertFetchable('http://shop.example:80').hostname, 'shop.example');
  assert.equal(assertFetchable('https://shop.example:443').hostname, 'shop.example');
  for (const bad of ['not a url', 'ftp://shop.example', 'file:///etc/passwd', 'gopher://shop.example', 'https://u:p@shop.example', 'https://shop.example:8443', 'http://localhost', 'http://a.localhost', 'http://x.internal',
    'http://nodots', 'http://127.1', 'http://017700000001', 'http://0x7f000001', 'http://[::1]', 'http://[fe80::1]', 'http://169.254.169.254.']) {
    assert.throws(() => assertFetchable(bad), BlockedAddressError, bad);
  }
});

test('a name that resolves to a private address is refused without connecting', async () => {
  let connected = 0;
  const request = async () => { connected++; return { status: 200, headers: {}, body: '' }; };
  await assert.rejects(() => safeFetch('https://sneaky.example', { lookup: answer('169.254.169.254'), request }), BlockedAddressError);
  await assert.rejects(() => safeFetch('https://sneaky.example', { lookup: answer('93.184.216.34', '10.0.0.5'), request }), BlockedAddressError, 'one private answer among public ones');
  await assert.rejects(() => safeFetch('https://sneaky.example', { lookup: answer(), request }), BlockedAddressError, 'no answer at all');
  assert.equal(connected, 0);
});

test('it connects to exactly the address it checked', async () => {
  const seen = [];
  const res = await safeFetch('https://shop.example/', { lookup: async () => PUBLIC, request: async (url, pinned) => { seen.push([url.hostname, pinned.address]); return { status: 200, headers: {}, body: 'ok' }; } });
  assert.equal(res.body, 'ok');
  assert.deepEqual(seen, [['shop.example', '93.184.216.34']]);
});

const redirecting = (locations) => {
  const steps = [...locations];
  return async () => (steps.length ? { status: 302, headers: { location: steps.shift() }, body: '' } : { status: 200, headers: {}, body: 'end' });
};

test('every redirect is checked again', async () => {
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.5', family: 4 }] : PUBLIC);
  await assert.rejects(() => safeFetch('https://shop.example', { lookup, request: redirecting(['http://10.0.0.5/admin']) }), BlockedAddressError);
  await assert.rejects(() => safeFetch('https://shop.example', { lookup, request: redirecting(['https://evil.example/']) }), BlockedAddressError);
  await assert.rejects(() => safeFetch('https://shop.example', { lookup, request: redirecting(['ftp://shop.example/']) }), BlockedAddressError);
  await assert.rejects(() => safeFetch('https://shop.example', { lookup, request: redirecting(['https://shop.example:8443/']) }), BlockedAddressError);
});

test('three redirects are followed, a fourth is not', async () => {
  const lookup = async () => PUBLIC;
  assert.equal((await safeFetch('https://a.example', { lookup, request: redirecting(['/1', '/2', 'https://b.example/3']) })).body, 'end');
  await assert.rejects(() => safeFetch('https://a.example', { lookup, request: redirecting(['/1', '/2', '/3', '/4']) }), /Too many redirects/);
});

function localSite(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  t.after(() => server.close());
  return new Promise((resolve) => server.on('listening', () => resolve(server.address().port)));
}

const PINNED = { address: '127.0.0.1', family: 4 };

test('the request goes to the pinned address under the site\'s own name, carrying nothing of ours', async (t) => {
  let headers;
  const port = await localSite(t, (req, res) => { headers = req.headers; res.setHeader('content-type', 'text/html'); res.end('<p>hello</p>'); });
  const res = await requestOnce(new URL(`http://pinned.localhost:${port}/page`), PINNED);
  assert.equal(res.status, 200);
  assert.equal(res.body, '<p>hello</p>');
  assert.equal(headers.host, `pinned.localhost:${port}`);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.doesNotMatch(headers['user-agent'], /bhava|github|node/i);
});

test('a page over the cap is cut off', async (t) => {
  const port = await localSite(t, (_req, res) => { res.write(Buffer.alloc(4000)); res.end(Buffer.alloc(4000)); });
  await assert.rejects(() => requestOnce(new URL(`http://127.0.0.1:${port}/`), PINNED, { maxBytes: 5000 }), /too large/);
});

test('a redirect is handed back, not followed, so the caller can check it', async (t) => {
  const port = await localSite(t, (_req, res) => { res.statusCode = 302; res.setHeader('location', 'http://10.0.0.5/'); res.end('moved'); });
  const res = await requestOnce(new URL(`http://127.0.0.1:${port}/`), PINNED);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'http://10.0.0.5/');
});

test('stopping the signal stops the request', async (t) => {
  const port = await localSite(t, () => { /* never answers */ });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(() => requestOnce(new URL(`http://127.0.0.1:${port}/`), PINNED, { signal: controller.signal }));
});
