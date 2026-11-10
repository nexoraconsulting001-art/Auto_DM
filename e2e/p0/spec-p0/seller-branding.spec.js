// What a seller sees, in a real browser. The owner app is PRD Phase 5, outside this build run, so F-75 is
// checked here on the web admin and on the one thing the app will read: the workspace identity from the API.
import { test, expect } from '@playwright/test';
import { OWNER, startApp } from '../../../test/helpers.js';

const SELLER_PRIMARY = '#234D33';
const SELLER_PRIMARY_RGB = 'rgb(35, 77, 51)';
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let app;
let logoUrl;

test.beforeAll(async () => {
  app = await startApp({ overrides: { adminUi: 'console', platformDomain: 'shops.example' } });
  const mediaId = await app.repos.media.save(TINY_PNG, 'image/png');
  logoUrl = `/media/${mediaId}`;
  await app.repos.brandKit.save({ logoUrl, colors: { primary: SELLER_PRIMARY }, headingFont: 'Playfair Display' });
});
test.afterAll(() => app.close());

async function signIn(page) {
  await page.goto(`${app.base}/admin`);
  await page.getByLabel('Mobile number').fill(OWNER.phone);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
}

const openEveryMenuItem = async (page, visit) => {
  const nav = page.locator('nav a, .tabbar a, .sidenav a');
  const links = await nav.evaluateAll((elements) => [...new Set(elements.map((a) => a.getAttribute('href')))].filter((h) => h?.startsWith('/admin')));
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) {
    await page.goto(`${app.base}${href}`);
    await page.waitForLoadState('networkidle');
    await visit(href);
  }
};

test('F-75: the web admin stays platform-branded and shows the seller\'s logo only as the workspace identity', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveTitle(/Bhava/);
  await expect(page.getByRole('img', { name: 'Bhava' }).first()).toBeVisible();

  await openEveryMenuItem(page, async (href) => {
    const outside = await page.locator(`img[src*="${logoUrl}"]`).evaluateAll((images) =>
      images.filter((img) => !img.closest('[class*="workspace"], [class*="switcher"]')).length);
    expect(outside, `${href}: the seller's logo outside the workspace identity`).toBe(0);
    const html = await page.content();
    expect(html.toLowerCase(), `${href}: the seller's colour in the page`).not.toContain(SELLER_PRIMARY.toLowerCase());
    expect(html, `${href}: the seller's font in the page`).not.toContain('Playfair');
    const paintedInSellerColour = await page.locator('button, a, h1, h2').evaluateAll((elements, rgb) =>
      elements.filter((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color].includes(rgb)).length, SELLER_PRIMARY_RGB);
    expect(paintedInSellerColour, `${href}: elements in the seller's colour`).toBe(0);
  });
});

test('F-75: the API gives the owner app the seller\'s logo as workspace identity and no theme', async () => {
  const login = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: OWNER.phone, password: OWNER.password }) });
  expect(login.status).toBe(201);
  const { token } = await login.json();
  const me = await (await fetch(`${app.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json();
  expect(me.business.logoUrl).toBe(logoUrl);
  expect(Object.keys(me.business).sort()).toEqual(['id', 'logoUrl', 'name', 'plan', 'slug']);
});

test('U-10: no screen of the seller console offers a raw event log export', async ({ page }) => {
  await signIn(page);
  await openEveryMenuItem(page, async (href) => {
    await expect(page.getByText(/raw (event )?(log|export|data)|event log export/i), href).toHaveCount(0);
    const downloads = await page.locator('a[download], a[href*="export"]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    expect(downloads.filter((h) => /raw|event|audit|compliance/i.test(h)), href).toEqual([]);
  });
});

test('F-119: no button or link on any seller console screen downloads a raw log', async ({ page }) => {
  await signIn(page);
  await openEveryMenuItem(page, async (href) => {
    await expect(page.getByRole('button', { name: /\braw\b|event log/i }), href).toHaveCount(0);
    await expect(page.getByRole('link', { name: /\braw\b|event log/i }), href).toHaveCount(0);
  });
});
