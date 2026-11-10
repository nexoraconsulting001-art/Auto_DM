// What a seller and a shopper see in a real browser for Phase 2, phone-sized, on the real API with the simulators behind it.
// Needs a console build. Screen addresses aren't in the contract, so each page is reached from the menu where it can be.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { addReel } from '../../../test/p0/spec-p0/support.js';
import { TRAFFIC_PATHS, VISITOR_COOKIE, addP2Shop, liveReel, openP2World, shopper, unique } from '../../../test/p2/spec-p2/support.js';

test.use({ viewport: { width: 360, height: 740 } });

let world;
let shop;
const SLUG = 'console-shop';

test.beforeEach(async () => {
  world = await openP2World({ defaultTenant: SLUG });
});
test.afterEach(async () => {
  await world.close();
});

const setUp = async (options = {}) => {
  shop = await addP2Shop(world, { slug: SLUG, ...options });
  return shop;
};

async function signIn(page, path = '') {
  await page.goto(`${world.base}/admin${path}`);
  await page.getByLabel('Mobile number').fill(shop.owner.phone);
  await page.getByLabel('Password').fill(shop.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
}

async function openScreen(page, label, fallback) {
  const direct = page.getByRole('link', { name: label }).first();
  if (await direct.isVisible().catch(() => false)) return direct.click();
  const more = page.getByRole('link', { name: 'More' }).or(page.getByRole('button', { name: 'More' })).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    const entry = page.getByRole('link', { name: label }).first();
    if (await entry.isVisible().catch(() => false)) return entry.click();
  }
  return page.goto(`${world.base}/admin${fallback}`);
}

const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const days = (n, value) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, value]));

async function openAnalytics(page, sub = '', fallback = '/analytics') {
  await signIn(page);
  await openScreen(page, /Analytics|Insights/i, `${fallback}${sub}`);
}

test('N-01: the analytics screen on a phone shows the cached days, the last 2 flagged, and when they were last updated', async ({ page }) => {
  await setUp();
  await shop.seedDays('reach', days(28, 1200));
  await shop.seedDays('views', days(28, 2400));
  await shop.clearMetaCalls();
  await openAnalytics(page);
  await expect(page.getByText(/may still change/i).first()).toBeVisible();
  await expect(page.getByText(/Views \(replaces impressions\)/)).toBeVisible();
  await expect(page.getByText(/last updated/i).first()).toBeVisible();
  await expect(page.getByText(/From Instagram\/Facebook/).first()).toBeVisible();
  expect(await sideways(page)).toBe(0);
  expect(await seriousFindings(page)).toEqual([]);
  expect(await world.meta.calls({})).toEqual([]);
});

test('N-02: under 100 followers Audience shows the notice and no error', async ({ page }) => {
  await setUp({ followers: 80 });
  await shop.poll();
  await signIn(page);
  await openScreen(page, /Audience/i, '/analytics/audience');
  await expect(page.getByText('Available once you reach 100 followers')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('N-03: an empty day says No data, and the total notes the gap', async ({ page }) => {
  await setUp();
  await shop.seedDays('comments', { 3: 10, 4: null, 5: 7 });
  await openAnalytics(page);
  await expect(page.getByText(/No data/).first()).toBeVisible();
});

test('N-11: a story with 3 viewers shows <5, and a caption holding HTML is text', async ({ page }) => {
  await setUp();
  await shop.seedMedia({ mediaId: `low${unique()}`, kind: 'story', postedAgoMs: 3_600_000, belowThreshold: true, caption: '<img src=x onerror="window.__xss=1">' });
  await signIn(page);
  await openScreen(page, /Stories/i, '/analytics/stories');
  await expect(page.getByText('<5').first()).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('N-23: Reach Guard says "Reach is down X%" and gives normal causes, and the override needs the typed word', async ({ page }) => {
  await setUp();
  const range = (from, count, value) => Object.fromEntries(Array.from({ length: count }, (_, i) => [from + i, value]));
  await shop.seedDays('reach', { ...range(6, 28, 10000), 5: 5500, 4: 5200, 3: 5800, 2: 5800 });
  for (let i = 0; i < 12; i++) await shop.seedMedia({ mediaId: `r${i}x${unique()}`, kind: 'reel', postedAgoMs: (40 + i) * 86_400_000, latest: { reach: 5000 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 5000 } }] });
  await shop.evaluate();
  await signIn(page);
  await openScreen(page, /Reach Guard/i, '/reach-guard');
  await expect(page.getByText(/Reach is down \d+% vs your usual/)).toBeVisible();
  await expect(page.getByText(/shadow.?ban/i)).toHaveCount(0);
  await page.getByRole('button', { name: /Override/i }).click();
  const confirm = page.getByRole('button', { name: /Confirm|Override/i }).last();
  await expect(confirm).toBeDisabled();
  await page.getByRole('textbox').last().fill('override');
  await expect(confirm).toBeEnabled();
  expect(await sideways(page)).toBe(0);
});

test('N-31: a rejected token shows score 0 and Reconnect Instagram', async ({ page }) => {
  await setUp();
  await world.meta.post('/tokens/revoke', { igUserId: shop.igUserId });
  await shop.poll();
  await shop.settle();
  await signIn(page);
  await openScreen(page, /Account Health|Health/i, '/account-health');
  await expect(page.getByText(/Reconnect Instagram/).first()).toBeVisible();
});

test('N-36: tapping Refresh now twice says how old the figures are', async ({ page }) => {
  await setUp();
  await shop.poll();
  await openAnalytics(page);
  await page.getByRole('button', { name: /Refresh now/i }).click();
  await page.getByRole('button', { name: /Refresh now/i }).click();
  await expect(page.getByText(/Updated \d+ min/)).toBeVisible();
});

test('N-14: the funnel lists each step with its label, and a one-tap Amazon reel says why a step is empty', async ({ page }) => {
  await setUp();
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap' });
  await shop.seedFunnel(auto.mediaId, { comments: 25, dms: 24, linkType: 'amazon', linkMode: 'one_tap' });
  await shop.settle();
  await signIn(page);
  await page.goto(`${world.base}/admin/analytics/funnels/${auto.mediaId}`);
  await expect(page.getByText('Measured by Bhava').first()).toBeVisible();
  await expect(page.getByText('not available for this link type')).toBeVisible();
  await expect(page.getByText(/one tap/i).first()).toBeVisible();
  expect(await seriousFindings(page)).toEqual([]);
});

test('N-51: Explore runs from the phone: one metric by source, with totals', async ({ page }) => {
  await setUp();
  await shop.seedSessions([{ count: 30, source: 'bio_link' }, { count: 20, source: 'whatsapp' }]);
  await shop.settle();
  await signIn(page);
  await openScreen(page, /Explore/i, '/explore');
  await expect(page.getByRole('table')).toBeVisible();
  expect(await sideways(page)).toBe(0);
});

test('N-54: a pinned view appears on the dashboard', async ({ page }) => {
  await setUp();
  await shop.seedSessions([{ count: 3, source: 'bio_link' }]);
  const view = await shop.post('/saved-views', { name: 'My pinned view', definition: { metrics: ['sessions'], range: '7' } }, 201);
  await shop.post(`/saved-views/${view.id}/pin`, {}, 200);
  await signIn(page);
  await expect(page.getByText('My pinned view')).toBeVisible();
});

test('N-58: a tier 2 funnel with an add-to-cart step says Needs tier 3', async ({ page }) => {
  await setUp({ plan: 't2' });
  const funnel = await shop.post('/funnels', { name: 'Cart', steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }] }, 201);
  await signIn(page);
  await page.goto(`${world.base}/admin/funnels/${funnel.id}`);
  await expect(page.getByText('Needs tier 3')).toBeVisible();
});

test('N-81: the seller looks for a raw event log and finds summary exports only', async ({ page }) => {
  await setUp();
  await signIn(page);
  await openScreen(page, /Reports|Exports/i, '/reports');
  await expect(page.getByText(/raw event/i)).toHaveCount(0);
  await expect(page.getByText(/CSV/i).first()).toBeVisible();
  await expect(page.getByText(/Excel|XLSX/i).first()).toBeVisible();
});

test('N-63: a manager sees that API keys are the owner\'s to make', async ({ page }) => {
  await setUp();
  const manager = await shop.addManager();
  await page.goto(`${world.base}/admin`);
  await page.getByLabel('Mobile number').fill(manager.phone);
  await page.getByLabel('Password').fill(manager.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto(`${world.base}/admin/settings/api-keys`);
  await expect(page.getByRole('button', { name: /Create|New key/i })).toHaveCount(0);
});

// ---- the shopper's browser ---------------------------------------------------------------------------------------------

const reelPath = async () => `/r/${(await addReel(shop, String(100_000_000 + Math.floor(Math.random() * 1e9)), { headline: `Reel ${unique()}` })).reel.slug}`;

function requestsOf(page) {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  return seen;
}

test('N-45: a real browser on a buyer page reports the visit from the seller\'s own domain, sets the cookie and names no platform', async ({ page, context }) => {
  await setUp();
  const path = await reelPath();
  const seen = requestsOf(page);
  await page.goto(`${world.base}${path}?utm_source=instagram&utm_medium=dm&utm_campaign=launch`);
  await expect.poll(() => seen.filter((u) => u.includes(TRAFFIC_PATHS.event)).length).toBeGreaterThan(0);
  const here = new URL(world.base).host;
  for (const url of seen.filter((u) => u.startsWith('http'))) expect(new URL(url).host).toBe(here);
  expect((await context.cookies()).map((c) => c.name)).toContain(VISITOR_COOKIE);
  expect(await page.content()).not.toMatch(/bhava/i);
  for (const url of seen) expect(url).not.toMatch(/bhava/i);
  await shop.settle();
  expect((await shop.get('/traffic/summary', { range: '7' })).sessions.value).toBe(1);
});

test('N-16: opening a page with ?preview=1 in a browser is not a visit', async ({ page }) => {
  await setUp();
  const path = await reelPath();
  await page.goto(`${world.base}${path}?preview=1`);
  await page.waitForTimeout(800);
  await shop.settle();
  expect((await shop.get('/traffic/summary', { range: '7' })).sessions.value).toBe(0);
});

test('N-67: pixel on and no answer from the shopper: the browser asks nothing of Meta or Google', async ({ page }) => {
  await setUp();
  await shop.patch('/tags', { meta: { enabled: true, pixelId: '123456789', capiToken: 'token-1234567890' }, ga4: { enabled: true, measurementId: 'G-SPEC1234', apiSecret: 'secret-1234567890' } }, 200); // secret-scan:allow (made-up fixture values)
  const path = await reelPath();
  const seen = requestsOf(page);
  await page.goto(`${world.base}${path}`);
  await page.waitForTimeout(800);
  for (const url of seen) expect(url).not.toMatch(/facebook|google/i);
  expect(await page.content()).not.toContain('123456789');
});

test('N-70: with one business\'s pixel on, another\'s page has none of it', async ({ page }) => {
  await setUp();
  world.consent.grant();
  const other = await addP2Shop(world, { slug: 'other-shop' });
  await other.patch('/tags', { meta: { enabled: true, pixelId: '987654321', capiToken: 'token-1234567890' } }, 200); // secret-scan:allow (made-up fixture values)
  const res = await page.goto(`${world.base}${await reelPath()}`);
  expect(res.headers()['content-security-policy'] ?? '').not.toMatch(/facebook|google/i);
  expect(await page.content()).not.toContain('987654321');
});

test('N-48: the real-time panel shows the visitors on the site', async ({ page }) => {
  await setUp();
  for (let i = 0; i < 12; i++) await shopper(world, shop).send({ name: 'landing_view', path: '/r/launch', pageKind: 'landing', pageRef: 'launch', src: 'bio_link' });
  await signIn(page);
  await openScreen(page, /Traffic/i, '/traffic');
  await expect(page.getByText(/12/).first()).toBeVisible({ timeout: 15_000 });
});
