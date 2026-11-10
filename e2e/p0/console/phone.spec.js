// Every screen with real data on a 360 px phone: nothing sideways, nothing unreadable, nothing leaves the site, and Bhava's brand holds.
import { test, expect } from '@playwright/test';
import { REEL_ID, seedReel } from '../../../test/helpers.js';
import { PHONE, open, placeOrder, seriousFindings, sideways, startConsoleApp, watch } from './support.js';

let app;
let ids;
test.beforeAll(async () => {
  app = await startConsoleApp();
  const { products } = await seedReel(app.repos, { n: 3, stock: '9' });
  const category = await app.repos.categories.save(null, { name: 'A category with a really long name that keeps going', visible: 'on', position: 1 });
  await app.repos.products.update(products[0].id, { name: 'A product with a very long name that would push a phone screen sideways if it could', price: '123456.78', mrp: '200000', stock: '', active: 'on', categoryIds: [category.id], option_values: 'Small, Medium, Large', option_label: 'Size' });
  const order = await placeOrder(app, { productId: products[1].id, name: 'Someone With Quite A Long Name', qty: 1 });
  await app.repos.users.create({ name: 'Asha Kumari', phone: '9876543210', email: 'asha.kumari.with.long.address@example.test', password: 'secret1' });
  await app.repos.activity.log({ commentId: 'c1', reelId: REEL_ID, username: 'a_very_long_instagram_username_for_this_screen', text: 'a comment that goes on and on and on and on without much of a point to it at all', result: 'skip:no-keyword' });
  ids = { product: products[0].id, category: category.id, order: order.id };
});
test.afterAll(() => app.close());

const SCREENS = () => [
  ['/', 'Hello, Store'],
  ['/products', 'Products'],
  ['/products/new', 'Add product'],
  [`/products/${ids.product}`, /A product with a very long name/],
  ['/categories', 'Categories'],
  ['/categories/new', 'Add category'],
  [`/categories/${ids.category}`, /A category with a really long name/],
  ['/reels', 'Reels'],
  [`/reels/${REEL_ID}`, 'Edit reel store'],
  ['/orders', 'Orders'],
  [`/orders/${ids.order}`, /-/],
  ['/customers', 'Customers'],
  ['/activity', 'DM activity'],
  ['/settings', 'Settings'],
  ['/brand-kit', 'Brand kit'],
];

test.describe('at 360 px', () => {
  test.use({ viewport: PHONE });

  test('every screen fits, reads, and keeps to its own site', async ({ page }) => {
    test.setTimeout(180_000);
    const problems = watch(page, app);
    await open(page, app);
    for (const [path, heading] of SCREENS()) {
      await page.goto(`${app.base}/admin${path === '/' ? '' : path}`);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('.spinner')).toHaveCount(0);
      expect(await sideways(page), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
      expect(await seriousFindings(page), path).toEqual([]);
      const tooSmall = await page.locator('.tabbar a, .tabbar button, .shell-content button, .shell-content a.btn').evaluateAll((nodes) => nodes
        .filter((node) => node.offsetParent !== null)
        .map((node) => ({ text: node.getAttribute('aria-label') || node.textContent, height: node.getBoundingClientRect().height }))
        .filter(({ height }) => height < 36));
      expect(tooSmall, `${path}: tap targets`).toEqual([]);
    }
    expect(problems).toEqual([]);
  });

  test('the tab bar and More reach every screen', async ({ page }) => {
    await open(page, app);
    const tabs = page.locator('.tabbar');
    for (const name of ['Home', 'Orders', 'Products', 'Reels']) await expect(tabs.getByRole('link', { name })).toBeVisible();
    await page.getByRole('button', { name: 'More' }).click();
    for (const name of ['Categories', 'Customers', 'DM activity', 'Settings', 'Brand kit']) await expect(page.getByRole('dialog').getByRole('link', { name })).toBeVisible();
    expect(await seriousFindings(page)).toEqual([]);
    await page.getByRole('dialog').getByRole('link', { name: 'Customers' }).click();
    await expect(page).toHaveURL(/\/admin\/customers$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tabs).toBeVisible();
  });

  test('F-75: Bhava\'s name and logo are on the console, and the seller\'s shows only as the workspace', async ({ page }) => {
    await app.repos.brandKit.save({ logoUrl: 'https://cdn.example/seller-logo.png' });
    const context = page.context();
    await context.route('https://cdn.example/**', (route) => route.abort());
    await open(page, app);
    await expect(page).toHaveTitle('Bhava for Business');
    await expect(page.locator('.shell-mark')).toHaveAttribute('alt', 'Bhava');
    const logos = await page.locator('img[src*="seller-logo"]').evaluateAll((nodes) => nodes.map((node) => node.closest('.workspace') !== null));
    expect(logos.length).toBeGreaterThan(0);
    expect(logos.every(Boolean)).toBe(true);
    const style = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--neel').trim());
    expect(style.toLowerCase()).toBe('#3b2fc9');
    await app.repos.brandKit.save({ logoUrl: '' });
  });

  test('the menu says how many orders are waiting', async ({ page }) => {
    await open(page, app);
    await expect(page.locator('.tabbar').getByRole('link', { name: 'Orders, 1 waiting' })).toBeVisible();
    await expect(page.locator('.tabbar-dot')).toHaveCount(1);
  });

  test('sign in, on a phone, is Bhava\'s and accessible', async ({ page }) => {
    await page.goto(`${app.base}/admin`);
    await expect(page.getByRole('img', { name: 'Bhava' })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await seriousFindings(page)).toEqual([]);
  });
});

test('on a wide screen the same screens use the room', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, app);
  await expect(page.locator('.sidenav')).toBeVisible();
  for (const [path, heading] of SCREENS().filter(([path]) => ['/', '/products', `/orders/${ids.order}`, '/brand-kit'].includes(path))) {
    await page.goto(`${app.base}/admin${path === '/' ? '' : path}`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('.spinner')).toHaveCount(0);
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
    expect(await seriousFindings(page), path).toEqual([]);
  }
});
