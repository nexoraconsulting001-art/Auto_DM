// R-04 in a real browser: Instagram's in-app browser string, a mid-range phone's CPU, and a slow 4G link,
// on a landing page with 20 products and real image bytes.
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { OWNER, REEL_ID, startApp } from '../../../test/helpers.js';

const INSTAGRAM_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A346E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android (33/13; 450dpi; 1080x2400; samsung; SM-A346E; a34x; mt6877; en_IN; 548323757)';
const SLOW_4G = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const MID_RANGE_CPU = { rate: 4 };
const LCP_BUDGET_MS = 2500;
const REPEATS = 3;

/** A photo-like PNG of about 40 KB: blocks of colour, so it compresses the way a real product shot would. */
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
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

let app;
let landingPage;

test.beforeAll(async () => {
  app = await startApp({ overrides: { platformDomain: 'shops.example' } });
  const login = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: OWNER.phone, password: OWNER.password }) });
  expect(login.status).toBe(201);
  const { token } = await login.json();
  const authorization = `Bearer ${token}`;

  const ids = [];
  for (let i = 0; i < 20; i++) {
    const mediaId = await app.repos.media.save(productPhoto(i), 'image/png');
    const res = await fetch(`${app.base}/api/v1/products`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Product ${crypto.randomUUID().slice(0, 6)}`, pricePaise: 49900 + i, images: [`/media/${mediaId}`], active: true }),
    });
    expect(res.status).toBe(201);
    ids.push((await res.json()).id);
  }
  const reel = await fetch(`${app.base}/api/v1/reels/${REEL_ID}`, {
    method: 'PUT',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ headline: 'Brunch edit', keywords: ['LINK'], productIds: ids, active: true }),
  });
  expect(reel.status).toBe(200);
  landingPage = `${app.base}/r/${(await reel.json()).slug}?src=dm`;
});

test.afterAll(() => app.close());

test.use({ userAgent: INSTAGRAM_ANDROID });

const measureLcp = (page) => page.evaluate(() => new Promise((resolve) => {
  let latest = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) latest = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  setTimeout(() => resolve(latest), 1000);
}));

test('R-04: the landing page reaches LCP under 2.5 s in the in-app browser on 4G', async ({ page }) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', SLOW_4G);
  await cdp.send('Emulation.setCPUThrottlingRate', MID_RANGE_CPU);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const samples = [];
  for (let i = 0; i < REPEATS; i++) {
    await page.goto(landingPage, { waitUntil: 'load' });
    samples.push(await measureLcp(page));
  }
  for (const value of samples) expect(value, 'the browser reported a largest contentful paint').toBeGreaterThan(0);
  const median = [...samples].sort((x, y) => x - y)[Math.floor(REPEATS / 2)];
  expect(median, `LCP samples in ms: ${samples.map(Math.round).join(', ')}`).toBeLessThan(LCP_BUDGET_MS);
});
