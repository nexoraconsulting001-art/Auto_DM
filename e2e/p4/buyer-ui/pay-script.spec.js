// The store's payment screen script (PAY_JS, src/modules/storefront/views/pay.js, PRD 9.6) in a real phone browser against the real server and the
// gateway simulator: the order page's "Pay now" opens the gateway in the seller's name, the gateway's signed answer goes to
// the server, and the shopper lands on the order page, confirmed.
//
// The order page does not load this script yet and the store's Content-Security-Policy does not yet allow the gateway's
// script and frame (both are outside this track's folders and are reported). So this test adds the script to the page
// itself and lets the page run without the policy: it proves the script works, not that the order page uses it. The
// journey spec's '"Pay now" on the order page ...' test is the one that checks the page as it is served.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { PLATFORM_NAME, SHOP_NAME, UA, buyer, newPhone, openStore } from '../../../test/p4/buyer-ui/support.js';
import { PAY_JS } from '../../../src/modules/storefront/views/pay.js';
import { PHONE, checkScreen, standInGateway } from './browser.js';

createRequire(import.meta.url)('sharp');

test.use({ userAgent: UA.instagram, viewport: PHONE, bypassCSP: true });
test.describe.configure({ timeout: 120_000 });

let store;
test.beforeEach(async () => {
  store = await openStore();
});
test.afterEach(async () => {
  await store?.world.close();
});

test('pay.js opens the gateway in the seller’s name from "Pay now", and the signed answer confirms the order', async ({ page }) => {
  const { world, shop, plant, size } = store;
  const b = buyer(world, shop);
  const placed = await b.order({ lines: [{ productId: plant.id, variantId: size.M, qty: 2 }], address: { name: 'Asha Rao', phone: newPhone(), line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' } });
  const answers = [];
  const screens = [];
  await standInGateway(page, {
    onOpen: async (orderId, options) => {
      screens.push(options);
      const paid = await world.rzp.post('/pay', { orderId });
      const answer = { razorpay_payment_id: paid.payment.id, razorpay_order_id: orderId, razorpay_signature: paid.signature };
      answers.push(answer);
      return answer;
    },
  });
  const returns = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/store/payments/return')) returns.push(r.postDataJSON()); });

  await page.goto(`${world.base}/order/${placed.token}`);
  await expect(page.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible();
  await page.addScriptTag({ content: PAY_JS });
  await page.getByRole('button', { name: 'Pay now' }).click();

  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 15_000 });
  expect(screens.length, 'The gateway was opened once').toBe(1);
  const [opened] = screens;
  expect(opened.name).toBe(SHOP_NAME);
  expect(opened.order_id).toBe(placed.gateway.gatewayOrderId);
  expect(opened.amount).toBe(placed.gateway.amountPaise);
  expect(opened.currency).toBe('INR');
  expect(JSON.stringify(opened)).not.toMatch(PLATFORM_NAME);
  expect(returns).toEqual([{ orderToken: placed.token, gatewayOrderId: answers[0].razorpay_order_id, gatewayPaymentId: answers[0].razorpay_payment_id, signature: answers[0].razorpay_signature }]);
  const row = await shop.order(placed.orderNumber);
  expect([row.payment_status, row.fulfilment_status]).toEqual(['paid', 'new']);
  await checkScreen(page, 'The order page after paying');
});

test('pay.js: a forged answer from the page never marks the order paid', async ({ page }) => {
  const { world, shop, pot } = store;
  const b = buyer(world, shop);
  const placed = await b.order({ lines: [{ productId: pot.id, variantId: null, qty: 1 }] });
  await standInGateway(page, {
    // A page script pretends the gateway said yes.
    onOpen: async (orderId) => ({ razorpay_payment_id: 'pay_forged000001', razorpay_order_id: orderId, razorpay_signature: 'f'.repeat(64) }),
  });
  await page.goto(`${world.base}/order/${placed.token}`);
  await page.addScriptTag({ content: PAY_JS });
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page).toHaveURL(new RegExp(`/order/${placed.token}$`));
  await page.waitForLoadState('load');
  await expect(page.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible({ timeout: 10_000 });
  const row = await shop.order(placed.orderNumber);
  expect(row.payment_status).not.toBe('paid');
});
