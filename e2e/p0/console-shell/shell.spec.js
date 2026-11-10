// The seller console in a real browser, phone first. Needs a build: the gate makes one, or run npm run build:console.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OWNER, startApp } from '../../../test/helpers.js';

let app;
test.beforeAll(async () => {
  app = await startApp({ overrides: { adminUi: 'console' } });
});
test.afterAll(() => app.close());

const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact));
const signIn = async (page, password = OWNER.password) => {
  await page.getByLabel('Mobile number').fill(OWNER.phone);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
};
const fitsTheScreen = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

function watchForOutsideRequests(page) {
  const outside = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(app.base) && !request.url().startsWith('data:')) outside.push(request.url());
  });
  return outside;
}

test('on a phone: a deep link survives signing in, reloading works, and signing out ends it', async ({ page }) => {
  const outside = watchForOutsideRequests(page);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/401|Unauthorized/.test(message.text())) problems.push(message.text());
  });

  await page.goto(`${app.base}/admin/orders/12`);
  await expect(page.getByRole('heading', { name: 'Run your business from here' })).toBeVisible();
  await expect(page).toHaveTitle('Bhava for Business');
  await expect(page.getByRole('img', { name: 'Bhava' })).toBeVisible();
  expect(await fitsTheScreen(page)).toBe(true);
  expect(await seriousFindings(page)).toEqual([]);

  await signIn(page, 'wrong-password');
  await expect(page.getByRole('alert')).toContainText('don’t match');
  await signIn(page);

  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/orders\/12$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { name: 'Hello, Store' })).toBeVisible();
  await expect(page.locator('.shell-top .workspace-name')).toHaveText('Test store');
  expect(await fitsTheScreen(page)).toBe(true);
  expect(await seriousFindings(page)).toEqual([]);

  await page.getByRole('button', { name: 'More' }).click();
  expect(await seriousFindings(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Run your business from here' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Run your business from here' })).toBeVisible();

  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});

test('on a wide screen the tab bar gives way to a side menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.base}/admin`);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Hello, Store' })).toBeVisible();
  await expect(page.locator('.sidenav')).toBeVisible();
  await expect(page.locator('.tabbar')).toBeHidden();
  expect(await seriousFindings(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Run your business from here' })).toBeVisible();
});

test('a shopper\'s account opens the page but not the console', async ({ page }) => {
  await app.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
  await page.goto(`${app.base}/admin`);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Password').fill('secret1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'This account can’t open the console' })).toBeVisible();
  await expect(page.locator('.tabbar')).toHaveCount(0);
  expect(await seriousFindings(page)).toEqual([]);
});
