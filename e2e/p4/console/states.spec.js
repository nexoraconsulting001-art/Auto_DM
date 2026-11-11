// Every Phase 4 console screen's loading, failed and ready states, forced from the browser's side on the smallest phone, for a
// business with nothing yet; plus a feature the plan lacks, a thing that isn't there, a mistyped filter, and what staff are
// neither shown nor sent.
import { test, expect } from '@playwright/test';
import { addP4Shop, addStaff, openP4World, unique } from '../../../test/p4/spec-p4/kit.js';
import { SERVER_FAULT, expectHealthy, open, ownWorker, planRefusal, settled, PHONE } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P4ConsoleStates') });

const SLUG = `console-p4-states-${unique()}`.toLowerCase();
let world;
let shop;

// Where each state is, the call it waits on, and what it says while loading, when that fails, and once it works for a business with nothing yet.
const SCREENS = [
  { name: 'orders', path: '/orders', api: /\/api\/v1\/orders(\?|$)/, loading: 'Loading your orders', failed: 'We couldn’t load your orders', ready: 'No orders yet' },
  { name: 'order files', path: '/orders/files', api: /\/api\/v1\/order-downloads/, loading: 'Loading your files', failed: 'We couldn’t load your files', ready: 'No files yet' },
  { name: 'returns', path: '/returns', api: /\/api\/v1\/returns(\?|$)/, loading: 'Loading your returns', failed: 'We couldn’t load your returns', ready: 'No returns yet' },
  { name: 'return rules', path: '/returns/settings', api: /\/api\/v1\/return-settings$/, loading: 'Loading your return rules', failed: 'We couldn’t load your return rules', ready: 'Save return rules' },
  { name: 'invoices', path: '/invoices', api: /\/api\/v1\/invoices(\?|$)/, loading: 'Loading your invoices', failed: 'We couldn’t load your invoices', ready: 'No invoices yet' },
  { name: 'GST details', path: '/invoices/settings', api: /\/api\/v1\/invoice-settings$/, loading: 'Loading your GST details', failed: 'We couldn’t load your GST details', ready: 'Save GST details' },
  { name: 'stock', path: '/inventory', api: /\/api\/v1\/inventory(\?|$)/, loading: 'Loading your stock', failed: 'We couldn’t load your stock', ready: 'No products yet' },
  { name: 'stock alert level', path: '/inventory', api: /\/api\/v1\/inventory\/settings$/, loading: 'Loading your alert level', failed: 'We couldn’t load your alert level', ready: 'Alert when stock falls to' },
  { name: 'stock changes', path: '/inventory/movements', api: /\/api\/v1\/inventory\/movements/, loading: 'Loading the stock changes', failed: 'We couldn’t load the stock changes', ready: 'No stock changes yet' },
  { name: 'coupons', path: '/coupons', api: /\/api\/v1\/coupons(\?|$)/, loading: 'Loading your coupons', failed: 'We couldn’t load your coupons', ready: 'No coupons yet' },
  { name: 'reviews', path: '/reviews', api: /\/api\/v1\/reviews(\?|$)/, loading: 'Loading your reviews', failed: 'We couldn’t load your reviews', ready: 'No reviews yet' },
  { name: 'saves', path: '/reviews/saves', api: /\/api\/v1\/wishlist\/counts/, loading: 'Loading the saves', failed: 'We couldn’t load the saves', ready: 'Nothing saved yet' },
  { name: 'how you are paid', path: '/payments', api: /\/api\/v1\/payment-account$/, loading: 'Loading how you’re paid', failed: 'We couldn’t load how you’re paid', ready: 'Start KYC' },
  { name: 'ways to pay', path: '/payments', api: /\/api\/v1\/payment-settings$/, loading: 'Loading your payment options', failed: 'We couldn’t load your payment options', ready: 'Save payment options' },
  { name: 'statement', path: '/payments/statement', api: /\/api\/v1\/settlements(\?|$)/, loading: 'Loading your statement', failed: 'We couldn’t load your statement', ready: 'No payments yet' },
  { name: 'statement totals', path: '/payments/statement', api: /\/api\/v1\/settlements\/summary/, loading: 'Loading the totals', failed: 'We couldn’t load the totals', ready: 'Bhava takes no commission on sales.' },
  { name: 'shipping', path: '/shipping', api: /\/api\/v1\/shipping-settings$/, loading: 'Loading your shipping settings', failed: 'We couldn’t load your shipping settings', ready: 'Save shipping settings' },
  { name: 'shoppers', path: '/customers/shoppers', api: /\/api\/v1\/shoppers(\?|$)/, loading: 'Loading your shoppers', failed: 'We couldn’t load your shoppers', ready: 'No shoppers yet' },
  { name: 'customer files', path: '/customers/shoppers', api: /\/api\/v1\/shopper-downloads/, loading: 'Loading your files', failed: 'We couldn’t load your files', ready: 'No files yet' },
  { name: 'data requests', path: '/customers/data-requests', api: /\/api\/v1\/data-requests/, loading: 'Loading the data requests', failed: 'We couldn’t load the data requests', ready: 'No data requests yet' },
  { name: 'grievance contact', path: '/store-settings', api: /\/api\/v1\/privacy$/, loading: 'Loading your grievance contact', failed: 'We couldn’t load your grievance contact', ready: 'Save contact' },
  { name: 'order updates', path: '/store-settings/messages', api: /\/api\/v1\/alert-settings$/, loading: 'Loading your order updates settings', failed: 'We couldn’t load your order updates settings', ready: 'Save order updates' },
  { name: 'WhatsApp number', path: '/store-settings/messages', api: /\/api\/v1\/whatsapp-account$/, loading: 'Loading your WhatsApp number', failed: 'We couldn’t load your WhatsApp number', ready: 'Connect WhatsApp' },
  { name: 'templates', path: '/store-settings/messages', api: /\/api\/v1\/whatsapp-templates$/, loading: 'Loading your templates', failed: 'We couldn’t load your templates', ready: 'No templates yet' },
  { name: 'cart reminders', path: '/store-settings/messages', api: /\/api\/v1\/cart-reminders$/, loading: 'Loading your cart reminders', failed: 'We couldn’t load your cart reminders', ready: 'Send cart reminders' },
  { name: 'recent order updates', path: '/store-settings/messages', api: /\/api\/v1\/order-alerts/, loading: 'Loading your order updates', failed: 'We couldn’t load your order updates', ready: 'No order updates yet' },
  { name: 'policy pages', path: '/store-settings/policies', api: /\/api\/v1\/policies$/, loading: 'Loading your policy pages', failed: 'We couldn’t load your policy pages', ready: 'Text of your privacy policy' },
  { name: 'consent notice', path: '/store-settings/notice', api: /\/api\/v1\/consent-notice$/, loading: 'Loading your consent notice', failed: 'We couldn’t load your consent notice', ready: 'Publish as a new version' },
  { name: 'Shopify', path: '/store-settings/shopify', api: /\/api\/v1\/shopify$/, loading: 'Loading your Shopify connection', failed: 'We couldn’t load your Shopify connection', ready: 'Connect Shopify' },
];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  world = await openP4World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP4Shop(world, { slug: SLUG, name: 'Empty Shelf', whatsapp: false, pay: false, pickup: false, notice: false });
});
test.afterAll(async () => {
  await world?.close();
});

for (const screen of SCREENS) {
  test(`${screen.name}: loading, then a way back from a failure, then ready`, async ({ page }) => {
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

    await open(page, world, shop.owner, screen.path);
    await expect(page.getByRole('status').filter({ hasText: screen.loading }).first()).toBeVisible();
    mode = 'fail';
    release();

    const failure = page.getByRole('alert').filter({ hasText: screen.failed }).first();
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);

    mode = 'pass';
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: screen.loading })).toHaveCount(0);
    await expect(page.getByText(screen.ready).first()).toBeVisible();
    await settled(page);
    await expectHealthy(page);
  });
}

test('a feature the plan lacks reads as that, with the server\'s words and no retry that can\'t work', async ({ page }) => {
  await page.route(/\/api\/v1\/reviews(\?|$)/, (route) => route.fulfill(planRefusal('Reviews aren’t on your plan.')));
  await open(page, world, shop.owner, '/reviews');
  await expect(page.getByRole('heading', { name: 'This isn’t on your plan' })).toBeVisible();
  await expect(page.getByText('Reviews aren’t on your plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expectHealthy(page);
});

test('an order, return, coupon or shopper that isn\'t there reads as missing, not broken', async ({ page }) => {
  await open(page, world, shop.owner, '/orders/999999');
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  for (const path of ['/returns/999999', '/coupons/999999', '/customers/shoppers/999999']) {
    await page.goto(`${world.base}/admin${path}`);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
});

test('a mistyped filter in the address shows the default list, not an error', async ({ page }) => {
  await open(page, world, shop.owner, '/orders?fulfilment=moon&payment=maybe&held=perhaps&from=yesterday');
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  await page.goto(`${world.base}/admin/inventory?show=everything`);
  await expect(page.getByRole('button', { name: 'All', exact: true, pressed: true })).toBeVisible();
  await page.goto(`${world.base}/admin/returns?status=lost`);
  await expect(page.getByRole('heading', { name: 'No returns yet' })).toBeVisible();
  await page.goto(`${world.base}/admin/coupons?show=sometimes`);
  await expect(page.getByRole('heading', { name: 'No coupons yet' })).toBeVisible();
});

test('staff with the orders permission see orders and returns, and are neither shown nor sent the managers\' screens', async ({ page }) => {
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  const calls = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) calls.push(url.pathname);
  });
  await open(page, world, staff, '/orders');
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  await page.goto(`${world.base}/admin/returns`);
  await expect(page.getByRole('heading', { name: 'No returns yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return rules' })).toHaveCount(0);
  for (const path of ['/coupons', '/payments', '/store-settings', '/inventory', '/returns/settings', '/invoices/settings']) {
    await page.goto(`${world.base}/admin${path}`);
    await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
  }
  expect(calls.filter((call) => /coupons|payment-|privacy|inventory|return-settings|invoice-settings|alert-settings/.test(call))).toEqual([]);
  await expectHealthy(page);
});
