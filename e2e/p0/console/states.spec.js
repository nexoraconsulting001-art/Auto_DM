// Every screen's loading, error and empty states, forced from the browser's side.
import { test, expect } from '@playwright/test';
import { seedReel } from '../../../test/helpers.js';
import { PHONE, noPostsIg, open, placeOrder, seriousFindings, sideways, startConsoleApp, status, watch } from './support.js';

test.use({ viewport: PHONE });

const SERVER_FAULT = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on our side. Please try again.', code: 'internal' }) };

// Each screen: where it is, the API call it waits on, and what it says while loading and when that fails.
const SCREENS = [
  { name: 'dashboard stats', path: '', api: /\/api\/v1\/stats\/dashboard/, loading: 'Loading your numbers', failed: 'We couldn’t load your numbers', ready: 'From feeling to price' },
  { name: 'dashboard setup', path: '', api: /\/api\/v1\/settings\/setup/, loading: 'Checking your setup', failed: 'We couldn’t check your setup', ready: 'Set up your store' },
  { name: 'dashboard orders', path: '', api: /\/api\/v1\/orders\?/, loading: 'Loading your orders', failed: 'We couldn’t load your orders', ready: 'No orders yet' },
  { name: 'dashboard reels', path: '', api: /\/api\/v1\/reels\?/, loading: 'Loading your reels', failed: 'We couldn’t load your reels', ready: 'No reel stores yet' },
  { name: 'dashboard comments', path: '', api: /\/api\/v1\/activity\?/, loading: 'Loading your comments', failed: 'We couldn’t load your comments', ready: 'No comments yet' },
  { name: 'products', path: '/products', api: /\/api\/v1\/products\?/, loading: 'Loading your products', failed: 'We couldn’t load your products', ready: 'Your catalog is empty' },
  { name: 'categories', path: '/categories', api: /\/api\/v1\/categories\?/, loading: 'Loading your categories', failed: 'We couldn’t load your categories', ready: 'No categories yet' },
  { name: 'reels', path: '/reels', api: /\/api\/v1\/reels\?/, loading: 'Loading your reels', failed: 'We couldn’t load your reels', ready: 'No posts found' },
  { name: 'orders', path: '/orders', api: /\/api\/v1\/orders(\?|$)/, loading: 'Loading your orders', failed: 'We couldn’t load your orders', ready: 'No orders yet' },
  { name: 'customers', path: '/customers', api: /\/api\/v1\/customers(\?|$)/, loading: 'Loading your customers', failed: 'We couldn’t load your customers', ready: 'Store owner', readyIsText: true },
  { name: 'DM activity', path: '/activity', api: /\/api\/v1\/activity(\?|$)/, loading: 'Loading your DM activity', failed: 'We couldn’t load your DM activity', ready: 'Nothing yet' },
  { name: 'settings', path: '/settings', api: /\/api\/v1\/settings$/, loading: 'Loading your settings', failed: 'We couldn’t load your settings', ready: 'Store', readyIsPanel: true },
  { name: 'brand kit', path: '/brand-kit', api: /\/api\/v1\/brand-kit$/, loading: 'Loading your brand kit', failed: 'We couldn’t load your brand kit', ready: 'Pick a look' },
];

let app;
test.beforeAll(async () => {
  app = await startConsoleApp({ ig: noPostsIg() });
});
test.afterAll(() => app.close());

for (const screen of SCREENS) {
  test(`${screen.name}: shows loading, then a way back from a failure`, async ({ page }) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let mode = 'hold';
    await page.route(screen.api, async (route) => {
      if (mode === 'hold') await held;
      if (mode === 'fail') return route.fulfill(SERVER_FAULT);
      return route.continue();
    });

    await open(page, app, screen.path);
    await expect(status(page, screen.loading)).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    mode = 'fail';
    release();

    await expect(page.getByRole('heading', { name: screen.failed })).toBeVisible({ timeout: 15_000 });
    expect(await seriousFindings(page)).toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    mode = 'pass';
    await page.getByRole('alert').filter({ hasText: screen.failed }).getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    if (screen.readyIsText) await expect(page.getByText(screen.ready)).toBeVisible();
    else await expect(page.getByRole('heading', { name: screen.ready, exact: screen.readyIsPanel })).toBeVisible();
  });
}

test('an empty business: every list says so, and offers the next step', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app, '/products');
  await expect(page.getByRole('heading', { name: 'Your catalog is empty' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add your first product' })).toBeVisible();
  expect(await seriousFindings(page)).toEqual([]);

  await page.goto(`${app.base}/admin/categories`);
  await expect(page.getByRole('link', { name: 'Add your first category' })).toBeVisible();

  await page.goto(`${app.base}/admin/reels`);
  await expect(page.getByRole('heading', { name: 'No posts found' })).toBeVisible();
  expect(await seriousFindings(page)).toEqual([]);

  await page.goto(`${app.base}/admin/orders`);
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();

  await page.goto(`${app.base}/admin/activity`);
  await expect(page.getByRole('heading', { name: 'Nothing yet' })).toBeVisible();

  await page.goto(`${app.base}/admin`);
  await expect(page.getByRole('heading', { name: 'No reel stores yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a new product\'s form works even if the categories can\'t load', async ({ page }) => {
  await page.route(/\/api\/v1\/categories\?/, (route) => route.fulfill(SERVER_FAULT));
  await open(page, app, '/products/new');
  await expect(page.getByRole('heading', { name: 'We couldn’t load your categories' })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Name', { exact: true }).fill('No categories needed');
  await page.getByLabel('Price (₹)').fill('10');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);
});

test('Instagram being down leaves reels already set up on screen', async ({ page }) => {
  const down = await startConsoleApp({ ig: { ...noPostsIg(), listMedia: async () => { throw new Error('Instagram timed out'); } } });
  try {
    await seedReel(down.repos, { n: 1 });
    await page.route(/\/api\/v1\/instagram\/posts/, (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'We couldn’t reach Instagram.', code: 'internal' }) }));
    await open(page, down, '/reels');
    await expect(page.getByRole('status').filter({ hasText: 'We couldn’t load your Instagram posts' })).toBeVisible();
    await expect(page.getByText('Brunch edit')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit store', exact: true })).toBeVisible();
  } finally {
    down.close();
  }
});

test('a save that fails keeps what was typed and says why', async ({ page }) => {
  const busy = await startConsoleApp();
  try {
    const product = await busy.repos.products.create({ name: 'Kurta', price: '499', active: 'on' });
    await open(page, busy, `/products/${product.id}`);
    await page.route(/\/api\/v1\/products\/\d+$/, (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Please check the highlighted details.', code: 'validation_failed', fields: { pricePaise: 'That amount is too large' } }) })
      : route.continue()));
    await page.getByLabel('Name', { exact: true }).fill('Changed name');
    await page.getByRole('button', { name: 'Save product' }).click();
    await expect(page.getByText('That amount is too large')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Changed name');
    expect((await busy.repos.products.get(product.id)).name).toBe('Kurta');
  } finally {
    busy.close();
  }
});

test('a session that ends mid-use goes back to sign-in, and the place is kept', async ({ page }) => {
  await open(page, app, '/orders');
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await page.route(/\/api\/v1\/customers(\?|$)/, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Please log in again.', code: 'unauthorized' }) }));
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Customers' }).click();
  await expect(page.getByRole('heading', { name: 'Run your business from here' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/customers$/);
});

test('a long list loads more on request', async ({ page }) => {
  const big = await startConsoleApp();
  try {
    const { products } = await seedReel(big.repos, { n: 1 });
    for (let i = 0; i < 27; i += 1) await placeOrder(big, { productId: products[0].id, phone: `98765432${String(i).padStart(2, '0')}` });
    await open(page, big, '/orders');
    const rows = page.locator('.list-row');
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(27);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  } finally {
    big.close();
  }
});
