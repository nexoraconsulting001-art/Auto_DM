// How Express serves the seller console at /admin. Uses a stand-in build, so it doesn't need `npm run build:console`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWNER, login, startApp } from '../../helpers.js';
import { at } from '../backend-gaps/support.js';

const SHELL = '<!doctype html><title>Bhava for Business</title><div id="root"></div>';
const hashedAsset = 'index-abc123.js';
const builds = [];
after(() => builds.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function standInBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-console-'));
  builds.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'assets', hashedAsset), 'console.log(1)');
  fs.writeFileSync(path.join(dir, '.secret'), 'hidden');
  return dir;
}

const consoleApp = (overrides = {}) => startApp({ overrides: { adminUi: 'console', consoleDir: standInBuild(), ...overrides } });

test('/admin and every deep link under it are the app\'s page', async () => {
  const app = await consoleApp();
  try {
    for (const url of ['/admin', '/admin/', '/admin/products', '/admin/products/12', '/admin/orders/12/items?tab=x']) {
      const res = await fetch(`${app.base}${url}`, { redirect: 'manual' });
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-type'), /text\/html/, url);
      assert.equal(await res.text(), SHELL, url);
      assert.equal(res.headers.get('cache-control'), 'no-cache', url);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, url);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'(;|$)/, url);
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', url);
    }
    assert.equal((await fetch(`${app.base}/admin/products`, { method: 'HEAD' })).status, 200);
  } finally {
    app.close();
  }
});

test('the page carries no business data, whoever asks', async () => {
  const app = await consoleApp();
  try {
    await app.repos.products.create({ name: 'SECRET Pot', price: '199', active: 'on' });
    const { cookie } = await login(app.base);
    for (const headers of [{}, { cookie }]) assert.equal(await (await fetch(`${app.base}/admin/products`, { headers })).text(), SHELL);
  } finally {
    app.close();
  }
});

test('built files are served, and hashed ones are cached for good', async () => {
  const app = await consoleApp();
  try {
    const asset = await fetch(`${app.base}/admin/assets/${hashedAsset}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.match(asset.headers.get('cache-control'), /max-age=31536000/);
    const icon = await fetch(`${app.base}/admin/favicon.svg`);
    assert.equal(icon.status, 200);
    assert.doesNotMatch(icon.headers.get('cache-control'), /immutable/);
  } finally {
    app.close();
  }
});

test('a file that isn\'t there is a 404, not the page', async () => {
  const app = await consoleApp();
  try {
    for (const url of ['/admin/assets/old-chunk.js', '/admin/nope.css', '/admin/products/photo.png']) {
      const res = await fetch(`${app.base}${url}`);
      assert.equal(res.status, 404, url);
      assert.notEqual(await res.text(), SHELL, url);
    }
  } finally {
    app.close();
  }
});

test('nothing outside the build can be fetched', async () => {
  const app = await consoleApp();
  try {
    for (const url of ['/admin/.secret', '/admin/..%2f..%2fpackage.json', '/admin/assets/..%2f..%2f..%2fpackage.json', '/admin/%2e%2e/%2e%2e/package.json', '/admin/..%5c..%5cpackage.json']) {
      const text = await (await fetch(`${app.base}${url}`)).text();
      assert.doesNotMatch(text, /"workspaces"/, url);
      assert.notEqual(text, 'hidden', url);
    }
  } finally {
    app.close();
  }
});

test('the console is on each business\'s own address, and nowhere else', async () => {
  const app = await consoleApp({ defaultTenant: '' });
  try {
    await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
    assert.equal(await (await fetch(`${app.base}/admin`, { headers: at('leaf.bhava.test') })).text(), SHELL);
    const nowhere = await fetch(`${app.base}/admin`, { headers: at('nobody.example') });
    assert.equal(nowhere.status, 404);
    assert.notEqual(await nowhere.text(), SHELL);
  } finally {
    app.close();
  }
});

test('with the console on, the old pages are gone', async () => {
  const app = await consoleApp();
  try {
    const { cookie, csrf } = await login(app.base);
    assert.doesNotMatch(await (await fetch(`${app.base}/admin/settings`, { headers: { cookie } })).text(), /form-grid/);
    const post = await fetch(`${app.base}/admin/settings`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/x-www-form-urlencoded' }, body: 'store_name=Hijacked' });
    assert.equal(post.status, 404);
    assert.equal((await app.repos.settings.getAll()).store_name, 'My store');
  } finally {
    app.close();
  }
});

test('an unbuilt console says so plainly, and is not mistaken for a working one', async () => {
  const app = await startApp({ overrides: { adminUi: 'console', consoleDir: path.join(os.tmpdir(), `bhava-no-build-${process.pid}`) } });
  try {
    const res = await fetch(`${app.base}/admin/products`);
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /[A-Z]:\\|node_modules|index\.html/);
  } finally {
    app.close();
  }
});

test('unless switched on, /admin stays the old pages', async () => {
  const app = await startApp();
  try {
    const { cookie } = await login(app.base, { phone: OWNER.phone, password: OWNER.password });
    assert.match(await (await fetch(`${app.base}/admin`, { headers: { cookie } })).text(), /Dashboard/);
  } finally {
    app.close();
  }
});
