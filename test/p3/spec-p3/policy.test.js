// PRD 5.18: one structure for every business. What differs between two businesses is data only: the brand kit, settings, the
// block layout, entitlements and feature flags. Nothing a seller can save puts their own HTML, CSS or script on a buyer page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUYER_BLOCKS, DEFAULT_BLOCKS, addP3Shop, assertBranded404, assertNoLiveMarkup, cssOf, formOf, leadFormOn, need, noPlatformName, operatorOf, setFeature,
  setTier, skeletonOf, submitLead, useP3World,
} from './kit.js';
import { checkFolders, checkSource } from '../../../tools/policy-check.mjs';

const world = useP3World();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const blocks = (shop, surface = 'landing') => shop.must('GET', `/page-blocks?surface=${surface}`);
const saveBlocks = (shop, names, surface = 'landing') => shop.must('PUT', '/page-blocks', { surface, blocks: names.map((b) => (typeof b === 'string' ? { block: b } : b)) }, 200, 'Saving the layout');

/** Where each block starts in the page, by the marks the one shared layout gives it. */
function order(html) {
  const marks = { hero: /<section class="hero"/, ticker: /<div class="ticker"/, products: /<article class="card/, trust: /<section class="trust"/ };
  return Object.entries(marks).map(([name, re]) => [name, html.search(re)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

/** A business with a landing page. Made on tier 3, then moved to `plan`, so the page exists whatever the plan lets a seller create. */
async function shopWithPage({ plan } = {}) {
  const shop = await addP3Shop(world);
  const products = [await shop.product({ name: 'Block product one', pricePaise: 19900 }), await shop.product({ name: 'Block product two', pricePaise: 29900 })];
  const landing = await shop.page({ productIds: products.map((p) => p.id).slice(0, plan === 't1' ? 1 : 2), headline: 'Same structure' });
  if (plan) await setTier(world, shop, plan);
  return { shop, landing, html: async () => need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text };
}

// ---- F-96 ------------------------------------------------------------------------------------------------------------------

test('F-96: a feature switched on for one business appears for that business and for no other', async () => {
  const on = await shopWithPage({ plan: 't1' });
  const off = await shopWithPage({ plan: 't1' });
  for (const { shop } of [on, off]) assert.equal((await shop.must('GET', '/lead-forms')).available, false, 'Tier 1 has no lead form to begin with');
  await setFeature(on.shop, 'lead_form', true);
  assert.equal((await on.shop.must('GET', '/lead-forms')).available, true, 'The business it was switched on for has it');
  assert.equal((await off.shop.must('GET', '/lead-forms')).available, false, 'The other business does not');
  await leadFormOn(on.shop, 'landing');
  assert.ok(formOf(await on.html()), 'The form shows on its page');
  assert.equal(formOf(await off.html()), null, 'No form on the other business\'s page');
  const refused = await off.shop.send('PATCH', '/lead-forms', { surface: 'landing', enabled: true });
  assert.ok([403, 404].includes(refused.status), `The other business turning the form on answered ${refused.status}`);
  const sent = await submitLead(world, on.shop, `/r/${on.landing.slug}`, { firstName: 'Asha', phone: '9876543210' });
  assert.ok(sent.landed.status < 400, `The lead was taken: ${sent.landed.status}`);
  assert.equal((await on.shop.leadRows()).length, 1);
  assert.equal((await off.shop.leadRows()).length, 0);

  await setFeature(on.shop, 'lead_form', false);
  assert.equal((await on.shop.must('GET', '/lead-forms')).available, false, 'Switched off again, it is gone');
  assert.equal(formOf(await on.html()), null);
});

test('F-96: a switch is one business\'s row: it can\'t be set for another through any seller route, and a plan change doesn\'t copy it', async () => {
  const a = await addP3Shop(world, { plan: 't1' });
  const b = await addP3Shop(world, { plan: 't1' });
  await setFeature(a, 'whatsapp_order', true);
  await a.whatsapp('+91 93200 01717');
  await b.whatsapp('+91 93200 01718');
  assert.equal((await a.must('GET', '/page-settings')).whatsappAvailable, true);
  assert.equal((await b.must('GET', '/page-settings')).whatsappAvailable, false, 'Tier 1 without the switch has no WhatsApp order button');
  for (const [method, route] of [['PUT', '/features'], ['POST', '/features'], ['PATCH', '/settings/features'], ['PUT', '/tenant-features'], ['PATCH', '/plan']]) {
    const res = await b.send(method, route, { feature: 'whatsapp_order', enabled: true, plan: 't5' });
    assert.ok([404, 405].includes(res.status), `A seller ${method} ${route} answered ${res.status}`);
  }
  const sneaky = await b.send('PATCH', '/page-settings', { whatsappOrder: true, whatsappAvailable: true, features: ['whatsapp_order'] });
  assert.ok(sneaky.status < 500);
  assert.equal((await b.must('GET', '/page-settings')).whatsappAvailable, false);
  assert.equal((await b.sql('SELECT count(*)::int AS n FROM tenant_features WHERE tenant_id = $1', [b.tenantId]))[0].n, 0);
  await setTier(world, b, 't2');
  assert.equal((await b.must('GET', '/page-settings')).whatsappAvailable, true, 'On tier 2 the plan includes it');
});

// ---- F-97 ------------------------------------------------------------------------------------------------------------------

test('F-97: a check on a specific business id or name fails the policy check, and the product code has none', () => {
  const offenders = [
    "if (tenant.slug === 'mehtamart') return special();",
    'if (tenantId() === 3) discount = 10;',
    "const vip = business.name == 'Plant Store';",
    "if ('green-leaf' === req.tenant.slug) {}",
    "if (['a-shop', 'b-shop'].includes(tenant.slug)) {}",
    "db.query('SELECT * FROM products WHERE tenant_id = 7')",
  ];
  for (const line of offenders) assert.ok(checkSource(line, 'src/modules/pages/x.js').length >= 1, `Not caught: ${line}`);
  for (const line of ['if (tenant.id === row.tenant_id) ok();', 'WHERE tenant_id = $1 AND id = $2', "if (plan === 't1') limit = 1;"]) assert.deepEqual(checkSource(line, 'src/x.js'), [], `Wrongly caught: ${line}`);
  assert.deepEqual(checkFolders(), [], 'No product code treats one business differently');
});

test('F-97: the policy check runs in CI and in the suite, so a build that fails it is not merged', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['policy-check'] ?? '', /policy-check/);
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /policy-check/, 'CI runs the policy check on every build');
  assert.ok(fs.existsSync(path.join(repoRoot, 'test/p3/contract/policy.test.js')), 'And the test suite the gate runs checks the product code too');
  const names = ['mehta', 'offerwalebaba', 'plantstore', 'plant store'];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : /\.(js|mjs|jsx|ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const hits = [];
  for (const file of walk(path.join(repoRoot, 'src')).filter((f) => !f.includes(`${path.sep}migrations${path.sep}`))) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const name of names) if (code.toLowerCase().includes(name)) hits.push(`${path.relative(repoRoot, file)}: ${name}`);
  }
  assert.deepEqual(hits, [], 'Product code names a particular client');
});

// ---- F-98 ------------------------------------------------------------------------------------------------------------------

test('F-98: two businesses with the same blocks in different orders each see their own order', async () => {
  const a = await shopWithPage();
  const b = await shopWithPage();
  const c = await shopWithPage();
  await saveBlocks(a.shop, ['hero', 'ticker', 'products']);
  await saveBlocks(b.shop, ['products', 'ticker', 'hero']);
  assert.deepEqual(order(await a.html()), ['hero', 'ticker', 'products']);
  assert.deepEqual(order(await b.html()), ['products', 'ticker', 'hero']);
  const untouched = await blocks(c.shop);
  assert.equal(untouched.custom, false, 'A business that placed nothing has the default layout');
  assert.deepEqual(untouched.blocks.map((x) => x.block), [...DEFAULT_BLOCKS.landing]);
  assert.deepEqual(order(await c.html()).filter((n) => n !== 'trust'), ['hero', 'ticker', 'products']);
  assert.deepEqual((await blocks(a.shop)).blocks.map((x) => x.block), ['hero', 'ticker', 'products']);
  assert.deepEqual((await blocks(b.shop)).blocks.map((x) => x.block), ['products', 'ticker', 'hero']);
  assert.equal((await blocks(a.shop)).custom, true);

  await saveBlocks(a.shop, ['hero', { block: 'ticker', visible: false }, 'products']);
  assert.deepEqual(order(await a.html()), ['hero', 'products'], 'A hidden block is not drawn');
  assert.deepEqual(order(await b.html()), ['products', 'ticker', 'hero'], 'The other business is unchanged');
  const rows = await a.shop.sql('SELECT DISTINCT tenant_id FROM page_blocks WHERE tenant_id = ANY($1)', [[a.shop.tenantId, b.shop.tenantId, c.shop.tenantId]]);
  assert.deepEqual(rows.map((r) => Number(r.tenant_id)).sort(), [a.shop.tenantId, b.shop.tenantId].sort(), 'Each layout is its own business\'s rows');
});

test('F-98: a layout only takes blocks from the library, on the surfaces they belong to', async () => {
  const { shop, html } = await shopWithPage();
  const before = await blocks(shop);
  const bad = [
    { surface: 'landing', blocks: [{ block: 'custom_html' }] },
    { surface: 'landing', blocks: [{ block: 'script' }] },
    { surface: 'landing', blocks: [{ block: 'shelves' }] },
    { surface: 'landing', blocks: [{ block: 'video' }] },
    { surface: 'checkout', blocks: [{ block: 'hero' }] },
    { surface: 'landing', blocks: Array.from({ length: 31 }, () => ({ block: 'hero' })) },
    { surface: 'landing', blocks: [{ block: 'hero', html: '<b>x</b>' , settings: { [`${'a'.repeat(41)}`]: 1 } }] },
    { surface: 'landing', blocks: 'hero' },
  ];
  for (const body of bad) assert.equal((await shop.send('PUT', '/page-blocks', body)).status, 400, JSON.stringify(body).slice(0, 80));
  for (const name of Object.keys(BUYER_BLOCKS)) {
    for (const surface of ['landing', 'creator', 'store_home']) {
      if (BUYER_BLOCKS[name].surfaces.includes(surface)) continue;
      assert.equal((await shop.send('PUT', '/page-blocks', { surface, blocks: [{ block: name }] })).status, 400, `${name} on ${surface}`);
    }
  }
  assert.deepEqual(await blocks(shop), before);
  assertNoLiveMarkup(await html(), 'The landing page');
});

// ---- F-99 ------------------------------------------------------------------------------------------------------------------

test('F-99: every business draws a shared block with the same code, so one fix reaches all of them', async () => {
  const a = await shopWithPage();
  const b = await shopWithPage();
  await a.shop.must('PUT', '/theme', { preset: 'tadka', tuneAccent: false });
  await b.shop.must('PUT', '/theme', { preset: 'gadget-galli', tuneAccent: false });
  await saveBlocks(a.shop, ['hero', 'ticker', 'products']);
  await saveBlocks(b.shop, ['hero', 'ticker', 'products']);
  const [pageA, pageB] = [await a.html(), await b.html()];
  assert.deepEqual(skeletonOf(pageA), skeletonOf(pageB), 'The same blocks give the same structure for two businesses');
  const classes = (html) => [...new Set([...html.replace(/<style[\s\S]*?<\/style>/gi, '').matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].sort();
  assert.deepEqual(classes(pageA), classes(pageB), 'Both pages are drawn from the same block markup');
  const selectors = (html) => [...new Set((cssOf(html).match(/\.[a-z][\w-]*/gi) ?? []))].sort();
  assert.deepEqual(selectors(pageA), selectors(pageB), 'Both pages get the same stylesheet rules; only the values differ');
  assert.notEqual(cssOf(pageA), cssOf(pageB));
  const scripts = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/\?.*$/, ''));
  assert.deepEqual(scripts(pageA), scripts(pageB), 'Both load the same scripts');
  for (const dir of ['src/views', 'src/modules/pages', 'src/modules/creator', 'src/modules/categories']) {
    const full = path.join(repoRoot, dir);
    const names = fs.existsSync(full) ? fs.readdirSync(full, { recursive: true }).map(String) : [];
    assert.deepEqual(names.filter((n) => /tenant-\d+|client-|\.mehta|custom-[a-z]+\.js/i.test(n)), [], `${dir} has no per-client file`);
  }
});

// ---- F-100 -----------------------------------------------------------------------------------------------------------------

test('F-100: a request for a custom script on checkout is refused under the policy and logged with the alternative offered', async () => {
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  const created = await operator.must('POST', `/tenants/${shop.tenantId}/customisation-requests`, { summary: 'Custom script on the checkout page for a chat widget' }, 201);
  assert.deepEqual([created.tenantId, created.decision, created.alternative], [shop.tenantId, 'open', '']);
  const noAlternative = await operator.send('POST', `/customisation-requests/${created.id}/decision`, { decision: 'alternative', level: 3, othersWant: false, alternative: '' });
  assert.equal(noAlternative.status, 400, 'Refusing with an alternative must say what was offered');
  const decided = await operator.must('POST', `/customisation-requests/${created.id}/decision`, { decision: 'alternative', level: 3, othersWant: false, alternative: 'Use the WhatsApp button block for chat' });
  assert.equal(decided.decision, 'alternative');
  assert.equal(decided.alternative, 'Use the WhatsApp button block for chat');
  assert.equal(decided.level, 3);
  assert.ok(decided.decidedAt);
  const [row] = await shop.sql('SELECT decision, alternative, level, decided_at, decided_by FROM customisation_requests WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual([row.decision, row.alternative, row.level], ['alternative', 'Use the WhatsApp button block for chat', 3]);
  assert.ok(row.decided_at && row.decided_by, 'Who decided, and when, is kept');
  const listed = await operator.must('GET', `/customisation-requests?tenantId=${shop.tenantId}&decision=alternative`);
  assert.deepEqual(listed.items.map((r) => r.id), [created.id]);
  const other = await addP3Shop(world);
  assert.deepEqual((await operator.must('GET', `/customisation-requests?tenantId=${other.tenantId}`)).items, []);
  for (const res of [await shop.send('GET', '/customisation-requests'), await shop.send('POST', '/customisation-requests', { summary: 'x' })]) assert.ok([404, 405].includes(res.status), 'Sellers have no door into the triage list');
  assert.equal((await operator.send('POST', '/tenants/999999/customisation-requests', { summary: 'x' })).status, 404);
  assert.equal((await operator.send('POST', `/tenants/${shop.tenantId}/customisation-requests`, { summary: '' })).status, 400);
});

test('F-100: there is no way to put a script, HTML or CSS of the seller\'s own on a buyer page', async () => {
  const { shop, landing, html } = await shopWithPage();
  const payload = '<script>alert(1)</script><style>body{display:none}</style><img src=x onerror=alert(1)>';
  const tries = [
    ['PUT', '/page-blocks', { surface: 'landing', blocks: [{ block: 'hero' }, { block: 'countdown', settings: { text: payload, endsAt: '2030-01-01T00:00:00Z' } }, { block: 'faq', settings: { items: [{ q: payload, a: payload }] } }, { block: 'trust', settings: { items: [{ label: payload, icon: payload }] } }, { block: 'products' }] }],
    ['PUT', '/page-blocks', { surface: 'creator', blocks: [{ block: 'hero' }, { block: 'banner', settings: { text: payload, imageUrl: 'javascript:alert(1)', linkUrl: 'javascript:alert(1)' } }, { block: 'shelves' }] }],
    ['PATCH', `/pages/${landing.id}`, { headline: payload, description: payload }],
    ['PATCH', '/page-settings', { whatsappTemplate: `{product} ${payload}` }],
    ['PATCH', '/settings', { storeName: payload }],
    ['PATCH', '/creator-page', { slug: 'policy-shop', enabled: true, displayName: payload.slice(0, 80), bio: payload, moreShelfTitle: payload.slice(0, 40), websiteUrl: 'https://example.com/"><script>alert(1)</script>' }],
    ['PATCH', '/lead-forms', { surface: 'landing', enabled: true, offerLine: payload }],
    ['PATCH', '/page-settings', { customCss: 'body{display:none}', headHtml: payload, script: 'alert(1)' }],
  ];
  for (const [method, route, body] of tries) {
    const res = await shop.send(method, route, body);
    assert.ok(res.status < 500, `${method} ${route} crashed: ${res.status}`);
  }
  for (const pathname of [`/r/${landing.slug}`, '/policy-shop', '/r/none']) {
    const res = await shop.open(pathname);
    assert.ok(res.status < 500, `${pathname} answered ${res.status}`);
    assertNoLiveMarkup(res.text, pathname);
    assert.doesNotMatch(res.text, /<style>body\{display:none\}<\/style>/, `${pathname}: the seller's CSS is live`);
    assert.doesNotMatch(cssOf(res.text), /display:none\}\s*<|alert\(1\)/, `${pathname}: the seller's text is inside the stylesheet`);
  }
  assert.ok((await html()).length > 500);
});

// ---- F-101 -----------------------------------------------------------------------------------------------------------------

test('F-101: a level 5 feature enabled later for a second business works with that business\'s brand kit and settings, with no code change', async () => {
  const operator = await operatorOf(world);
  const first = await shopWithPage({ plan: 't1' });
  const second = await shopWithPage({ plan: 't1' });
  const request = await operator.must('POST', `/tenants/${first.shop.tenantId}/customisation-requests`, { summary: 'A form on the reel page to collect a name and a phone number', level: 5 }, 201);
  const accepted = await operator.must('POST', `/customisation-requests/${request.id}/decision`, { decision: 'accepted', level: 5, othersWant: true, feature: 'lead_form' });
  assert.deepEqual([accepted.decision, accepted.level, accepted.othersWant, accepted.feature], ['accepted', 5, true, 'lead_form'], 'The request records the flag the feature is built behind');
  await setFeature(first.shop, 'lead_form', true);
  await leadFormOn(first.shop, 'landing', { channels: ['whatsapp'] });
  assert.ok(formOf(await first.html()));
  assert.equal(formOf(await second.html()), null, 'Launched to the requesting business first');

  await second.shop.must('PUT', '/theme', { preset: 'gadget-galli', tuneAccent: false });
  await setFeature(second.shop, 'lead_form', true);
  await leadFormOn(second.shop, 'landing', { channels: ['email'], offerLine: 'Get our deal alerts' });
  const page = await second.html();
  const form = formOf(page);
  assert.ok(form, 'Enabled by data alone, the second business has the form');
  assert.ok(form.text.includes(second.shop.name), 'The consent names the second business');
  assert.ok(!form.text.includes(first.shop.name), 'Not the first');
  assert.ok(page.includes('Get our deal alerts'), 'Its own setting shows');
  assert.ok(cssOf(page).toLowerCase().includes('#0e1120'), 'In its own brand kit (Gadget Galli)');
  noPlatformName('The second business\'s page', page);
  const sent = await submitLead(world, second.shop, `/r/${second.landing.slug}`, { firstName: 'Ravi', email: 'ravi@example.com' });
  assert.ok(sent.landed.status < 400);
  assert.ok(sent.landed.text.includes(second.shop.name), 'The thank-you page is the second business\'s');
  assert.equal((await second.shop.leadRows()).length, 1);
  assert.equal((await first.shop.leadRows()).length, 0, 'No lead crossed over');
  const third = await shopWithPage({ plan: 't1' });
  assertBranded404(await third.shop.open('/lead/thanks'), third.shop, 'A business without the feature');
  for (const bad of [{ decision: 'accepted', level: 6, othersWant: true }, { decision: 'maybe', level: 5, othersWant: true }, { decision: 'accepted', level: 5, othersWant: true, feature: 'Bad Flag!' }]) {
    assert.equal((await operator.send('POST', `/customisation-requests/${request.id}/decision`, bad)).status, 400, JSON.stringify(bad));
  }
});
