// Site adapters (PRD 8.4): code every business shares, switched on per business by our team. Tested with an adapter for the
// simulator's api.example, registered through config, since no real adapter is built until its site is confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE_HOST } from '../../p0/spec-p0/support.js';
import { captureLogs, hit, openWorld } from './support.js';

/** Reads api.example's product service: /p/<slug> is the product page, /api/products/<id> its data. */
const apiSite = {
  name: 'api-site',
  label: 'API site',
  match: (url) => /^https:\/\/api\.example\/p\/[\w-]+$/.test(url),
  async fetchProduct(url, { fetcher }) {
    const slug = new URL(url).pathname.split('/').pop();
    const id = slug === 'steel-bottle' ? '1' : slug;
    return (await fetcher.json(`https://api.example/api/products/${id}`)).data;
  },
};
const PAGE = 'https://api.example/p/steel-bottle';

async function consoleFor(world, role) {
  const email = `${role}@ops.example`;
  await world.app.platform.platformUsers.create({ email, password: 'platform-pass', role });
  const login = await hit(world.app, '/login', { host: CONSOLE_HOST, method: 'POST', body: { email, password: 'platform-pass' } });
  assert.equal(login.status, 200, 'console sign-in');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const { csrf } = login.json();
  return (method, path, body) => hit(world.app, path, { host: CONSOLE_HOST, method, cookie, headers: { 'x-csrf-token': csrf }, ...(body ? { body } : {}) });
}

const enable = (shop, enabled = true) => shop.sql(
  `INSERT INTO site_adapters (tenant_id, adapter, enabled) VALUES ($1, 'api-site', $2) ON CONFLICT (tenant_id, adapter) DO UPDATE SET enabled = EXCLUDED.enabled`,
  [shop.tenantId, enabled],
);

test('our team switches an adapter on for one business, and only that business has it', async (t) => {
  const world = await openWorld(t, { adapters: [apiSite] });
  const [shop, other] = [await world.addShop(), await world.addShop()];
  const admin = await consoleFor(world, 'super_admin');
  const support = await consoleFor(world, 'support');
  const path = `/tenants/${shop.tenantId}/site-adapters`;

  assert.deepEqual((await admin('GET', path)).json(), { items: [{ name: 'api-site', label: 'API site', enabled: false }] });
  assert.deepEqual((await shop.json('/import-adapters')).items, [], 'a business sees only the adapters it may use');
  assert.equal((await support('PUT', path, { adapter: 'api-site', enabled: true })).status, 403, 'support can look, not switch');
  assert.equal((await admin('PUT', path, { adapter: 'no-such', enabled: true })).status, 400);
  assert.equal((await admin('PUT', path, { adapter: 'Bad Name!', enabled: true })).status, 400);
  assert.equal((await admin('PUT', '/tenants/999999/site-adapters', { adapter: 'api-site', enabled: true })).status, 404);
  assert.equal((await hit(world.app, path, { host: CONSOLE_HOST })).status, 401, 'no sign-in, no answer');
  assert.notEqual((await shop.call(path)).status, 200, 'a seller can’t reach the console’s route');

  const on = await admin('PUT', path, { adapter: 'api-site', enabled: true });
  assert.deepEqual(on.json(), { items: [{ name: 'api-site', label: 'API site', enabled: true }] });
  assert.deepEqual((await shop.json('/import-adapters')).items, [{ name: 'api-site', label: 'API site', enabled: true }]);
  assert.deepEqual((await other.json('/import-adapters')).items, [], 'F-96: switched on for one business, it appears for no other');
  assert.deepEqual((await admin('GET', `/tenants/${other.tenantId}/site-adapters`)).json().items.map((a) => a.enabled), [false]);
  const audit = await shop.sql(`SELECT actor, action, target FROM audit_log WHERE tenant_id = $1 AND action LIKE 'site_adapter.%'`, [shop.tenantId]);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].target], ['site_adapter.enabled', 'adapter:api-site']);

  assert.deepEqual((await admin('PUT', path, { adapter: 'api-site', enabled: false })).json().items.map((a) => a.enabled), [false]);
  assert.deepEqual((await shop.json('/import-adapters')).items, []);
});

test('K-12: with the adapter on, a product link is read from the site’s own service, not its HTML', async (t) => {
  const world = await openWorld(t, { adapters: [apiSite] });
  const shop = await world.addShop();
  await enable(shop);
  const result = await shop.post('/imports/link', { url: `${PAGE}?utm_source=ig` }, 200);
  assert.deepEqual([result.status, result.readFrom, result.reason], ['draft', 'adapter', null]);
  assert.deepEqual([result.draft.name, result.draft.pricePaise, result.draft.mrpPaise, result.draft.inStock, result.draft.source, result.draft.externalUrl], ['Steel bottle', 34900, 49900, true, 'adapter:api-site', PAGE]);
  const asked = (await world.sites.get('/calls')).calls.map((c) => c.path);
  assert.deepEqual(asked, ['/api/products/1'], 'only the service was asked');

  const saved = await shop.post(`/import-items/${result.itemId}/save`, { name: 'Steel bottle', pricePaise: 34900 });
  const product = await shop.json(`/products/${saved.productId}`);
  assert.deepEqual([product.source, product.sourceRef, product.fetchStatus, product.priceManual], ['adapter:api-site', '1', 'ok', false]);
  assert.deepEqual((await shop.products('source=adapter')).map((p) => p.id), [product.id]);
});

test('K-13: when the adapter’s service answers 404, HTML or broken JSON, the error is shown and logged, with no draft and no fallback', async (t) => {
  const logs = captureLogs(t);
  const world = await openWorld(t, { adapters: [apiSite] });
  const shop = await world.addShop();
  await enable(shop);
  for (const slug of ['missing', 'html', 'broken']) {
    world.sites.page('api.example', `/p/${slug}`, { body: `<!doctype html><title>${slug} page</title><meta property="og:title" content="Fallback ${slug}"><meta property="product:price:amount" content="10">` });
    const result = await shop.post('/imports/link', { url: `https://api.example/p/${slug}` }, 200);
    assert.deepEqual([result.status, result.reason, result.draft, result.itemId], ['failed', 'adapter_error', null, null], slug);
    assert.equal(result.message, 'That site’s product service didn’t answer properly.');
  }
  const asked = (await world.sites.get('/calls')).calls.map((c) => c.path);
  assert.deepEqual(asked, ['/api/products/missing', '/api/products/html', '/api/products/broken'], 'the product pages were never read');
  const lines = logs.text().split('\n').filter((l) => l.includes('imports.adapter_failed')).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => [l.tenantId, l.adapter, l.url]), ['missing', 'html', 'broken'].map((slug) => [shop.tenantId, 'api-site', `https://api.example/p/${slug}`]), 'logged with the business and the address');

  const job = await shop.importAndRun('/imports/bulk', { urls: ['https://api.example/p/broken', PAGE] });
  assert.deepEqual((await shop.items(job.id)).map((i) => [i.status, i.reason, i.readFrom]), [['failed', 'adapter_error', ''], ['created', null, 'adapter']], 'in a bulk paste the failure is reported and the next link still imports');
  assert.deepEqual(await shop.products().then((list) => list.map((p) => p.name)), ['Steel bottle']);
});

test('K-14: with the adapter off for the business, the import is the generic one, and the gate refuses its title-only result', async (t) => {
  const world = await openWorld(t, { adapters: [apiSite] });
  const [shop, other] = [await world.addShop(), await world.addShop()];
  await enable(other);
  await enable(shop, false);
  world.sites.page('api.example', '/p/steel-bottle', { body: '<!doctype html><title>Steel bottle</title><p>Loading…</p>' });
  const result = await shop.post('/imports/link', { url: PAGE }, 200);
  assert.deepEqual([result.status, result.reason, result.readFrom], ['refused', 'title_only', 'title']);
  assert.equal((await world.sites.get('/calls')).calls.some((c) => c.path.startsWith('/api/')), false, 'the service is not asked for a business without the adapter');
  assert.equal((await other.post('/imports/link', { url: PAGE }, 200)).readFrom, 'adapter', 'the business that has it still uses it');
});
