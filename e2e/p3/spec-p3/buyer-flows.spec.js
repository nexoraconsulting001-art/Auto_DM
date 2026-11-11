// What a shopper sees in a real browser for Phase 3, phone-sized: the landing page from a DM link, the tap that leaves it, the
// WhatsApp button, the creator page, the lead form, the five presets. Every request that would leave this machine is caught
// and answered here, so "opens directly" is checked on the browser's own navigation.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { PRESETS, addP3Shop, creatorPage, leadFormOn, openP3World, unique } from '../../../test/p3/spec-p3/kit.js';

test.use({ viewport: { width: 360, height: 740 } });

const SLUG = 'buyer-shop';
let world;
let shop;

test.beforeEach(async () => {
  world = await openP3World({ defaultTenant: SLUG });
  shop = await addP3Shop(world, { slug: SLUG, name: 'Leafy Corner' });
});
test.afterEach(async () => {
  await world.close();
});

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const serious = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);

/** Answers every request to another site with a small page, and records the address the browser asked for. */
async function catchOutside(page) {
  const outside = [];
  await page.route((url) => !isLocal(url.href), async (route) => {
    const request = route.request();
    outside.push({ url: request.url(), navigation: request.isNavigationRequest(), redirectedFrom: request.redirectedFrom()?.url() ?? null });
    if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Outside</title><h1>Outside site</h1>' });
  });
  return outside;
}

const taps = () => shop.trafficEvents(['outbound_tap', 'product_tap', 'whatsapp_tap', 'link_tap']);
async function waitForTaps(n) {
  for (let i = 0; i < 40; i++) {
    const rows = await taps();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  return taps();
}

async function twenty() {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await shop.product({ name: `Speed product ${i + 1}`, pricePaise: 49900 + i * 100, mrpPaise: 99900, images: [await shop.upload('#C8794E', { width: 800, height: 800 })], externalUrl: `https://${shop.siteHost}/p/speed-${i}` })).id);
  return shop.page({ productIds: ids, headline: 'Twenty things you asked about' });
}

// ---- K-40 ------------------------------------------------------------------------------------------------------------------

test('K-40: a landing page with 20 products paints its largest element in under 2.5 s on a 4G phone', async ({ page, context }) => {
  const landing = await twenty();
  await catchOutside(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // Lighthouse's mobile profile: 150 ms round trip, 1.6 Mbps down, 750 kbps up, a 4x slower processor.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${world.base}/r/${landing.slug}?utm_source=instagram&utm_medium=dm`, { waitUntil: 'load' });
  const lcp = await page.evaluate(() => new Promise((resolve) => {
    let last = 0;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) last = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => resolve(last), 1500);
  }));
  expect(lcp, 'A largest contentful paint was measured').toBeGreaterThan(0);
  expect(lcp, `LCP was ${Math.round(lcp)} ms`).toBeLessThan(2500);
  await expect(page.getByText('Speed product 20')).toHaveCount(1);
  expect(await sideways(page)).toBe(0);
  const cls = await page.evaluate(() => new Promise((resolve) => {
    let total = 0;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) total += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => resolve(total), 500);
  }));
  expect(cls, 'Nothing jumps as images load').toBeLessThan(0.1);
});

// ---- K-32 ------------------------------------------------------------------------------------------------------------------

test('K-32: the DM link opens with no redirect; tapping a product goes straight to the product\'s own address and counts one click', async ({ page }) => {
  const product = await shop.product({ name: 'Brass planter', pricePaise: 129900, externalUrl: `https://${shop.siteHost}/p/brass-${unique()}` });
  const landing = await shop.page({ productIds: [product.id] });
  const outside = await catchOutside(page);
  const response = await page.goto(`${world.base}/r/${landing.slug}?utm_source=instagram&utm_medium=dm&utm_content=1`);
  expect(response.status()).toBe(200);
  expect(response.request().redirectedFrom(), 'The DM link is not a redirect').toBeNull();
  expect(new URL(page.url()).pathname).toBe(`/r/${landing.slug}`);
  expect(await page.content()).not.toMatch(/bhava/i);
  await expect(page.getByText('₹1,299')).toBeVisible();

  const button = page.locator(`a[data-product="${product.id}"]`).first();
  await expect(button).toBeVisible();
  const sameSiteNavigations = [];
  page.on('request', (request) => { if (request.isNavigationRequest() && isLocal(request.url())) sameSiteNavigations.push(request.url()); });
  await button.click();
  await page.waitForURL((url) => url.hostname === shop.siteHost, { timeout: 10_000 });
  const navigation = outside.find((o) => o.navigation);
  expect(`${new URL(navigation.url).origin}${new URL(navigation.url).pathname}`).toBe(product.externalUrl);
  expect(navigation.redirectedFrom, 'The browser went there directly').toBeNull();
  expect(sameSiteNavigations, 'No hop through this site on the way').toEqual([]);
  const counted = await waitForTaps(1);
  expect(counted.length, 'One click is counted').toBe(1);
  expect(counted[0].product_id).toBe(product.id);
});

// ---- K-35 ------------------------------------------------------------------------------------------------------------------

test('K-35: the WhatsApp button opens wa.me with the name, price and link, and one click is counted', async ({ page }) => {
  await shop.whatsapp('+91 93200 01717');
  await shop.must('PATCH', '/page-settings', { whatsappOrder: true });
  const product = await shop.product({ name: 'Steel Bottle', pricePaise: 34900 });
  const landing = await shop.page({ productIds: [product.id] });
  const outside = await catchOutside(page);
  await page.goto(`${world.base}/r/${landing.slug}`);
  const button = page.locator('a[href^="https://wa.me/919320001717"]').filter({ hasText: /whatsapp/i }).first();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box.height, 'The button is big enough to tap').toBeGreaterThanOrEqual(40);
  await button.click();
  await expect.poll(() => outside.some((o) => o.url.startsWith('https://wa.me/919320001717'))).toBe(true);
  const text = new URL(outside.find((o) => o.url.startsWith('https://wa.me/')).url).searchParams.get('text');
  expect(text).toContain('Steel Bottle');
  expect(text).toContain('₹349');
  expect(text).toContain(`/r/${landing.slug}`);
  const counted = await waitForTaps(1);
  expect(counted.filter((e) => e.name === 'whatsapp_tap').length).toBe(1);
});

// ---- K-51 ------------------------------------------------------------------------------------------------------------------

test('K-51: tapping a reel tile on the creator page opens its landing page directly', async ({ page }) => {
  const landing = await shop.page({ headline: 'Kitchen reel' });
  const category = await shop.category('Kitchen');
  await shop.addToCategory(category.id, landing.id);
  const creator = await creatorPage(shop);
  await catchOutside(page);
  await page.goto(`${world.base}/${creator.slug}`);
  await expect(page.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  expect(await sideways(page)).toBe(0);
  expect(await serious(page)).toEqual([]);
  const requests = [];
  page.on('request', (request) => { if (request.isNavigationRequest()) requests.push({ url: request.url(), from: request.redirectedFrom()?.url() ?? null }); });
  await page.locator(`a[href*="/r/${landing.slug}"]`).first().click();
  await page.waitForURL((url) => url.pathname === `/r/${landing.slug}`);
  expect(requests.length, 'One navigation').toBe(1);
  expect(requests[0].from).toBeNull();
  expect(new URL(page.url()).searchParams.get('utm_medium')).toBe('bio');
  expect(await page.content()).not.toMatch(/bhava/i);
});

// ---- K-60, K-61 ------------------------------------------------------------------------------------------------------------

test('K-60: the search box on the creator page finds this page\'s products and reels', async ({ page }) => {
  const bottle = await shop.product({ name: 'Steel Bottle', tags: ['insulated'] });
  const reel = await shop.page({ productIds: [bottle.id], headline: 'My daily carry' });
  await shop.page({ headline: 'Something else entirely' });
  const creator = await creatorPage(shop);
  await catchOutside(page);
  await page.goto(`${world.base}/${creator.slug}`);
  const box = page.getByRole('searchbox').or(page.locator('input[name="q"]')).first();
  await expect(box).toBeVisible();
  await box.fill('steel bottle');
  await box.press('Enter');
  await expect(page.locator(`a[href*="/r/${reel.slug}"]`).first()).toBeVisible();
  await expect(page.getByText('Something else entirely')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/${creator.slug}`);
  await box.fill('<script>window.__xss = 1</script>');
  await box.press('Enter');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('K-61: a shared shelf link opens the creator page with that shelf in view', async ({ page }) => {
  const reels = [];
  for (let i = 0; i < 6; i++) reels.push(await shop.page({ headline: `Bottle reel ${i}` }));
  const kitchenReel = await shop.page({ headline: 'Kitchen reel' });
  const bottles = await shop.category('Bottles');
  await shop.addToCategory(bottles.id, reels.map((r) => r.id));
  const kitchen = await shop.category('Kitchen');
  await shop.addToCategory(kitchen.id, kitchenReel.id);
  const creator = await creatorPage(shop);
  await catchOutside(page);
  const response = await page.goto(`${world.base}/${creator.slug}/${kitchen.slug}`);
  expect(response.status()).toBe(200);
  expect(response.request().redirectedFrom()).toBeNull();
  await expect(page.getByRole('heading', { name: 'Kitchen' })).toBeInViewport();
  await expect(page.locator(`a[href*="/r/${kitchenReel.slug}"]`).first()).toBeVisible();
  expect(await page.title()).toContain('Kitchen');
});

// ---- K-54 to K-56 ----------------------------------------------------------------------------------------------------------

async function formPage(page) {
  const landing = await shop.page({ headline: 'Lead page' });
  await leadFormOn(shop, 'landing', { channels: ['whatsapp', 'email'] });
  await catchOutside(page);
  await page.goto(`${world.base}/r/${landing.slug}`);
  const form = page.locator('form[action$="/lead"]');
  await expect(form).toBeVisible();
  return { landing, form };
}

test('K-56: the form cannot be sent while the consent box is unticked', async ({ page }) => {
  const { form } = await formPage(page);
  const box = form.getByRole('checkbox');
  await expect(box.first()).not.toBeChecked();
  await expect(form).toContainText('Leafy Corner');
  await form.locator('input[type="text"]:visible, input:not([type]):visible').first().fill('Asha');
  await form.locator('input[type="tel"]').fill('9876543210');
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/lead') posts.push(request.url()); });
  const send = form.getByRole('button');
  if (await send.isEnabled()) await send.click();
  await page.waitForTimeout(600);
  expect(posts, 'Nothing was sent').toEqual([]);
  expect(await shop.leadRows()).toEqual([]);
  expect(new URL(page.url()).pathname).not.toContain('thanks');
});

test('K-55: a first name alone is stopped with "Add a phone number or email"', async ({ page }) => {
  const { form } = await formPage(page);
  await form.locator('input[type="text"]:visible, input:not([type]):visible').first().fill('Asha');
  for (const box of await form.getByRole('checkbox').all()) await box.check();
  await form.getByRole('button').click();
  await expect(page.getByText(/Add a phone number or email/)).toBeVisible();
  expect(await shop.leadRows()).toEqual([]);
  expect(await page.content()).not.toMatch(/bhava/i);
});

test('K-54: a shopper fills the form, ticks the box and lands on the seller\'s thank-you page', async ({ page }) => {
  const { form, landing } = await formPage(page);
  expect(await serious(page)).toEqual([]);
  await form.locator('input[type="text"]:visible, input:not([type]):visible').first().fill('Asha');
  await form.locator('input[type="tel"]').fill('98765 43210');
  for (const box of await form.getByRole('checkbox').all()) await box.check();
  await form.getByRole('button').click();
  await expect(page.getByText(/thank/i).first()).toBeVisible();
  await expect(page.getByText('Leafy Corner').first()).toBeVisible();
  expect(await page.content()).not.toMatch(/bhava/i);
  expect(await page.title()).not.toMatch(/bhava/i);
  const rows = await shop.leadRows();
  expect(rows.length).toBe(1);
  expect(rows[0].phone).toBe('+919876543210');
  expect(rows[0].source_ref).toBe(landing.slug);
  await page.reload();
  expect((await shop.leadRows()).length, 'Reloading the thank-you page sends nothing again').toBe(1);
});

// ---- F-105, K-34 -----------------------------------------------------------------------------------------------------------

test('F-105: the same reel page in all five presets fits a phone, reads well and has the same sections', async ({ page }) => {
  const products = [];
  for (let i = 0; i < 3; i++) products.push(await shop.product({ name: `Preset product ${i + 1}`, pricePaise: 10000 * (i + 1), mrpPaise: 20000 * (i + 1), images: [await shop.upload('#C8794E')] }));
  const landing = await shop.page({ productIds: products.map((p) => p.id), headline: 'Festive picks' });
  await catchOutside(page);
  const outlines = [];
  for (const preset of PRESETS) {
    await shop.must('PUT', '/theme', { preset, tuneAccent: false });
    await page.goto(`${world.base}/r/${landing.slug}`);
    await expect(page.getByText('Preset product 3')).toBeVisible();
    expect(await sideways(page), `${preset} scrolls sideways`).toBe(0);
    expect(await serious(page), `${preset} has contrast or labelling problems`).toEqual([]);
    outlines.push(await page.evaluate(() => [...document.querySelectorAll('main > *, main section, main h1, main h2, main article')].map((el) => el.tagName)));
  }
  for (const outline of outlines.slice(1)) expect(outline).toEqual(outlines[0]);
});

test('K-34: in the browser the page, its title and everything it loads carry no platform name', async ({ page }) => {
  const landing = await shop.page();
  const loaded = [];
  page.on('response', (response) => loaded.push(response));
  await catchOutside(page);
  await page.goto(`${world.base}/r/${landing.slug}`);
  await page.waitForLoadState('networkidle');
  expect(await page.title()).not.toMatch(/bhava/i);
  expect(await page.content()).not.toMatch(/bhava/i);
  for (const response of loaded) {
    expect(response.url(), 'An address the page loads').not.toMatch(/bhava/i);
    expect(JSON.stringify(await response.allHeaders()), `Headers of ${response.url()}`).not.toMatch(/bhava/i);
    if (isLocal(response.url()) && /javascript|css|json/.test(response.headers()['content-type'] ?? '')) expect(await response.text(), `Body of ${response.url()}`).not.toMatch(/bhava/i);
  }
  const cookies = await page.context().cookies();
  expect(JSON.stringify(cookies)).not.toMatch(/bhava/i);
  const storage = await page.evaluate(() => JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)]));
  expect(storage).not.toMatch(/bhava/i);
});
