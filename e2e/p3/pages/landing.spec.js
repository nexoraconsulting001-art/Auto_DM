// The landing page in a real browser, as Instagram's in-app browser on a mid-range phone would open it (PRD 8.10 to 8.12):
// K-40 speed on throttled 4G with 20 products, accessibility in every preset, and one counted tap per button with no hop.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { addProduct, shop } from '../../../test/p3/pages/support.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import() (a circular require inside one
// of its dependencies). Loading it once with plain require first puts it in the cache the app's import() then reads.
createRequire(import.meta.url)('sharp');

const INSTAGRAM_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A346E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android (33/13; 420dpi; 1080x2340; samsung; SM-A346E; a34x; mt6877; en_IN; 548323749)';
const SLOW_4G = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const MID_RANGE_CPU = { rate: 4 };
const LCP_BUDGET_MS = 2500;
const REPEATS = 3;
const PRESETS = ['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti'];

// A launch option of its own gives this file a worker of its own, so the require above runs before any other test file in the
// same process has tried (and failed, for good) to import sharp. The dead proxy that keeps the browser off the internet stays.
test.use({ userAgent: INSTAGRAM_ANDROID, launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--disable-features=LandingPagesOwnWorker'] } });

/** A photo-like PNG of about 40 KB, so image bytes cost what a real product shot costs. */
function productPhoto(seed) {
  const size = 480;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const tile = (x >> 4) ^ (y >> 4) ^ seed;
      row[1 + x * 3] = (tile * 53) & 255;
      row[2 + x * 3] = (tile * 97) & 255;
      row[3 + x * 3] = ((tile * 151) ^ ((x * y) >> 7)) & 255;
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
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** node:test's `t.after`, for a Playwright test: everything registered is closed when the test ends. */
function closer() {
  const closing = [];
  return { after: (fn) => closing.push(fn), close: async () => { for (const fn of closing.reverse()) await fn(); } };
}

/** A shop with a 20-product landing page, a cover picture, the WhatsApp button on and a logo. */
async function bigPage(t) {
  const s = await shop(t, { whatsapp: '+91 93200 01717' });
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const image = await s.api.upload(productPhoto(i));
    ids.push((await addProduct(s.app, s.repos, s.tenant, { name: `Handwoven cotton kurta ${i + 1}`, price: String(899 + i * 10), mrp: '1499', externalUrl: `https://shop.example/products/kurta-${i + 1}`, image })).id);
  }
  await s.repos.settings.update({ store_name: 'Zari and Co' });
  await s.api('PATCH', '/page-settings', { whatsappOrder: true });
  const cover = await s.api.upload(productPhoto(99));
  const made = await s.api('POST', '/pages', { kind: 'reel', mediaId: '17900000000000900', headline: 'The big kurta edit', description: 'Twenty pieces from this week’s reel.', productIds: ids, coverUrl: cover });
  expect(made.status).toBe(201);
  return { ...s, ids, url: `${s.app.base}/r/the-big-kurta-edit?utm_source=instagram&utm_medium=dm&utm_campaign=kurta&utm_content=17900000000000900` };
}

const measureLcp = (page) => page.evaluate(() => new Promise((resolve) => {
  let latest = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) latest = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  setTimeout(() => resolve(latest), 1000);
}));

test('K-40: a landing page with 20 products reaches LCP under 2.5 s in Instagram\'s in-app browser on 4G', async ({ page }) => {
  test.setTimeout(180_000);
  const t = closer();
  try {
    const s = await bigPage(t);
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
    for (const value of samples) expect(value, 'the browser reported a largest contentful paint').toBeGreaterThan(0);
    const median = [...samples].sort((x, y) => x - y)[Math.floor(REPEATS / 2)];
    expect(median, `LCP samples in ms: ${samples.map(Math.round).join(', ')}`).toBeLessThan(LCP_BUDGET_MS);
    await expect(page.locator('article.card')).toHaveCount(20);
  } finally {
    await t.close();
  }
});

test('the landing page is accessible and fits a phone in every preset, and never names the platform', async ({ page }) => {
  test.setTimeout(180_000);
  const t = closer();
  try {
    const s = await bigPage(t);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const preset of PRESETS) {
      expect((await s.api('PUT', '/theme', { preset, tuneAccent: false })).status).toBe(200);
      await page.goto(s.url, { waitUntil: 'load' });
      await expect(page.getByRole('heading', { level: 1 })).toContainText('The big kurta');
      const findings = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
      expect(findings, preset).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${preset}: nothing scrolls sideways`).toBeLessThanOrEqual(0);
      const small = await page.locator('article.card .actions a').evaluateAll((links) => links.filter((a) => a.getBoundingClientRect().height < 44).length);
      expect(small, `${preset}: every button is at least 44 px tall`).toBe(0);
      expect(await page.content()).not.toMatch(/bhava/i);
    }
  } finally {
    await t.close();
  }
});

test('K-32, K-35: a tap opens the product\'s own address directly and is counted once; so is a WhatsApp tap', async ({ page }) => {
  const t = closer();
  try {
    const s = await bigPage(t);
    const outside = [];
    await page.route(/^https:\/\/(shop\.example|wa\.me|api\.whatsapp\.com)\//, (route) => {
      outside.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>there</title>' });
    });
    const hits = [];
    page.on('request', (request) => {
      if (request.url().includes('/_t/e')) hits.push(request.postDataJSON());
    });
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    await Promise.all([page.waitForResponse((r) => r.url().includes('/_t/e')), page.goto(s.url)]);
    await expect.poll(() => hits.map((h) => h.name).sort()).toEqual(['landing_view', 'page_view']);

    // The third card's button: straight to the shop's own page, with the campaign's tags and nothing of ours in between.
    const card = page.locator('article.card').nth(2);
    await card.getByRole('link', { name: /Visit website/ }).click();
    await page.waitForURL(/shop\.example/);
    expect(outside).toEqual(['https://shop.example/products/kurta-3?utm_source=instagram&utm_medium=dm&utm_campaign=kurta&utm_content=17900000000000900']);
    expect(navigations.filter((url) => !url.startsWith('https://shop.example/') && !url.includes('/r/the-big-kurta-edit'))).toEqual([]);
    await expect.poll(async () => s.app.db.platform.query(`SELECT name, product_id, outbound_host FROM traffic_events WHERE tenant_id = $1 AND name IN ('outbound_tap', 'whatsapp_tap')`, [s.tenant.id]))
      .toEqual([{ name: 'outbound_tap', product_id: s.ids[2], outbound_host: 'shop.example' }]);

    // Back on the page, the WhatsApp button of the first card: wa.me with the product, its price and the page.
    await Promise.all([page.waitForResponse((r) => r.url().includes('/_t/e')), page.goto(s.url)]);
    outside.length = 0;
    await page.locator('article.card').first().getByRole('link', { name: /Order on WhatsApp/ }).click();
    await page.waitForURL(/wa\.me/);
    expect(outside.length).toBe(1);
    const wa = new URL(outside[0]);
    expect(`${wa.origin}${wa.pathname}`).toBe('https://wa.me/919320001717');
    expect(wa.searchParams.get('text')).toBe('Hi, I would like to order Handwoven cotton kurta 1 (₹899). https://shop.test/r/the-big-kurta-edit');
    await expect.poll(async () => (await s.app.db.platform.query(`SELECT name, product_id FROM traffic_events WHERE tenant_id = $1 AND name IN ('outbound_tap', 'whatsapp_tap') ORDER BY id`, [s.tenant.id])))
      .toEqual([{ name: 'outbound_tap', product_id: s.ids[2] }, { name: 'whatsapp_tap', product_id: s.ids[0] }]);
  } finally {
    await t.close();
  }
});
