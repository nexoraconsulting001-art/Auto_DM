// PRD 5.5: the Platform Console creates a business from one form. Websites are never really fetched here:
// F-21, F-22 and F-24 hand the app a stand-in fetcher, and F-23 must be refused before anything connects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, need, onConsole, signInCookie, startWorld } from './support.js';
import { consolePaths, hooks } from './surfaces.js';

const form = (name, website) => ({
  name,
  website,
  igHandle: 'sample_handle',
  tier: 't2',
  ownerName: 'Ravi Kumar',
  ownerPhone: '9123456780',
  ownerEmail: 'ravi@seller.example',
  plan: 't2',
  cycle: 'monthly',
});

const PRIMARY_ON_SITE = '#2E7D32';
const LOGO_ON_SITE = 'https://plantstore.example/assets/logo.png';
const PLANT_SITE = `<!doctype html><html><head>
  <title>Plant Store</title>
  <meta name="theme-color" content="${PRIMARY_ON_SITE}">
  <link rel="icon" href="${LOGO_ON_SITE}">
  <meta property="og:image" content="${LOGO_ON_SITE}">
  <script type="application/ld+json">${JSON.stringify([
    { '@context': 'https://schema.org', '@type': 'Product', name: 'Snake Plant', image: 'https://plantstore.example/p/1.jpg', offers: { '@type': 'Offer', price: '349', priceCurrency: 'INR' } },
    { '@context': 'https://schema.org', '@type': 'Product', name: 'Money Plant', image: 'https://plantstore.example/p/2.jpg', offers: { '@type': 'Offer', price: '199', priceCurrency: 'INR' } },
  ])}</script>
</head><body><h1>Plant Store</h1></body></html>`;

const staticSite = (html) => async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });

test('F-21: creating a business from its website gives a draft kit in its colours and logo, and draft products', async (t) => {
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: staticSite(PLANT_SITE) } });
  const operator = await consoleUser(app);
  const res = need(await onConsole(app, operator, consolePaths.createBusiness, { method: 'POST', body: form('Plant Store', 'https://plantstore.example') }), 201, 'Create a business').json();
  const tenantId = res.tenant.id;

  const draft = res.draftKit;
  assert.equal(draft.colors.primary.toUpperCase(), PRIMARY_ON_SITE);
  assert.equal(draft.logoUrl, LOGO_ON_SITE);

  const products = await app.db.query('SELECT name, active FROM products WHERE tenant_id = $1 ORDER BY name', [tenantId]);
  assert.deepEqual(products.map((p) => p.name), ['Money Plant', 'Snake Plant']);
  assert.ok(products.every((p) => p.active === false), 'imported products wait as drafts');
  const owners = await app.db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND role = 'owner'`, [tenantId]);
  assert.equal(owners.length, 1);
});

test('F-21: a website another business already uses warns before anything is created', async (t) => {
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: staticSite(PLANT_SITE) } });
  const operator = await consoleUser(app);
  const submit = (body) => onConsole(app, operator, consolePaths.createBusiness, { method: 'POST', body });
  need(await submit(form('Plant Store', 'https://plantstore.example')), 201, 'First business');
  const before = (await app.db.query('SELECT count(*)::int AS n FROM tenants'))[0].n;
  const second = await submit(form('Plant Store Two', 'https://plantstore.example/'));
  assert.equal(second.status, 409);
  assert.match(second.text, /already/i);
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM tenants'))[0].n, before, 'nothing new was created');
});

test('F-22: the sample business imports through its confirmed site adapter', async (t) => {
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: staticSite('<!doctype html><title>Mehta Mart</title>') } });
  const operator = await consoleUser(app);
  const res = need(await onConsole(app, operator, consolePaths.createBusiness, { method: 'POST', body: form('Mehta Mart', 'https://mehtamartmhm.example') }), 201, 'Create the sample business').json();
  assert.ok(res.import.adapter, 'the import names the adapter it used');
  assert.notEqual(res.import.adapter, 'generic');
  const [{ n }] = await app.db.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND active = false', [res.tenant.id]);
  assert.ok(n > 0, 'products arrived as drafts');
});

test('F-23: a website at the cloud metadata address is blocked and the form says it is not reachable', async (t) => {
  const app = await startWorld(t);
  const operator = await consoleUser(app);
  const res = await onConsole(app, operator, consolePaths.createBusiness, { method: 'POST', body: form('Sneaky', 'http://169.254.169.254/latest/meta-data/') });
  need(res, [400, 422], 'Create a business with a metadata address');
  assert.match(res.text, /website not reachable/i);
  assert.deepEqual(await app.db.query(`SELECT 1 FROM tenants WHERE name = 'Sneaky' AND status <> 'onboarding'`), [], 'no live business exists');
});

test('F-24: a website that hangs times out at 8 s and leaves an empty draft and a retry', async (t) => {
  const hang = (_url, { signal } = {}) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: hang } });
  const operator = await consoleUser(app);
  const started = Date.now();
  const res = need(await onConsole(app, operator, consolePaths.createBusiness, { method: 'POST', body: form('Slow Site', 'https://slow.example') }), 201, 'Create a business with a slow website').json();
  const took = Date.now() - started;
  assert.ok(took >= 7500 && took < 15_000, `took ${took} ms`);
  const [{ n }] = await app.db.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [res.tenant.id]);
  assert.equal(n, 0, 'the draft is empty');
  assert.ok(res.import.canRetry, 'the console offers a retry');
  need(await onConsole(app, operator, consolePaths.retryImport(res.tenant.id), { method: 'POST' }), [200, 201, 202], 'Retry the import');
});

test('F-25: owner credentials are rejected on the console host', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  await consoleUser(app); // positive control: a platform user does get in

  for (const body of [{ email: shop.owner.phone, password: shop.owner.password }, { phone: shop.owner.phone, password: shop.owner.password }]) {
    const res = await hit(app, '/login', { host: CONSOLE_HOST, method: 'POST', body });
    assert.equal(res.status, 401);
  }
  const cookie = await signInCookie(app, shop);
  assert.equal((await hit(app, '/me', { host: CONSOLE_HOST, cookie })).status, 401, 'a business session means nothing on the console');
});

test('F-25: a failed console sign-in says nothing about any business', async (t) => {
  const app = await startWorld(t);
  await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const res = await hit(app, '/login', { host: CONSOLE_HOST, method: 'POST', body: { email: 'nobody@team.example', password: 'wrong' } });
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.text, /Kesar Home/);
});
