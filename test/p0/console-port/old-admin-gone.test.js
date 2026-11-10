// The server-rendered admin is deleted, and /admin is the React console whatever ADMIN_UI says.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { login, startApp } from '../../helpers.js';
import { repoRoot } from '../backend-gaps/support.js';
import { at } from '../backend-gaps/support.js';
import { baseUrlFor, tenantBaseUrl } from '../../../src/routes/admin.js';
import { SHELL, removeBuild, standInBuild } from './support/build.js';

const builds = [];
after(() => builds.forEach(removeBuild));
function build() {
  const dir = standInBuild();
  builds.push(dir);
  return dir;
}

const OLD_POSTS = [
  ['/admin/settings', 'store_name=Hijacked'],
  ['/admin/products', 'name=Hijacked&price=1&active=on'],
  ['/admin/products/1', 'name=Hijacked&price=1'],
  ['/admin/products/1/delete', ''],
  ['/admin/categories', 'name=Hijacked'],
  ['/admin/categories/1', 'name=Hijacked'],
  ['/admin/categories/1/delete', ''],
  ['/admin/reels/1', 'keywords=LINK'],
  ['/admin/reels/1/delete', ''],
  ['/admin/orders/1/status', 'status=cancelled'],
  ['/admin/customers/1/reset', ''],
  ['/admin/checklist/dismiss', ''],
  ['/admin/demo-data', ''],
  ['/admin/media', ''],
];

test('the old admin\'s files are gone from the repo', () => {
  for (const file of ['src/views/admin.js', 'public/admin.js', 'public/admin.css']) {
    assert.equal(fs.existsSync(path.join(repoRoot, file)), false, file);
  }
  const routes = fs.readFileSync(path.join(repoRoot, 'src/routes/admin.js'), 'utf8');
  assert.doesNotMatch(routes, /views\/admin|r\.(get|post)\(/, 'no page handlers are left');
});

for (const adminUi of ['legacy', 'console']) {
  test(`with ADMIN_UI=${adminUi}, /admin and its deep links are the console's page`, async () => {
    const app = await startApp({ overrides: { adminUi, consoleDir: build() } });
    try {
      for (const url of ['/admin', '/admin/products', '/admin/products/new', '/admin/orders/12', '/admin/settings', '/admin/brand-kit']) {
        const res = await fetch(`${app.base}${url}`, { redirect: 'manual' });
        assert.equal(res.status, 200, url);
        assert.equal(await res.text(), SHELL, url);
        assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, url);
      }
    } finally {
      app.close();
    }
  });

  test(`with ADMIN_UI=${adminUi}, nothing can be changed through the old form addresses`, async () => {
    const app = await startApp({ overrides: { adminUi, consoleDir: build() } });
    try {
      const product = await app.repos.products.create({ name: 'Keep me', price: '199', active: 'on' });
      const { cookie, csrf } = await login(app.base);
      for (const [url, body] of OLD_POSTS) {
        const res = await fetch(`${app.base}${url.replace('/1', `/${product.id}`)}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
        assert.equal(res.status, 404, url);
      }
      assert.equal((await app.repos.settings.getAll()).store_name, 'My store');
      assert.equal((await app.repos.products.get(product.id)).name, 'Keep me');
    } finally {
      app.close();
    }
  });
}

test('the page itself holds nothing of the business, and needs no sign-in to load', async () => {
  const app = await startApp({ overrides: { consoleDir: build() } });
  try {
    await app.repos.products.create({ name: 'SECRET Pot', price: '199', active: 'on' });
    const res = await fetch(`${app.base}/admin/products`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /SECRET/);
  } finally {
    app.close();
  }
});

test('the console is served on each business\'s own address and nowhere else', async () => {
  const app = await startApp({ overrides: { consoleDir: build(), defaultTenant: '' } });
  try {
    await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
    assert.equal(await (await fetch(`${app.base}/admin`, { headers: at('leaf.bhava.test') })).text(), SHELL);
    assert.equal((await fetch(`${app.base}/admin`, { headers: at('nobody.example') })).status, 404);
  } finally {
    app.close();
  }
});

test('store links into the admin still have a console page to land on', async () => {
  const views = fs.readFileSync(path.join(repoRoot, 'src/views/store.js'), 'utf8');
  const linked = [...views.matchAll(/\/admin(\/[a-z-]+)?/g)].map((m) => m[1] ?? '').filter(Boolean);
  assert.ok(linked.length > 3, 'the storefront still links to the admin');
  const features = fs.readdirSync(path.join(repoRoot, 'console/src/features'));
  for (const link of new Set(linked)) assert.ok(features.includes(link.slice(1)), `${link} has a console feature`);
});

test('the address helpers the server and webhooks need are still here', () => {
  const config = { publicBaseUrl: 'https://shop.test', defaultTenant: 'default', platformDomain: 'bhava.test' };
  assert.equal(tenantBaseUrl({ slug: 'default' }, config), 'https://shop.test');
  assert.equal(tenantBaseUrl({ slug: 'leaf' }, config), 'https://leaf.bhava.test');
  const req = { protocol: 'https', get: (name) => (name === 'host' ? 'leaf.bhava.test' : undefined) };
  assert.equal(baseUrlFor(req, { publicBaseUrl: '', defaultTenant: '' }), 'https://leaf.bhava.test');
});
