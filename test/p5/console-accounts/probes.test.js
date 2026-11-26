// What the console's sign-in page asks the server before it draws (console/src/features/account/options.js and signin.js),
// against the real app: one question, app.requirements, whose answer says whether the phone-and-password form exists
// (only while PASSWORD_LOGIN is on), whether this is the sign-in host where Google starts, and which ways in are offered.
// The page tries no route to see whether it is there: on a business's own address /auth/google/start is the store's 404
// and, with PASSWORD_LOGIN off, /api/v1/auth/login is a 404 too, and a browser reports each as an error (R3-OP2-1).
// Asking must change nothing: no failed sign-in recorded, no limit used up. P-11 (the console's half).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '../../../shared/api-client/index.js';
import { askWaysIn } from '../../../console/src/features/account/signin.js';
import { APP_HOST, OWNER, accountsApp, browserTab, call } from './support.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The sign-in page's question as the console asks it (options.js), from a tab on `host` (null: the default business at 127.0.0.1), and every request it sent. */
async function signInPage(app, host) {
  const tab = browserTab(app, { ip: '10.77.0.1' }, { host: host ?? '127.0.0.1' });
  const api = createApiClient({ fetch: (...args) => tab.target.fetch(...args) });
  const ways = await askWaysIn(() => api.app.requirements({ platform: 'android' }));
  return { ways, paths: tab.seen.map((s) => s.path) };
}

describe('with PASSWORD_LOGIN on (tests and local runs)', () => {
  let app;
  before(async () => {
    app = await accountsApp({ overrides: { passwordLogin: true } });
  });
  after(() => app?.close());

  test('P-11: the sign-in page is told the password form exists on a business\'s own address, and asks nothing else', async () => {
    const { ways, paths } = await signInPage(app, null);
    assert.equal(ways.password, true);
    assert.equal(ways.signInHost, false);
    assert.deepEqual(paths, ['/api/v1/app/requirements'], 'no route is tried to see whether it exists');
  });

  test('asking records no failed sign-in and uses up no limit: the right password still opens, a wrong one is still "don’t match"', async () => {
    for (let i = 0; i < 40; i++) assert.equal((await signInPage(app, null)).ways.password, true);
    const wrong = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, ip: '10.77.0.1', body: { phone: OWNER.phone, password: 'not-it', transport: 'bearer' } });
    assert.equal(wrong.status, 401, wrong.text);
    assert.match(wrong.json.error, /don’t match/);
    const right = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, ip: '10.77.0.1', body: { phone: OWNER.phone, password: OWNER.password, transport: 'bearer' } });
    assert.equal(right.status, 201, right.text);
  });

  test('the server says it is the sign-in host there and nowhere else, even where Google is not set up', async () => {
    const there = await call(app, '/api/v1/app/requirements?platform=android');
    assert.equal(there.status, 200, there.text);
    assert.deepEqual(there.json.web, { signInHost: true, passwordLogin: true });
    const here = await call(app, '/api/v1/app/requirements?platform=android', { host: null });
    assert.deepEqual(here.json.web, { signInHost: false, passwordLogin: true });
    // What the flag stands for: on the sign-in host Google's start answers with a redirect; anywhere else it is not there.
    const start = await call(app, '/auth/google/start?target=web');
    assert.ok(start.status >= 300 && start.status < 400, `${start.status} ${start.text}`);
    const elsewhere = await call(app, '/auth/google/start?target=web', { host: null });
    assert.equal(elsewhere.status, 404);
  });

  test('P-11: on the sign-in host the password route exists but the form is not offered, because a password cannot open a session there', async () => {
    const { ways, paths } = await signInPage(app, APP_HOST);
    assert.equal(ways.password, false);
    assert.equal(ways.signInHost, true);
    assert.deepEqual(paths, ['/api/v1/app/requirements']);
    // What the form would have done there: refused, whatever the number and password.
    const tried = await call(app, '/api/v1/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password, transport: 'cookie' } });
    assert.equal(tried.status, 401, tried.text);
    assert.equal((await signInPage(app, null)).ways.password, true, 'on a business\'s own address it is offered');
  });

  test('app.requirements answers the console, which sends no app headers, with the ways in', async () => {
    const res = await call(app, '/api/v1/app/requirements?platform=android', { host: null });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.signIn, { whatsapp: true, google: false, apple: false });
    const there = await call(app, '/api/v1/app/requirements?platform=android');
    assert.equal(there.status, 200);
  });
});

describe('with PASSWORD_LOGIN off (everywhere else)', () => {
  let app;
  before(async () => {
    app = await accountsApp({ overrides: { passwordLogin: false, sellerGoogleClientId: 'sim-seller-google-client', sellerGoogleClientSecret: 'sim-seller-google-secret' } });
  });
  after(() => app?.close());

  test('P-11: no password form, on a business\'s address or on the sign-in host, and the missing route is never asked', async () => {
    for (const host of [null, APP_HOST]) {
      const { ways, paths } = await signInPage(app, host);
      assert.equal(ways.password, false);
      assert.deepEqual(paths, ['/api/v1/app/requirements']);
    }
    // The route is not there: the answer comes before the bearer check, so no token, cookie or body changes it.
    const res = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, body: { phone: OWNER.phone, password: OWNER.password } });
    assert.equal(res.status, 404);
  });

  test('Google is offered where it starts: set up on the server, and on the sign-in host', async () => {
    const res = await call(app, '/api/v1/app/requirements?platform=android');
    assert.equal(res.json.signIn.google, true);
    assert.deepEqual(res.json.web, { signInHost: true, passwordLogin: false });
    assert.equal((await signInPage(app, APP_HOST)).ways.google, true);
    const elsewhere = await signInPage(app, null);
    assert.equal(elsewhere.ways.google, false);
    assert.deepEqual(elsewhere.paths, ['/api/v1/app/requirements'], 'a business\'s address never asks for the Google start, which is its store\'s 404 there');
  });

  test('a server that cannot be reached is no password form and no Google, and the code is still the way in', async () => {
    const ways = await askWaysIn(async () => {
      throw new TypeError('fetch failed');
    });
    assert.deepEqual(ways, { whatsapp: true, google: false, password: false, signInHost: false });
  });
});

/** Source without its comments, which may name the start without asking it. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Every source file of the clients that run in a browser. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe('no client asks a route to see whether it exists', () => {
  test('the Google start is only ever a link: no fetch of it, and no probe of the password route, in the console or shared client', () => {
    const files = ['console/src', 'shared'].flatMap((dir) => sources(path.join(ROOT, dir)));
    assert.ok(files.length > 20, 'the console\'s sources were found');
    const found = [];
    for (const file of files) {
      const text = code(readFileSync(file, 'utf8'));
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      // A request (fetch, send, get, post) whose address is the Google start or a string built from it.
      if (/\b(fetch|send|get|post|request)\s*\(\s*[^)]*(GOOGLE_START|\/auth\/google\/start)/.test(text)) found.push(`${rel}: requests the Google start`);
      if (/googleStartsHere|passwordLoginOn/.test(text)) found.push(`${rel}: has a sign-in probe`);
      if (/['"`]\/api\/v1\/auth\/login['"`]\s*,\s*\{[^}]*Bearer -/.test(text)) found.push(`${rel}: probes the password route`);
    }
    assert.deepEqual(found, []);
    const signin = code(readFileSync(path.join(ROOT, 'console/src/features/account/signin.js'), 'utf8'));
    assert.equal([...signin.matchAll(/\$\{GOOGLE_START\}/g)].length, 1, 'the Google start is used once, by googleStartUrl (an href)');
    assert.doesNotMatch(signin, /\(\s*GOOGLE_START\b/, 'and is never handed to anything that could send it');
  });
});
