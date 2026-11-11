// The buyer's whole journey in a real phone browser inside Instagram (PRD 9.1 to 9.10): the reel's page, the product, the
// bag, checkout, paying by UPI or cash on delivery, the order's own page, and the parcel's tracking page from the shipping
// message. Every screen is checked with axe (WCAG 2.1 AA and 2.2 target size), at 360 px and for the platform's name, and
// the messages the shopper gets on WhatsApp carry the seller's brand and direct links only. Everything runs on the
// simulators. The payment gateway's own script is answered by a stand-in (browser.js), as no real service is reached.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { AGGREGATOR_NAME, PLATFORM_NAME, PRODUCT_NAME, SHOP_NAME, UA, gatewayOrderOf, linksIn, messageText, newPhone, openStore, pathOf, readAs } from '../../../test/p4/buyer-ui/support.js';
import { PHONE, checkScreen, standInGateway } from './browser.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(); a plain require first fixes it.
createRequire(import.meta.url)('sharp');

test.use({ userAgent: UA.instagram, viewport: PHONE });
test.describe.configure({ timeout: 240_000 });

let store;
test.beforeEach(async () => {
  store = await openStore();
});
test.afterEach(async () => {
  await store?.world.close();
});

async function fillAddress(page, phone) {
  await page.getByLabel('Full name').fill('Asha Rao');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Address', { exact: true }).fill('12 Lake Road');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('PIN code').fill('411001');
  await page.getByLabel('State').selectOption({ label: 'Maharashtra' });
}

/** From the reel to the bag: the reel's page, its product, a size, and the bag page. */
async function reelToBag(page) {
  const { world, reel, size } = store;
  await page.goto(`${world.base}/r/${reel.slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Balcony');
  await expect(page.getByText(PRODUCT_NAME).first()).toBeVisible();
  await checkScreen(page, 'The reel’s page');

  await page.getByRole('link', { name: `View product, ${PRODUCT_NAME}` }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${reel.slug}/p/`));
  await expect(page.getByRole('heading', { name: PRODUCT_NAME })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the reel' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByText('Choose an option first.')).toBeVisible();
  await page.locator(`label:has(input[name="variant"][value="${size.L}"])`).click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added to your bag.' })).toBeVisible();
  await expect(page.locator('[data-bag-count]').first()).toHaveText('1');
  await checkScreen(page, 'The product page');

  await page.getByRole('link', { name: 'View bag' }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.locator('[data-lines] li')).toHaveCount(1);
  await expect(page.locator('[data-lines]')).toContainText('L');
  await expect(page.locator('[data-total]')).not.toHaveText('');
  await checkScreen(page, 'The bag');
}

test('a shopper from a reel pays by UPI, sees the order confirmed and follows the parcel to the door', async ({ page }) => {
  const { world, shop } = store;
  const phone = newPhone();
  const outside = await standInGateway(page);
  await reelToBag(page);

  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator('[data-lines]')).toContainText(PRODUCT_NAME);
  await checkScreen(page, 'Checkout, as it opens');
  // Placing it with nothing filled in says what is missing, in words.
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByRole('alert')).toHaveText(/accept the terms/i);

  await fillAddress(page, phone.slice(3));
  await page.getByRole('radio', { name: /UPI, card or netbanking/ }).check();
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page.getByRole('checkbox', { name: 'Send me order updates on WhatsApp' }).check();
  await expect(page.locator('[data-row="total"] [data-amount]')).toHaveText(/₹/);
  const total = await page.locator('[data-row="total"] [data-amount]').textContent();
  await checkScreen(page, 'Checkout, filled in');
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();
  await expect(page.locator('[data-bag-count]').first()).toHaveText('');
  await checkScreen(page, 'The order page, waiting for payment');
  const orderPath = pathOf(page.url());
  const [order] = await shop.orders();
  expect(order.payment_mode).toBe('prepaid');
  expect(Number(order.total_paise) / 100).toBe(Number(String(total).replace(/[^\d.]/g, '')));

  // The shopper pays in their UPI app; the gateway tells the store by its signed webhook.
  const gatewayOrderId = await gatewayOrderOf(shop, order.order_number);
  expect(gatewayOrderId, 'The order has a payment waiting at the gateway').toBeTruthy();
  await world.rzp.post('/pay', { orderId: gatewayOrderId, webhook: true });
  await shop.orderWhen(order.order_number, (o) => o.payment_status === 'paid');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay now' })).toHaveCount(0);
  await expect(page.getByText(PRODUCT_NAME)).toBeVisible();
  await checkScreen(page, 'The order page, confirmed');

  // The seller ships it and the courier picks it up. The "on its way" message on WhatsApp carries the seller's name and a
  // direct link to the seller's own tracking page (S-78); the shopper taps it.
  const shipment = await shop.ship(await shop.order(order.order_number));
  await shop.track(shipment.awb, 'PICKED UP', { location: 'Pune hub' });
  await world.quiet(1200);
  const messages = await world.whatsappTo(phone);
  const storeHost = new URL(shipment.trackingUrl).hostname;
  for (const m of messages) {
    expect(`${messageText(m)} ${readAs(m)}`, 'A WhatsApp message to the shopper names the platform').not.toMatch(PLATFORM_NAME);
    for (const link of linksIn(readAs(m))) expect(new URL(link).hostname, `A message link goes through someone else's address: ${link}`).toBe(storeHost);
  }
  const onItsWay = messages.find((m) => m.body?.template?.name === 'order_shipped');
  expect(onItsWay, 'The shopper got an "on its way" message on WhatsApp').toBeTruthy();
  expect(readAs(onItsWay)).toContain(SHOP_NAME);
  const followLink = linksIn(readAs(onItsWay))[0];
  expect.soft(pathOf(followLink), '"Follow it here" in the on-its-way message should open the parcel’s tracking page').toBe(pathOf(shipment.trackingUrl));

  await page.goto(`${world.base}${pathOf(shipment.trackingUrl)}`);
  await expect(page.getByText(shipment.awb)).toBeVisible();
  await expect(page.getByText('Picked up', { exact: true })).toBeVisible();
  await checkScreen(page, 'The tracking page, picked up');
  expect(await page.content()).not.toMatch(AGGREGATOR_NAME);

  await shop.track(shipment.awb, 'OUT FOR DELIVERY', { location: 'Pune hub' });
  await world.quiet(800);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Out for delivery' })).toBeVisible();
  await checkScreen(page, 'The tracking page, out for delivery');

  await shop.track(shipment.awb, 'DELIVERED', { location: 'Pune' });
  await world.quiet(800);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Delivered' })).toBeVisible();
  await checkScreen(page, 'The tracking page, delivered');

  await page.goto(`${world.base}${orderPath}`);
  await expect(page.getByRole('heading', { name: 'Delivered' })).toBeVisible();
  await checkScreen(page, 'The order page, delivered');
  expect(outside.filter((u) => PLATFORM_NAME.test(u)), 'The browser asked the platform for something').toEqual([]);
  await expect(page).toHaveTitle(new RegExp(SHOP_NAME));
});

test('a shopper pays cash on delivery after confirming their number with a WhatsApp code', async ({ page }) => {
  const { world, shop } = store;
  const phone = newPhone();
  await standInGateway(page);
  await reelToBag(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await fillAddress(page, phone.slice(3));
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await expect(page.locator('[data-row="balance"]')).toBeVisible();
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page.getByRole('heading', { name: 'Confirm your number' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'We sent a 6-digit code on WhatsApp.' })).toBeVisible();
  expect(await shop.orders(), 'No order is placed before the number is confirmed').toEqual([]);
  await checkScreen(page, 'Checkout, confirming the number');

  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Confirm and place order' }).click();
  await expect(page.locator('[data-verify-status]')).not.toHaveText('We sent a 6-digit code on WhatsApp.');
  expect(await shop.orders()).toEqual([]);

  await page.getByLabel('6-digit code').fill(await world.codeFor(phone));
  await page.getByRole('button', { name: 'Confirm and place order' }).click();
  await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByText(/in cash when it arrives/)).toBeVisible();
  await checkScreen(page, 'The order page, cash on delivery');
  const orders = await shop.orders();
  expect(orders.map((o) => [o.payment_mode, o.payment_status])).toEqual([['cod', 'cod_due']]);
  for (const m of await world.whatsappTo(phone)) expect(messageText(m)).not.toMatch(PLATFORM_NAME);
});

test('"Pay now" on the order page opens the payment screen in the seller’s name and brings the shopper back paid', async ({ page }) => {
  const { world, shop } = store;
  const phone = newPhone();
  const screens = [];
  await standInGateway(page, {
    // The shopper approves the payment on the gateway's screen; the gateway hands the page its signed answer.
    onOpen: async (orderId, options) => {
      screens.push(options);
      const paid = await world.rzp.post('/pay', { orderId });
      return { razorpay_payment_id: paid.payment.id, razorpay_order_id: orderId, razorpay_signature: paid.signature };
    },
  });
  await reelToBag(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await fillAddress(page, phone.slice(3));
  await page.getByRole('radio', { name: /UPI, card or netbanking/ }).check();
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible();

  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.locator('[data-pay-error]'), 'Pay now answered with an error instead of opening the payment screen').toBeHidden();
  await expect.poll(() => screens.length, { message: 'The payment screen never opened', timeout: 8000 }).toBe(1);
  const [opened] = screens;
  expect(opened.name).toBe(SHOP_NAME);
  expect(JSON.stringify(opened)).not.toMatch(PLATFORM_NAME);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 10_000 });
  const [order] = await shop.orders();
  expect(order.payment_status).toBe('paid');
});
