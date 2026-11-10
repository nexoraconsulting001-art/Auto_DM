// PRD 5.5: the Platform Console's create-a-business form, beyond the scenarios in test/p0/spec-p0/console.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedAddressError } from '../../../src/modules/platform-console/safe-fetch.js';
import { brandFrom, cleanWebsite, productsFrom, websiteKey } from '../../../src/modules/platform-console/site-read.js';
import { CONSOLE_HOST, NEUTRAL, addBusiness, consoleUser, hit, need, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { hooks } from '../../p0/spec-p0/surfaces.js';

const form = (name, website = '', extra = {}) => ({ name, website, igHandle: '@Sample_Handle', ownerName: 'Ravi Kumar', ownerPhone: '9123456780', ownerEmail: 'ravi@seller.example', plan: 't2', cycle: 'yearly', ...extra });

const page = (head) => `<!doctype html><html><head>${head}</head><body>hello</body></html>`;
const product = (name, price = '349', extra = {}) => ({ '@context': 'https://schema.org', '@type': 'Product', name, offers: { '@type': 'Offer', price, priceCurrency: 'INR' }, ...extra });
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const site = (html, status = 200, type = 'text/html') => async () => ({ status, headers: { 'content-type': type }, body: html });
const SITE = 'https://plantstore.example';

async function world(t, fetcher) {
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: fetcher ?? site(page('<title>x</title>')) } });
  const operator = await consoleUser(app);
  const create = (body, who = operator) => onConsole(app, who, '/tenants', { method: 'POST', body });
  const tenantCount = async () => (await app.db.query('SELECT count(*)::int AS n FROM tenants'))[0].n;
  const productsOf = (id) => app.db.query('SELECT name, price_paise, images, stock, active FROM products WHERE tenant_id = $1 ORDER BY name', [id]);
  return { app, operator, create, tenantCount, productsOf };
}

test('a new business starts in onboarding with what the form said, and its owner', async (t) => {
  const { app, create } = await world(t);
  const res = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  assert.equal(res.tenant.status, 'onboarding');
  assert.equal(res.tenant.slug, 'plant-store');
  assert.equal(res.tenant.plan, 't2');

  const [row] = await app.db.query('SELECT website, expected_ig_handle, billing_cycle FROM tenants WHERE id = $1', [res.tenant.id]);
  assert.deepEqual(row, { website: SITE, expected_ig_handle: 'sample_handle', billing_cycle: 'yearly' });
  const [owner] = await app.db.query(`SELECT name, phone, email, role FROM users WHERE tenant_id = $1`, [res.tenant.id]);
  assert.deepEqual(owner, { name: 'Ravi Kumar', phone: '9123456780', email: 'ravi@seller.example', role: 'owner' });
});

test('the audit row says who created it and carries no contact details', async (t) => {
  const { app, operator, create } = await world(t);
  const { tenant } = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  const rows = await app.db.query(`SELECT actor, action, details FROM audit_log WHERE tenant_id = $1`, [tenant.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, `platform:${operator.email}`);
  assert.equal(rows[0].action, 'business.create');
  assert.doesNotMatch(JSON.stringify(rows[0]), /9123456780|ravi@seller/);
});

test('a business with no website is created with nothing to import', async (t) => {
  const { create } = await world(t, () => { throw new Error('must not be called'); });
  const res = need(await create(form('No Site')), 201, 'Create').json();
  assert.equal(res.draftKit, null);
  assert.equal(res.import, null);
});

test('reserved slugs are never handed out, whatever the business is called', async (t) => {
  const { app, create } = await world(t);
  for (const name of ['Admin', 'API', 'www', 'App', 'Bhava', 'Edge']) {
    const { tenant } = need(await create(form(name)), 201, name).json();
    assert.notEqual(tenant.slug, name.toLowerCase(), name);
    assert.match(tenant.slug, new RegExp(`^${name.toLowerCase()}-`), name);
  }
  const res = await hit(app, '/', { host: `admin.${NEUTRAL}` });
  assert.notEqual(res.status, 200, 'the reserved host stays the console\'s');
});

test('names that collide get their own address, and a name with no Latin letters still gets one', async (t) => {
  const { create } = await world(t);
  assert.equal(need(await create(form('Plant Store')), 201, 'First').json().tenant.slug, 'plant-store');
  assert.equal(need(await create(form('Plant-Store')), 201, 'Second').json().tenant.slug, 'plant-store-2');
  assert.match(need(await create(form('मेहता मार्ट')), 201, 'Hindi').json().tenant.slug, /^business/);
});

test('the same website counts as a duplicate however it is written', async (t) => {
  const { create, tenantCount } = await world(t);
  need(await create(form('Plant Store', 'https://www.PlantStore.example/')), 201, 'First');
  const before = await tenantCount();
  for (const same of ['plantstore.example', 'http://plantstore.example', 'https://plantstore.example//', 'www.plantstore.example']) {
    const res = await create(form('Another', same));
    assert.equal(res.status, 409, same);
    assert.match(res.text, /already/);
  }
  assert.equal(await tenantCount(), before);
  need(await create(form('A Section', 'https://plantstore.example/india')), 201, 'A different page is a different website');
});

test('two forms sent together for one website create one business', async (t) => {
  const { create } = await world(t);
  const results = await Promise.all([create(form('One', SITE)), create(form('Two', SITE))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test('bad form details are refused before anything is created or fetched', async (t) => {
  let fetched = 0;
  const { create, tenantCount } = await world(t, async () => { fetched++; return { status: 200, headers: {}, body: '' }; });
  const before = await tenantCount();
  for (const [what, extra] of [
    ['a short name', { name: '' }],
    ['no owner name', { ownerName: ' ' }],
    ['a one-letter owner name', { ownerName: 'R' }],
    ['a bad phone', { ownerPhone: '12345' }],
    ['a bad email', { ownerEmail: 'not-an-email' }],
    ['an Instagram link', { igHandle: 'https://instagram.com/x' }],
    ['an unknown plan', { plan: 't9' }],
    ['an unknown cycle', { cycle: 'weekly' }],
  ]) {
    assert.equal((await create(form('Valid Name', SITE, extra))).status, 400, what);
  }
  assert.equal(await tenantCount(), before);
  assert.equal(fetched, 0);
});

test('addresses that aren\'t public websites are refused before any connection', async (t) => {
  let fetched = 0;
  const { create, tenantCount } = await world(t, async () => { fetched++; return { status: 200, headers: {}, body: '' }; });
  const before = await tenantCount();
  for (const url of ['http://127.0.0.1/admin', 'http://10.0.0.5/', 'http://192.168.0.1', 'http://[::1]/', 'http://[::ffff:169.254.169.254]/', 'http://0x7f.0.0.1/', 'http://2852039166/',
    'ftp://plantstore.example', 'file:///etc/passwd', 'https://user:pw@plantstore.example', 'http://plantstore.example:8080', 'http://localhost/', 'http://printer.local/', 'http://intranet/']) {
    const res = await create(form('Sneaky', url));
    assert.equal(res.status, 400, url);
    assert.match(res.text, /website not reachable/i, url);
  }
  assert.equal(fetched, 0);
  assert.equal(await tenantCount(), before);
});

test('a name that turns out to be a private address is refused too, and leaves nothing', async (t) => {
  const { create, tenantCount } = await world(t, async () => { throw new BlockedAddressError(); });
  const before = await tenantCount();
  const res = await create(form('Rebound', 'https://rebinding.example'));
  assert.equal(res.status, 400);
  assert.match(res.text, /website not reachable/i);
  assert.equal(await tenantCount(), before);
});

test('a fetcher that ignores the stop signal still can\'t hold the form past the limit', async (t) => {
  const app = await startWorld(t, { overrides: { [hooks.siteFetcher]: () => new Promise(() => {}), siteReadTimeoutMs: 50 } });
  const operator = await consoleUser(app);
  const res = need(await onConsole(app, operator, '/tenants', { method: 'POST', body: form('Slow', SITE) }), 201, 'Create').json();
  assert.equal(res.import.canRetry, true);
});

test('a site that errors or isn\'t a page leaves an empty draft and a retry', async (t) => {
  for (const [what, fetcher] of [['a 500', site('oops', 500)], ['a PDF', site('%PDF', 200, 'application/pdf')], ['a thrown error', async () => { throw new Error('reset'); }]]) {
    const { create, productsOf } = await world(t, fetcher);
    const res = need(await create(form('Broken', SITE)), 201, what).json();
    assert.equal(res.draftKit, null, what);
    assert.equal(res.import.canRetry, true, what);
    assert.deepEqual(await productsOf(res.tenant.id), [], what);
  }
});

test('retrying fills the draft, and retrying again adds nothing twice', async (t) => {
  let body = null;
  const { app, operator, create, productsOf } = await world(t, async () => (body ? { status: 200, headers: { 'content-type': 'text/html' }, body } : { status: 503, headers: {}, body: '' }));
  const { tenant } = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  const retry = () => onConsole(app, operator, `/tenants/${tenant.id}/import/retry`, { method: 'POST' });

  need(await retry(), 202, 'Retry while the site is still down');
  const [alert] = await app.db.query(`SELECT message FROM alerts WHERE audience = 'ops' AND kind = 'business.import_failed' AND tenant_id = $1`, [tenant.id]);
  assert.match(alert.message, /Plant Store/);

  body = page(`<meta name="theme-color" content="#2E7D32">${ld([product('Snake Plant'), product('Money Plant', '199')])}`);
  need(await retry(), 202, 'Retry with the site back');
  need(await retry(), 202, 'And again');
  assert.deepEqual((await productsOf(tenant.id)).map((p) => [p.name, p.price_paise, p.active]), [['Money Plant', 19900, false], ['Snake Plant', 34900, false]]);
  const [kit] = await app.db.query('SELECT colors FROM brand_kits WHERE tenant_id = $1', [tenant.id]);
  assert.equal(kit.colors.primary, '#2E7D32');
});

test('a retry never overwrites a kit someone has already saved', async (t) => {
  const { app, operator, create } = await world(t, site(page('<meta name="theme-color" content="#2E7D32">')));
  const { tenant } = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  await app.db.query(`UPDATE brand_kits SET colors = colors || '{"primary":"#123456"}' WHERE tenant_id = $1`, [tenant.id]);
  need(await onConsole(app, operator, `/tenants/${tenant.id}/import/retry`, { method: 'POST' }), 202, 'Retry');
  const [kit] = await app.db.query('SELECT colors FROM brand_kits WHERE tenant_id = $1', [tenant.id]);
  assert.equal(kit.colors.primary, '#123456');
});

test('retrying is refused for a business with no website, and for one that doesn\'t exist', async (t) => {
  const { app, operator, create } = await world(t);
  const { tenant } = need(await create(form('No Site')), 201, 'Create').json();
  assert.equal((await onConsole(app, operator, `/tenants/${tenant.id}/import/retry`, { method: 'POST' })).status, 400);
  assert.equal((await onConsole(app, operator, '/tenants/999999/import/retry', { method: 'POST' })).status, 404);
  assert.equal((await onConsole(app, operator, '/tenants/abc/import/retry', { method: 'POST' })).status, 404);
});

test('the form is open to Bhava\'s team only, and needs its CSRF token', async (t) => {
  const { app, create, operator } = await world(t);
  const support = await consoleUser(app, 'support');
  need(await create(form('By Support'), support), 201, 'Support can onboard');
  assert.equal((await hit(app, '/tenants', { host: CONSOLE_HOST, method: 'POST', body: form('Signed Out') })).status, 401);
  assert.equal((await hit(app, '/tenants', { host: CONSOLE_HOST, method: 'POST', cookie: operator.cookie, body: form('No Token') })).status, 403);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  assert.equal((await hit(app, '/tenants', { host: shop.host, method: 'POST', cookie: operator.cookie, body: form('On A Shop') })).status, 404);
});

test('opening a business for support points at its own address, and needs a real business', async (t) => {
  const { app, operator } = await world(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const open = (id) => onConsole(app, operator, `/tenants/${id}/impersonate`, { method: 'POST', body: { reason: 'ticket 9' } });
  assert.equal(need(await open(shop.tenant.id), 200, 'Open').json().url, `https://kesar-home.${NEUTRAL}/admin`);
  await app.db.query(`INSERT INTO tenant_domains (domain, tenant_id, is_primary) VALUES ('shop.kesarhome.example', $1, true)`, [shop.tenant.id]);
  assert.equal(need(await open(shop.tenant.id), 200, 'Open').json().url, 'https://shop.kesarhome.example/admin');
  assert.equal((await open(999999)).status, 404);
});

// ---- Reading a page ----

const BASE = 'https://shop.example/';

test('the website we keep is canonical, and its key ignores how it was written', () => {
  assert.equal(cleanWebsite('PlantStore.example/India/?utm=1#top'), 'https://plantstore.example/India');
  assert.equal(websiteKey('http://www.plantstore.example/'), websiteKey('https://plantstore.example'));
  assert.notEqual(websiteKey('https://a.example/x'), websiteKey('https://a.example/y'));
  assert.throws(() => cleanWebsite('http://127.0.0.1'), BlockedAddressError);
});

test('the logo comes from the best place the page offers', () => {
  const organisation = ld({ '@type': 'Organization', logo: { url: '/org.png' } });
  const touch = '<link rel="apple-touch-icon" href="/touch.png">';
  const og = '<meta content="https://cdn.example/og.png" property="og:image">';
  const icon = "<link rel='shortcut icon' href='/fav.ico'>";
  assert.equal(brandFrom(page(organisation + touch + og + icon), BASE).logoUrl, 'https://shop.example/org.png');
  assert.equal(brandFrom(page(touch + og + icon), BASE).logoUrl, 'https://shop.example/touch.png');
  assert.equal(brandFrom(page(og + icon), BASE).logoUrl, 'https://cdn.example/og.png');
  assert.equal(brandFrom(page(icon), BASE).logoUrl, 'https://shop.example/fav.ico');
  assert.equal(brandFrom(page('<title>nothing here</title>'), BASE), null);
});

test('the theme colour is checked, and paired with text that reads on it', () => {
  const colors = (value) => brandFrom(page(`<meta name="theme-color" content="${value}">`), BASE)?.colors;
  assert.deepEqual(colors('#2e7d32'), { primary: '#2E7D32', on_primary: '#FFFFFF' });
  assert.deepEqual(colors('#fd0'), { primary: '#FFDD00', on_primary: '#000000' });
  assert.equal(colors('red;}</style><script>alert(1)</script>'), undefined);
  assert.equal(colors('rgb(1,2,3)'), undefined);
});

test('a logo link that isn\'t a web address is ignored', () => {
  assert.equal(brandFrom(page('<link rel="icon" href="javascript:alert(1)">'), BASE), null);
  assert.equal(brandFrom(page('<link rel="icon" href="data:image/png;base64,AAAA">'), BASE), null);
});

test('products come from JSON-LD in every shape sites write it', () => {
  const graph = ld({ '@graph': [product('In Graph'), { '@type': 'WebSite', name: 'Not a product' }] });
  const group = ld({ '@type': 'ProductGroup', name: 'With Variants', hasVariant: [{ '@type': 'Product', offers: { price: '1,299.00', priceCurrency: 'INR' } }] });
  const aggregate = ld(product('Aggregate', undefined, { offers: { '@type': 'AggregateOffer', lowPrice: 99, priceCurrency: 'INR' } }));
  const typed = ld({ ...product('Many Types'), '@type': ['Thing', 'Product'] });
  const found = productsFrom(page(graph + group + aggregate + typed), BASE);
  assert.deepEqual(found.map((p) => [p.name, p.price]), [['In Graph', '349'], ['With Variants', '1,299.00'], ['Aggregate', '99'], ['Many Types', '349']]);
});

test('product images are made absolute, availability is honoured, and text is plain', () => {
  const [p] = productsFrom(page(ld(product('<b>Bold</b>  Name', '10', {
    description: '<em>x</em>Nice   pot',
    image: ['/a.jpg', { url: 'https://cdn.example/b.jpg' }, 'javascript:alert(1)'],
    offers: { price: '10', availability: 'https://schema.org/OutOfStock' },
  }))), BASE);
  assert.equal(p.name, 'Bold Name');
  assert.equal(p.description, 'x Nice pot');
  assert.deepEqual(p.images, ['https://shop.example/a.jpg', 'https://cdn.example/b.jpg']);
  assert.equal(p.stock, '0');
});

test('what can\'t be sold honestly is left out', () => {
  const found = productsFrom(page(`<script type="application/ld+json">{not json</script>${ld([
    product('Keep'), product('Keep'), product('X'), product('In Dollars', '5', { offers: { price: '5', priceCurrency: 'USD' } }), { '@type': 'Product', name: 'No Offer' },
  ])}`), BASE);
  assert.deepEqual(found.map((p) => p.name), ['Keep']);
});

test('a price the store can\'t read loses that product, not the import', async (t) => {
  const { create, productsOf } = await world(t, site(page(ld([product('Good'), product('Bad Price', 'call us')]))));
  const res = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  assert.deepEqual((await productsOf(res.tenant.id)).map((p) => p.name), ['Good']);
  assert.equal(res.import.adapter, 'json-ld');
  assert.equal(res.import.canRetry, false);
});

test('pages built to be slow to read are read quickly', () => {
  const MB2 = 2_000_000;
  const flood = (unit) => unit.repeat(Math.floor(MB2 / unit.length));
  const hostile = [
    flood('<script type="application/ld+json">'),
    `<script type="application/ld+json">${'['.repeat(100_000)}</script>`,
    flood('<meta '),
    flood('<link rel='),
    `<meta ${'a'.repeat(MB2)}>`,
    flood('<meta a="b >'),
    `<script type="application/ld+json">${JSON.stringify(product('Pot', '1', { description: '<'.repeat(MB2 / 2) }))}</script>`,
  ];
  for (const html of hostile) {
    const started = Date.now();
    productsFrom(html, BASE);
    brandFrom(html, BASE);
    const took = Date.now() - started;
    assert.ok(took < 2000, `${html.slice(0, 30)} took ${took} ms`);
  }
});

test('letters that change length when lowered don\'t throw the reading off', () => {
  const [p] = productsFrom(page(`<title>${'\u0130'.repeat(50)}</title>${ld(product('Pot'))}`), BASE);
  assert.equal(p.name, 'Pot');
});

test('a NUL byte or an absurd price on a site costs that product and not the business', async (t) => {
  const { create, productsOf } = await world(t, site(page(ld([product('Good'), product('Too Dear', '99999999999'), product('Nul\u0000Name', '5')]))));
  const res = need(await create(form('Plant Store', SITE)), 201, 'Create').json();
  assert.deepEqual((await productsOf(res.tenant.id)).map((p) => p.name), ['Good', 'NulName']);
});
