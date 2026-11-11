// PRD 5.19, 5.3 and 8.9: the look of a business's buyer pages. Five presets as data, the accent tuned from the logo, the seal
// text and ticker the seller can edit, the look read from the business's own website, and colours that can never carry markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, PRESET_SLOTS, addP3Shop, assertNoLiveMarkup, contrast, creatorPage, cssOf, hueGap, isHex, luminance, need, noPlatformName, operatorOf,
  productIdsOf, sitePage, skeletonOf, textOf, unique, useP3World,
} from './kit.js';

const world = useP3World();

const theme = (shop) => shop.must('GET', '/theme');
const choose = (shop, preset, tuneAccent = true) => shop.must('PUT', '/theme', { preset, tuneAccent }, 200, `Picking ${preset}`);
const landingHtml = async (shop, landing) => need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
const hasColor = (html, hex) => html.toLowerCase().includes(String(hex).toLowerCase());
const fontsOf = (html) => decodeURIComponent((html.match(/fonts\.googleapis\.com\/css2\?[^"']+/g) ?? []).join(' ')).replace(/\+/g, ' ');

function assertPasses(colors, what) {
  for (const [bg, fg] of [['primary', 'on_primary'], ['accent', 'on_accent'], ['ground', 'ink'], ['card', 'ink']]) {
    if (!colors[bg] || !colors[fg]) continue;
    assert.ok(isHex(colors[bg]) && isHex(colors[fg]), `${what}: ${bg} ${colors[bg]} / ${fg} ${colors[fg]} are not plain colours`);
    const ratio = contrast(colors[bg], colors[fg]);
    assert.ok(ratio >= 4.5, `${what}: ${fg} ${colors[fg]} on ${bg} ${colors[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
  }
}

// ---- K-27 ------------------------------------------------------------------------------------------------------------------

test('K-27: reading the look of a Shopify store gives its forest green as primary, with Playfair Display and Inter', async () => {
  const shop = await addP3Shop(world);
  await world.shopify.post('/storefront', { name: 'Green Leaf Plants', themeColor: '#1F4D2B', headingFont: 'Playfair Display', bodyFont: 'Inter' });
  const read = await shop.must('POST', '/theme/site-reads', { website: 'https://plants.example' }, 201, 'Reading the website');
  assert.equal(read.status, 'read', JSON.stringify(read).slice(0, 300));
  assert.equal(read.colors.primary?.toUpperCase(), '#1F4D2B', 'The primary is the site\'s forest green');
  assert.equal(read.headingFont, 'Playfair Display');
  assert.equal(read.bodyFont, 'Inter');
  assert.ok(read.logoUrl, 'A logo was found');
  assert.equal(read.appliedAt, null, 'Reading is not applying');
  assert.equal((await theme(shop)).source, 'preset', 'Nothing changes until the read is applied');

  const applied = await shop.must('POST', `/theme/site-reads/${read.id}/apply`, undefined, 200, 'Applying the read');
  assert.equal(applied.source, 'website');
  assert.equal(applied.colors.primary.toUpperCase(), '#1F4D2B');
  assert.deepEqual([applied.headingFont, applied.bodyFont], ['Playfair Display', 'Inter']);
  assertPasses(applied.colors, 'The applied theme');
  const kit = await shop.must('GET', '/brand-kit');
  assert.equal(kit.colors.primary.toUpperCase(), '#1F4D2B', 'It is saved to the brand kit (5.3)');
  const html = await landingHtml(shop, await shop.page());
  assert.ok(hasColor(cssOf(html), '#1F4D2B'), 'The buyer page wears the green');
  assert.match(fontsOf(html), /Playfair Display/);
  assert.match(fontsOf(html), /Inter/);
  noPlatformName('The themed page', html);
});

test('K-27: theme-color, CSS variables, button colours, Google Fonts and the Organization logo are all read from an ordinary site', async () => {
  const shop = await addP3Shop(world);
  const read = await shop.must('POST', '/theme/site-reads', { website: 'brand.example' }, 201, 'Reading brand.example');
  assert.equal(read.status, 'read');
  assert.equal(read.colors.primary?.toUpperCase(), '#1F4D2B');
  assert.deepEqual([read.headingFont, read.bodyFont], ['Playfair Display', 'Inter']);
  assert.match(read.logoUrl, /brand-logo\.png|\/media\//, `The JSON-LD Organization logo comes first: ${read.logoUrl}`);
  assert.match(read.website, /^https?:\/\/brand\.example/);
  const list = await shop.must('GET', '/theme/site-reads');
  assert.deepEqual(list.items.map((r) => r.id), [read.id]);
  const other = await addP3Shop(world);
  assert.deepEqual((await other.must('GET', '/theme/site-reads')).items, [], 'Another business doesn\'t see this read');
  assert.equal((await other.send('POST', `/theme/site-reads/${read.id}/apply`)).status, 404, 'Nor can it apply it');
  assert.equal((await theme(other)).source, 'preset');
});

test('K-27: a JavaScript-only site keeps the preset plus the logo and is flagged "check theme"; an unknown font maps to a supported one', async () => {
  const shop = await addP3Shop(world);
  const before = await theme(shop);
  const read = await shop.must('POST', '/theme/site-reads', { website: 'https://scriptonly.example' }, 201, 'Reading a JavaScript-only site');
  assert.equal(read.status, 'script_only');
  const applied = await shop.must('POST', `/theme/site-reads/${read.id}/apply`, undefined, 200, 'Applying it');
  assert.equal(applied.preset, before.preset, 'The preset is kept');
  assert.deepEqual(applied.colors, before.colors, 'The preset\'s colours are kept');
  assert.equal(applied.check, true, 'Flagged for our team to check');
  assert.ok(applied.logoUrl, 'The icon is used as the logo');

  const host = `fonts-${unique()}.example`;
  world.sites.site(host, { pages: { '/': { body: sitePage('<title>Font shop</title><meta name="theme-color" content="#234D33"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zzyzx+Display&family=Qwertyuiop+Sans&display=swap"><style>h1{font-family:"Zzyzx Display"}body{font-family:"Qwertyuiop Sans";}</style>') } } });
  const fonts = await shop.must('POST', '/theme/site-reads', { website: `https://${host}` }, 201, 'Reading unknown fonts');
  assert.equal(fonts.status, 'read');
  const known = new Set((await shop.must('GET', '/theme/presets')).items.flatMap((p) => [p.headingFont, p.bodyFont]));
  for (const font of [fonts.headingFont, fonts.bodyFont]) {
    assert.ok(font && !/Zzyzx|Qwertyuiop/.test(font), `An unknown font was kept: ${font}`);
    assert.match(font, /^[A-Za-z0-9 ]{2,40}$/, `A font name is plain words: ${font}`);
  }
  assert.ok(known.size >= 5);
});

test('K-27: a site that is slow, huge, broken or gone is a failed read, and the theme stays as it was', async () => {
  const shop = await addP3Shop(world);
  const before = await theme(shop);
  for (const website of ['https://huge.example', 'https://malformed.example', 'https://nowhere-at-all.example', 'https://loop.example/r/0', 'https://wrongtype.example/image.png']) {
    const res = await shop.send('POST', '/theme/site-reads', { website });
    assert.ok(res.status < 500, `${website} answered ${res.status}`);
    if (res.status === 201) {
      const read = res.json();
      assert.ok(['failed', 'blocked', 'script_only', 'read'].includes(read.status));
      for (const value of Object.values(read.colors)) assert.ok(isHex(value), `${website}: a colour that isn't one: ${value}`);
    }
  }
  assert.deepEqual(await theme(shop), before);
});

// ---- K-28 ------------------------------------------------------------------------------------------------------------------

test('K-28: a site whose button text is 2.1:1 on its brand colour is saved as a pair that passes 4.5:1, with a note', async () => {
  const shop = await addP3Shop(world);
  assert.ok(contrast('#8ABE9C', '#FFFFFF') < 2.3, 'The fixture really is about 2.1:1');
  const read = await shop.must('POST', '/theme/site-reads', { website: 'https://lowcontrast.example' }, 201, 'Reading the low-contrast site');
  assert.equal(read.status, 'read');
  assert.ok(read.notes.length >= 1, 'The read carries a note about the change');
  assert.match(read.notes.join(' '), /contrast|4\.5|black|white|readab/i, `The note says what changed: ${read.notes.join(' | ')}`);
  assertPasses(read.colors, 'The read');
  assert.equal(read.colors.primary.toUpperCase(), '#8ABE9C', 'The brand colour is kept; the text on it moves');
  assert.ok(['#000000', '#FFFFFF'].includes(read.colors.on_primary.toUpperCase()), `Failures move to black or white: ${read.colors.on_primary}`);
  const applied = await shop.must('POST', `/theme/site-reads/${read.id}/apply`, undefined, 200, 'Applying it');
  assertPasses(applied.colors, 'The saved theme');
  assert.ok(applied.notes.length >= 1, 'The saved theme keeps the note');
  assert.equal(applied.check, true, 'Our team is asked to look at a read that changed colours');
  const html = await landingHtml(shop, await shop.page());
  assert.ok(!/color:\s*#fff(fff)?[^;]*;[^}]*background(-color)?:\s*#8abe9c|background(-color)?:\s*#8abe9c[^}]*color:\s*#fff(fff)?\b/i.test(cssOf(html)), 'No rule puts white text on the pale green');
});

test('K-28: every preset passes 4.5:1 as shipped, and a hand-picked colour that fails is not saved as a failing pair', async () => {
  const shop = await addP3Shop(world);
  const presets = (await shop.must('GET', '/theme/presets')).items;
  assert.ok(presets.length >= 5);
  for (const preset of presets) assertPasses(preset.colors, `Preset ${preset.code}`);
  const res = await shop.send('PATCH', '/brand-kit', { colors: { primary: '#FFFF66', on_primary: '#FFFFFF' } });
  assert.ok(res.status < 500);
  const now = await theme(shop);
  assertPasses(now.colors, 'The theme after a failing hand-picked pair');
});

// ---- K-29 ------------------------------------------------------------------------------------------------------------------

const BAD_COLOR = 'red;}</style><script>alert(1)</script>';

test('K-29: a colour carrying markup read from a site is rejected, and nothing of it reaches a buyer page', async () => {
  const shop = await addP3Shop(world);
  const res = await shop.send('POST', '/theme/site-reads', { website: 'https://inject.example' });
  assert.ok([201, 400].includes(res.status), `Reading inject.example answered ${res.status}`);
  if (res.status === 201) {
    const read = res.json();
    for (const [slot, value] of Object.entries(read.colors)) assert.ok(isHex(value), `${slot} is "${value}"`);
    assert.doesNotMatch(JSON.stringify(read), /<script|<\/style|javascript:/i, 'None of the injected text is kept');
    if (read.status === 'read') await shop.must('POST', `/theme/site-reads/${read.id}/apply`, undefined, 200, 'Applying it');
  }
  const html = await landingHtml(shop, await shop.page());
  assertNoLiveMarkup(html, 'The landing page');
  assert.doesNotMatch(cssOf(html), /red;\}|javascript:|<\/?script/i, 'The stylesheet carries none of it');
  assert.equal((html.match(/<\/style>/gi) ?? []).length, (html.match(/<style\b/gi) ?? []).length, 'No stray </style>');
});

test('K-29: a colour, font, seal or logo typed with markup is refused by every door, and nothing is saved', async () => {
  const shop = await addP3Shop(world);
  const before = await theme(shop);
  const doors = [
    ['PATCH', '/brand-kit', { colors: { primary: BAD_COLOR } }],
    ['PATCH', '/brand-kit', { colors: { primary: 'red' } }],
    ['PATCH', '/brand-kit', { colors: { primary: '#12345G' } }],
    ['PATCH', '/brand-kit', { colors: { primary: 'url(javascript:alert(1))' } }],
    ['PATCH', '/brand-kit', { colors: { primary: '#fff;background:url(https://evil.example/x)' } }],
    ['PATCH', '/brand-kit', { colors: { 'primary;}</style><script>alert(1)</script>': '#123456' } }],
    ['PATCH', '/brand-kit', { headingFont: 'Inter";}</style><script>alert(1)</script>' }],
    ['PATCH', '/brand-kit', { bodyFont: 'x, url(https://evil.example/f.woff)' }],
    ['PATCH', '/brand-kit', { logoUrl: 'javascript:alert(1)' }],
    ['PATCH', '/brand-kit', { faviconUrl: 'data:text/html,<script>alert(1)</script>' }],
    ['PATCH', '/theme', { sealText: '<script>alert(1)</script>' }],
    ['PATCH', '/theme', { sealText: 'x}</style>' }],
    ['PATCH', '/theme', { tickerItems: ['Fine', '<img src=x onerror=alert(1)>'] }],
    ['PUT', '/theme', { preset: '../../etc/passwd' }],
    ['PUT', '/theme', { preset: 'no-such-look' }],
    ['PUT', '/theme', { preset: 'tadka</style>' }],
  ];
  for (const [method, path, body] of doors) {
    const res = await shop.send(method, path, body);
    assert.ok([400, 404].includes(res.status), `${method} ${path} ${JSON.stringify(body).slice(0, 80)} answered ${res.status}: ${res.text.slice(0, 150)}`);
  }
  assert.deepEqual(await theme(shop), before, 'Nothing was saved');
  const html = await landingHtml(shop, await shop.page());
  assertNoLiveMarkup(html, 'The landing page');
});

test('K-29: even a bad value already in the database is checked before it reaches <style>', async () => {
  const shop = await addP3Shop(world);
  await shop.must('PATCH', '/brand-kit', { colors: { primary: '#234D33' } });
  const tamper = async (sql, params) => {
    try { await shop.sql(sql, params); return true; } catch { return false; }
  };
  await tamper(`UPDATE brand_kits SET colors = colors || $2::jsonb WHERE tenant_id = $1`, [shop.tenantId, JSON.stringify({ primary: BAD_COLOR, ground: 'expression(alert(1))', 'x}</style><script>alert(1)</script>': '#000000' })]);
  await tamper(`UPDATE brand_kits SET heading_font = $2, body_font = $3 WHERE tenant_id = $1`, [shop.tenantId, 'Inter";}</style><script>alert(1)</script>', 'x</style><script>alert(1)</script>']);
  await tamper(`UPDATE brand_kits SET seal_text = $2, ticker_items = $3 WHERE tenant_id = $1`, [shop.tenantId, '</text></svg><script>alert(1)</script>', ['<script>alert(1)</script>']]);
  await tamper(`UPDATE brand_kits SET logo_url = $2 WHERE tenant_id = $1`, [shop.tenantId, 'javascript:alert(1)']);
  const landing = await shop.page();
  const res = await shop.open(`/r/${landing.slug}`);
  assert.equal(res.status, 200, `A bad brand kit row broke the page: ${res.status}`);
  assertNoLiveMarkup(res.text, 'The landing page');
  assert.doesNotMatch(cssOf(res.text), /red;\}|expression\(|<\/?script|url\(\s*javascript/i);
  assert.equal((res.text.match(/<\/style>/gi) ?? []).length, (res.text.match(/<style\b/gi) ?? []).length, 'No stray </style>');
  assert.doesNotMatch(res.text, /fonts\.googleapis\.com[^"']*(<|%3C|script)/i, 'The fonts link carries no markup');
});

// ---- F-102 -----------------------------------------------------------------------------------------------------------------

test('F-102: a seller picks Tadka and uploads a logo: every buyer surface uses Tadka, with the accent tuned from the logo', async () => {
  const shop = await addP3Shop(world);
  const logoColor = '#1E66D0';
  const logo = await shop.upload(logoColor, { width: 400, height: 400, filename: 'logo.png' });
  await shop.must('PATCH', '/brand-kit', { logoUrl: logo });
  const picked = await choose(shop, 'tadka');
  assert.equal(picked.preset, 'tadka');
  assert.equal(picked.presetName, 'Tadka');
  assert.deepEqual([picked.headingFont, picked.bodyFont], ['Bricolage Grotesque', 'Nunito']);
  assert.equal(picked.accentFrom, 'logo');
  assert.equal(picked.logoUrl, logo);
  assert.notEqual(picked.colors.accent.toUpperCase(), '#F6C343', 'The accent is no longer Tadka\'s own turmeric');
  assert.ok(hueGap(picked.colors.accent, logoColor) <= 25, `The accent ${picked.colors.accent} keeps the logo's blue`);
  assertPasses(picked.colors, 'Tadka tuned from the logo');
  assert.equal(picked.colors.primary.toUpperCase(), '#B4340F', 'Only the accent is tuned');
  assert.equal(picked.slots.reelFrame, 'tilted');

  const landing = await shop.page();
  const creator = await creatorPage(shop);
  const surfaces = [`/r/${landing.slug}`, `/${creator.slug}`, '/r/no-such-page', '/'];
  for (const path of surfaces) {
    const res = await shop.open(path);
    assert.ok([200, 404].includes(res.status), `${path} answered ${res.status}`);
    assert.match(fontsOf(res.text), /Bricolage Grotesque/, `${path} uses Tadka's heading font`);
    assert.match(fontsOf(res.text), /Nunito/, `${path} uses Tadka's body font`);
    assert.ok(hasColor(cssOf(res.text), picked.colors.accent), `${path} uses the tuned accent ${picked.colors.accent}`);
    assert.ok(hasColor(cssOf(res.text), '#B4340F'), `${path} uses Tadka's chilli`);
    assert.ok(res.text.includes(logo), `${path} shows the logo`);
    noPlatformName(path, res.text);
  }
  const other = await addP3Shop(world);
  assert.notEqual((await theme(other)).colors.accent, picked.colors.accent, 'Another business keeps its own look');
});

test('F-102: with tuning off, or no logo to tune from, the preset keeps a passing accent', async () => {
  const shop = await addP3Shop(world);
  const plainPick = await choose(shop, 'tadka', false);
  assert.equal(plainPick.colors.accent.toUpperCase(), '#F6C343');
  assert.equal(plainPick.accentFrom, '');
  const noLogo = await choose(shop, 'tadka', true);
  assert.ok(['', 'profile_photo'].includes(noLogo.accentFrom), `With no logo the accent comes from the Instagram photo or stays: ${noLogo.accentFrom}`);
  assertPasses(noLogo.colors, 'Tadka with no logo');
  const theirs = await (await addP3Shop(world)).upload('#00AA00');
  const res = await shop.send('PATCH', '/brand-kit', { logoUrl: theirs });
  assert.ok(res.status < 500);
  const html = await landingHtml(shop, await shop.page());
  if (html.includes(theirs)) assert.equal((await shop.open(theirs)).status, 404, 'Another business\'s file never serves on this host');
});

// ---- F-103 -----------------------------------------------------------------------------------------------------------------

test('F-103: switching from Tadka to Mitti changes the look of every buyer page and nothing else', async () => {
  const shop = await addP3Shop(world);
  await choose(shop, 'tadka', false);
  const products = [await shop.product({ name: 'Mango pickle', pricePaise: 24900 }), await shop.product({ name: 'Garlic chutney', pricePaise: 19900 })];
  const landing = await shop.page({ productIds: products.map((p) => p.id) });
  const category = await shop.category('Pickles');
  await shop.addToCategory(category.id, landing.id);
  const creator = await creatorPage(shop);
  const tables = ['products', 'reels', 'reel_products', 'categories', 'category_reels', 'orders', 'creator_pages', 'automations', 'product_variants', 'product_images'];
  const fingerprint = async () => {
    const out = {};
    for (const table of tables) out[table] = (await shop.sql(`SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS sum FROM ${table} t WHERE tenant_id = $1`, [shop.tenantId]))[0];
    return out;
  };
  const before = { data: await fingerprint(), page: await shop.must('GET', `/pages/${landing.id}`), html: await landingHtml(shop, landing), creator: (await shop.open(`/${creator.slug}`)).text };

  const switched = await choose(shop, 'mitti', false);
  assert.equal(switched.preset, 'mitti');
  const after = { data: await fingerprint(), page: await shop.must('GET', `/pages/${landing.id}`), html: await landingHtml(shop, landing), creator: (await shop.open(`/${creator.slug}`)).text };
  assert.deepEqual(after.data, before.data, 'Products, reels, links, categories and orders are untouched');
  assert.deepEqual({ ...after.page, updatedAt: 0 }, { ...before.page, updatedAt: 0 }, 'The page and its link are the same');
  assert.equal(after.page.url, before.page.url);
  assert.deepEqual(productIdsOf(after.html), productIdsOf(before.html));
  assert.deepEqual(skeletonOf(after.html), skeletonOf(before.html), 'The sections are the same');
  assert.notEqual(cssOf(after.html), cssOf(before.html), 'The look changed');
  for (const html of [after.html, after.creator]) {
    assert.match(fontsOf(html), /Lora/);
    assert.match(fontsOf(html), /Work Sans/);
    assert.doesNotMatch(fontsOf(html), /Bricolage|Nunito/);
    assert.ok(hasColor(cssOf(html), '#4E5D3A'), 'Mitti\'s sage');
    assert.ok(!hasColor(cssOf(html), '#B4340F'), 'Tadka\'s chilli is gone');
  }
  assert.ok(textOf(after.html).includes('Mango pickle') && textOf(after.html).includes('₹249'));
});

// ---- F-104 -----------------------------------------------------------------------------------------------------------------

test('F-104: a logo colour that fails contrast as an accent is darkened until text on it passes 4.5:1', async () => {
  const shop = await addP3Shop(world);
  const logos = ['#FFE14D', '#7FD1AE', '#FF8A80', '#9E9E9E', '#40C4FF', '#FFFFFF', '#F5F5DC', '#FF00FF', '#00FF00', '#101010'];
  for (const preset of PRESETS) {
    for (const color of logos) {
      const logo = await shop.upload(color, { width: 200, height: 200, filename: 'logo.png' });
      await shop.must('PATCH', '/brand-kit', { logoUrl: logo });
      const picked = await choose(shop, preset);
      const { accent, on_accent: onAccent } = picked.colors;
      assert.ok(isHex(accent) && isHex(onAccent), `${preset} from ${color}: ${accent} / ${onAccent}`);
      const ratio = contrast(accent, onAccent);
      assert.ok(ratio >= 4.5, `${preset} from a ${color} logo: text ${onAccent} on accent ${accent} is ${ratio.toFixed(2)}:1`);
      assertPasses(picked.colors, `${preset} from a ${color} logo`);
      if (contrast(color, onAccent) < 4.5 && picked.accentFrom === 'logo') {
        assert.ok(luminance(accent) < luminance(color) + 0.001 || contrast(accent, onAccent) >= 4.5, `${preset}: the failing ${color} was not darkened (${accent})`);
        if (!['#FFFFFF', '#F5F5DC', '#9E9E9E', '#101010'].includes(color)) assert.ok(hueGap(accent, color) <= 30, `${preset}: darkening ${color} to ${accent} changed its hue`);
      }
    }
  }
});

test('F-104: a pale yellow logo on Utsav ends darker than the logo, in the same hue, and the buyer page uses that darker accent', async () => {
  const shop = await addP3Shop(world);
  const pale = '#FFE14D';
  await shop.must('PATCH', '/brand-kit', { logoUrl: await shop.upload(pale, { width: 200, height: 200 }) });
  const picked = await choose(shop, 'utsav');
  assert.equal(picked.accentFrom, 'logo');
  const white = contrast(pale, '#FFFFFF');
  assert.ok(white < 4.5, 'White text on the raw logo colour fails');
  assert.ok(contrast(picked.colors.accent, picked.colors.on_accent) >= 4.5);
  if (luminance(picked.colors.on_accent) > 0.5) assert.ok(luminance(picked.colors.accent) < luminance(pale), 'With light text the accent was darkened');
  assert.ok(hueGap(picked.colors.accent, pale) <= 30);
  assert.ok(hasColor(cssOf(await landingHtml(shop, await shop.page())), picked.colors.accent));
});

// ---- F-105 -----------------------------------------------------------------------------------------------------------------

test('F-105: one reel page in all five presets has the same sections in the same order; only the look differs', async () => {
  const shop = await addP3Shop(world);
  const products = [];
  for (let i = 0; i < 4; i++) products.push(await shop.product({ name: `Preset product ${i + 1}`, pricePaise: 10000 * (i + 1), mrpPaise: 15000 * (i + 1) }));
  const landing = await shop.page({ productIds: products.map((p) => p.id), headline: 'Festive picks for you' });
  const other = await shop.page({ headline: 'Another reel' });
  const category = await shop.category('Festive');
  await shop.addToCategory(category.id, [landing.id, other.id]);
  const seen = {};
  for (const preset of PRESETS) {
    const picked = await choose(shop, preset, false);
    assert.equal(picked.preset, preset);
    for (const [slot, allowed] of Object.entries(PRESET_SLOTS)) assert.ok(allowed.includes(picked.slots[slot]), `${preset}.${slot} is "${picked.slots[slot]}"`);
    const html = await landingHtml(shop, landing);
    const headings = [...html.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => textOf(m[2]));
    seen[preset] = { skeleton: skeletonOf(html), headings, products: productIdsOf(html), css: cssOf(html), fonts: fontsOf(html), prices: (textOf(html).match(/₹[\d,]+/g) ?? []) };
    noPlatformName(`${preset} page`, html);
    assertPasses(picked.colors, `Preset ${preset}`);
  }
  const first = seen[PRESETS[0]];
  assert.ok(first.skeleton.length >= 3, `The page has sections: ${first.skeleton.join(' ')}`);
  for (const preset of PRESETS.slice(1)) {
    assert.deepEqual(seen[preset].skeleton, first.skeleton, `${preset}: the sections or their order differ from ${PRESETS[0]}`);
    assert.deepEqual(seen[preset].headings, first.headings, `${preset}: the headings differ`);
    assert.deepEqual(seen[preset].products, first.products, `${preset}: the products differ`);
    assert.deepEqual(seen[preset].prices, first.prices, `${preset}: the prices differ`);
    assert.notEqual(seen[preset].css, first.css, `${preset} looks the same as ${PRESETS[0]}`);
  }
  assert.equal(new Set(PRESETS.map((p) => seen[p].css)).size, 5, 'Five different looks');
  assert.equal(new Set(PRESETS.map((p) => seen[p].fonts)).size, 5, 'Five different font pairs');
});

test('F-105: the five presets are the ones in the PRD, with their fonts, and each fills every template slot', async () => {
  const shop = await addP3Shop(world);
  const items = (await shop.must('GET', '/theme/presets')).items;
  const byCode = Object.fromEntries(items.map((p) => [p.code, p]));
  const expected = {
    utsav: ['Utsav', 'Cormorant Garamond', 'Jost', 'arch', 'upper'], dewdrop: ['Dewdrop', 'DM Serif Display', 'Manrope', 'dewdrop', 'none'],
    tadka: ['Tadka', 'Bricolage Grotesque', 'Nunito', 'tilted', 'none'], 'gadget-galli': ['Gadget Galli', 'Space Grotesk', 'Inter', 'screen', 'none'],
    mitti: ['Mitti', 'Lora', 'Work Sans', 'pebble', 'none'],
  };
  for (const [code, [name, heading, body, frame, buttonCase]] of Object.entries(expected)) {
    const p = byCode[code];
    assert.ok(p, `Preset ${code} is offered`);
    assert.deepEqual([p.name, p.headingFont, p.bodyFont, p.slots.reelFrame, p.slots.buttonCase], [name, heading, body, frame, buttonCase]);
    assert.ok(p.madeFor.length > 3, `${code} says who it is made for`);
    assert.ok(p.slots.sealText.length > 0 && p.slots.tickerItems.length > 0, `${code} has default seal text and ticker items`);
    for (const slot of Object.keys(PRESET_SLOTS)) assert.ok(p.slots[slot], `${code} fills ${slot}`);
  }
  assert.ok(contrast(byCode['gadget-galli'].colors.ground, '#FFFFFF') > 10, 'Gadget Galli is dark');
});

// ---- F-106 -----------------------------------------------------------------------------------------------------------------

test('F-106: the seal text edited to "Handmade in Kutch" shows on all the seller\'s buyer pages, and only theirs', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  await choose(shop, 'mitti', false);
  await choose(other, 'mitti', false);
  const landing = await shop.page();
  const second = await shop.page();
  const creator = await creatorPage(shop);
  const theirLanding = await other.page();
  const before = await landingHtml(shop, landing);
  assert.ok(before.includes('Handmade · Natural · Crafted'), 'The preset\'s seal text shows at first');

  const saved = await shop.must('PATCH', '/theme', { sealText: 'Handmade in Kutch' });
  assert.equal(saved.sealText, 'Handmade in Kutch');
  assert.equal(saved.slots.sealText, 'Handmade in Kutch');
  for (const path of [`/r/${landing.slug}`, `/r/${second.slug}`, `/${creator.slug}`]) {
    const html = need(await shop.open(path), 200, path).text;
    const seal = /<svg class="seal"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    assert.ok(seal.includes('Handmade in Kutch'), `${path}: the seal shows the new text`);
    assert.ok(!html.includes('Handmade · Natural · Crafted'), `${path}: the preset's text is gone`);
  }
  assert.ok((await landingHtml(other, theirLanding)).includes('Handmade · Natural · Crafted'), 'Another business on the same preset keeps the preset\'s text');
  await choose(shop, 'tadka', false);
  assert.ok((await landingHtml(shop, landing)).includes('Handmade in Kutch'), 'The seller\'s text survives a change of preset');
  const cleared = await shop.must('PATCH', '/theme', { sealText: '' });
  assert.equal(cleared.sealText, '');
  assert.ok((await landingHtml(shop, landing)).includes('Fresh · Homemade · Small batch'), 'Emptied, it returns to the preset\'s');
});

test('F-106: ticker items are editable too; text with markup, too long or too many is refused', async () => {
  const shop = await addP3Shop(world);
  const landing = await shop.page();
  const saved = await shop.must('PATCH', '/theme', { tickerItems: ['Ships from Bhuj', 'Block printed by hand', 'Tom & Co. #1'] });
  assert.deepEqual(saved.tickerItems, ['Ships from Bhuj', 'Block printed by hand', 'Tom & Co. #1']);
  const html = await landingHtml(shop, landing);
  const ticker = /<div class="ticker"[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? '';
  assert.ok(textOf(ticker).includes('Ships from Bhuj') && textOf(ticker).includes('Tom & Co. #1'), `The ticker shows the seller's items: ${textOf(ticker).slice(0, 200)}`);
  for (const body of [{ sealText: 'x'.repeat(61) }, { sealText: 'A <b>bold</b> seal' }, { sealText: '{{constructor}}' }, { tickerItems: Array.from({ length: 9 }, (_, i) => `Item ${i}`) }, { tickerItems: ['x'.repeat(41)] }, { tickerItems: 'one' }, { sealText: 42 }]) {
    assert.equal((await shop.send('PATCH', '/theme', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual((await theme(shop)).tickerItems, ['Ships from Bhuj', 'Block printed by hand', 'Tom & Co. #1']);
  assertNoLiveMarkup(await landingHtml(shop, landing), 'The landing page');
});

// ---- F-107 -----------------------------------------------------------------------------------------------------------------

const sixth = (code, changes = {}) => ({
  code, name: 'Neon Bazaar', madeFor: 'Street food and night markets', position: 6, active: true,
  colors: { ground: '#101418', card: '#1B2026', ink: '#F4F6F8', muted: '#B5BDC6', line: '#2C333B', primary: '#FF4F7B', on_primary: '#1A0A10', accent: '#35E0C0', on_accent: '#06231D', eyebrow: '#35E0C0' },
  headingFont: 'Space Grotesk', bodyFont: 'Inter',
  slots: { reelFrame: 'screen', photoShape: 'rounded', cardStyle: 'panel', buttonStyle: 'pill', buttonCase: 'upper', radius: 16, pattern: 'grid', highlight: 'marker', flourish: 'squiggle', sealIcon: 'bolt', ticker: 'band', priceStyle: 'neon', labelStyle: 'code', logoShape: 'square', offTag: 'tilted', displayWeight: 700, sealText: 'Hot · Fresh · Tonight', tickerItems: ['Open late', 'Made to order'] },
  ...changes,
});

test('F-107: a sixth preset added as data appears in "Pick a look" for every seller and works on their pages, with no code change', async () => {
  const operator = await operatorOf(world);
  const a = await addP3Shop(world);
  const b = await addP3Shop(world, { plan: 't1' });
  const code = `neon-${unique()}`.toLowerCase();
  assert.ok(!(await a.must('GET', '/theme/presets')).items.some((p) => p.code === code));
  const saved = await operator.must('PUT', '/theme-presets', sixth(code));
  assert.equal(saved.code, code);
  for (const shop of [a, b]) {
    const items = (await shop.must('GET', '/theme/presets')).items;
    const found = items.find((p) => p.code === code);
    assert.ok(found, 'Every seller sees the new look');
    assert.deepEqual([found.name, found.madeFor, found.headingFont], ['Neon Bazaar', 'Street food and night markets', 'Space Grotesk']);
    assert.ok(items.length >= 6);
    for (const original of PRESETS) assert.ok(items.some((p) => p.code === original), `${original} is still offered`);
  }
  const picked = await choose(a, code, false);
  assert.equal(picked.preset, code);
  assert.equal(picked.slots.sealText, 'Hot · Fresh · Tonight');
  const landing = await a.page();
  const html = await landingHtml(a, landing);
  assert.ok(hasColor(cssOf(html), '#FF4F7B'), 'A buyer page wears the new preset');
  assert.ok(html.includes('Hot · Fresh · Tonight'));
  await choose(a, 'utsav', false);
  const base = await landingHtml(a, landing);
  assert.deepEqual(skeletonOf(html), skeletonOf(base), 'The sixth preset has the same sections as the first five');

  await operator.must('PUT', '/theme-presets', sixth(code, { active: false }));
  assert.ok(!(await b.must('GET', '/theme/presets')).items.some((p) => p.code === code), 'Switched off, it leaves the picker');
});

test('F-107: a preset that fails contrast, carries CSS in a slot or a colour, or is saved by the wrong person is refused', async () => {
  const operator = await operatorOf(world);
  const shop = await addP3Shop(world);
  const code = `bad-${unique()}`.toLowerCase();
  const base = sixth(code);
  const bad = [
    ['white text on yellow', { colors: { ...base.colors, primary: '#FFEE58', on_primary: '#FFFFFF' } }],
    ['grey ink on grey ground', { colors: { ...base.colors, ground: '#808080', ink: '#8A8A8A' } }],
    ['a colour with markup', { colors: { ...base.colors, primary: 'red;}</style><script>alert(1)</script>' } }],
    ['a missing colour is fine, an unknown slot is not', { colors: { ...base.colors, 'x}</style>': '#000000' } }],
    ['CSS in a slot', { slots: { ...base.slots, reelFrame: 'arch;}</style><script>alert(1)</script>' } }],
    ['an unknown slot', { slots: { ...base.slots, customCss: 'body{display:none}' } }],
    ['markup in the seal', { slots: { ...base.slots, sealText: '<script>alert(1)</script>' } }],
    ['a radius as CSS', { slots: { ...base.slots, radius: '4px;}</style>' } }],
    ['a font with markup', { headingFont: 'Inter";}</style><script>alert(1)</script>' }],
    ['a bad code', { code: 'Neon Bazaar!' }],
    ['no name', { name: '' }],
  ];
  for (const [what, changes] of bad) {
    const res = await operator.send('PUT', '/theme-presets', { ...base, ...changes });
    assert.equal(res.status, 400, `${what}: answered ${res.status} ${res.text.slice(0, 150)}`);
  }
  const support = await operatorOf(world, 'support');
  assert.equal((await support.send('PUT', '/theme-presets', base)).status, 403, 'Only a super admin adds a look');
  for (const [method, path] of [['PUT', '/theme/presets'], ['POST', '/theme/presets'], ['PUT', '/brand-kit/presets'], ['POST', '/brand-kit/presets']]) {
    const res = await shop.send(method, path, base);
    assert.ok([404, 405].includes(res.status), `A seller ${method} ${path} answered ${res.status}`);
  }
  assert.ok(!(await shop.must('GET', '/theme/presets')).items.some((p) => p.code === code), 'None of them was added');
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM theme_presets WHERE code = $1', [code]))[0].n, 0);
});
