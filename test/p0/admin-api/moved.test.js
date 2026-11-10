// baseUrlFor, tenantBaseUrl and setupChecklist moved here from src/routes/admin.js and must behave as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupChecks } from '../../../src/modules/admin-api/setup.js';
import { baseUrlFor, reelStoreUrl, storeBaseUrl, tenantBaseUrl } from '../../../src/modules/admin-api/urls.js';
import * as adminRoutes from '../../../src/routes/admin.js';
import { SETTING_DEFAULTS } from '../../../src/repos/settings.js';
import { withTenant } from '../../../src/tenancy.js';
import { OWNER, login, startApp } from '../../helpers.js';
import { withApp } from './support.js';

const request = (host, forwarded) => ({ protocol: 'https', get: (name) => ({ host, 'x-forwarded-host': forwarded })[name] });
const inTenant = (slug, fn) => withTenant({ id: 1, slug }, fn);

test('the old module still hands out the same functions, so src/server.js keeps working', () => {
  assert.equal(adminRoutes.baseUrlFor, baseUrlFor);
  assert.equal(adminRoutes.tenantBaseUrl, tenantBaseUrl);
});

test('tenantBaseUrl: the default business uses PUBLIC_BASE_URL, others their own subdomain', () => {
  const config = { defaultTenant: 'main', publicBaseUrl: 'https://shop.test', platformDomain: 'bhava.test' };
  assert.equal(tenantBaseUrl({ slug: 'main' }, config), 'https://shop.test');
  assert.equal(tenantBaseUrl({ slug: 'leaf' }, config), 'https://leaf.bhava.test');
  assert.equal(tenantBaseUrl({ slug: 'leaf' }, { ...config, platformDomain: '' }), 'https://shop.test');
  assert.equal(tenantBaseUrl({ slug: 'main' }, { ...config, publicBaseUrl: '' }), 'https://main.bhava.test');
});

test('baseUrlFor: PUBLIC_BASE_URL for the default business only, otherwise the request\'s address', () => {
  const config = { defaultTenant: 'main', publicBaseUrl: 'https://shop.test' };
  assert.equal(inTenant('main', () => baseUrlFor(request('a.example'), config)), 'https://shop.test');
  assert.equal(inTenant('leaf', () => baseUrlFor(request('leaf.example'), config)), 'https://leaf.example');
  assert.equal(inTenant('leaf', () => baseUrlFor(request('leaf.example', 'front.example'), config)), 'https://front.example');
  assert.equal(inTenant('leaf', () => baseUrlFor(request('leaf.example'), { ...config, defaultTenant: '' })), 'https://shop.test');
  assert.equal(baseUrlFor(request('a.example'), config), 'https://shop.test');
});

test('storeBaseUrl picks the address the webhook puts in DMs, and the request only as a last resort', () => {
  const config = { defaultTenant: 'main', publicBaseUrl: '', platformDomain: 'bhava.test' };
  assert.equal(inTenant('leaf', () => storeBaseUrl(request('other.example'), config)), 'https://leaf.bhava.test');
  assert.equal(inTenant('leaf', () => storeBaseUrl(request('leaf.example'), { ...config, platformDomain: '' })), 'https://leaf.example');
  assert.equal(reelStoreUrl('https://leaf.example', 'a b'), 'https://leaf.example/r/a%20b?src=dm');
});

test('the checklist has the six steps the dashboard shows, with what the old page needs', async () => {
  const setup = createSetupChecks({ repos: { activity: { count: async () => 0 }, igAccounts: { current: async () => null } }, ig: {} });
  const checklist = await withTenant({ id: 1 }, () => setup.setupChecklist({ ...SETTING_DEFAULTS, checklist_dismissed: '1' }, { logoUrl: '' }, { products: 0, orders: 0 }, [], null));
  assert.equal(checklist.dismissed, true);
  assert.equal(checklist.steps.length, 6);
  for (const step of checklist.steps) {
    for (const field of ['key', 'title', 'text', 'href', 'action']) assert.ok(step[field], field);
    assert.equal(step.done, false);
  }
  assert.deepEqual(checklist.steps.map((s) => s.title), ['Connect Instagram', 'Add your store details', 'Add products', 'Set up your first reel store', 'Receive a comment', 'Get your first order']);
});

test('the old server-rendered dashboard still shows the checklist and settings', async () => {
  const app = await startApp();
  try {
    const { cookie } = await login(app.base, { ...OWNER, csrfPage: '/admin' });
    const dashboard = await (await fetch(`${app.base}/admin`, { headers: { cookie } })).text();
    assert.match(dashboard, /Set up your store/);
    assert.match(dashboard, /Connect Instagram/);
    assert.equal((await fetch(`${app.base}/admin/settings`, { headers: { cookie } })).status, 200);
  } finally {
    app.close();
  }
});

test('with admin-api on, the server-rendered pages keep working alongside it', withApp(async ({ base }) => {
  const { cookie } = await login(base, { ...OWNER, csrfPage: '/admin' });
  assert.equal((await fetch(`${base}/admin/reels`, { headers: { cookie } })).status, 200);
}));
