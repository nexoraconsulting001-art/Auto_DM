// PRD 8.4: site adapters, for sites with no Open Graph or JSON-LD. An adapter is code for every business; our team turns one on
// per business in the Platform Console. The fixture api.example is a site of the kind an adapter reads: a JSON product service
// at /api/products/<id> with a 404, an HTML answer and broken JSON beside it.
//
// The contract names no adapter and no address pattern, so these tests find the adapter that takes api.example by trying every
// registered adapter against the fixture's product addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP3Shop, captureLogs, ogPage, operatorOf, paste, sitePage, useP3World } from './kit.js';

const world = useP3World();

/** Product addresses of the fixture site, in the shapes an adapter could match, for the service's record `key`. */
const addresses = (key) => [`https://api.example/p/${key === '1' ? 'steel-bottle' : key}`, `https://api.example/products/${key}`, `https://api.example/product/${key}`, `https://api.example/p/${key}`];

/** HTML at every one of those addresses that a generic import would happily read: so "from the API, not the HTML" is checkable. */
function plantHtml(key, body) {
  for (const url of addresses(key)) world.sites.page('api.example', new URL(url).pathname, { body });
}

async function adapterNames(operator, shop) {
  return (await operator.must('GET', `/tenants/${shop.tenantId}/site-adapters`)).items;
}

/** Turns every registered adapter on (or off) for one business. */
async function setAdapters(operator, shop, enabled) {
  const items = await adapterNames(operator, shop);
  assert.ok(items.length >= 1, 'No site adapter is registered, so 8.4 can\'t be shown working');
  for (const item of items) await operator.must('PUT', `/tenants/${shop.tenantId}/site-adapters`, { adapter: item.name, enabled });
  return items;
}

/** Pastes each address shape and gives the first result the adapter answered. */
async function viaAdapter(shop, key) {
  const results = [];
  for (const url of addresses(key)) {
    const result = await paste(shop, url);
    results.push({ url, ...result });
    if (result.readFrom === 'adapter' || result.reason === 'adapter_error') return { url, ...result, results };
  }
  return { results, status: 'none' };
}

// ---- K-12 ------------------------------------------------------------------------------------------------------------------

test('K-12: a product link from a site with an adapter is matched, and its data comes from the site\'s API, not its HTML', async () => {
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  await setAdapters(operator, shop, true);
  plantHtml('1', ogPage({ name: 'HTML bottle', price: '1', image: 'https://api.example/img/html.png' }));
  await world.sites.delete('/calls');
  const result = await viaAdapter(shop, '1');
  assert.equal(result.status, 'draft', `No adapter took an api.example product link: ${JSON.stringify(result.results.map((r) => [r.url, r.status, r.readFrom, r.reason]))}`);
  assert.equal(result.readFrom, 'adapter');
  assert.equal(result.draft.name, 'Steel bottle', 'The API\'s title, not the HTML\'s');
  assert.equal(result.draft.pricePaise, 34900);
  assert.equal(result.draft.mrpPaise, 49900);
  assert.equal(result.draft.inStock, true);
  assert.match(result.draft.source, /^adapter:[a-z0-9-]{1,40}$/, 'The draft says which adapter read it');
  const calls = (await world.sites.calls()).filter((c) => c.headers.host?.startsWith('api.example'));
  assert.ok(calls.some((c) => c.path.startsWith('/api/products/')), `The site's API was called: ${calls.map((c) => c.path).join(', ')}`);
  const productId = await shop.saveDraft(result);
  const saved = await shop.getProduct(productId);
  assert.match(saved.source, /^adapter:/);
  assert.equal(saved.pricePaise, 34900);
  const listed = await shop.must('GET', '/import-adapters');
  assert.ok(listed.items.some((a) => a.enabled), 'The owner sees the adapter is on for them');
});

test('K-12: an adapter turned on for one business is off for every other, and only our team can turn it on', async () => {
  const operator = await operatorOf(world);
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const [first] = await setAdapters(operator, a, true);
  assert.ok((await adapterNames(operator, a)).every((x) => x.enabled));
  assert.ok((await adapterNames(operator, b)).every((x) => !x.enabled), 'Another business has no adapter on');
  assert.ok((await b.must('GET', '/import-adapters')).items.every((x) => !x.enabled));
  const support = await operatorOf(world, 'support');
  const refused = await support.send('PUT', `/tenants/${b.tenantId}/site-adapters`, { adapter: first.name, enabled: true });
  assert.equal(refused.status, 403, `A support operator turning an adapter on answered ${refused.status}`);
  for (const [method, path] of [['PUT', '/import-adapters'], ['POST', '/import-adapters'], ['PATCH', '/import-adapters']]) {
    const res = await b.send(method, path, { adapter: first.name, name: first.name, enabled: true });
    assert.ok([404, 405].includes(res.status), `A seller ${method} ${path} answered ${res.status}`);
  }
  for (const adapter of ['no-such-adapter', '../etc', 'A', '']) {
    const res = await operator.send('PUT', `/tenants/${b.tenantId}/site-adapters`, { adapter, enabled: true });
    assert.ok([400, 404].includes(res.status), `Turning on "${adapter}" answered ${res.status}`);
  }
  assert.equal((await operator.send('PUT', '/tenants/999999/site-adapters', { adapter: first.name, enabled: true })).status, 404);
  assert.equal((await b.sql('SELECT count(*)::int AS n FROM site_adapters WHERE tenant_id = $1 AND enabled', [b.tenantId]))[0].n, 0);
});

// ---- K-13 ------------------------------------------------------------------------------------------------------------------

test('K-13: when the adapter\'s API answers 404, HTML or broken JSON the error is shown and logged; there is no draft and no HTML fallback', async (t) => {
  const logs = captureLogs(t);
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  await setAdapters(operator, shop, true);
  const mediaBefore = (await shop.mediaRows()).length;
  for (const key of ['missing', 'html', 'broken']) {
    plantHtml(key, ogPage({ name: `Fallback ${key}`, price: '250', image: 'https://api.example/img/f.png' }));
    const result = await viaAdapter(shop, key);
    assert.notEqual(result.status, 'none', `No adapter took an api.example link for "${key}": ${JSON.stringify(result.results.map((r) => [r.url, r.status, r.readFrom, r.reason]))}`);
    assert.equal(result.status, 'failed', `${key}: ${result.raw.slice(0, 300)}`);
    assert.equal(result.reason, 'adapter_error');
    assert.equal(result.draft, null, `${key}: no draft`);
    assert.ok(!result.raw.includes(`Fallback ${key}`), `${key}: the HTML was read as a fallback`);
    assert.ok(result.message.length > 0, 'The owner is shown the error');
    const rows = await shop.sql(`SELECT status, reason, url FROM import_items WHERE tenant_id = $1 AND url = $2`, [shop.tenantId, result.url]);
    assert.ok(rows.some((r) => r.status === 'failed' && r.reason === 'adapter_error'), `${key}: the failure is recorded against the business and the address: ${JSON.stringify(rows)}`);
  }
  assert.equal((await shop.productRows()).length, 0);
  assert.equal((await shop.mediaRows()).length, mediaBefore);
  const text = logs.text();
  assert.match(text, /adapter/i, 'The error is logged');
  assert.ok(text.includes('api.example'), 'The log names the address');
  assert.ok(new RegExp(`"?tenant(_?[iI]d)?"?\\s*[:=]\\s*"?${shop.tenantId}\\b`).test(text) || text.includes(shop.slug), 'The log names the business');
});

test('K-13: an adapter API that is slow, huge or redirects to a private address fails the same way', async () => {
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  await setAdapters(operator, shop, true);
  const mark = world.dials.length;
  world.sites.page('api.example', '/api/products/private', { redirect: 'http://169.254.169.254/latest/meta-data/' });
  world.sites.page('api.example', '/api/products/huge', { type: 'application/json', body: `{"id":3,"title":"${'a'.repeat(5 * 1024 * 1024)}"}` });
  world.sites.page('api.example', '/api/products/array', { type: 'application/json', body: '[1,2,3]' });
  world.sites.page('api.example', '/api/products/evil', { type: 'application/json', body: JSON.stringify({ id: 4, title: '<script>alert(1)</script>', price: -5, mrp: 'x', url: 'javascript:alert(1)', images: ['file:///etc/passwd'] }) });
  for (const key of ['private', 'huge', 'array', 'evil']) {
    plantHtml(key, sitePage('<title>Nothing</title>'));
    const result = await viaAdapter(shop, key);
    for (const r of result.results) {
      assert.ok(r.http === 200 || r.http === 400, `${key}: ${r.raw.slice(0, 200)}`);
      if (r.status === 'draft') {
        assert.ok((r.draft.pricePaise ?? 0) >= 0, `${key}: a negative price was read`);
        assert.doesNotMatch(JSON.stringify(r.draft.images), /file:|javascript:/, `${key}: an unsafe image address was kept`);
        assert.doesNotMatch(r.draft.externalUrl, /^javascript:/);
      }
    }
  }
  assert.ok(world.dialsSince(mark).every((d) => d.address !== '169.254.169.254'), 'The adapter never connected to the metadata address');
});

// ---- K-14 ------------------------------------------------------------------------------------------------------------------

test('K-14: with the adapter off for the business the link is imported the generic way, and the title-only result is refused', async () => {
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  await setAdapters(operator, shop, false);
  plantHtml('1', sitePage('<title>Steel bottle</title>', '<div id="app"></div>'));
  await world.sites.delete('/calls');
  for (const url of addresses('1')) {
    const result = await paste(shop, url);
    assert.notEqual(result.readFrom, 'adapter', `${url} was read by a disabled adapter`);
    assert.ok(!['draft', 'existing'].includes(result.status), `${url}: ${result.raw.slice(0, 300)}`);
    assert.equal(result.reason, 'title_only', `${url}: refused as ${result.reason}`);
  }
  const calls = (await world.sites.calls()).filter((c) => c.path.startsWith('/api/'));
  assert.deepEqual(calls.map((c) => c.path), [], 'The site\'s API is never called for a business without the adapter');
  assert.equal((await shop.productRows()).length, 0);
});

test('K-14: a business that never had the adapter reads the same page generically too, and gets a draft when the HTML is enough', async () => {
  const shop = await addP3Shop(world);
  plantHtml('1', ogPage({ name: 'Generic bottle', price: '275', image: 'https://api.example/img/1.png' }));
  const result = await paste(shop, addresses('1')[0]);
  assert.equal(result.status, 'draft', result.raw.slice(0, 300));
  assert.equal(result.readFrom, 'open_graph');
  assert.equal(result.draft.name, 'Generic bottle');
  assert.equal(result.draft.pricePaise, 27500);
});
