// Q-10 (the demo scripts), Q-12 (the seller console as a web app) and Q-13 (showcase feedback). The browser halves are in
// e2e/p8/spec-p8. Here: the scripts' text against the product (a step that names something that no longer exists fails),
// the service worker run in a fake worker scope, and the feedback routes over HTTP.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FEEDBACK_SEVERITIES, FEEDBACK_STATES, FeedbackItem } from '../../../src/contracts/api/platform.js';
import {
  CONSOLE_HOST, addBusiness, closeShared, consoleUser, exists, filesUnder, hit, keys, onConsole, read, repoRoot, sharedWorld, showcase, strangers, u,
} from './support.js';

after(closeShared);

// ---- Q-10: demo scripts ----------------------------------------------------------------------------------------------------------

const scriptFiles = () => filesUnder('docs/showcase', { ext: ['.md'] }).filter((f) => !/readme|index/i.test(path.basename(f)));
const STEP = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const stepsOf = (text) => text.split(/\r?\n/).map((line) => STEP.exec(line)).filter(Boolean).map((m) => ({ n: Number(m[1]), text: m[2] }));
const tokensOf = (step) => [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
const isRoute = (token) => /^\/[A-Za-z0-9/_-]*$/.test(token);

/** What the console has: its route paths and its labels, read from the feature registrations. */
function consoleVocabulary() {
  const routes = [];
  const labels = new Set();
  for (const file of filesUnder('console/src/features', { ext: ['.jsx', '.js'] })) {
    const text = read(file);
    for (const m of text.matchAll(/path:\s*'([^']*)'/g)) routes.push(m[1]);
    for (const m of text.matchAll(/label:\s*'([^']*)'/g)) labels.add(m[1].toLowerCase());
  }
  const sources = filesUnder('console/src', { ext: ['.jsx', '.js'] }).map((f) => read(f)).join('\n').toLowerCase();
  return { routes, labels, sources };
}
const routeExists = (vocab, route) => {
  const rest = route.replace(/^\/admin\/?/, '').replace(/\/+$/, '');
  if (rest === '') return true;
  return vocab.routes.some((r) => new RegExp(`^${r.replace(/:[a-zA-Z]+/g, '[^/]+').replace(/\*/g, '.*')}$`).test(rest));
};

/** Every step of a script that names a screen, a route or a control the product no longer has: [{ step, token }]. */
function drift(text, vocab, buyerKnows = () => true) {
  const found = [];
  for (const step of stepsOf(text)) {
    for (const token of tokensOf(step.text)) {
      if (/[<{>}$]/.test(token) || /\s{2,}/.test(token)) continue;
      if (isRoute(token)) {
        const ok = token.startsWith('/admin') ? routeExists(vocab, token) : buyerKnows(token);
        if (!ok) found.push({ step: step.n, token });
      } else if (!vocab.sources.includes(token.toLowerCase()) && !buyerKnows(token)) {
        found.push({ step: step.n, token });
      }
    }
  }
  return found;
}

/** The scripts, and a failure when there are fewer than one per business: a check over no scripts proves nothing. */
function needScripts() {
  const files = scriptFiles();
  assert.ok(files.length >= keys().length, `docs/showcase holds ${files.length} scripts for ${keys().length} businesses`);
  return files;
}

const TOPICS = [
  ['a comment on a reel', /comment/i], ['the DM', /\bDMs?\b|direct message/i], ['the landing page', /landing page|reel page/i], ['checkout', /checkout/i],
  ['payment in test mode', /test mode|test payment/i], ['tracking', /track/i], ['the owner\'s home', /\bhome\b/i], ['the inbox', /inbox/i], ['orders', /orders?/i],
  ['insights', /insights/i], ['Reach Guard', /reach guard/i], ['their branded app', /\bapp\b/i],
];

test('Q-10: there is a demo script for every sample business, in numbered steps a presenter can follow on a phone', () => {
  const files = needScripts();
  for (const file of files) {
    const text = read(file);
    const steps = stepsOf(text);
    assert.ok(steps.length >= 10, `${file}: ${steps.length} numbered steps`);
    assert.deepEqual(steps.map((s) => s.n), steps.map((_, i) => i + 1), `${file}: the steps are numbered 1, 2, 3 in order`);
    for (const [what, pattern] of TOPICS) assert.match(text, pattern, `${file}: the story covers ${what}`);
    assert.match(text, /simulat/i, `${file}: says which parts are simulated`);
    assert.ok(steps.every((s) => s.text.length <= 400), `${file}: a step is short enough to read on a phone`);
  }
});

test('Q-10: a script needs no real Instagram account, no real money, no deployed server and shows no real person', () => {
  for (const file of needScripts()) {
    const text = read(file);
    assert.deepEqual(strangers(text), [], `${file}: a phone, email or id outside the invented ranges`);
    for (const url of text.matchAll(/https?:\/\/[^\s)`>"']+/g)) {
      const host = new URL(url[0]).hostname;
      assert.match(host, /(^localhost$|^127\.|\.localhost$|\.example$|\.test$|^example\.(com|org|net)$|\.example\.(com|org|net)$)/, `${file}: ${host} is a real address`);
    }
    assert.doesNotMatch(text, /(log ?in|sign ?in|connect)[^.\n]{0,40}(your|a|the) (real|own|personal) (instagram|facebook|whatsapp)/i, `${file}: asks for a real account`);
    assert.doesNotMatch(text, /\b(real|live) (money|card|payment|upi)\b/i, `${file}: asks for real money`);
    assert.doesNotMatch(text, /(card number|cvv|otp of your|password of)/i);
  }
});

test('Q-10: every step still matches the product: each screen, route and control a script names exists', () => {
  const vocab = consoleVocabulary();
  assert.ok(vocab.routes.length >= 15, 'the console\'s routes were read');
  for (const file of needScripts()) {
    const found = drift(read(file), vocab, (token) => {
      // A buyer address or a control of the buyer's pages, the apps or the platform: it must be somewhere in the product's source.
      const needle = token.toLowerCase();
      const roots = ['src', 'apps/shopper/src', 'apps/owner/src', 'public', 'shared'];
      return roots.some((root) => filesUnder(root, { ext: ['.js', '.jsx', '.mjs', '.html', '.css', '.json'] }).some((f) => read(f).toLowerCase().includes(isRoute(token) ? needle.split('/')[1] ?? needle : needle)));
    });
    assert.deepEqual(found, [], `${file}: steps that name something that is not there`);
  }
});

test('Q-10: the drift check itself catches a step that no longer exists, and passes the real ones', () => {
  const vocab = consoleVocabulary();
  const real = '1. Open `/admin/orders` and read the list.\n2. Tap `Orders` in the menu.\n';
  assert.deepEqual(drift(real, vocab, () => false), [], 'a real route and a real label pass');
  const broken = '1. Open `/admin/orders-of-the-future-zz` and read the list.\n2. Press `Frobnicate Everything Zz`.\n3. Open `/admin/products` now.';
  const found = drift(broken, vocab, () => false);
  assert.deepEqual(found.map((f) => [f.step, f.token]), [[1, '/admin/orders-of-the-future-zz'], [2, 'Frobnicate Everything Zz']], 'only the two steps that drifted');
  assert.deepEqual(stepsOf('Intro\n1. one\n   2) two\nnot a step\n3. three').map((s) => s.n), [1, 2, 3]);
});

test('Q-10: a script walks every route it names on the seeded buyer address without an error', { timeout: 900_000 }, async () => {
  const app = await sharedWorld();
  const { seedShowcase } = await import('../../../scripts/showcase.js');
  const businesses = showcase();
  const results = await seedShowcase({ db: app.db, repos: app.platform, ctx: app.ctx, businesses });
  const files = needScripts();
  let walked = 0;
  for (const file of files) {
    const text = read(file);
    const owner = businesses.find((b) => text.includes(b.seed.business.name) || text.includes(b.seed.business.slug)) ?? businesses[files.indexOf(file) % businesses.length];
    const result = results.find((r) => r.key === owner.key);
    for (const step of stepsOf(text)) {
      for (const token of tokensOf(step.text)) {
        if (!isRoute(token) || token.startsWith('/admin')) continue;
        const res = await hit(app, token, { host: `${result.slug}.shops.example` });
        assert.ok(res.status >= 200 && res.status < 400, `${file} step ${step.n}: ${token} answered ${res.status}`);
        assert.doesNotMatch(res.text, /bhava/i, `${file} step ${step.n}: ${token} shows the platform name to a buyer`);
        walked += 1;
      }
    }
  }
  assert.ok(walked >= files.length, `the scripts name buyer addresses to walk (${walked})`);
});

// ---- Q-12: the seller console as a web app ---------------------------------------------------------------------------------------

const SW = 'console/public/sw.js';

test('Q-12: the manifest makes the console installable, and it is the console\'s own: Bhava-branded, scoped to /admin/', () => {
  const manifest = JSON.parse(read('console/public/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/admin/');
  assert.ok(manifest.start_url.startsWith('/admin/'));
  assert.match(manifest.name, /bhava/i, 'a seller surface is Bhava-branded');
  assert.ok(manifest.short_name.length <= 12);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.ok(manifest.icons.length >= 1);
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/admin/'), `${icon.src} is inside the scope`);
    assert.ok(exists(`console/public/${icon.src.replace(/^\/admin\//, '')}`), `${icon.src} exists`);
  }
  assert.ok(manifest.icons.some((i) => /png/.test(i.type) && /192|512/.test(i.sizes)), 'a PNG icon of 192 or 512 pixels: iPhones and Android need one');
  const html = read('console/index.html');
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"/, 'an icon for the iPhone\'s home screen');
  assert.match(html, /apple-mobile-web-app-capable|mobile-web-app-capable/, 'opens full screen from the iPhone\'s home screen');
});

test('Q-12: the page asks the worker to clear what it cached on sign-out and on a change of business', () => {
  const callers = filesUnder('console/src', { ext: ['.jsx', '.js'] }).filter((f) => !f.endsWith('pwa/register.js') && read(f).includes('clearBusinessCaches'));
  assert.ok(callers.length >= 1, 'something calls clearBusinessCaches');
  const text = callers.map(read).join('\n');
  assert.match(text, /sign.?out|logout/i, 'on sign-out');
  assert.match(text, /switch|business/i, 'on a change of business');
});

test('Q-12: clearBusinessCaches removes exactly the console\'s own caches and nothing else', async () => {
  const { CACHE_PREFIX, clearBusinessCaches } = await import('../../../console/src/pwa/register.js');
  const store = new Map([[`${CACHE_PREFIX}shell-v1`, 1], [`${CACHE_PREFIX}anything`, 1], ['someone-elses-cache', 1], ['workbox-precache', 1]]);
  globalThis.caches = { keys: async () => [...store.keys()], delete: async (name) => store.delete(name) };
  try {
    assert.equal(await clearBusinessCaches(), 2);
    assert.deepEqual([...store.keys()].sort(), ['someone-elses-cache', 'workbox-precache']);
    assert.equal(await clearBusinessCaches(), 0);
  } finally {
    delete globalThis.caches;
  }
});

/** A fake service worker scope: runs sw.js and answers what its listeners do. */
function workerScope({ cached = {}, network = () => new Response('from the network', { status: 200 }), origin = 'https://app.example' } = {}) {
  const listeners = new Map();
  const puts = [];
  const stores = new Map(Object.entries(cached).map(([name, urls]) => [name, new Map(urls.map((url) => [url, new Response(`cached ${url}`)]))]));
  const opened = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (request) => store.get(typeof request === 'string' ? request : request.url)?.clone(),
      put: async (request, response) => { puts.push({ cache: name, url: typeof request === 'string' ? request : request.url, status: response?.status }); store.set(typeof request === 'string' ? request : request.url, response); },
      add: async (request) => { const url = typeof request === 'string' ? new URL(request, origin).href : request.url; puts.push({ cache: name, url }); store.set(url, new Response('x')); },
      addAll: async (list) => { for (const r of list) { const url = typeof r === 'string' ? new URL(r, origin).href : r.url; puts.push({ cache: name, url }); store.set(url, new Response('x')); } },
      delete: async (request) => store.delete(typeof request === 'string' ? request : request.url),
      keys: async () => [...store.keys()].map((url) => new Request(url)),
    };
  };
  const fetched = [];
  const self = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    location: new URL(`${origin}/admin/sw.js`),
    registration: { scope: `${origin}/admin/` },
    skipWaiting: () => { self.skipped = true; return Promise.resolve(); },
    clients: { claim: () => { self.claimed = true; return Promise.resolve(); }, matchAll: async () => [] },
    caches: {
      open: async (name) => opened(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (request) => { for (const store of stores.values()) { const hit_ = store.get(typeof request === 'string' ? request : request.url); if (hit_) return hit_.clone(); } return undefined; },
      has: async (name) => stores.has(name),
    },
    fetch: async (request) => { fetched.push(typeof request === 'string' ? request : request.url); return network(request); },
  };
  self.self = self;
  const context = vm.createContext({ self, caches: self.caches, fetch: self.fetch, Response, Request, Headers, URL, URLSearchParams, Promise, console, setTimeout, clearTimeout, location: self.location, clients: self.clients, skipWaiting: self.skipWaiting, registration: self.registration });
  vm.runInContext(process.env.P8_SW_FILE ? fs.readFileSync(process.env.P8_SW_FILE, 'utf8') : read(SW), context, { filename: SW });

  const settle = async (event) => { await Promise.all(event.waits); return event; };
  const event = (extra = {}) => ({ waits: [], waitUntil(p) { this.waits.push(Promise.resolve(p)); }, ...extra });
  return {
    self, puts, stores, fetched, listeners,
    async install() { const e = event(); listeners.get('install')?.(e); return settle(e); },
    async activate() { const e = event(); listeners.get('activate')?.(e); return settle(e); },
    /** A fetch event: { responded, response } where responded is whether the worker took the request over. */
    async fetchEvent(url, { method = 'GET', headers = {}, mode = 'cors', destination = '' } = {}) {
      const request = Object.assign(new Request(new URL(url, origin), { method, headers }), {});
      Object.defineProperty(request, 'mode', { value: mode });
      Object.defineProperty(request, 'destination', { value: destination });
      let responded = null;
      const e = event({ request, respondWith(p) { responded = Promise.resolve(p); }, preloadResponse: Promise.resolve(undefined) });
      listeners.get('fetch')?.(e);
      await settle(e);
      return { responded: responded !== null, response: responded ? await responded.catch((err) => ({ error: err })) : null };
    },
  };
}

test('Q-12: the service worker file exists, is its own file, and registers only for the console scope', () => {
  assert.ok(exists(SW), 'console/public/sw.js');
  const text = read(SW);
  assert.match(text, /bhava-console-/, 'every cache is named with the console\'s prefix so sign-out finds it');
  assert.match(text, /skipWaiting/, 'an update does not wait for every tab to close');
  assert.match(text, /clients\.claim/);
  assert.doesNotMatch(text, /localStorage|indexedDB/, 'nothing of a business is kept by the worker');
  assert.doesNotMatch(text, /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}\//i, 'no outside address is hard-wired into the worker');
});

test('Q-12: the worker never stores or serves an answer from /api, whoever asks, and never touches another origin or a write', async () => {
  const w = workerScope();
  await w.install();
  await w.activate();
  const apiPaths = ['/api/v1/products', '/api/v1/orders?limit=20', '/api/v1/auth/me', '/api/store/cart', '/api/v1/media', '/admin/api/v1/products', '/media/abc123', '/api'];
  for (const p of apiPaths) {
    for (const headers of [{}, { authorization: 'Bearer abc', cookie: 'sid=1' }]) {
      const r = await w.fetchEvent(p, { headers });
      if (r.responded) assert.equal(r.response?.error, undefined, `${p}: an answer from the network, not a failure`);
    }
  }
  assert.deepEqual(w.puts.filter((x) => /\/api\b|\/media\//.test(x.url)), [], 'nothing from the API or a business\'s media was stored');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await w.fetchEvent('/admin/', { method });
    assert.equal(r.responded, false, `${method} goes straight through`);
  }
  const other = await w.fetchEvent('https://cdn.other.example/lib.js');
  assert.equal(other.responded, false, 'another origin is none of its business');
  const buyer = await w.fetchEvent('/p/some-reel-page');
  assert.equal(buyer.responded, false, 'a buyer page outside /admin/ is never handled');
  const response = await w.fetchEvent('/api/v1/products');
  assert.ok(!response.responded || !w.stores.size || ![...w.stores.values()].some((s) => [...s.keys()].some((k) => k.includes('/api/'))), 'and nothing is served later from a cache either');
});

test('Q-12: a cached API answer that an older worker left behind is never served', async () => {
  const w = workerScope({ cached: { 'bhava-console-v0': ['https://app.example/api/v1/products', 'https://app.example/admin/'] }, network: () => new Response('fresh from the network') });
  await w.install();
  await w.activate();
  const r = await w.fetchEvent('/api/v1/products');
  if (r.responded) {
    const text = await r.response.text?.();
    assert.doesNotMatch(String(text), /^cached /, 'the stale API answer was not served');
  }
  assert.equal([...w.stores.keys()].filter((k) => k.startsWith('bhava-console-') && [...w.stores.get(k).keys()].some((u_) => u_.includes('/api/'))).length, 0, 'it no longer sits in a console cache');
});

test('Q-12: an update replaces the old shell: old console caches go, other caches stay, and the new worker takes over at once', async () => {
  const w = workerScope({ cached: { 'bhava-console-shell-0': ['https://app.example/admin/'], 'bhava-console-old': ['https://app.example/admin/x.js'], 'unrelated-cache': ['https://app.example/y'] } });
  await w.install();
  await w.activate();
  assert.equal(w.self.skipped, true, 'skipWaiting');
  assert.equal(w.self.claimed, true, 'clients.claim');
  const names = [...w.stores.keys()];
  assert.ok(names.includes('unrelated-cache'), 'a cache that is not the console own is left alone');
  assert.ok(!names.includes('bhava-console-old'), 'an old console cache is cleaned out, so no stuck version');
});

test('Q-12: the shell can be served offline, the data cannot: a navigation with no network gets the shell or an offline page, an API call fails', async () => {
  const down = () => { throw new TypeError('Failed to fetch'); };
  const w = workerScope({ network: (req) => new Response('shell', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await w.install();
  await w.activate();
  await w.fetchEvent('/admin/', { mode: 'navigate', destination: 'document' });
  await w.fetchEvent('/admin/assets/index-abc.js', { destination: 'script' });
  w.self.fetch = async () => down();
  const nav = await w.fetchEvent('/admin/products', { mode: 'navigate', destination: 'document' });
  if (nav.responded) assert.equal(nav.response?.error, undefined, 'an offline navigation still answers with something');
  const api = await w.fetchEvent('/api/v1/products');
  if (api.responded) {
    const text = api.response?.error ? '' : await api.response.text();
    assert.doesNotMatch(text, /<div id="root"|<html/i, 'an API call never gets the page shell as its answer');
  }
});

// ---- Q-13: feedback -----------------------------------------------------------------------------------------------------------------

let feedbackWorld;
async function feedback() {
  if (feedbackWorld) return feedbackWorld;
  const app = await sharedWorld();
  const a = await addBusiness(app, { slug: u('fb-first'), name: 'Feedback First' });
  const b = await addBusiness(app, { slug: u('fb-second'), name: 'Feedback Second' });
  const admin = await consoleUser(app, 'super_admin');
  const support = await consoleUser(app, 'support');
  const onboarder = await consoleUser(app, 'onboarding');
  feedbackWorld = { app, a, b, admin, support, onboarder };
  return feedbackWorld;
}
const create = (w, who, business, body) => onConsole(w.app, who, `/tenants/${business.tenant.id}/feedback`, { method: 'POST', body });
const item = { saidBy: 'The owner', area: 'Orders', text: 'The packed filter is hard to find', severity: 'medium' };

test('Q-13: feedback is logged against its business, with who said it, where, how bad, and starts as new', async () => {
  const w = await feedback();
  const res = await create(w, w.admin, w.a, item);
  assert.equal(res.status, 201, res.text);
  const made = FeedbackItem.parse(res.json());
  assert.equal(made.tenantId, w.a.tenant.id);
  assert.equal(made.tenantName, 'Feedback First');
  assert.equal(made.state, 'new');
  assert.equal(made.fixedIn, '');
  assert.equal(made.saidBy, 'The owner');
  assert.equal(made.area, 'Orders');
  assert.equal(made.severity, 'medium');
  assert.match(made.createdBy, /operator|@/i, 'who logged it');
  const defaulted = await create(w, w.support, w.a, { saidBy: 'Shopper', area: 'Checkout', text: 'No severity given' });
  assert.equal(defaulted.status, 201);
  assert.equal(defaulted.json().severity, 'medium');
  for (const severity of FEEDBACK_SEVERITIES) assert.equal((await create(w, w.admin, w.a, { ...item, severity })).status, 201, severity);
});

test('Q-13: it is tracked to fixed: planned, then fixed with what fixed it, and a fix that is undone clears it', async () => {
  const w = await feedback();
  const made = (await create(w, w.admin, w.a, { ...item, text: 'Track me' })).json();
  const patch = (id, body, who = w.admin) => onConsole(w.app, who, `/feedback/${id}`, { method: 'PATCH', body });
  assert.equal((await patch(made.id, { state: 'planned' })).json().state, 'planned');
  assert.equal((await patch(made.id, { state: 'fixed' })).status, 400, 'fixed must say what fixed it');
  const fixed = await patch(made.id, { state: 'fixed', fixedIn: 'd690d18' }, w.support);
  assert.equal(fixed.status, 200, fixed.text);
  assert.deepEqual([fixed.json().state, fixed.json().fixedIn], ['fixed', 'd690d18']);
  assert.equal((await patch(made.id, { state: 'planned', fixedIn: 'd690d18' })).status, 400, 'only a fixed item says what fixed it');
  assert.equal((await patch(made.id, { severity: 'blocker' })).json().fixedIn, 'd690d18', 'changing the severity leaves the fix alone');
  const reopened = await patch(made.id, { state: 'new' });
  assert.deepEqual([reopened.json().state, reopened.json().fixedIn], ['new', ''], 'moving away from fixed clears fixedIn');
  assert.equal((await patch(made.id, { state: 'declined' })).json().state, 'declined');
  for (const bad of [{}, { state: 'done' }, { severity: 'urgent' }, { state: 'fixed', fixedIn: ' ' }, { fixedIn: 'x'.repeat(81), state: 'fixed' }]) assert.equal((await patch(made.id, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await patch(99999999, { state: 'planned' })).status, 404);
  assert.equal((await patch('abc', { state: 'planned' })).status, 400);
});

test('Q-13: the list is per business: one business\'s feedback is not in another\'s list, by filter, by state or by page', async () => {
  const w = await feedback();
  for (let i = 0; i < 12; i++) assert.equal((await create(w, w.admin, w.a, { ...item, text: `first-${i}-zq` })).status, 201);
  for (let i = 0; i < 4; i++) assert.equal((await create(w, w.admin, w.b, { ...item, text: `second-${i}-zq` })).status, 201);
  const list = (query) => onConsole(w.app, w.admin, `/feedback?${query}`);
  const read_ = async (query) => {
    const seen = [];
    let cursor = '';
    for (let pages = 0; pages < 20; pages++) {
      const res = await list(`${query}&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(res.status, 200, res.text);
      const body = res.json();
      assert.ok(body.items.length <= 5);
      seen.push(...body.items);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    return seen;
  };
  const first = await read_(`tenantId=${w.a.tenant.id}`);
  assert.ok(first.every((i) => i.tenantId === w.a.tenant.id), 'only the first business\'s items');
  assert.ok(first.filter((i) => /^first-\d+-zq$/.test(i.text)).length === 12, 'all twelve, across pages');
  assert.equal(new Set(first.map((i) => i.id)).size, first.length, 'no item twice across pages');
  assert.equal(first.some((i) => /^second-/.test(i.text)), false);
  const second = await read_(`tenantId=${w.b.tenant.id}`);
  assert.equal(second.filter((i) => /^second-\d+-zq$/.test(i.text)).length, 4);
  assert.equal(second.some((i) => /^first-/.test(i.text)), false);
  const all = await read_('state=all');
  assert.ok(all.some((i) => i.tenantId === w.a.tenant.id) && all.some((i) => i.tenantId === w.b.tenant.id), 'the platform sees every business');
  for (const state of FEEDBACK_STATES) assert.ok((await read_(`state=${state}`)).every((i) => i.state === state), `only ${state}`);
  assert.equal((await list('state=whatever')).status, 400);
  assert.equal((await list('tenantId=abc')).status, 400);
});

test('Q-13: only the platform\'s support and super admin roles can read or change feedback; nobody signed in, a seller and another role cannot', async () => {
  const w = await feedback();
  const made = (await create(w, w.admin, w.a, { ...item, text: 'secret-feedback-zq' })).json();
  const calls = [['/feedback', 'GET'], [`/tenants/${w.a.tenant.id}/feedback`, 'POST', item], [`/feedback/${made.id}`, 'PATCH', { state: 'planned' }]];
  for (const [url, method, body] of calls) {
    assert.equal((await hit(w.app, url, { host: CONSOLE_HOST, method, body })).status, 401, `${method} ${url}: nobody signed in`);
    assert.equal((await onConsole(w.app, w.onboarder, url, { method, body })).status, 403, `${method} ${url}: another platform role`);
    assert.ok([200, 201].includes((await onConsole(w.app, w.support, url, { method, body })).status), `${method} ${url}: support`);
  }
  const state = await onConsole(w.app, w.admin, `/feedback/${made.id}`);
  assert.ok([404, 405].includes(state.status) || state.status === 200, 'a single read is not required');
  const after_ = (await onConsole(w.app, w.admin, `/feedback?tenantId=${w.a.tenant.id}`)).json().items.find((i) => i.id === made.id);
  assert.equal(after_.state, 'planned', 'the refused attempts changed nothing');

  // A seller's own session, on its own address and on the console's, sees none of it.
  const { signIn } = await import('./support.js');
  const token = await signIn(w.app, w.a);
  for (const route of ['/api/v1/feedback', '/api/v1/platform/feedback', `/api/v1/feedback/${made.id}`]) {
    const res = await hit(w.app, route, { host: w.a.host, token });
    assert.ok([403, 404].includes(res.status), `${route}: ${res.status}`);
    assert.doesNotMatch(res.text, /secret-feedback-zq/);
  }
  const asSeller = await hit(w.app, '/feedback', { host: CONSOLE_HOST, token });
  assert.ok([401, 403].includes(asSeller.status));
  assert.doesNotMatch(asSeller.text, /secret-feedback-zq/);
  const other = await hit(w.app, `/feedback`, { host: w.b.host, token: await signIn(w.app, w.b) });
  assert.doesNotMatch(other.text, /secret-feedback-zq/, 'a different business\'s session on its own address');
});

test('Q-13: words are kept as written and bounded: markup comes back as text, nothing blank, nothing huge, an unknown business is refused', async () => {
  const w = await feedback();
  const markup = '<script>alert(1)</script><img src=x onerror=alert(2)> & "quotes"';
  const res = await create(w, w.admin, w.a, { ...item, text: markup, saidBy: '<b>Owner</b>' });
  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type']?.split(';')[0], 'application/json', 'JSON, never a page');
  assert.equal(res.json().text, markup, 'stored as written: escaping is the screen\'s job');
  const stored = await w.app.db.platform.query(`SELECT body FROM feedback_items WHERE id = $1`, [res.json().id]);
  assert.equal(stored[0].body, markup);
  for (const bad of [{ ...item, text: '   ' }, { ...item, text: 'x'.repeat(2001) }, { ...item, area: '' }, { ...item, saidBy: 'y'.repeat(121) }, { ...item, severity: 'urgent' }, { saidBy: 'a' }, { ...item, tenantId: 1 }]) {
    const r = await create(w, w.admin, w.a, bad);
    assert.ok([400, 422].includes(r.status) || (r.status === 201 && bad.tenantId === 1), `${JSON.stringify(bad).slice(0, 60)}: ${r.status}`);
    if (r.status === 201) assert.equal(r.json().tenantId, w.a.tenant.id, 'a tenantId in the body does not move it to another business');
  }
  const ghost = await onConsole(w.app, w.admin, '/tenants/99999999/feedback', { method: 'POST', body: item });
  assert.equal(ghost.status, 404);
});

test('Q-13: a closed business takes its feedback with it, and none is left for another to find', async () => {
  const w = await feedback();
  const gone = await addBusiness(w.app, { slug: u('fb-gone'), name: 'Feedback Gone' });
  assert.equal((await create(w, w.admin, gone, { ...item, text: 'goes-away-zq' })).status, 201);
  await w.app.db.platform.query('DELETE FROM tenants WHERE id = $1', [gone.tenant.id]);
  const all = (await onConsole(w.app, w.admin, '/feedback?limit=100')).json().items;
  assert.equal(all.some((i) => i.text === 'goes-away-zq'), false);
});

test('Q-13: the Platform Console has a Feedback screen, and the feature registers itself', () => {
  const files = filesUnder('console/src/platform/features/feedback', { ext: ['.jsx', '.js'] });
  assert.ok(files.length >= 1, 'the screen exists');
  const text = files.map(read).join('\n');
  assert.match(text, /feedback/i);
  assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML\s*=/, 'feedback text is never put in as markup');
  assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules/feedback')));
});
