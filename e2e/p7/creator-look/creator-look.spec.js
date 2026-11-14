// The creator page in a real browser at phone size (PRD 8.14), as Instagram's in-app browser opens it from a bio link: every
// preset passes axe with nothing off the side of the screen and every button big enough to tap, the Free plan's badge is a
// link in the footer and a paid page has none, and the page reaches LCP under 2.5 s on throttled 4G.
//
// Set CREATOR_SHOTS_DIR to a folder outside the repo to also save a full-page picture of each preset there:
// creator-<preset>.png is the Free plan's page (with the badge), creator-<preset>-full.png a paid page with WhatsApp, a link
// block and the lead form switched on. The browser cannot reach the internet, so web fonts fall back to the device's own.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

// See e2e/p3/pages/landing.spec.js: sharp must be loaded with require before the app imports it inside Playwright's worker,
// and a launch option of its own gives this file its own worker. The dead proxy that keeps the browser off the internet stays.
// semver is in the same position (a package that requires itself in a circle), reached through the app's imports, so the app's
// test support is imported only after both are in require's cache.
const require = createRequire(import.meta.url);
require('semver');
require('sharp');
const { addProduct, setPlan, shop } = await import('../../../test/p3/pages/support.js');

const INSTAGRAM_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A346E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android (33/13; 420dpi; 1080x2340; samsung; SM-A346E; a34x; mt6877; en_IN; 548323740)';
const SLOW_4G = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const MID_RANGE_CPU = { rate: 4 };
const LCP_BUDGET_MS = 2500;
const REPEATS = 3;
const PRESETS = ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti'];
const SHOTS = process.env.CREATOR_SHOTS_DIR ? path.resolve(process.env.CREATOR_SHOTS_DIR) : '';

test.use({ userAgent: INSTAGRAM_ANDROID, launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--disable-features=CreatorLookOwnWorker'] } });

/** A photo-like PNG: a soft two-colour sweep with a lit spot, so tiles look like reel covers and cost what a real one costs. */
function picture(from, to, width = 360, height = 640) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(from), rgb(to)];
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const sweep = (x / width) * 0.35 + (y / height) * 0.65;
      const spot = Math.max(0, 1 - Math.hypot(x - width * 0.62, y - height * 0.36) / (width * 0.6)) * 46;
      const grain = ((x * 7 + y * 13) % 5) - 2;
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(a[c] + (b[c] - a[c]) * sweep + spot + grain)));
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** node:test's `t.after`, for a Playwright test: everything registered is closed when the test ends. */
function closer() {
  const closing = [];
  return { after: (fn) => closing.push(fn), close: async () => { for (const fn of closing.reverse()) await fn(); } };
}

const SHELVES = [
  ['Festive edit', [['Silk dupatta, three ways', '#8C2F4B', '#F2C078'], ['Brass diya set', '#B5651D', '#FFE2A8'], ['Mirror-work potli', '#5B2A86', '#F4A6C0'], ['Gota patti kurta', '#A63A50', '#FBD5B0'], ['Jhumka haul under ₹499', '#24526B', '#F6D186']]],
  ['Kitchen', [['Steel bottle that stays cold', '#2E5E4E', '#CFE8D5'], ['Masala box, labelled', '#9C4A1A', '#F3D9B1'], ['Cast iron tawa care', '#3B3B46', '#C9CCD6'], ['Ten-minute lunch boxes', '#C2572B', '#FFE6C7']]],
];
const LOOSE = [['Desk makeover', '#31456A', '#DDE6F5'], ['Monsoon skincare', '#3F7C74', '#E3F3EE'], ['Weekend market finds', '#7A4B2A', '#F1DEC4']];

/** A business with a full creator page: a photo, an about line, both buttons, a link block, two shelves, loose reels, a lead form. */
async function creatorShop(t) {
  const s = await shop(t, { plan: 't2', whatsapp: '+91 93200 01717' });
  const must = async (method, pathname, body) => {
    const res = await s.api(method, pathname, body);
    expect(res.status, `${method} ${pathname}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body;
  };
  await s.repos.settings.update({ store_name: 'Zari and Co' });
  await must('PATCH', '/page-settings', { whatsappOrder: true });
  let n = 0;
  const reel = async ([headline, from, to]) => {
    const cover = await s.api.upload(picture(from, to));
    const image = await s.api.upload(picture(to, from, 240, 240));
    const product = await addProduct(s.app, s.repos, s.tenant, { name: `${headline} pick`, price: String(349 + (n += 1) * 50), mrp: '999', externalUrl: `https://shop.example/p/${n}`, image });
    // A reel with its landing page, as a sync from the account leaves it: the cover is the tile's picture.
    const mediaId = String(17_900_000_000_007_000n + BigInt(n));
    await s.repos.reels.save(mediaId, { headline, keywords: 'LINK', productIds: [product.id], active: 'on', caption: '', thumbnail_url: cover });
    return (await s.app.db.platform.query('SELECT id FROM reels WHERE ig_media_id = $1', [mediaId]))[0];
  };
  for (const [name, reels] of SHELVES) {
    const category = await must('POST', '/categories', { name });
    for (const item of reels) await must('POST', `/categories/${category.id}/reels`, { pageId: (await reel(item)).id });
  }
  for (const item of LOOSE) await reel(item);
  await must('PATCH', '/creator-page', {
    slug: 'zari',
    enabled: true,
    displayName: 'Zari picks',
    bio: 'Handpicked festive wear, kitchen finds and small-shop favourites. New reels every week.',
    photoUrl: await s.api.upload(picture('#7A1F3D', '#F5B83D', 240, 240)),
    websiteUrl: 'https://zari.example/shop',
    showWhatsapp: true,
  });
  await must('PUT', '/page-blocks', {
    surface: 'creator',
    blocks: [{ block: 'hero' }, { block: 'banner', settings: { text: 'The Diwali edit is live', linkUrl: 'https://zari.example/diwali' } }, { block: 'shelves' }, { block: 'lead_form' }, { block: 'whatsapp' }],
  });
  await must('PATCH', '/lead-forms', { surface: 'creator', enabled: true, offerLine: 'Be first to hear about new drops' });
  return { ...s, must, url: `${s.app.base}/zari` };
}

/** Scrolls the whole page so every lazy picture and later tile has loaded, then returns to the top. */
async function settle(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(window.innerHeight * 0.8)) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
    await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }))));
  });
}

/** What every preset must get right on a phone. */
async function checkPhonePage(page, label) {
  await expect(page.locator('h1'), label).toHaveText('Zari picks');
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: nothing off the side`).toBe(true);
  // Every image arrived from this machine: a broken picture would be a hole in the page.
  expect(await page.evaluate(() => [...document.images].filter((img) => !img.naturalWidth).length), `${label}: broken pictures`).toBe(0);
  // Things a thumb taps are at least 44 px tall and, apart from text links, 44 px wide.
  const small = await page.evaluate(() => [...document.querySelectorAll('.creator-links a, .creator-search button, .creator-search input, .chips a, a.creator-link, .reel-tile, .made-with, .card .btn, .more-tiles a, .section h2 a')]
    .map((el) => ({ el: `${el.className}`, box: el.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && (box.height < 43.5 || box.width < 43.5))
    .map(({ el, box }) => `${el} ${Math.round(box.width)}x${Math.round(box.height)}`));
  expect(small, `${label}: tap targets under 44 px`).toEqual([]);
  // The photo sits over the cover, centred, above the name.
  const [cover, photo, name] = await Promise.all(['.creator-cover', '.creator-photo', '#creator-name'].map((sel) => page.locator(sel).boundingBox()));
  expect(photo.y).toBeLessThan(cover.y + cover.height);
  expect(photo.y + photo.height).toBeGreaterThan(cover.y + cover.height);
  expect(Math.abs(photo.x + photo.width / 2 - (cover.x + cover.width / 2))).toBeLessThan(2);
  expect(name.y).toBeGreaterThanOrEqual(photo.y + photo.height);
  await expect(page.locator('.site-header')).toBeHidden();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`), `${label}: axe`).toEqual([]);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

test('every preset: the creator page is a clean phone page that passes axe, with the badge link on Free and none on a paid plan', async ({ page }) => {
  test.setTimeout(300_000);
  const t = closer();
  try {
    const s = await creatorShop(t);
    for (const preset of PRESETS) {
      // A paid plan: everything the page can carry, and the seller's name only.
      await setPlan(s.app, s.tenant, 't2');
      await s.must('PUT', '/theme', { preset });
      expect((await page.goto(s.url)).status()).toBe(200);
      await checkPhonePage(page, `${preset}, paid`);
      await expect(page.locator('.creator-links a')).toHaveCount(2);
      await expect(page.locator('a.creator-link')).toHaveText('The Diwali edit is live');
      await expect(page.getByRole('search')).toBeVisible();
      await expect(page.locator('.reel-tile')).toHaveCount(12);
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
      await expect(page.locator('.made-with')).toHaveCount(0);
      expect(await page.content()).not.toMatch(/bhava/i);
      await shot(page, `creator-${preset}-full.png`);

      // The Free plan: the same page with the footer badge, which is a link to the sign-up page with a referral code.
      await setPlan(s.app, s.tenant, 'free');
      expect((await page.goto(s.url)).status()).toBe(200);
      await checkPhonePage(page, `${preset}, Free`);
      const badge = page.locator('footer a.made-with');
      await expect(badge).toHaveText('Made with Bhava');
      await expect(badge).toHaveAttribute('href', /^https:\/\/app\.bhava\.test\/signup\?ref=[a-z0-9]{6,20}$/);
      expect(await page.evaluate(() => (document.body.innerText.match(/bhava/gi) ?? []).length), 'the platform is named once, in the badge').toBe(1);
      await shot(page, `creator-${preset}.png`);
    }

    // The other views of the page: one shelf, and a search.
    await setPlan(s.app, s.tenant, 't2');
    for (const [what, pathname] of [['a shelf', '/zari/kitchen'], ['a search', '/zari?q=steel'], ['a search that finds nothing', '/zari?q=zzzz']]) {
      expect((await page.goto(`${s.app.base}${pathname}`)).status()).toBe(200);
      await checkPhonePage(page, what);
    }
  } finally {
    await t.close();
  }
});

const measureLcp = (page) => page.evaluate(() => new Promise((resolve) => {
  let latest = { time: 0, what: '' };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) latest = { time: entry.startTime, what: `${entry.element?.tagName ?? '?'}.${entry.element?.parentElement?.className ?? ''}` };
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  setTimeout(() => resolve(latest), 1000);
}));

test('the creator page reaches LCP under 2.5 s in Instagram\'s in-app browser on throttled 4G', async ({ page }) => {
  test.setTimeout(180_000);
  const t = closer();
  try {
    const s = await creatorShop(t);
    await setPlan(s.app, s.tenant, 'free');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', SLOW_4G);
    await cdp.send('Emulation.setCPUThrottlingRate', MID_RANGE_CPU);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const samples = [];
    for (let i = 0; i < REPEATS; i++) {
      const response = await page.goto(s.url, { waitUntil: 'load' });
      expect(response.status()).toBe(200);
      expect(response.headers()['content-encoding']).toBe('gzip');
      samples.push(await measureLcp(page));
    }
    for (const { time } of samples) expect(time, 'the browser reported a largest contentful paint').toBeGreaterThan(0);
    const median = samples.map((sample) => sample.time).sort((x, y) => x - y)[Math.floor(REPEATS / 2)];
    expect(median, `LCP samples in ms: ${samples.map((sample) => `${Math.round(sample.time)} (${sample.what})`).join(', ')}`).toBeLessThan(LCP_BUDGET_MS);
    await expect(page.locator('.reel-tile')).toHaveCount(12);
  } finally {
    await t.close();
  }
});
