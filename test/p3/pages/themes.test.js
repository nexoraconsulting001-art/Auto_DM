// Themes (PRD 5.18, 5.19, 8.9): picking a look, the accent from the logo, the seller's own seal and ticker words, a look read
// from the business's website through safeFetch, the block layout, and what Bhava's team does on the platform host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio } from '../../../src/modules/brand/theme.js';
import { addProduct, metaTag, open, secondShop, sections, shop, upload } from './support.js';

const PRESETS = ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti'];
const PLATFORM_HOST = 'admin.bhava.test';

async function withPage(s, { headline = 'Kitchen edit', mediaId = '17900000000000100' } = {}) {
  const product = await addProduct(s.app, s.repos, s.tenant, { name: 'Steel Bottle', price: '349', mrp: '499', externalUrl: 'https://shop.example/bottle' });
  const page = await s.api('POST', '/pages', { kind: 'reel', mediaId, headline, productIds: [product.id] });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  return { product, page: page.body };
}

const cssOf = (html) => /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const logo = (s, color) => upload(s, color, 256, 256);
const close = (a, b) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 6);

/** Signs Bhava's own team in on the platform host: ops(method, path, body) -> { status, body }. */
async function platformUser(app, role = 'super_admin', email = `${role}@team.example`) {
  await app.platform.platformUsers.create({ email, password: 'platform-pass', role });
  const onConsole = (path, init = {}) => fetch(`${app.base}${path}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-host': PLATFORM_HOST, ...init.headers } });
  const res = await onConsole('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'platform-pass' }) });
  const { csrf } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const answer = await onConsole(path, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await answer.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch { /* a plain-text answer */ }
    return { status: answer.status, body: parsed };
  };
}

test('F-102, F-103, F-104: picking a look with a logo tunes the accent, and switching looks changes nothing but the look', async (t) => {
  const s = await shop(t);
  const { page } = await withPage(s);

  const looks = await s.api('GET', '/theme/presets');
  assert.equal(looks.status, 200, JSON.stringify(looks.body));
  assert.deepEqual(looks.body.items.map((p) => p.code), PRESETS);
  assert.deepEqual(looks.body.items.map((p) => p.madeFor), ['Fashion and ethnic wear', 'Beauty and skincare', 'Food, home chefs and pantry', 'Gadgets, electronics and deals', 'Handmade, decor and home']);

  // A teal logo: dark enough for white text, so it becomes the accent as it is.
  await s.repos.brandKit.save({ logoUrl: await logo(s, '#1F6F5C') });
  const tadka = await s.api('PUT', '/theme', { preset: 'tadka' });
  assert.equal(tadka.status, 200, JSON.stringify(tadka.body));
  assert.deepEqual([tadka.body.preset, tadka.body.presetName, tadka.body.source, tadka.body.accentFrom], ['tadka', 'Tadka', 'preset', 'logo']);
  assert.ok(close(tadka.body.colors.accent, '#1F6F5C'), `the accent ${tadka.body.colors.accent} is the logo's colour`);
  assert.equal(tadka.body.colors.on_accent, '#FFFFFF');
  assert.equal(tadka.body.colors.primary, '#B4340F', 'the rest of the preset is untouched');
  const inTadka = await open(s.app, '/r/kitchen-edit');
  assert.match(inTadka.text, /Bricolage\+Grotesque/);
  assert.ok(cssOf(inTadka.text).includes(`--accent:${tadka.body.colors.accent}`), 'the buyer page wears the tuned accent');
  assert.ok(inTadka.text.includes(`<img src="${tadka.body.logoUrl}"`), 'and the logo');

  // F-104: a logo colour text can't be read on is darkened until it can.
  await s.repos.brandKit.save({ logoUrl: await logo(s, '#D9534F') });
  const tuned = await s.api('PUT', '/theme', { preset: 'tadka' });
  assert.ok(!close(tuned.body.colors.accent, '#D9534F'), 'the colour moved');
  assert.ok(contrastRatio(tuned.body.colors.accent, tuned.body.colors.on_accent) >= 4.5);
  assert.ok(contrastRatio(tuned.body.colors.accent, '#000000') < contrastRatio('#D9534F', '#000000'), 'darker than the logo');
  assert.equal(tuned.body.notes.length, 1);

  // F-103: Tadka to Mitti. The look changes; pages, products, links and counts are exactly as they were.
  const snapshot = async () => ({
    pages: (await s.api('GET', '/pages')).body.items.map(({ updatedAt, ...rest }) => rest),
    page: (await s.api('GET', `/pages/${page.id}`)).body,
    products: await s.app.db.platform.query('SELECT id, name, slug, price_paise, external_url, active, updated_at FROM products WHERE tenant_id = $1 ORDER BY id', [s.tenant.id]),
    reels: await s.app.db.platform.query('SELECT id, slug, headline, active, updated_at FROM reels WHERE tenant_id = $1 ORDER BY id', [s.tenant.id]),
  });
  const before = await snapshot();
  const mitti = await s.api('PUT', '/theme', { preset: 'mitti', tuneAccent: false });
  assert.equal(mitti.status, 200);
  assert.deepEqual([mitti.body.preset, mitti.body.accentFrom, mitti.body.colors.accent], ['mitti', '', '#E3A47D'], 'without tuning, the preset\'s own accent');
  assert.deepEqual(await snapshot(), before);
  const inMitti = await open(s.app, '/r/kitchen-edit');
  assert.match(inMitti.text, /family=Lora/);
  assert.notEqual(cssOf(inMitti.text), cssOf(inTadka.text));
  assert.deepEqual(sections(inMitti.text), sections(inTadka.text), 'the same sections in the same order');

  // A look that isn't offered can't be picked, and nothing changes.
  assert.equal((await s.api('PUT', '/theme', { preset: 'no-such-look' })).status, 400);
  await s.app.db.platform.query(`UPDATE theme_presets SET active = false WHERE code = 'dewdrop'`);
  assert.equal((await s.api('PUT', '/theme', { preset: 'dewdrop' })).status, 400);
  assert.equal((await s.api('GET', '/theme')).body.preset, 'mitti');
  assert.ok(!(await s.api('GET', '/theme/presets')).body.items.some((p) => p.code === 'dewdrop'));

  // A black and white logo has no colour to give: the preset keeps its own accent.
  await s.repos.brandKit.save({ logoUrl: await logo(s, '#1A1A1A') });
  const grey = await s.api('PUT', '/theme', { preset: 'utsav' });
  assert.deepEqual([grey.body.accentFrom, grey.body.colors.accent], ['', '#D4AF37']);
});

test('F-105: one landing page drawn in all five presets has the same sections in the same order; only the look differs', async (t) => {
  const s = await shop(t, { whatsapp: '919320001717' });
  await withPage(s);
  await s.api('PATCH', '/page-settings', { whatsappOrder: true });
  const pages = {};
  for (const code of PRESETS) {
    assert.equal((await s.api('PUT', '/theme', { preset: code })).status, 200, code);
    pages[code] = (await open(s.app, '/r/kitchen-edit')).text;
  }
  for (const code of PRESETS) {
    assert.deepEqual(sections(pages[code]), sections(pages.utsav), code);
    assert.doesNotMatch(pages[code], /bhava/i, code);
    assert.equal(metaTag(pages[code], 'og:title'), 'Kitchen edit');
  }
  assert.deepEqual(sections(pages.utsav).filter((name) => !name.startsWith('article')), ['header.site-header', 'section.hero', 'div class="ticker"', 'section.section', 'footer.site-footer']);
  assert.equal(new Set(PRESETS.map((code) => cssOf(pages[code]))).size, 5, 'five different looks');
  assert.match(pages['gadget-galli'], /color-scheme:dark/);
});

test('F-106: the seller\'s own seal text and ticker show on their pages, survive a change of look, and can\'t carry markup', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const other = await secondShop(s.app);
  const theirProduct = await addProduct(s.app, other.repos, other.tenant, { name: 'Their thing', externalUrl: 'https://shop.example/their' });
  assert.equal((await other.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000101', headline: 'Theirs', productIds: [theirProduct.id] })).status, 201);

  const before = await open(s.app, '/r/kitchen-edit');
  assert.match(before.text, /Festive · Handpicked · Made in India/, 'the preset\'s own words to start with');
  const saved = await s.api('PATCH', '/theme', { sealText: 'Handmade in Kutch', tickerItems: ['Block printed', 'Ships in 2 days'] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.sealText, 'Handmade in Kutch');
  assert.equal(saved.body.slots.sealText, 'Handmade in Kutch');
  const after = await open(s.app, '/r/kitchen-edit');
  assert.match(after.text, /Handmade in Kutch · Handmade in Kutch/);
  assert.match(after.text, /Block printed<i><\/i><\/span><span>Ships in 2 days/);
  assert.doesNotMatch(after.text, /Festive · Handpicked/);
  // Another business's pages keep their own words.
  assert.doesNotMatch((await open(s.app, '/r/theirs', { host: other.host })).text, /Handmade in Kutch/);

  // The words are the seller's, not the preset's: they stay when the look changes.
  await s.api('PUT', '/theme', { preset: 'dewdrop' });
  assert.match((await open(s.app, '/r/kitchen-edit')).text, /Handmade in Kutch/);
  // Empty goes back to the preset's.
  await s.api('PATCH', '/theme', { sealText: '', tickerItems: [] });
  assert.match((await open(s.app, '/r/kitchen-edit')).text, /Clean · Kind · Caring/);

  for (const bad of [{ sealText: '<script>alert(1)</script>' }, { sealText: 'x'.repeat(61) }, { tickerItems: ['ok', '</style><script>'] }, { tickerItems: Array(9).fill('nine') }, { sealText: 'a{color:red}' }]) {
    assert.equal((await s.api('PATCH', '/theme', bad)).status, 400, JSON.stringify(bad));
  }
  assert.doesNotMatch((await open(s.app, '/r/kitchen-edit')).text, /<script>alert/);
});

test('K-27: a look read from the business\'s website gives its colour, fonts and logo, and applying it dresses the buyer pages', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const read = await s.api('POST', '/theme/site-reads', { website: 'brand.example' });
  assert.equal(read.status, 201, JSON.stringify(read.body));
  assert.equal(read.body.status, 'read');
  assert.equal(read.body.website, 'https://brand.example/');
  assert.equal(read.body.colors.primary, '#1F4D2B');
  assert.equal(read.body.colors.on_primary, '#FFFFFF');
  assert.equal(read.body.colors.ground, '#FAF7F0');
  assert.deepEqual([read.body.headingFont, read.body.bodyFont], ['Playfair Display', 'Inter']);
  assert.match(read.body.logoUrl, /^\/media\/[0-9a-f-]{36}$/, 'the logo is stored as the business\'s own file');
  assert.deepEqual(read.body.notes, []);
  assert.equal(read.body.appliedAt, null);
  // Every request went to the site's own checked address, and only to that site.
  assert.ok(s.sites.dials.length >= 2);
  assert.ok(s.sites.dials.every((d) => d.host === 'brand.example' && d.address === '93.184.216.34'), JSON.stringify(s.sites.dials));

  // Nothing changes until it is applied.
  assert.equal((await s.api('GET', '/theme')).body.source, 'preset');
  const applied = await s.api('POST', `/theme/site-reads/${read.body.id}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.source, applied.body.check, applied.body.accentFrom, applied.body.website], ['website', false, 'website', 'https://brand.example/']);
  assert.deepEqual([applied.body.colors.primary, applied.body.headingFont, applied.body.bodyFont, applied.body.logoUrl], ['#1F4D2B', 'Playfair Display', 'Inter', read.body.logoUrl]);
  const page = await open(s.app, '/r/kitchen-edit');
  assert.ok(cssOf(page.text).includes('--primary:#1F4D2B'));
  assert.match(page.text, /family=Playfair\+Display[^"]*family=Inter/);
  assert.ok(page.text.includes(`<img src="${read.body.logoUrl}"`));
  assert.equal((await fetch(`${s.app.base}${read.body.logoUrl}`)).headers.get('content-type'), 'image/webp', 'the logo was re-encoded, never stored as it came');
  assert.doesNotMatch(page.text, /bhava/i);

  const list = await s.api('GET', '/theme/site-reads');
  assert.equal(list.body.items.length, 1);
  assert.ok(list.body.items[0].appliedAt);

  // Another business can neither see nor apply this read.
  const other = await secondShop(s.app);
  assert.deepEqual((await other.api('GET', '/theme/site-reads')).body.items, []);
  assert.equal((await other.api('POST', `/theme/site-reads/${read.body.id}/apply`)).status, 404);
  assert.equal((await other.api('GET', '/theme')).body.source, 'preset');

  // Back to a ready-made look at any time.
  const back = await s.api('PUT', '/theme', { preset: 'mitti', tuneAccent: false });
  assert.deepEqual([back.body.source, back.body.colors.primary, back.body.headingFont], ['preset', '#4E5D3A', 'Lora']);
});

test('K-28: a site whose button text is 2.1:1 is saved as a pair that passes, with a note, and flagged for a check', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const read = await s.api('POST', '/theme/site-reads', { website: 'https://lowcontrast.example/' });
  assert.equal(read.status, 201, JSON.stringify(read.body));
  assert.equal(read.body.colors.primary, '#8ABE9C');
  assert.equal(read.body.colors.on_primary, '#000000');
  assert.ok(read.body.notes.some((n) => /button text was 2\.\d:1.*changed to black/.test(n)), JSON.stringify(read.body.notes));
  assert.ok(read.body.notes.some((n) => /Comic Neue isn’t available, so Nunito is used/.test(n)), 'an unknown font maps to the nearest offered one');
  assert.equal(read.body.headingFont, 'Nunito');

  const applied = await s.api('POST', `/theme/site-reads/${read.body.id}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.check, true, 'our team looks at a look that was changed on the way in');
  assert.deepEqual(applied.body.notes, read.body.notes);
  const { colors } = applied.body;
  for (const [text, ground] of [['on_primary', 'primary'], ['ink', 'ground'], ['ink', 'card'], ['on_accent', 'accent']]) {
    assert.ok(contrastRatio(colors[text], colors[ground]) >= 4.5, `${text} on ${ground}: ${contrastRatio(colors[text], colors[ground]).toFixed(2)}`);
  }
  assert.ok(cssOf((await open(s.app, '/r/kitchen-edit')).text).includes('--on-primary:#000000'));
});

test('K-29: a site whose colours carry markup and script gives no colour, and nothing of it reaches a buyer page', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const read = await s.api('POST', '/theme/site-reads', { website: 'https://inject.example' });
  assert.equal(read.status, 201, JSON.stringify(read.body));
  assert.equal(read.body.status, 'read');
  assert.deepEqual(read.body.colors, {});
  assert.doesNotMatch(JSON.stringify(read.body), /<script|<\/style|javascript:/i);
  const applied = await s.api('POST', `/theme/site-reads/${read.body.id}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.source, applied.body.check, applied.body.colors.primary], ['preset', true, '#7A1F3D'], 'the preset stays, flagged');
  const page = await open(s.app, '/r/kitchen-edit');
  assert.doesNotMatch(page.text, /alert\(1\)|red;\}/);
  assert.equal([...page.text.matchAll(/<\/style>/g)].length, 2, 'the page\'s own two style blocks, closed once each');
  const stored = await s.app.db.platform.query('SELECT colors::text AS colors FROM brand_kits WHERE tenant_id = $1', [s.tenant.id]);
  assert.doesNotMatch(JSON.stringify(stored), /script|red/);
});

test('8.9, K-04: a JavaScript-only site keeps the preset plus its logo, flagged "check theme"; private addresses and dead sites are refused and never applied', async (t) => {
  const s = await shop(t);
  const app = await s.api('POST', '/theme/site-reads', { website: 'scriptonly.example' });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  assert.equal(app.body.status, 'script_only');
  assert.deepEqual([app.body.colors, app.body.headingFont], [{}, '']);
  assert.match(app.body.logoUrl, /^\/media\//);
  const applied = await s.api('POST', `/theme/site-reads/${app.body.id}/apply`);
  assert.deepEqual([applied.body.preset, applied.body.source, applied.body.check, applied.body.logoUrl], ['utsav', 'preset', true, app.body.logoUrl]);
  assert.match(applied.body.notes[0], /JavaScript/);

  const dials = s.sites.dials.length;
  for (const website of ['http://10.0.0.5/', 'https://internal.example/', 'http://169.254.169.254/latest/meta-data', 'https://toprivate.example/meta', 'http://localhost/']) {
    const res = await s.api('POST', '/theme/site-reads', { website });
    assert.equal(res.status, 201, website);
    assert.equal(res.body.status, 'blocked', website);
    assert.deepEqual(res.body.notes, ['That address isn’t a public website']);
    assert.equal((await s.api('POST', `/theme/site-reads/${res.body.id}/apply`)).status, 409);
  }
  assert.deepEqual(s.sites.dials.slice(dials).filter((d) => d.host !== 'toprivate.example'), [], 'nothing private was connected to');
  const gone = await s.api('POST', '/theme/site-reads', { website: 'https://gone.example/missing-page' });
  assert.equal(gone.body.status, 'failed');
  for (const website of ['javascript:alert(1)', 'ftp://brand.example/', 'https://user:pass@brand.example/', 'x']) {
    assert.equal((await s.api('POST', '/theme/site-reads', { website })).status, 400, website);
  }
  assert.equal((await s.api('GET', '/theme')).body.preset, 'utsav', 'no refused read changed the look');

  // Paged, newest first.
  const first = await s.api('GET', '/theme/site-reads?limit=3');
  assert.equal(first.body.items.length, 3);
  assert.equal(first.body.items[0].status, 'failed');
  const rest = await s.api('GET', `/theme/site-reads?limit=10&cursor=${first.body.nextCursor}`);
  assert.equal(rest.body.items.length, 4);
  assert.ok(rest.body.items.every((r) => r.id < first.body.items[2].id));
});

test('F-98, F-99: two businesses place the same shared blocks in different orders and each page shows its own', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const other = await secondShop(s.app);
  const theirProduct = await addProduct(s.app, other.repos, other.tenant, { name: 'Their thing', externalUrl: 'https://shop.example/their' });
  assert.equal((await other.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000102', headline: 'Theirs', productIds: [theirProduct.id] })).status, 201);

  const start = await s.api('GET', '/page-blocks?surface=landing');
  assert.equal(start.status, 200);
  assert.equal(start.body.custom, false);
  assert.deepEqual(start.body.blocks.map((b) => b.block), ['hero', 'ticker', 'products', 'lead_form', 'more_reels', 'trust', 'whatsapp']);

  const faq = { block: 'faq', settings: { items: [{ q: 'Do you ship & deliver everywhere?', a: 'Yes, across India.' }] } };
  const mine = await s.api('PUT', '/page-blocks', { surface: 'landing', blocks: [{ block: 'hero' }, { block: 'products' }, faq, { block: 'ticker', visible: false }] });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.custom, true);
  const theirs = await other.api('PUT', '/page-blocks', { surface: 'landing', blocks: [faq, { block: 'hero' }, { block: 'ticker' }, { block: 'products' }] });
  assert.equal(theirs.status, 200);

  const order = (html) => sections(html).filter((name) => /^(section|div)/.test(name));
  const minePage = await open(s.app, '/r/kitchen-edit');
  const theirPage = await open(s.app, '/r/theirs', { host: other.host });
  assert.deepEqual(order(minePage.text), ['section.hero', 'section.section', 'section.section']);
  assert.deepEqual(order(theirPage.text), ['section.section', 'section.hero', 'div class="ticker"', 'section.section']);
  assert.ok(minePage.text.indexOf('id="products-h"') < minePage.text.indexOf('id="faq-h"'));
  assert.ok(theirPage.text.indexOf('id="faq-h"') < theirPage.text.indexOf('id="products-h"'));
  // The same block, the same code: both draw it the same way, escaped.
  for (const page of [minePage, theirPage]) assert.match(page.text, /<summary>Do you ship &amp; deliver everywhere\?<\/summary><p>Yes, across India\.<\/p>/);

  // Custom markup, CSS or script is never a setting, and a block only goes where it belongs.
  for (const blocks of [
    [{ block: 'faq', settings: { items: [{ q: '<script>alert(1)</script>', a: 'x' }] } }],
    [{ block: 'hero', settings: { html: '<b>x</b>' } }],
    [{ block: 'testimonials', settings: { items: [{ quote: 'Nice', name: 'A' }] } }],
    [{ block: 'countdown', settings: { text: 'Sale', endsAt: 'soon', style: 'color:red' } }],
    [{ block: 'hero' }, { block: 'hero' }],
  ]) {
    assert.equal((await s.api('PUT', '/page-blocks', { surface: 'landing', blocks })).status, 400, JSON.stringify(blocks));
  }
  assert.deepEqual((await s.api('GET', '/page-blocks?surface=landing')).body.blocks.map((b) => [b.block, b.visible]), [['hero', true], ['products', true], ['faq', true], ['ticker', false]], 'a refused save changes nothing');
  // An empty list goes back to the default layout; other surfaces were never touched.
  assert.equal((await s.api('PUT', '/page-blocks', { surface: 'landing', blocks: [] })).body.custom, false);
  assert.equal((await s.api('GET', '/page-blocks?surface=creator')).body.custom, false);
});

test('F-107: a sixth preset saved by our team appears in "Pick a look" for every seller, with no code change', async (t) => {
  const s = await shop(t);
  await withPage(s);
  const other = await secondShop(s.app);
  const admin = await platformUser(s.app, 'super_admin');
  const support = await platformUser(s.app, 'support');
  const neel = {
    code: 'neel', name: 'Neel', madeFor: 'Stationery and gifts', position: 6,
    colors: { ground: '#F6F5F1', card: '#FFFFFF', ink: '#16152B', muted: '#55546B', line: '#DDDCE6', primary: '#3B2FC9', on_primary: '#FFFFFF', accent: '#F5B83D', on_accent: '#16152B', eyebrow: '#3B2FC9' },
    headingFont: 'Figtree', bodyFont: 'Figtree',
    slots: { reelFrame: 'plain', photoShape: 'rounded', cardStyle: 'panel', buttonStyle: 'pill', buttonCase: 'none', radius: 12, pattern: 'dots', highlight: 'marker', flourish: 'line', sealIcon: 'star', ticker: 'pill', priceStyle: 'body', labelStyle: 'plain', logoShape: 'circle', offTag: 'pill', displayWeight: 700, sealText: 'New · Now · Neel', tickerItems: ['Wrapped by hand'] },
  };

  assert.equal((await support('PUT', '/theme-presets', neel)).status, 403, 'only a super admin adds a look');
  for (const [change, field] of [
    [{ colors: { ...neel.colors, on_primary: '#8A84E0' } }, 'colors.on_primary'],
    [{ colors: { ...neel.colors, ink: '#C9C8D4' } }, 'colors.ink'],
    [{ headingFont: 'Papyrus' }, 'headingFont'],
    [{ slots: { ...neel.slots, reelFrame: 'url(javascript:alert(1))' } }, null],
    [{ slots: { ...neel.slots, css: '.btn{display:none}' } }, null],
    [{ slots: { ...neel.slots, sealText: '</text><script>alert(1)</script>' } }, null],
    [{ colors: { ...neel.colors, accent: 'red;}</style>' } }, null],
  ]) {
    const res = await admin('PUT', '/theme-presets', { ...neel, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
    if (field) assert.ok(res.body.fields[field], `${field} is named`);
  }
  assert.ok(!(await s.api('GET', '/theme/presets')).body.items.some((p) => p.code === 'neel'));

  const saved = await admin('PUT', '/theme-presets', neel);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await support('GET', '/theme-presets')).body.items.length, 6);
  // Every seller sees it at once, and can wear it.
  for (const api of [s.api, other.api]) {
    const looks = (await api('GET', '/theme/presets')).body.items;
    assert.deepEqual(looks.map((p) => p.code), [...PRESETS, 'neel']);
    assert.equal(looks.at(-1).madeFor, 'Stationery and gifts');
  }
  const chosen = await s.api('PUT', '/theme', { preset: 'neel' });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  const page = await open(s.app, '/r/kitchen-edit');
  assert.ok(cssOf(page.text).includes('--primary:#3B2FC9'));
  assert.match(page.text, /family=Figtree/);
  assert.match(page.text, /New · Now · Neel/);
  assert.deepEqual(sections(page.text).filter((n) => !n.startsWith('article')), ['header.site-header', 'section.hero', 'div class="ticker"', 'section.section', 'footer.site-footer'], 'the same sections as every other preset');

  // Turned off, it leaves the picker; a business already wearing it keeps its pages.
  assert.equal((await admin('PUT', '/theme-presets', { ...neel, active: false })).status, 200);
  assert.ok(!(await other.api('GET', '/theme/presets')).body.items.some((p) => p.code === 'neel'));
  assert.equal((await open(s.app, '/r/kitchen-edit')).status, 200);
  const audit = await s.app.db.platform.query(`SELECT actor, target FROM audit_log WHERE tenant_id IS NULL AND action = 'theme_preset.saved'`);
  assert.equal(audit.length, 2);
  assert.match(audit[0].actor, /^platform:\d+$/);

  // The platform's routes are on the platform host only, and need a sign-in there.
  assert.equal((await fetch(`${s.app.base}/theme-presets`, { headers: { 'x-forwarded-host': PLATFORM_HOST } })).status, 401);
  assert.notEqual((await s.api('GET', '/theme-presets')).status, 200);
});

test('F-100: a request for a custom script is refused under the policy and kept with the alternative that was offered', async (t) => {
  const s = await shop(t);
  const other = await secondShop(s.app);
  const admin = await platformUser(s.app, 'super_admin');

  const made = await admin('POST', `/tenants/${s.tenant.id}/customisation-requests`, { summary: 'Wants a custom tracking script on the checkout page' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.decision, made.body.level, made.body.tenantId], ['open', null, s.tenant.id]);
  assert.equal((await admin('POST', '/tenants/999999/customisation-requests', { summary: 'x' })).status, 404);
  assert.equal((await admin('POST', `/tenants/${s.tenant.id}/customisation-requests`, { summary: '' })).status, 400);

  const decide = (body, id = made.body.id) => admin('POST', `/customisation-requests/${id}/decision`, body);
  const noAlternative = await decide({ decision: 'alternative', level: 3, othersWant: false });
  assert.equal(noAlternative.status, 400, 'an alternative must say what was offered');
  assert.equal((await decide({ decision: 'accepted', level: 5, othersWant: false, feature: 'checkout.custom_script' })).status, 400, 'a feature only one client would use is not built into the core');
  assert.equal((await decide({ decision: 'accepted', level: 5, othersWant: true })).status, 400, 'a core feature names the flag it is built behind');

  const refused = await decide({ decision: 'alternative', level: 2, othersWant: false, alternative: 'Offered the built-in Meta pixel and GA4 tags, which load with the shopper\'s consent' });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.deepEqual([refused.body.decision, refused.body.level, refused.body.othersWant], ['alternative', 2, false]);
  assert.match(refused.body.alternative, /built-in Meta pixel/);
  assert.ok(refused.body.decidedAt);
  assert.equal((await decide({ decision: 'declined', level: 1, othersWant: false })).status, 409, 'decided once');

  // A level 5 feature others want is accepted behind a per-business flag, which is data (F-96, F-101).
  const second = await admin('POST', `/tenants/${other.tenant.id}/customisation-requests`, { summary: 'Gift wrapping option at checkout', level: 5 });
  const accepted = await decide({ decision: 'accepted', level: 5, othersWant: true, feature: 'checkout.gift_wrap' }, second.body.id);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.feature, 'checkout.gift_wrap');
  await other.repos.entitlements.setOverride('checkout.gift_wrap', { enabled: true });
  assert.equal(await other.repos.entitlements.can('checkout.gift_wrap'), true);
  assert.equal(await s.repos.entitlements.can('checkout.gift_wrap'), false, 'on for the one business, and for no other');

  const all = await admin('GET', '/customisation-requests');
  assert.deepEqual(all.body.items.map((r) => [r.tenantName, r.decision]), [['Second Shop', 'accepted'], ['Test store', 'alternative']]);
  assert.deepEqual((await admin('GET', `/customisation-requests?tenantId=${s.tenant.id}`)).body.items.map((r) => r.id), [made.body.id]);
  assert.deepEqual((await admin('GET', '/customisation-requests?decision=accepted')).body.items.map((r) => r.id), [second.body.id]);
  const audit = await s.app.db.platform.query(`SELECT action, details FROM audit_log WHERE tenant_id IS NULL AND action LIKE 'customisation_request.%' ORDER BY id`);
  assert.deepEqual(audit.map((a) => a.action), ['customisation_request.created', 'customisation_request.decided', 'customisation_request.created', 'customisation_request.decided']);
  assert.doesNotMatch(JSON.stringify(audit), /tracking script|Gift wrapping/, 'the log holds ids and the decision, not the client\'s words');

  // A business's own code path can't read the triage table at all.
  const { withTenant } = await import('../../../src/tenancy.js');
  await assert.rejects(() => withTenant(s.tenant, () => s.app.db.query('SELECT * FROM customisation_requests')), /permission denied/);
});
