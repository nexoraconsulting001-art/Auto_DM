// The link check: safeFetch's link-check profile (PRD 4.11, 8.2). No database and no internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { createLinkChecker, pinnedDispatcher, publicOnlyLookup, verifyLink } from '../../../src/modules/links/check.js';

/** A fetch answering from a table of url -> status or [status, location]. It records every call. */
function fakeFetch(table) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const entry = table[url];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) throw new Error(`Nothing should have asked for ${url}`);
    const [status, location] = Array.isArray(entry) ? entry : [entry];
    return new Response((status >= 300 && status < 400) || status === 204 ? null : 'hello', { status, headers: location ? { location } : {} });
  };
  return { fetch, calls };
}

const failure = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const URL_A = 'https://shop.example/a';

const run = (table, url = URL_A) => {
  const fake = fakeFetch(table);
  return createLinkChecker({ fetch: fake.fetch })(url).then((out) => ({ ...out, calls: fake.calls }));
};

test('C-64: a 200 passes', async () => {
  const out = await run({ [URL_A]: 200 });
  assert.deepEqual([out.ok, out.reason, out.httpStatus], [true, null, 200]);
});

test('PRD 8.2: one GET, no automatic redirects, no credentials, and a User-Agent that names nobody', async () => {
  const { calls } = await run({ [URL_A]: 200 });
  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.deepEqual([init.method, init.redirect, init.credentials], ['GET', 'manual', 'omit']);
  assert.ok(init.signal instanceof AbortSignal);
  assert.doesNotMatch(init.headers['user-agent'], /bhava|github|auto.?dm/i);
  assert.equal(init.headers.cookie, undefined);
});

for (const status of [201, 204, 206, 400, 401, 403, 404, 429, 500, 503]) {
  test(`C-64: a ${status} fails the check`, async () => {
    const out = await run({ [URL_A]: status });
    assert.deepEqual([out.ok, out.reason, out.httpStatus], [false, 'link.check_failed', status]);
  });
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`C-64: a ${status} to another site is link.redirect, and that site is never asked`, async () => {
    const out = await run({ [URL_A]: [status, 'https://other.example/new'] });
    assert.deepEqual([out.ok, out.reason, out.httpStatus], [false, 'link.redirect', status]);
    assert.equal(out.calls.length, 1);
  });
}

for (const location of ['https://sub.shop.example/a', 'https://shop.example.evil.example/a', 'https://example/a', 'http://other.example/', '//other.example/x']) {
  test(`C-64: ${location} is another site`, async () => assert.equal((await run({ [URL_A]: [302, location] })).reason, 'link.redirect'));
}

for (const [from, to] of [
  ['https://shop.example/a', 'https://www.shop.example/a'],
  ['https://www.shop.example/a', 'https://shop.example/a'],
  ['https://shop.example/a', 'https://SHOP.example/b'],
]) {
  test(`C-64: ${from} to ${to} stays on the same site`, async () => {
    const out = await run({ [from]: [301, to], [new URL(to).href]: 200 }, from);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.calls.length, 2);
  });
}

test('C-64: a relative redirect stays on the same site', async () => {
  const out = await run({ [URL_A]: [302, '/b?c=1'], 'https://shop.example/b?c=1': 200 });
  assert.equal(out.ok, true);
});

test('C-64: after the allowed redirect, the page still has to answer 200', async () => {
  const out = await run({ [URL_A]: [302, '/b'], 'https://shop.example/b': 404 });
  assert.deepEqual([out.ok, out.reason, out.httpStatus], [false, 'link.check_failed', 404]);
});

test('PRD 8.2: a second redirect is one too many', async () => {
  const out = await run({ [URL_A]: [302, '/b'], 'https://shop.example/b': [302, '/c'] });
  assert.deepEqual([out.ok, out.reason, out.calls.length], [false, 'link.check_failed', 2]);
});

test('C-64: a second redirect that leaves the site is still link.redirect', async () => {
  const out = await run({ [URL_A]: [302, '/b'], 'https://shop.example/b': [302, 'https://other.example/'] });
  assert.equal(out.reason, 'link.redirect');
});

test('PRD 4.11: a redirect down to http on the same site fails', async () => {
  const out = await run({ [URL_A]: [301, 'http://shop.example/a'] });
  assert.deepEqual([out.ok, out.reason, out.calls.length], [false, 'link.scheme', 1]);
});

test('PRD 8.2: a port other than 443 is never asked, at the start or after a redirect', async () => {
  const first = await run({}, 'https://shop.example:8443/a');
  assert.deepEqual([first.ok, first.reason, first.calls.length], [false, 'link.check_failed', 0]);
  const second = await run({ [URL_A]: [302, 'https://shop.example:8443/a'] });
  assert.deepEqual([second.ok, second.reason, second.calls.length], [false, 'link.check_failed', 1]);
});

test('a redirect with no address, or one that can\'t be read, fails', async () => {
  assert.equal((await run({ [URL_A]: [302] })).reason, 'link.check_failed');
  assert.equal((await run({ [URL_A]: [302, 'https://'] })).reason, 'link.check_failed');
});

test('an http address is never asked', async () => {
  const out = await run({}, 'http://shop.example/a');
  assert.deepEqual([out.ok, out.reason, out.calls.length], [false, 'link.scheme', 0]);
});

test('PRD 4.11: 5 s is the limit, even for an answer that ignores being cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const check = createLinkChecker({ fetch: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const pending = check(URL_A);
  await new Promise(setImmediate);
  t.mock.timers.tick(4999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const out = await pending;
  assert.deepEqual([out.ok, out.reason, out.httpStatus], [false, 'link.check_failed', null]);
  assert.equal(signal.aborted, true);
});

for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTPUBLIC']) {
  test(`C-64: ${code} is the site's failure`, async () => {
    const out = await run({ [URL_A]: failure(code) });
    assert.deepEqual([out.ok, out.reason, out.unavailable], [false, 'link.check_failed', undefined]);
  });
}

for (const code of ['EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'ENETGUARD']) {
  test(`${code} says nothing about the site, so the answer is marked unavailable`, async () => {
    const out = await run({ [URL_A]: failure(code) });
    assert.deepEqual([out.ok, out.reason, out.unavailable], [false, 'link.check_failed', true]);
  });
}

test('PRD 8.2: a second check of one host within a second waits its turn', async () => {
  const stored = new Map();
  const cache = { get: async (key) => stored.get(key) ?? null, set: async (key, value) => void stored.set(key, value) };
  const { fetch } = fakeFetch({ [URL_A]: 200 });
  const check = createLinkChecker({ fetch, cache });
  const started = Date.now();
  await check(URL_A);
  assert.ok(Date.now() - started < 900, 'The first check doesn\'t wait');
  await check(URL_A);
  assert.ok(Date.now() - started >= 950, 'The second one did');
  assert.ok([...stored.keys()].every((key) => key === 'links:host:shop.example'));
});

// ---- destination rules first ----

const context = { whatsappNumber: '919876543210', blockedHosts: new Map([['bit.ly', 'shortener']]) };
const neverAsked = async () => assert.fail('Nothing should have been fetched');

test('C-39: WhatsApp gets a number check and no request', async () => {
  assert.deepEqual(await verifyLink('https://wa.me/919876543210', context, neverAsked), { ok: true, reason: null, httpStatus: null });
  assert.deepEqual(await verifyLink('https://wa.me/911111111111', context, neverAsked), { ok: false, reason: 'link.not_allowlisted', httpStatus: null });
});

test('C-65: what the rules refuse is never fetched', async () => {
  for (const [url, reason] of [['https://bit.ly/x', 'link.shortener'], ['http://shop.example/', 'link.scheme'], ['https://169.254.169.254/', 'link.blocked'], ['https://localhost/', 'link.blocked']]) {
    assert.deepEqual(await verifyLink(url, context, neverAsked), { ok: false, reason, httpStatus: null }, url);
  }
});

test('an address the rules allow goes to the request', async () => {
  const answer = { ok: true, reason: null, httpStatus: 200 };
  assert.deepEqual(await verifyLink(URL_A, context, async (url) => (url === URL_A ? answer : null)), answer);
});

// ---- connecting only to the address that was checked ----

const asLookup = (hostname, options) => new Promise((resolve, reject) => {
  publicOnlyLookup(hostname, options, (err, ...rest) => (err ? reject(err) : resolve(rest)));
});

test('K-05: lookup hands over the public address it checked, in both shapes net.connect asks for', async (t) => {
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
  assert.deepEqual(await asLookup('shop.example', {}), ['93.184.216.34', 4]);
  assert.deepEqual(await asLookup('shop.example', { all: true }), [[{ address: '93.184.216.34', family: 4 }]]);
});

test('K-04: one private address among the answers refuses the whole name', async (t) => {
  for (const address of ['169.254.169.254', '10.0.0.5', '::1', '::ffff:127.0.0.1']) {
    t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]));
    await assert.rejects(asLookup('shop.example', { all: true }), { code: 'ENOTPUBLIC' }, address);
    dns.lookup.mock.restore();
  }
});

test('lookup passes on a DNS failure and refuses an empty answer', async (t) => {
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })));
  await assert.rejects(asLookup('shop.example', {}), { code: 'ENOTFOUND' });
  dns.lookup.mock.restore();
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, []));
  await assert.rejects(asLookup('shop.example', {}), { code: 'ENOTPUBLIC' });
});

test('K-05: fetch really connects through the lookup it is given, and only once', async (t) => {
  const seen = [];
  const server = http.createServer((rq, rs) => { seen.push(rq.headers.host); rs.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const lookups = [];
  const agent = pinnedDispatcher((hostname, options, callback) => {
    lookups.push(hostname);
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });
  t.after(() => agent.close());
  const { port } = server.address();
  const res = await fetch(`http://pinned.localhost:${port}/`, { dispatcher: agent });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(seen, [`pinned.localhost:${port}`]);
  assert.deepEqual(lookups, ['pinned.localhost']);
});

test('K-04: the real checker stops at the lookup when a name points inside, and blames the site', async (t) => {
  const lookups = [];
  t.mock.method(dns, 'lookup', (host, _options, callback) => {
    lookups.push(host);
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  // A .localhost name, so that tools/net-guard lets it reach the lookup when the suite runs under it.
  const out = await createLinkChecker()('https://rebind.localhost/x');
  assert.deepEqual([out.ok, out.reason, out.httpStatus, out.unavailable], [false, 'link.check_failed', null, undefined]);
  assert.deepEqual(lookups, ['rebind.localhost']);
});

test('the default checker calls fetch as it is at the time, with the pinned dispatcher', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response('hello', { status: 200 });
  });
  const out = await createLinkChecker()(URL_A);
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, URL_A);
  assert.equal(calls[0].init.dispatcher, pinnedDispatcher());
});
