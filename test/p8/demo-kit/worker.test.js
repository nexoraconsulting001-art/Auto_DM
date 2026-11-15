// Q-12: the service worker run in a fake worker scope, the install hint's rules, and the page's clean-up on sign-out and switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from '../spec-p8/support.js';
import { isIosSafari, isStandalone, shouldShowHint } from '../../../console/src/features/install/rules.js';

const ORIGIN = 'https://app.example';

/** sw.js in a scope with an in-memory cache storage. Answers the listeners' effects. */
function worker({ stored = {}, network = () => new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } }) } = {}) {
  const listeners = new Map();
  const stores = new Map(Object.entries(stored).map(([name, urls]) => [name, new Map(urls.map((u) => [u, new Response('old')]))]));
  const puts = [];
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (key) => store.get(typeof key === 'string' ? key : key.url)?.clone(),
      put: async (key, response) => { const url = typeof key === 'string' ? key : key.url; puts.push(url); store.set(url, response); },
      delete: async (key) => store.delete(typeof key === 'string' ? key : key.url),
      keys: async () => [...store.keys()].map((u) => new Request(u)),
    };
  };
  const self = {
    location: new URL(`${ORIGIN}/admin/sw.js`),
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => { self.skipped = true; return Promise.resolve(); },
    clients: { claim: () => { self.claimed = true; return Promise.resolve(); } },
    fetch: async (request) => network(request),
  };
  const caches = { open: async (n) => open(n), keys: async () => [...stores.keys()], has: async (n) => stores.has(n), delete: async (n) => stores.delete(n) };
  vm.runInContext(read('console/public/sw.js'), vm.createContext({ self, caches, Response, Request, URL, Promise, console }));
  const event = (extra = {}) => ({ waits: [], waitUntil(p) { this.waits.push(Promise.resolve(p)); }, ...extra });
  const run = async (type) => { const e = event(); listeners.get(type)(e); await Promise.all(e.waits); };
  const fetchEvent = async (path, { method = 'GET', mode = 'cors', headers = {} } = {}) => {
    const request = new Request(new URL(path, ORIGIN), { method, headers });
    Object.defineProperty(request, 'mode', { value: mode });
    let answer = null;
    const e = event({ request, respondWith: (p) => { answer = Promise.resolve(p); } });
    listeners.get('fetch')(e);
    return { handled: answer !== null, response: answer ? await answer : null };
  };
  return { self, stores, puts, run, fetchEvent };
}

test('Q-12: the worker answers only GETs inside /admin/ and never an API or media path', async () => {
  const w = worker();
  await w.run('install');
  await w.run('activate');
  for (const path of ['/api/v1/orders', '/api/store/cart', '/admin/api/v1/orders', '/media/x', '/admin/media/x', '/p/some-page', '/robots.txt', '/admin/sw.js']) {
    assert.equal((await w.fetchEvent(path)).handled, false, `${path} goes straight through`);
  }
  assert.equal((await w.fetchEvent('/admin/orders', { headers: { authorization: 'Bearer x' } })).handled, false);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await w.fetchEvent('/admin/', { method })).handled, false, method);
  assert.equal((await w.fetchEvent('https://elsewhere.example/admin/app.js')).handled, false);
  assert.deepEqual(w.puts.filter((u) => /\/api\/|\/media\//.test(u)), []);
});

test('Q-12: a page opened online is kept as the shell, and opened offline it is served from there', async () => {
  const w = worker();
  await w.run('install');
  const online = await w.fetchEvent('/admin/orders', { mode: 'navigate' });
  assert.equal(online.handled, true);
  w.self.fetch = async () => { throw new TypeError('offline'); };
  const offline = await w.fetchEvent('/admin/orders', { mode: 'navigate' });
  assert.equal(offline.handled, true);
  assert.match(await offline.response.text(), /id="root"/, 'the shell, which holds no business data');
});

test('Q-12: with no stored shell and no network a navigation gets an offline page with a Try again button, never a blank page', async () => {
  const w = worker({ network: () => { throw new TypeError('offline'); } });
  await w.run('install');
  const nav = await w.fetchEvent('/admin/products', { mode: 'navigate' });
  assert.equal(nav.handled, true);
  const html = await nav.response.text();
  assert.match(html, /You are offline/);
  assert.match(html, /Try again/);
  assert.match(html, /Bhava/, 'the seller console is Bhava-branded');
});

test('Q-12: an error page or a redirect is never kept as the shell', async () => {
  const w = worker({ network: () => new Response('boom', { status: 500, headers: { 'content-type': 'text/html' } }) });
  await w.run('install');
  w.puts.length = 0;
  await w.fetchEvent('/admin/orders', { mode: 'navigate' });
  assert.deepEqual(w.puts, []);
});

test('Q-12: an update takes over at once, deletes old console caches and the API answers an older worker kept, and leaves other caches alone', async () => {
  const w = worker({ stored: { 'bhava-console-shell-v0': [`${ORIGIN}/admin/`], 'bhava-console-old': [`${ORIGIN}/api/v1/products`], other: [`${ORIGIN}/x`] } });
  await w.run('install');
  assert.equal(w.self.skipped, true);
  await w.run('activate');
  assert.equal(w.self.claimed, true);
  const names = [...w.stores.keys()];
  assert.ok(names.includes('other'));
  assert.ok(!names.includes('bhava-console-old') && !names.includes('bhava-console-shell-v0'));
  for (const name of names.filter((n) => n.startsWith('bhava-console-'))) assert.ok([...w.stores.get(name).keys()].every((u) => !u.includes('/api/')));
});

test('Q-12: the worker keeps no business data of its own', () => {
  const text = read('console/public/sw.js');
  assert.doesNotMatch(text, /localStorage|indexedDB|sessionStorage/);
  assert.match(text, /bhava-console-/);
});

test('Q-12: the install hint is for iPhone Safari only, once, and not when already installed', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  assert.equal(isIosSafari(safari), true);
  assert.equal(isIosSafari(chromeIos), false, 'other iPhone browsers cannot add to the home screen');
  assert.equal(isIosSafari(android), false);
  assert.equal(isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', 5), true, 'an iPad that says it is a Mac');
  assert.equal(isIosSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', 0), false);
  assert.equal(shouldShowHint({ userAgent: safari, standalone: false, dismissed: false }), true);
  assert.equal(shouldShowHint({ userAgent: safari, standalone: true, dismissed: false }), false);
  assert.equal(shouldShowHint({ userAgent: safari, standalone: false, dismissed: true }), false);
  assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => { throw new Error('no'); } }), false);
});

test('Q-12: the page clears the console caches when the person signs out and when the business changes', () => {
  const live = read('console/src/features/install/live.js');
  assert.match(live, /\/auth\/logout/);
  assert.match(live, /clearBusinessCaches/);
  assert.match(live, /switch of business/);
  assert.match(read('console/src/features/install/index.jsx'), /\.\/live\.js/);
});
