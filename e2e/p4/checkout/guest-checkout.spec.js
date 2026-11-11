// The store in a real phone browser (PRD 9.1, 9.2, 9.5): a guest adds a size to the bag, the bag is priced by the server
// even when the browser's copy is tampered with, the checkout page places one order however often it is tapped, and the
// order's own page wears the seller's brand only.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { payments, product, q, storeApp, withSizes } from '../../../test/p4/checkout/support.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(); a plain require first fixes it.
createRequire(import.meta.url)('sharp');
test.use({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--disable-features=StoreCheckoutOwnWorker'] } });

let app;
let kurti;
let sizes;
test.beforeAll(async () => {
  app = await storeApp();
  await payments(app);
  kurti = await product(app, { name: 'Block print kurti', pricePaise: 70000, stock: null });
  sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 0 }, { value: 'L', stock: 2, pricePaise: 72000 }]);
});
test.afterAll(() => app?.close());

test('S-93 a guest buys a size with UPI: bag, checkout and the order page, priced by the server and in the seller\'s brand', async ({ page }) => {
  await page.goto(`${app.base}/p/${kurti.slug}`);
  await expect(page.locator(`input[name="variant"][value="${sizes.M}"]`)).toBeDisabled();
  await page.locator(`label:has(input[value="${sizes.L}"])`).click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByText('Added to your bag.')).toBeVisible();
  await expect(page.locator('[data-bag-count]').first()).toHaveText('1');

  // S-05: a price written into the browser's bag is never sent and never believed.
  await page.evaluate(() => {
    const bag = JSON.parse(localStorage.getItem('store:bag:v2'));
    bag.lines[0].price = 100;
    bag.lines[0].unitPaise = 100;
    localStorage.setItem('store:bag:v2', JSON.stringify(bag));
  });
  await page.goto(`${app.base}/cart`);
  await expect(page.locator('[data-lines] li')).toHaveCount(1);
  await expect(page.locator('[data-total]')).toHaveText('₹720');

  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator('[data-row="total"] [data-amount]')).toHaveText('₹720');
  await page.locator('input[name="name"]').fill('Asha Rao');
  await page.locator('input[name="phone"]').fill('9876543210');
  await page.locator('input[name="line1"]').fill('12 Lake Road');
  await page.locator('input[name="city"]').fill('Pune');
  await page.locator('select[name="stateCode"]').selectOption('27');
  await page.locator('input[name="pincode"]').fill('411001');
  const upi = page.locator('input[name="paymentMode"][value="prepaid"]');
  await expect(upi).toBeEnabled();
  await upi.check();
  await expect(page.locator('input[name="paymentMode"][value="cod"]')).toBeDisabled();
  await expect(page.locator('[data-mode-reason="cod"]')).toHaveText(/isn’t offered/);
  await page.locator('input[name="acceptTerms"]').check();
  // S-15: two taps in a row.
  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();
  await page.evaluate(() => {
    const button = document.querySelector('[data-place]');
    button.click();
    button.click();
  });
  await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Neel Studio');
  expect(/bhava/i.test(await page.content())).toBe(false);

  const orders = await q(app, 'SELECT total_paise, payment_mode, fulfilment_status FROM orders WHERE tenant_id = $1', [app.tenant.id]);
  expect(orders.map((o) => [Number(o.total_paise), o.payment_mode, o.fulfilment_status])).toEqual([[72000, 'prepaid', 'pending']]);
  await expect(page.locator('[data-bag-count]').first()).toHaveText('');
});
