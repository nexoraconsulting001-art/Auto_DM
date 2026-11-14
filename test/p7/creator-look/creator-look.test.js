// PRD 8.14 and 5.20: how the creator page is put together (the profile header, the search field, link blocks, the tiles) in
// every preset, and the Free plan's footer badge with the business's referral link, which no paid plan carries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformSiteUrlOf } from '../../../src/config.js';
import { REFERRAL_CODE, REFERRAL_PARAM, referralLink } from '../../../src/contracts/billing.js';
import { bindTenant } from '../../../src/repos/index.js';
import { BROWSER, addCategory, addMedia, addPage, secondBusiness, setPlan, startWorld } from '../../p3/creator-leads/support.js';

const PRESETS = ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti'];

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

async function must(business, path, method, body) {
  const res = await business.api(path, { method, body });
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const footerOf = (text) => /<footer\b[\s\S]*?<\/footer>/i.exec(text)?.[0] ?? '';
const badgeOf = (text) => /<a class="made-with" href="([^"]+)" rel="noopener">(?:<svg[^>]*>.*?<\/svg>)?Made with Bhava<\/a>/.exec(text);
const codesOf = (w, tenant = w.tenant) => w.db.platform.query('SELECT code FROM seller_referral_codes WHERE tenant_id = $1', [tenant.id]);

test('the referral link is the sign-up address with the code, and nothing else', () => {
  assert.equal(REFERRAL_PARAM, 'ref');
  assert.equal(referralLink('https://bhava.example/signup', 'k7m2p9xw'), 'https://bhava.example/signup?ref=k7m2p9xw');
  for (const [site, code] of [
    ['http://bhava.example/signup', 'k7m2p9xw'], // not https
    ['https://bhava.example/signup?x=1', 'k7m2p9xw'], // already carries a query
    ['https://bhava.example/"><script>', 'k7m2p9xw'],
    ['javascript:alert(1)', 'k7m2p9xw'],
    ['', 'k7m2p9xw'],
    ['https://bhava.example/signup', 'short'],
    ['https://bhava.example/signup', 'UPPER123'],
    ['https://bhava.example/signup', 'a&b=c1234'],
    ['https://bhava.example/signup', ''],
  ]) assert.equal(referralLink(site, code), '', `${site} + ${code}`);

  assert.equal(platformSiteUrlOf({ platformSiteUrl: 'https://bhava.example/start', platformDomain: 'x.test' }), 'https://bhava.example/start');
  assert.equal(platformSiteUrlOf({ platformSiteUrl: '', platformAppHost: 'sellers.x.test' }), 'https://sellers.x.test/signup');
  assert.equal(platformSiteUrlOf({ platformSiteUrl: 'http://plain.example', platformDomain: 'x.test' }), 'https://app.x.test/signup', 'a site that is not https is not used');
  assert.equal(platformSiteUrlOf({ platformSiteUrl: '', platformDomain: '' }), '');
});

test('K-64, F-127: on Free the footer badge opens the sign-up page with this business’s own referral code', async (t) => {
  const w = await world(t, { plan: 'free' });
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  const reel = await addPage(w, { headline: 'Brass lamp' });
  const shelf = await addCategory(w, 'Home');
  await setPlan(w, 't2');
  await must(w, `/categories/${shelf.id}/reels`, 'POST', { pageId: reel.id });
  await setPlan(w, 'free');
  await must(w, '/creator-page', 'PATCH', { slug: 'zari', enabled: true });
  assert.deepEqual(await codesOf(w), [], 'no code until the page is first shown');

  const first = await w.page('/zari', { headers: BROWSER });
  assert.equal(first.status, 200);
  const badge = badgeOf(first.text);
  assert.ok(badge, 'the badge is a link');
  const [row] = await codesOf(w);
  assert.match(row.code, REFERRAL_CODE);
  assert.equal(badge[1], `https://app.bhava.test/signup?ref=${row.code}`);
  assert.ok(footerOf(first.text).includes(badge[0]), 'the badge is in the footer');
  assert.equal((first.text.match(/bhava/gi) ?? []).length, (footerOf(first.text).match(/bhava/gi) ?? []).length, 'the platform is named in the footer only');
  assert.equal((first.text.match(/Made with Bhava/g) ?? []).length, 1);
  assert.doesNotMatch(JSON.stringify(first.headers), /bhava/i);
  assert.doesNotMatch(/<title>([^<]*)<\/title>/.exec(first.text)[1], /bhava/i);

  // The code is made once and kept: every view of the page carries the same link.
  for (const path of ['/zari', '/zari?q=lamp', '/zari/home']) {
    const res = await w.page(path, { headers: BROWSER });
    assert.equal(res.status, 200, path);
    assert.equal(badgeOf(res.text)?.[1], badge[1], path);
  }
  assert.equal((await codesOf(w)).length, 1);
  assert.equal(await w.repos.referralCodes.code(), row.code);

  // The tiles fragment and the landing page a tile opens are not the creator page: no badge, no link.
  for (const path of ['/zari/_tiles?shelf=_more&offset=0', `/r/${reel.slug}`]) {
    const res = await w.page(path, { headers: BROWSER });
    assert.doesNotMatch(res.text, /bhava|[?&;]ref=/i, path);
  }
});

test('K-52, K-64, U-08: tier 1 and above carry no badge, no referral link and no platform name', async (t) => {
  const w = await world(t, { plan: 'free' });
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  await addPage(w, { headline: 'Brass lamp' });
  await must(w, '/creator-page', 'PATCH', { slug: 'zari', enabled: true });
  const free = await w.page('/zari', { headers: BROWSER });
  const code = (await codesOf(w))[0].code;
  assert.ok(badgeOf(free.text));

  for (const plan of ['t1', 't2', 't3', 't5']) {
    await setPlan(w, plan);
    for (const path of ['/zari', '/zari?q=lamp', '/zari/_tiles?shelf=_more&offset=0']) {
      const res = await w.page(path, { headers: BROWSER });
      assert.equal(res.status, 200, `${plan} ${path}`);
      assert.doesNotMatch(res.text, /bhava|made-with"|made with|signup/i, `${plan} ${path}`);
      assert.ok(!res.text.includes(code), `${plan} ${path} carries the referral code`);
      assert.doesNotMatch(JSON.stringify(res.headers), /bhava/i, `${plan} ${path} headers`);
    }
  }
  // Back on Free, the same code returns.
  await setPlan(w, 'free');
  assert.equal(badgeOf((await w.page('/zari', { headers: BROWSER })).text)?.[1], `https://app.bhava.test/signup?ref=${code}`);
});

test('a business’s code is its own: another business on Free gets a different one, and neither can read the other’s', async (t) => {
  const w = await world(t, { plan: 'free' });
  const other = await secondBusiness(w, { plan: 'free' });
  for (const business of [w, other]) {
    await addPage(business, { headline: 'Reel' });
    await must(business, '/creator-page', 'PATCH', { slug: 'picks', enabled: true });
  }
  const mine = badgeOf((await w.page('/picks', { headers: BROWSER })).text)[1];
  const theirs = badgeOf((await other.page('/picks', { headers: BROWSER })).text)[1];
  assert.notEqual(mine, theirs);
  assert.equal(mine, `https://app.bhava.test/signup?ref=${(await codesOf(w))[0].code}`);
  assert.equal(theirs, `https://app.bhava.test/signup?ref=${(await codesOf(w, other.tenant))[0].code}`);
  assert.equal(await bindTenant(w.platform, other.tenant).referralCodes.code(), (await codesOf(w, other.tenant))[0].code);
  assert.equal((await w.db.platform.query('SELECT count(*)::int AS n FROM seller_referral_codes'))[0].n, 2);
  // Outside a business there is no code to read.
  await assert.rejects(() => w.ctx.repos.referralCodes.code());
});

test('the badge follows PLATFORM_SITE_URL, and is words only when there is no sign-up address', async (t) => {
  const w = await world(t, { plan: 'free', overrides: { platformSiteUrl: 'https://start.example/join' } });
  await addPage(w, { headline: 'Reel' });
  await must(w, '/creator-page', 'PATCH', { slug: 'zari', enabled: true });
  const res = await w.page('/zari', { headers: BROWSER });
  assert.equal(badgeOf(res.text)?.[1], `https://start.example/join?ref=${(await codesOf(w))[0].code}`);

  const bare = await world(t, { plan: 'free', overrides: { platformSiteUrl: '', platformDomain: '', platformAppHost: '' } });
  await addPage(bare, { headline: 'Reel' });
  await must(bare, '/creator-page', 'PATCH', { slug: 'zari', enabled: true });
  const plain = await bare.page('/zari', { headers: BROWSER });
  assert.equal(plain.status, 200);
  assert.match(footerOf(plain.text), /<span class="made-with">(<svg[^>]*>.*?<\/svg>)?Made with Bhava<\/span>/);
  assert.doesNotMatch(plain.text, /<a class="made-with"/);
  assert.deepEqual(await codesOf(bare), [], 'no code is made for a link that can’t be shown');
});

test('the page is a profile: cover, photo or initials, name, about line, wide buttons, search, link blocks and tiles, in every preset', async (t) => {
  const w = await world(t, { plan: 't2' });
  await w.repos.settings.update({ store_name: 'Zari & Co', support_whatsapp: '+91 93200 01717' });
  const reel = await addPage(w, { headline: 'Brass lamp' });
  const shelf = await addCategory(w, 'Home');
  await must(w, `/categories/${shelf.id}/reels`, 'POST', { pageId: reel.id });
  await must(w, '/page-settings', 'PATCH', { whatsappOrder: true });
  await must(w, '/creator-page', 'PATCH', { slug: 'zari', enabled: true, displayName: 'Zari <picks>', bio: 'Brass, clay & cotton', websiteUrl: 'https://zari.example/shop', showWhatsapp: true });
  await must(w, '/page-blocks', 'PUT', {
    surface: 'creator',
    blocks: [
      { block: 'hero' },
      { block: 'banner', settings: { text: 'Diwali edit & more', linkUrl: 'https://zari.example/diwali' } },
      { block: 'banner', settings: { text: 'Free delivery over ₹999' } },
      { block: 'shelves' },
      { block: 'whatsapp' },
    ],
  });

  const shapes = new Set();
  for (const preset of PRESETS) {
    await must(w, '/theme', 'PUT', { preset });
    const res = await w.page('/zari', { headers: BROWSER });
    assert.equal(res.status, 200, preset);
    const text = res.text;
    assert.match(text, /<body class="creator">/, preset);
    // The profile: initials when there is no photo, the name as the one h1, the about line, then the two buttons.
    const head = /<div class="creator-cover" aria-hidden="true"><\/div>\s*<section class="creator-head" aria-labelledby="creator-name">[\s\S]*?<\/section>/.exec(text)?.[0];
    assert.ok(head, `${preset}: the profile header`);
    assert.match(head, /<span class="creator-photo"><span aria-hidden="true">ZP<\/span><\/span>/);
    assert.match(head, /<h1 id="creator-name">Zari &lt;picks&gt;<\/h1>/);
    assert.equal((text.match(/<h1\b/g) ?? []).length, 1);
    assert.match(head, /<p>Brass, clay &amp; cotton<\/p>/);
    assert.match(head, /<a class="btn" href="https:\/\/zari\.example\/shop" rel="noopener">Visit website<\/a>/);
    assert.match(head, /<a class="outline-btn" href="https:\/\/wa\.me\/919320001717" rel="noopener">.*WhatsApp<\/a>/);
    // The search field, then the link blocks as cards: a link with an arrow, and a notice with none.
    assert.match(text, /<form class="creator-search" method="get" action="\/zari" role="search">\s*<input type="search" name="q"[^>]*aria-label="Search reels and products"/);
    assert.match(text, /<a class="card creator-link" href="https:\/\/zari\.example\/diwali" rel="noopener"><span>Diwali edit &amp; more<\/span><svg/);
    assert.match(text, /<div class="card creator-link"><span>Free delivery over ₹999<\/span><\/div>/);
    assert.ok(text.indexOf('creator-head') < text.indexOf('creator-link') && text.indexOf('creator-link') < text.indexOf('creator-search'), `${preset}: blocks keep the business's order`);
    assert.match(text, new RegExp(`class="reel-tile" href="/r/${reel.slug}\\?utm_source=instagram&amp;utm_medium=bio"`));
    // The shapes this page adds come from the preset; nothing typed by the seller is in a stylesheet.
    const css = [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');
    shapes.add(`${/\.creator-photo\{(border-radius:[^}]*)\}/.exec(css)?.[1]} | ${/\.creator \.reel-tile\{([^}]*)\}/.exec(css)?.[1]}`);
    assert.doesNotMatch(css, /Zari|picks|Diwali|zari\.example/);
    assert.match(css, /\.creator \.site-header\{display:none\}/);
    assert.doesNotMatch(text, /bhava/i, `${preset}: a paid page names the seller only`);
  }
  assert.equal(shapes.size, PRESETS.length, `each preset draws the photo and tiles its own way: ${[...shapes].join(' ; ')}`);
});

test('a link block with a picture shows it beside the words, and the photo is the page’s first image', async (t) => {
  const w = await world(t, { plan: 't2' });
  await addPage(w, { headline: 'Reel' });
  const photo = await addMedia(w);
  const art = await addMedia(w);
  await must(w, '/creator-page', 'PATCH', { slug: 'zari', enabled: true, photoUrl: `/media/${photo}` });
  await must(w, '/page-blocks', 'PUT', {
    surface: 'creator',
    blocks: [{ block: 'hero' }, { block: 'banner', settings: { text: 'All reels', imageUrl: `/media/${art}`, linkUrl: '/reels' } }, { block: 'shelves' }],
  });
  const { text } = await w.page('/zari', { headers: BROWSER });
  assert.match(text, new RegExp(`<span class="creator-photo"><img src="/media/${photo}/card" alt="" width="120" height="120" decoding="async"></span>`));
  assert.match(text, new RegExp(`<a class="card creator-link" href="/reels"><img src="/media/${art}" alt="" width="52" height="52" loading="lazy" decoding="async"><span>All reels</span><svg`));
  assert.ok(text.indexOf(`/media/${photo}`) < text.indexOf('<img', text.indexOf(`/media/${photo}`) + 1), 'the photo comes first');
});
