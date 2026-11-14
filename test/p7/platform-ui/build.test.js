// The Platform Console's build (PRD 5.5, F-90, F-91): a page that holds no data, loads nothing from outside, lives under /console/,
// and shares nothing with the seller bundle. Also served by the real app on the platform host and nowhere else.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { bundleText, buildConsole } from './support.js';

let dir;
let text;
before(() => {
  dir = buildConsole();
  text = bundleText(dir);
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('F-90: the page is the console’s own: it says so, is not indexed, and every file it loads is under /console/ and local', () => {
  const html = text['platform.html'];
  assert.ok(html, 'platform.html is built');
  assert.match(html, /<title>Bhava Console<\/title>/);
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/, 'no inline script: the page’s content security policy allows scripts from itself only');
  assert.doesNotMatch(html, /style="|<style/, 'no inline style either');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(match[1], /^\/console\//, `${match[1]} is not under /console/`);
  assert.ok(Object.keys(text).some((name) => /^assets\/platform-.*\.js$/.test(name)), 'the entry script is a file');
});

test('F-90: each screen is a file of its own, loaded when it is opened, so a role pays only for what it uses', () => {
  const chunks = Object.keys(text).filter((name) => /^assets\/pages-.*\.js$/.test(name));
  assert.ok(chunks.length >= 12, `${chunks.length} screen files`);
  const entry = text[Object.keys(text).find((name) => /^assets\/platform-.*\.js$/.test(name))];
  assert.ok(!entry.includes('Raw exports'), 'the exports screen is not in the entry file');
  assert.ok(!entry.includes('Rebuild every app'), 'the apps screen is not in the entry file');
});

test('F-91: nothing of the seller’s console or API is in the bundle, and nothing of the console names a seller’s address', () => {
  const all = Object.entries(text).filter(([name]) => name.endsWith('.js') || name.endsWith('.html')).map(([, body]) => body).join('\n');
  for (const sentinel of ['/api/v1', 'Bhava for Business', '/admin/', 'Welcome to Bhava. Your creator page is ready']) assert.ok(!all.includes(sentinel), `the bundle holds ${sentinel}`);
  assert.ok(all.includes('/tenants'), 'the console’s own routes are there');
  for (const name of Object.keys(text)) assert.ok(!/admin|seller/i.test(name), `${name}: a seller-named file in the console build`);
});

test('F-91: no secret is baked into the build, and no address of the platform host', () => {
  const all = Object.values(text).join('\n');
  assert.ok(!/(sk_live|rzp_(live|test)_|whsec_|-----BEGIN)/.test(all));
  assert.ok(!/https?:\/\/[a-z0-9.-]*(bhava|shops)\.[a-z]+/i.test(all.replace(/https?:\/\/(www\.)?w3\.org[^"'\s]*/g, '')), 'no host of ours is written into the code');
});

test('F-90: the real app serves the console on the platform host only, with a strict policy, and any path that is not a file is the app', async (t) => {
  const app = await startWorld(t, { overrides: { platformConsoleDir: dir } });
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });
  const shell = await hit(app, '/console/health/12', { host: CONSOLE_HOST });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Bhava Console/);
  assert.match(shell.headers['content-security-policy'], /script-src 'self'/);
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(shell.headers['cache-control'], 'no-store');
  assert.equal(shell.headers['x-frame-options'], 'DENY');

  // Every file the page names is served, with the right kind of content, on the platform host.
  for (const match of text['platform.html'].matchAll(/(?:src|href)="([^"]+)"/g)) {
    const res = await hit(app, match[1], { host: CONSOLE_HOST });
    assert.equal(res.status, 200, match[1]);
  }
  for (const name of Object.keys(text).filter((n) => /^assets\/pages-.*\.js$/.test(n))) {
    const res = await hit(app, `/console/${name}`, { host: CONSOLE_HOST });
    assert.equal(res.status, 200, name);
    assert.match(res.headers['content-type'], /javascript/, name);
  }
  // On a business's address and on nothing else, none of it exists.
  for (const pathname of ['/console/', '/console/health', `/console/${Object.keys(text).find((n) => n.startsWith('assets/platform-') && n.endsWith('.js'))}`]) {
    const res = await hit(app, pathname, { host: shop.host });
    assert.equal(res.status, 404, pathname);
    assert.ok(!res.text.includes('Bhava Console'));
  }
  assert.equal((await hit(app, '/console/', { host: `other.${CONSOLE_HOST}` })).status, 404, 'a look-alike host is not the platform host');
  assert.equal((await hit(app, '/console/', { host: `${CONSOLE_HOST}.evil.example` })).status, 404);

  // The page holds no data: its api is the platform host's own and answers only a signed-in role.
  assert.equal((await hit(app, '/me', { host: CONSOLE_HOST })).status, 401);
  const op = await consoleUser(app, 'service_operator');
  assert.equal((await onConsole(app, op, '/tenants', { method: 'POST', body: {} })).status, 403, 'a service operator is refused when it calls a business route directly');
  assert.equal((await onConsole(app, op, '/tenant-health')).status, 403);
  assert.equal((await onConsole(app, op, '/raw-export', { method: 'POST', body: { reason: 'x' } })).status, 403);
  assert.equal(path.basename(dir).startsWith('bhava-platform-ui-'), true);
});
