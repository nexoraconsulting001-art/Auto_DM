// The one shared buyer layout (PRD 5.18, 5.19): the seller's brand only, the same sections in every preset, and nothing a seller
// or a website typed can break out of the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerPage, buyerTheme, hero, loadBuyerLayout, notFoundPage, priceText, productCard, safeHref, section, sendBuyerPage, ticker, tileStrip, trustRow } from '../../../src/views/buyer/index.js';
import { html } from '../../../src/views/html.js';
import { setup } from '../../helpers.js';

const PRESETS = ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti'];

function landing(theme, { name = 'Zari and Co', product = 'Banarasi silk saree' } = {}) {
  const main = html`${hero({ theme, eyebrow: 'New in', title: 'The Banarasi', highlight: 'Edit', media: { imageUrl: 'https://cdn.example/reel.jpg', linkUrl: 'https://www.instagram.com/reel/x' }, tags: [{ text: 'Saree · ₹4,899' }] })}
${ticker(theme)}
${section({ theme, id: 'products-h', kicker: 'In the reel', title: 'Shop it piece by piece', body: [1, 2].map((n) => productCard({ name: product, number: n, imageUrl: 'https://cdn.example/p.jpg', price: priceText({ pricePaise: 489900, mrpPaise: 749900 }), href: 'https://zari.example/saree', productId: 7 })) })}
${section({ theme, id: 'more-h', title: 'More reels', body: tileStrip({ items: [{ href: '/r/potli', label: 'Potli', imageUrl: 'https://cdn.example/t.jpg' }] }) })}
${trustRow([{ label: 'Ships across India', icon: 'truck' }])}`;
  return String(buyerPage({ theme, business: { name }, meta: { title: `The Banarasi Edit · ${name}`, description: 'Shop the reel', url: 'https://zari.example/r/banarasi?utm_source=instagram', image: { url: 'https://zari.example/media/abc', width: 1200, height: 630 } }, main, footer: { note: 'Ships from Varanasi', whatsappHref: 'https://wa.me/919320001717' } }));
}

async function presetKits() {
  const { db, repos } = await setup();
  const kits = {};
  for (const code of PRESETS) {
    await repos.brandKit.save({ preset: code });
    kits[code] = await repos.brandKit.get();
  }
  return { db, repos, kits };
}

/** The page's structure: element names and their labels, ids and classes that name sections, with every style removed. */
const skeleton = (page) => page.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<link[^>]+fonts\.googleapis[^>]+>/, '').match(/<(header|main|section|footer|article|h1|h2|h3|div class="ticker"|nav)\b[^>]*>/g).map((tag) => tag.replace(/\s(style|content|href|src)="[^"]*"/g, ''));

test('F-105: the same page in all five presets has the same sections in the same order; only the look differs', async () => {
  const { kits } = await presetKits();
  const pages = Object.fromEntries(PRESETS.map((code) => [code, landing(buyerTheme(kits[code]))]));
  const first = skeleton(pages.utsav);
  for (const code of PRESETS) assert.deepEqual(skeleton(pages[code]), first, code);
  const styles = new Set(PRESETS.map((code) => /<style>([\s\S]*?)<\/style>/.exec(pages[code])[1]));
  assert.equal(styles.size, 5, 'each preset looks different');
  assert.match(pages.tadka, /Bricolage\+Grotesque/);
  assert.match(pages['gadget-galli'], /color-scheme:dark/);
});

test('K-34, K-52: a buyer page carries the seller\'s brand only, never the platform\'s', async () => {
  const { kits } = await presetKits();
  for (const code of PRESETS) {
    const page = landing(buyerTheme(kits[code]));
    assert.doesNotMatch(page, /bhava/i, code);
    assert.match(page, /Zari and Co/);
  }
  assert.doesNotMatch(String(notFoundPage({ theme: buyerTheme(kits.utsav), business: { name: 'Zari and Co' } })), /bhava/i);
  const sent = {};
  const res = { locals: {}, set(k, v) { sent[k.toLowerCase()] = v; return this; }, status(s) { sent.status = s; return this; }, type(t) { sent.type = t; return this; }, send(b) { sent.body = b; return this; } };
  sendBuyerPage(res, landing(buyerTheme(kits.utsav)), { page: { kind: 'creator', ref: 'priya' } });
  assert.deepEqual(res.locals.page, { kind: 'creator', ref: 'priya' });
  assert.doesNotMatch(JSON.stringify(sent).replace(sent.body, ''), /bhava/i, 'no header names it either');
});

test('K-38: the share tags are early in the head, with og:url free of the query string', () => {
  const page = landing(buyerTheme({}));
  const head = page.slice(0, page.indexOf('<style>'));
  for (const tag of ['og:url', 'og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:type', 'twitter:card']) assert.match(head, new RegExp(`(property|name)="${tag}"`), tag);
  assert.match(head, /property="og:url" content="https:\/\/zari\.example\/r\/banarasi"/);
  assert.match(head, /name="robots" content="noindex,follow"/, 'noindex by default (8.12)');
  assert.match(String(buyerPage({ theme: buyerTheme({}), business: { name: 'Priya' }, meta: { title: 'Priya', indexable: true } })), /content="index,follow"/);
});

test('K-29: colours, fonts and slots carrying markup can\'t reach the stylesheet; text and links are escaped', async () => {
  const theme = buyerTheme({
    colors: { primary: 'red;}</style><script>alert(1)</script>', ground: '#FFF' },
    headingFont: "Inter'}</style><script>",
    slots: { reelFrame: 'arch;}</style><script>', radius: '4px;}</style>', sealText: '</text><script>alert(2)</script>' },
    logoUrl: 'javascript:alert(3)',
  });
  const page = String(buyerPage({
    theme,
    business: { name: '<img src=x onerror=alert(4)>' },
    meta: { title: '</title><script>alert(5)</script>', url: 'javascript:alert(6)' },
    main: html`${hero({ theme, title: '<script>alert(7)</script>', media: { imageUrl: 'javascript:alert(8)', linkUrl: '//evil.example/' } })}${productCard({ name: '"><script>alert(9)</script>', href: 'javascript:alert(10)', price: priceText({ pricePaise: 100 }) })}`,
  }));
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /javascript:/i);
  assert.doesNotMatch(page, /href="\/\/evil/);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /--primary:#7A1F3D/, 'a broken colour falls back to the default preset');
  for (const bad of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', ' https://x.example/a b', 'https://x.example/"onmouseover=x']) assert.equal(safeHref(bad), '', bad);
  for (const good of ['https://x.example/p?a=1&b=2', '/r/brunch', 'https://wa.me/919320001717?text=Hi%20there']) assert.equal(safeHref(good), good);
});

test('F-106: the seller\'s seal text and ticker show on the page; the preset\'s show when they set none', async () => {
  const { repos } = await presetKits();
  await repos.brandKit.save({ preset: 'mitti', sealText: 'Handmade in Kutch', tickerItems: ['Natural clay', 'Fair wages'] });
  const { theme } = await loadBuyerLayout(repos);
  const page = landing(theme);
  assert.match(page, /Handmade in Kutch · Handmade in Kutch/);
  assert.match(page, /Natural clay/);
  await repos.brandKit.save({ sealText: '', tickerItems: [] });
  assert.match(landing((await loadBuyerLayout(repos)).theme), /Handmade · Natural · Crafted/);
  await assert.rejects(() => repos.brandKit.save({ sealText: 'Hand<b>made</b>' }), /plain words/);
  await assert.rejects(() => repos.brandKit.save({ tickerItems: Array.from({ length: 9 }, (_, i) => `Point ${i}`) }), /at most 8/);
  const kit = await repos.brandKit.get();
  assert.equal(kit.preset, 'mitti', 'a refused save changes nothing');
  assert.equal(kit.slots.reelFrame, 'pebble');
});

test('a sold-out card says so, a discount shows as -N%, and images below the first wait to load', () => {
  const theme = buyerTheme({});
  const card = String(productCard({ name: 'Pot', imageUrl: 'https://cdn.example/p.jpg', price: priceText({ pricePaise: 59900, mrpPaise: 79900, soldOut: true }), href: '/r/x/p/pot', productId: 3 }));
  assert.match(card, /Sold out/);
  assert.match(card, /-25%/);
  assert.match(card, /₹799/);
  assert.match(card, /loading="lazy"/);
  assert.match(card, /data-product="3"/);
  assert.doesNotMatch(String(hero({ theme, title: 'x', media: { imageUrl: 'https://cdn.example/a.jpg' } })), /loading="lazy"/, 'the hero is the largest paint and loads first');
  assert.deepEqual(priceText({ pricePaise: 34900 }), { now: '₹349', was: '', off: '', soldOut: false });
});
