// The pure rules behind landing pages and themes: what media a page shows, block settings, colours read from a website, and
// the accent tuned from a logo. No database and no network.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUYER_BLOCKS, DEFAULT_BLOCKS } from '../../../src/contracts/buyer-pages.js';
import { contrastRatio } from '../../../src/modules/brand/theme.js';
import { BLOCK_SETTINGS, checkBlocks, renderSharedBlock } from '../../../src/modules/pages/blocks.js';
import { heroMedia, kindOfMedia, mediaColumns, shareSource, storyExpired } from '../../../src/modules/pages/media.js';
import { ROBOTS_TXT } from '../../../src/modules/pages/routes.js';
import { previewVersion } from '../../../src/modules/pages/share.js';
import { productHref } from '../../../src/modules/pages/view.js';
import { dominantColor, tuneAccent } from '../../../src/modules/themes/accent.js';
import { websiteAddress } from '../../../src/modules/themes/api.js';
import { extractLook, lookColors, mapFont, parseColor } from '../../../src/modules/themes/site-read.js';
import { buyerTheme } from '../../../src/views/buyer/index.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-10T12:00:00Z');
const theme = buyerTheme({});

// ---- media ----------------------------------------------------------------------------------------------------------

test('8.10: a page shows media_url, else the thumbnail for a video, else a link to the post', () => {
  const base = { kind: 'reel', products: [{ image_url: '/media/p1' }], permalink: 'https://www.instagram.com/reel/x/' };
  assert.deepEqual(heroMedia({ ...base, media_type: 'VIDEO', media_url: 'https://cdn.example/v.mp4', thumbnail_url: 'https://cdn.example/t.jpg' }, NOW), { imageUrl: 'https://cdn.example/t.jpg', videoUrl: 'https://cdn.example/v.mp4', linkUrl: '' });
  assert.deepEqual(heroMedia({ ...base, media_type: 'VIDEO', media_url: '', thumbnail_url: 'https://cdn.example/t.jpg' }, NOW), { imageUrl: 'https://cdn.example/t.jpg', videoUrl: '', linkUrl: base.permalink });
  assert.deepEqual(heroMedia({ ...base, media_type: 'IMAGE', media_url: 'https://cdn.example/i.jpg', thumbnail_url: '' }, NOW), { imageUrl: 'https://cdn.example/i.jpg', videoUrl: '', linkUrl: base.permalink });
  assert.deepEqual(heroMedia({ ...base, media_type: '', media_url: '', thumbnail_url: '' }, NOW), { imageUrl: '/media/p1', videoUrl: '', linkUrl: base.permalink }, 'with nothing from Instagram, a product photo and the link');
  // A Phase 0 row has no media type, only the old video address.
  assert.equal(heroMedia({ ...base, media_type: '', video_url: 'https://cdn.example/old.mp4', thumbnail_url: 'https://cdn.example/t.jpg' }, NOW).videoUrl, 'https://cdn.example/old.mp4');
});

test('K-31, 4.14: a story has an expiry, is never offered once past it, and its picture is never the share image', () => {
  const posted = new Date(NOW.getTime() - 2 * HOUR);
  const live = mediaColumns({ media_type: 'IMAGE', media_url: 'https://cdn.example/story.jpg', timestamp: posted.toISOString(), permalink: 'https://www.instagram.com/stories/x/1/' }, 'story', NOW);
  assert.equal(live.expires_at.getTime(), posted.getTime() + 24 * HOUR);
  assert.equal(live.media_url, 'https://cdn.example/story.jpg');
  const over = mediaColumns({ media_type: 'VIDEO', media_url: 'https://cdn.example/story.mp4', thumbnail_url: 'https://cdn.example/s.jpg', timestamp: new Date(NOW.getTime() - 30 * HOUR).toISOString() }, 'story', NOW);
  assert.deepEqual([over.media_url, over.thumbnail_url, over.video_url], ['', '', ''], 'a story already over is saved with no media address');
  const unknown = mediaColumns({}, 'story', NOW);
  assert.equal(unknown.expires_at.getTime(), NOW.getTime() + 24 * HOUR, 'with no time from Instagram the clock starts now');
  assert.equal(mediaColumns({ timestamp: posted.toISOString() }, 'reel', NOW).expires_at, null);

  const page = { kind: 'story', ...live, cover_media_id: null, products: [{ image_url: '' }, { image_url: '/media/p2' }] };
  assert.equal(storyExpired(page, NOW), false);
  assert.equal(heroMedia(page, NOW).imageUrl, 'https://cdn.example/story.jpg');
  assert.equal(heroMedia(page, NOW).linkUrl, '', 'a story has no lasting link');
  const later = new Date(live.expires_at.getTime() + 1);
  assert.equal(storyExpired(page, later), true);
  assert.deepEqual(heroMedia(page, later), { imageUrl: '/media/p2', videoUrl: '', linkUrl: '' });
  assert.equal(heroMedia({ ...page, cover_media_id: 'abc' }, later).imageUrl, '/media/abc');
  assert.equal(shareSource(page), '/media/p2', 'never the story itself, even while it is up');
  assert.equal(shareSource({ ...page, kind: 'reel', thumbnail_url: 'https://cdn.example/t.jpg' }), 'https://cdn.example/t.jpg');
  assert.equal(shareSource({ ...page, kind: 'reel', thumbnail_url: 'https://cdn.example/t.jpg', cover_media_id: 'abc' }), '/media/abc');
});

test('media from Instagram is kept only as plain https addresses of the known types', () => {
  const odd = mediaColumns({ media_type: 'SVG', media_url: 'javascript:alert(1)', thumbnail_url: 'http://plain.example/t.jpg', permalink: 'https://x.example/"><script>', caption: 'c'.repeat(900), timestamp: 'not a date' }, 'post', NOW);
  assert.deepEqual([odd.media_type, odd.media_url, odd.thumbnail_url, odd.permalink, odd.posted_at], ['', '', '', '', null]);
  assert.equal(odd.caption.length, 500);
  assert.deepEqual(['REELS', 'STORY', 'FEED', undefined].map((type) => kindOfMedia({ media_product_type: type })), ['reel', 'story', 'post', 'post']);
});

test('K-39: the preview\'s version follows the picture and the ground colour, and nothing else', () => {
  const page = { id: 1, kind: 'reel', thumbnail_url: 'https://cdn.example/a.jpg', headline: 'A', products: [] };
  const version = previewVersion(page, theme);
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(previewVersion({ ...page, headline: 'B' }, theme), version);
  assert.notEqual(previewVersion({ ...page, thumbnail_url: 'https://cdn.example/b.jpg' }, theme), version);
  assert.notEqual(previewVersion(page, buyerTheme({ colors: { ground: '#000000' } })), version);
});

test('6.6, K-32, K-63: a product button is the destination itself, tagged only where the rules say', () => {
  const page = { slug: 'kitchen', channel: 'instagram', ig_media_id: '179' };
  assert.equal(productHref({ external_url: 'https://shop.example/p?size=m&utm_source=newsletter', slug: 'p' }, page), 'https://shop.example/p?size=m&utm_source=newsletter&utm_medium=dm&utm_campaign=kitchen&utm_content=179', 'tags already there win');
  assert.equal(productHref({ external_url: 'https://shop.example/p', slug: 'p' }, page, { utmEnabled: false }), 'https://shop.example/p');
  assert.equal(productHref({ external_url: 'https://www.amazon.in/dp/B0TEST?th=1', slug: 'p' }, page), 'https://www.amazon.in/dp/B0TEST?th=1', 'an Amazon link is left exactly as saved');
  assert.equal(productHref({ external_url: 'https://shop.example/p', slug: 'p' }, { ...page, channel: 'facebook' }, { campaign: 'diwali' }), 'https://shop.example/p?utm_source=facebook&utm_medium=dm&utm_campaign=diwali&utm_content=179');
  assert.equal(productHref({ external_url: '', slug: 'brass pot' }, page), '/r/kitchen/p/brass%20pot');
});

test('8.12: robots.txt names the preview crawlers and never the platform', () => {
  for (const agent of ['facebookexternalhit', 'meta-externalagent', 'WhatsApp', 'Twitterbot']) assert.ok(ROBOTS_TXT.includes(`User-agent: ${agent}\nAllow: /\n`), agent);
  assert.doesNotMatch(ROBOTS_TXT, /bhava/i);
  assert.match(ROBOTS_TXT, /User-agent: \*\n(Disallow: \S+\n)+Allow: \/\n/);
});

// ---- blocks (5.18) --------------------------------------------------------------------------------------------------

test('5.18: every block has a settings schema, and the default layouts are made of blocks allowed on their surface', () => {
  assert.deepEqual(Object.keys(BLOCK_SETTINGS).sort(), Object.keys(BUYER_BLOCKS).sort());
  for (const [surface, blocks] of Object.entries(DEFAULT_BLOCKS)) {
    assert.doesNotThrow(() => checkBlocks(surface, blocks.map((block) => ({ block, visible: true, settings: {} }))), surface);
  }
});

test('5.18: a block\'s settings are plain values; markup, script, unknown keys and blocks from another surface are refused', () => {
  const ok = checkBlocks('landing', [
    { block: 'hero', settings: {} },
    { block: 'faq', settings: { items: [{ q: 'Do you ship?', a: 'Yes, across India.' }] } },
    { block: 'countdown', visible: false, settings: { text: 'Sale ends soon', endsAt: '2026-12-01T10:00:00+05:30' } },
    { block: 'trust', settings: { items: [{ label: 'Cash on delivery', icon: 'cash' }] } },
  ]);
  assert.deepEqual(ok.map((b) => [b.block, b.visible]), [['hero', true], ['faq', true], ['countdown', false], ['trust', true]]);
  const refused = (surface, block, pattern) => assert.throws(() => checkBlocks(surface, [block]), (err) => err.code === 'validation_failed' && pattern.test(JSON.stringify(err.fields)), JSON.stringify(block));
  refused('landing', { block: 'faq', settings: { items: [{ q: '<script>alert(1)</script>', a: 'x' }] } }, /plain words/);
  refused('landing', { block: 'faq', settings: { items: [{ q: 'Q', a: 'x' }], css: 'body{display:none}' } }, /blocks\.0\.settings/);
  refused('landing', { block: 'hero', settings: { html: '<b>hi</b>' } }, /blocks\.0\.settings/);
  refused('landing', { block: 'countdown', settings: { text: 'Sale', endsAt: 'tomorrow' } }, /endsAt/);
  refused('landing', { block: 'testimonials', settings: { items: [{ quote: 'Lovely', name: 'A' }] } }, /can’t go on this page/);
  refused('store_home', { block: 'banner', settings: { text: 'Sale', linkUrl: 'javascript:alert(1)' } }, /linkUrl/);
  refused('store_home', { block: 'banner', settings: { text: 'Sale', imageUrl: 'https://x.example/a.png" onerror="alert(1)' } }, /imageUrl/);
  refused('store_home', { block: 'video', settings: { url: 'http://plain.example/v.mp4' } }, /url/);
  assert.throws(() => checkBlocks('landing', [{ block: 'hero', settings: {} }, { block: 'hero', settings: {} }]), /once/);
  assert.throws(() => checkBlocks('landing', [{ block: 'no_such_block', settings: {} }]), /can’t go on this page/);
});

test('F-99: a shared block draws only what its settings say, escaped, and a row that no longer fits draws nothing', () => {
  const faq = String(renderSharedBlock({ block: 'faq', settings: { items: [{ q: 'Do you ship & deliver?', a: 'Yes' }] } }, { theme }));
  assert.match(faq, /<summary>Do you ship &amp; deliver\?<\/summary><p>Yes<\/p>/);
  // A row written before a rule changed, or by hand: nothing of it reaches the page.
  assert.equal(String(renderSharedBlock({ block: 'faq', settings: { items: [{ q: '<script>alert(1)</script>', a: 'x' }] } }, { theme })), '');
  assert.equal(String(renderSharedBlock({ block: 'banner', settings: { text: 'Sale', linkUrl: 'javascript:alert(1)' } }, { theme })), '');
  assert.equal(String(renderSharedBlock({ block: 'made_up', settings: {} }, { theme })), '');

  const countdown = { block: 'countdown', settings: { text: 'Diwali sale', endsAt: '2026-11-12T18:00:00+05:30' } };
  assert.match(String(renderSharedBlock(countdown, { theme, now: NOW })), /Diwali sale<\/span><time datetime="2026-11-12T12:30:00\.000Z">Ends 12 Nov, 6:00 pm<\/time>/);
  assert.equal(String(renderSharedBlock(countdown, { theme, now: new Date('2026-11-13T00:00:00Z') })), '', 'an ended sale isn\'t advertised');

  const banner = String(renderSharedBlock({ block: 'banner', settings: { text: 'New in', imageUrl: '/media/abc', linkUrl: '/c/new' } }, { theme }));
  assert.match(banner, /<a class="banner" href="\/c\/new"><img src="\/media\/abc" alt="" width="520" height="260" loading="lazy"/);
  const bulk = String(renderSharedBlock({ block: 'bulk_order', settings: { text: 'Ordering for an office?' } }, { theme, whatsappNumber: '919320001717' }));
  assert.match(bulk, /href="https:\/\/wa\.me\/919320001717\?text=/);
  assert.doesNotMatch(String(renderSharedBlock({ block: 'bulk_order', settings: { text: 'Ordering for an office?' } }, { theme })), /wa\.me/, 'with no number saved there is no WhatsApp button');
  assert.equal(String(renderSharedBlock({ block: 'trust', settings: {} }, { theme, trustItems: [] })), '', 'the trust row shows nothing when the seller promises nothing');
  assert.match(String(renderSharedBlock({ block: 'trust', settings: {} }, { theme, trustItems: [{ label: 'Ships across India', icon: 'truck' }] })), /Ships across India/);
  for (const html of [faq, banner, bulk]) assert.doesNotMatch(html, /bhava/i);
});

// ---- the look read from a website (8.9) ----------------------------------------------------------------------------

test('K-29: only a hex or rgb() colour is a colour; names, variables, gradients and anything carrying markup are refused', () => {
  assert.equal(parseColor('#1f4d2b'), '#1F4D2B');
  assert.equal(parseColor(' #abc '), '#AABBCC');
  assert.equal(parseColor('#1F4D2Bcc'), '#1F4D2B');
  assert.equal(parseColor('rgb(31, 77, 43)'), '#1F4D2B');
  assert.equal(parseColor('rgba(31,77,43,0.5)'), '#1F4D2B');
  assert.equal(parseColor('rgb(31 77 43 / 50%)'), '#1F4D2B');
  assert.equal(parseColor('#1F4D2B !important'), '#1F4D2B');
  for (const bad of ['red', 'red;}</style><script>alert(1)</script>', '#1F4D2B;}</style><script>', 'url(javascript:alert(1))', 'var(--x)', 'linear-gradient(#fff,#000)', 'rgb(300,0,0)', '#12345', '#GGGGGG', '', null, undefined, 'expression(alert(1))', '#fff'.repeat(20)]) {
    assert.equal(parseColor(bad), null, String(bad));
  }
});

test('8.9: a font the allow-list lacks maps to the nearest offered family', () => {
  assert.deepEqual(mapFont('Playfair Display'), { font: 'Playfair Display', exact: true });
  assert.deepEqual(mapFont('"inter"'), { font: 'Inter', exact: true });
  assert.deepEqual(mapFont('Comic Neue'), { font: 'Nunito', exact: false });
  assert.deepEqual(mapFont('Helvetica Neue', 'Helvetica Neue, Arial, sans-serif'), { font: 'Inter', exact: false });
  assert.deepEqual(mapFont('Some Unknown Serif', '"Some Unknown Serif", Georgia, serif'), { font: 'Lora', exact: false });
  assert.deepEqual(mapFont('Mystery', 'Mystery, sans-serif'), { font: 'Inter', exact: false });
  assert.deepEqual(mapFont('Courier Prime', 'Courier Prime, monospace'), { font: 'Space Grotesk', exact: false });
  assert.deepEqual(mapFont('x"></style><script>alert(1)</script>'), { font: 'Inter', exact: false });
});

const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test('K-27: theme-color, custom properties, button colours, Google Fonts and the logo are read from a homepage', () => {
  const html = page(
    '<title>Green Thumb</title><meta name="theme-color" content="#1F4D2B">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&amp;family=Inter:wght@400;600&amp;display=swap">'
    + '<link rel="stylesheet" href="/theme.css"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">'
    + '<meta property="og:image" content="https://cdn.example/og.png">'
    + '<style>:root{--color-primary:#1F4D2B;--color-text:#1A1A1A;--color-background:#FAF7F0}</style>'
    + '<script type="application/ld+json">{"@type":"Organization","logo":{"@type":"ImageObject","url":"https://brand.example/brand-logo.png"}}</script>',
    '<a class="btn" href="/shop">Shop now</a>',
  );
  const first = extractLook({ html, pageUrl: 'https://brand.example/' });
  assert.deepEqual(first.found, { primary: '#1F4D2B', on_primary: null, ground: '#FAF7F0', ink: '#1A1A1A', accent: null });
  assert.deepEqual(first.fonts, { heading: 'Playfair Display', body: 'Inter' });
  assert.deepEqual(first.logoCandidates, ['https://brand.example/brand-logo.png', 'https://brand.example/apple-touch-icon.png', 'https://cdn.example/og.png']);
  assert.deepEqual(first.stylesheets, ['https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;600&display=swap', 'https://brand.example/theme.css']);
  assert.equal(first.manifestUrl, 'https://brand.example/site.webmanifest');
  assert.equal(first.scriptOnly, false);
  assert.deepEqual(first.notes, []);

  // Its stylesheet and manifest fill in the button and add the manifest's icon.
  const full = extractLook({
    html,
    css: ['.btn,.button--primary{background:#2A6B3C;color:#FFFFFF}body{font-family:"Inter",sans-serif;color:#1A1A1A}h1,h2{font-family:"Playfair Display",serif}'],
    manifest: { theme_color: '#000000', icons: [{ src: '/icon-192.png', sizes: '192x192' }, { src: '/icon-512.png', sizes: '512x512' }, { src: '/icon.svg', sizes: '1024x1024', type: 'image/svg+xml' }] },
    pageUrl: 'https://brand.example/',
  });
  assert.equal(full.found.primary, '#2A6B3C', 'a button\'s own colour comes first');
  assert.equal(full.found.on_primary, '#FFFFFF');
  assert.ok(full.logoCandidates.includes('https://brand.example/icon-512.png'), 'the largest bitmap icon');
  assert.ok(!full.logoCandidates.some((url) => /\.svg/.test(url)), 'never an SVG');

  const { colors, notes, adjusted } = lookColors(full.found, {});
  assert.equal(colors.primary, '#2A6B3C');
  assert.equal(colors.ground, '#FAF7F0');
  assert.equal(colors.ink, '#1A1A1A');
  assert.deepEqual([notes, adjusted], [[], false]);
  for (const [text, ground] of [['ink', 'ground'], ['ink', 'card'], ['muted', 'ground'], ['on_primary', 'primary'], ['on_accent', 'accent'], ['eyebrow', 'ground']]) {
    assert.ok(contrastRatio(colors[text], colors[ground]) >= 4.5, `${text} on ${ground}`);
  }
});

test('K-28: a pair that misses 4.5:1 moves to black or white, with a note that says so', () => {
  const look = extractLook({ html: page('<style>.btn{background:#8ABE9C;color:#FFFFFF}body{color:#BBBBBB;background:#FFFFFF}</style>'), pageUrl: 'https://lowcontrast.example/' });
  assert.ok(contrastRatio('#8ABE9C', '#FFFFFF') < 2.2);
  const { colors, notes, adjusted } = lookColors(look.found, {});
  assert.equal(colors.on_primary, '#000000');
  assert.equal(colors.ink, '#000000');
  assert.ok(contrastRatio(colors.on_primary, colors.primary) >= 4.5);
  assert.ok(contrastRatio(colors.ink, colors.ground) >= 4.5);
  assert.equal(adjusted, true);
  assert.equal(notes.length, 2);
  assert.match(notes.join(' '), /The button text was 2\.\d:1 against its background, so it was changed to black/);
  // On a dark button the move is to white.
  assert.equal(lookColors({ primary: '#1F2A44', on_primary: '#333333' }, {}).colors.on_primary, '#FFFFFF');
});

test('K-29: a page whose colours and fonts carry markup yields nothing but safe values', () => {
  const bad = 'red;}</style><script>alert(1)</script>';
  const look = extractLook({
    html: page(`<meta name="theme-color" content="${bad}"><style>:root{--color-primary:${bad};--brand:url(javascript:alert(1))}h1{font-family:"x</style><script>alert(2)</script>", serif}</style>`
      + '<link rel="apple-touch-icon" href="javascript:alert(3)"><meta property="og:image" content="data:text/html,<script>alert(4)</script>">', `<button style="background:${bad}">Buy</button>`),
    pageUrl: 'https://inject.example/',
  });
  assert.deepEqual(look.found, { primary: null, on_primary: null, ground: null, ink: null, accent: null });
  assert.deepEqual(look.logoCandidates, []);
  assert.deepEqual(lookColors(look.found, {}).colors, {});
  assert.doesNotMatch(JSON.stringify(look), /<script|javascript:|<\/style/i);
});

test('8.9: a page that is all JavaScript is told apart from one that simply states no colours', () => {
  const app = extractLook({ html: page('<title>App Shop</title><link rel="apple-touch-icon" href="/icon.png"><script src="/bundle.js" defer></script>', '<div id="root"></div><noscript>Turn on JavaScript.</noscript>'), pageUrl: 'https://scriptonly.example/' });
  assert.equal(app.scriptOnly, true);
  assert.deepEqual(app.logoCandidates, ['https://scriptonly.example/icon.png']);
  const plain = extractLook({ html: page('<title>Plain</title>', `<p>${'Words about the shop. '.repeat(20)}</p><script src="/a.js"></script>`), pageUrl: 'https://plain.example/' });
  assert.equal(plain.scriptOnly, false);
  assert.equal(plain.anyColour, false);
});

test('8.9: a page built to be slow to read is read in bounded time, and still gives up what it honestly states', () => {
  const MB = 1024 * 1024;
  const hostile = [
    '<meta '.repeat(MB / 3),
    '<style>'.repeat(MB / 4),
    `<style>${'a{'.repeat(MB / 2)}</style>`,
    `<style>${'--x:'.repeat(MB / 2)}</style>`,
    `<style>${'.btn'.repeat(MB / 2)}</style>`,
    '<script type="application/ld+json">'.repeat(40_000),
    `<script src="/a.js"></script>${'<'.repeat(2 * MB)}`,
    `<a class="${'btn '.repeat(MB / 4)}" style="${'background:'.repeat(MB / 11)}">x</a>`,
    `<link rel="stylesheet" href="${'/a'.repeat(MB)}">`,
    `<style>/*${'*'.repeat(MB)}</style>`,
    `<meta name="theme-color" content="#1F4D2B">${'<meta<link<style<script<button<a '.repeat(60_000)}`,
  ];
  for (const [i, html] of hostile.entries()) {
    const started = performance.now();
    const look = extractLook({ html, css: ['a{'.repeat(MB), `${'x'.repeat(2 * MB)}{color:#111111}`], pageUrl: 'https://slow.example/' });
    assert.ok(performance.now() - started < 3000, `page ${i} took ${Math.round(performance.now() - started)} ms`);
    assert.doesNotMatch(JSON.stringify(look.found), /[<>]/);
  }
  assert.equal(extractLook({ html: hostile.at(-1), pageUrl: 'https://slow.example/' }).found.primary, '#1F4D2B');
  // Rules inside @media are still read, and a comment in a selector doesn't hide it.
  const nested = extractLook({ html: page('<style>@media (min-width:1px){ /* buttons */ .btn{background:#2A6B3C;color:#fff} } body{color:#111;background:#fafafa}</style>'), pageUrl: 'https://nested.example/' });
  assert.deepEqual(nested.found, { primary: '#2A6B3C', on_primary: '#FFFFFF', ground: '#FAFAFA', ink: '#111111', accent: null });
});

test('8.9: a website address is an http(s) site, with https:// added when left off', () => {
  assert.equal(websiteAddress('brand.example'), 'https://brand.example/');
  assert.equal(websiteAddress('  http://brand.example/home  '), 'http://brand.example/home');
  for (const bad of ['javascript:alert(1)', 'ftp://brand.example', 'https://user:pass@brand.example/', 'https://', `https://brand.example/${'a'.repeat(600)}`, 'file:///etc/passwd']) {
    assert.throws(() => websiteAddress(bad), (err) => err.code === 'validation_failed', bad);
  }
});

// ---- the accent tuned from a logo (5.19) ---------------------------------------------------------------------------

function pixels(spec) {
  const out = [];
  for (const [hex, count, alpha = 255] of spec) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < count; i++) out.push(...rgb, alpha);
  }
  return Uint8Array.from(out);
}

test('F-102: a logo\'s main colour is its most common colourful one; background, ink and see-through pixels don\'t count', () => {
  assert.equal(dominantColor(pixels([['#FFFFFF', 700], ['#111111', 150], ['#1F6F5C', 100], ['#D9534F', 50]])), '#1F6F5C');
  assert.equal(dominantColor(pixels([['#D9534F', 60], ['#1F6F5C', 500, 0], ['#FFFFFF', 40]])), '#D9534F', 'transparent pixels are skipped');
  assert.equal(dominantColor(pixels([['#FFFFFF', 500], ['#222222', 480], ['#808080', 15], ['#D9534F', 5]])), null, 'a black and white logo has no accent to give');
  assert.equal(dominantColor(new Uint8Array(0)), null);
  assert.equal(dominantColor(Uint8Array.from([31, 111, 92, 31, 111, 92]), { channels: 3 }), '#1F6F5C');
});

test('F-104: an accent text can\'t be read on is darkened until it passes 4.5:1; one that already passes is left alone', () => {
  const tadka = { ground: '#FFF8E6', on_accent: '#2B1406' };
  const failing = tuneAccent('#D9534F', tadka);
  assert.ok(contrastRatio('#D9534F', tadka.on_accent) < 4.5 && contrastRatio('#D9534F', '#FFFFFF') < 4.5, 'the logo colour fails with dark and with white text');
  assert.equal(failing.changed, true);
  assert.equal(failing.on_accent, '#FFFFFF');
  assert.ok(contrastRatio(failing.accent, failing.on_accent) >= 4.5);
  assert.ok(contrastRatio(failing.accent, '#000000') < contrastRatio('#D9534F', '#000000'), 'it was darkened');

  assert.deepEqual(tuneAccent('#FFE45C', tadka), { accent: '#FFE45C', on_accent: '#2B1406', changed: false });
  assert.deepEqual(tuneAccent('#1B2A6B', tadka), { accent: '#1B2A6B', on_accent: '#FFFFFF', changed: false }, 'a dark colour takes white text as it is');

  // On a dark preset prices are written in the accent, so it must read on the dark ground: it is lightened, with dark text on it.
  const dark = tuneAccent('#1B2A6B', { ground: '#0E1120', on_accent: '#0E1120' });
  assert.equal(dark.changed, true);
  assert.ok(contrastRatio(dark.accent, '#0E1120') >= 4.5);
  assert.ok(contrastRatio(dark.accent, dark.on_accent) >= 4.5);

  for (let i = 0; i < 300; i++) {
    const colour = `#${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
    for (const preset of [tadka, { ground: '#0E1120', on_accent: '#0E1120' }, { ground: '#FFF5F6', on_accent: '#3A1626' }]) {
      const tuned = tuneAccent(colour, preset);
      assert.ok(tuned && contrastRatio(tuned.accent, tuned.on_accent) >= 4.5, `${colour} on ${preset.ground}`);
    }
  }
  assert.equal(tuneAccent('red', tadka), null);
  assert.equal(tuneAccent(null, tadka), null);
});
