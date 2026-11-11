// The engagement features in a real phone browser (PRD 9.19, 9.20, 9.21): hearts saved logged out join the account after
// sign-in, a shopper who received a product writes a review from its page, and the points page shows the invite link,
// all in the seller's brand.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { advance, delivered, loyaltyOn, markPaid, ordered, payments, product, rows, signedIn, storeApp } from '../../../test/p4/engagement/support.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(); a plain require first fixes it.
createRequire(import.meta.url)('sharp');

let app;
let lamp;
let bell;
test.beforeAll(async () => {
  app = await storeApp();
  await payments(app);
  lamp = await product(app, { name: 'Brass lamp', pricePaise: 100000, stock: 20 });
  bell = await product(app, { name: 'Temple bell', pricePaise: 50000, stock: 20 });
});
test.afterAll(() => app?.close());

/** Signs the browser in as this shopper, with the session cookie the sign-in would have set. */
const signInBrowser = (page, who) => page.context().addCookies([{ name: '_sid', value: who.cookie.split('=')[1], url: app.base }]);

test('S-84: hearts tapped while logged out are in the account wishlist after sign-in', async ({ page }) => {
  for (const p of [lamp, bell]) {
    await page.goto(`${app.base}/p/${p.slug}`);
    // The product's own heart; the cards under it have theirs, named after their product.
    await page.getByRole('button', { name: 'Save to wishlist', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove from wishlist', exact: true })).toBeVisible();
  }
  await page.goto(`${app.base}/wishlist`);
  await expect(page.getByText('Brass lamp')).toBeVisible();
  await expect(page.getByText('Temple bell')).toBeVisible();
  // A heart on the product cards too.
  await page.goto(`${app.base}/shop`);
  await expect(page.getByRole('button', { name: 'Remove Brass lamp from wishlist' })).toHaveAttribute('aria-pressed', 'true');

  const asha = await signedIn(app, { phone: '+919811122233' });
  await signInBrowser(page, asha);
  await page.goto(`${app.base}/wishlist`);
  await expect.poll(async () => (await rows(app, 'SELECT product_id FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY product_id', [app.tenant.id, asha.id])).map((r) => r.product_id))
    .toEqual([lamp.id, bell.id].sort((a, b) => a - b));
  await expect(page.getByText('Brass lamp')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('store:wish:v1'))).toBeNull();
  // Removing from the account's own list.
  await page.locator(`[data-wish-remove="${bell.id}"]`).click();
  await expect.poll(async () => (await rows(app, 'SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [app.tenant.id]))[0].n).toBe(1);
  expect(/bhava/i.test(await page.content())).toBe(false);
});

test('S-81: the shopper who received the lamp reviews it from its page; the review waits for the owner', async ({ page }) => {
  const ravi = await signedIn(app, { phone: '+919811122244', name: 'Ravi Kumar' });
  await signInBrowser(page, ravi);
  await page.goto(`${app.base}/p/${lamp.slug}`);
  await expect(page.locator('form[data-review-form]')).toHaveCount(0);
  await delivered(app, ravi, lamp.id);
  await page.reload();
  const form = page.locator('form[data-review-form]');
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Send review' }).click();
  await expect(form.getByRole('alert')).toHaveText('Choose from 1 to 5 stars.');
  await form.locator('input[name="rating"][value="4"]').check();
  await form.locator('textarea[name="body"]').fill('Warm light <b>and</b> solid');
  await form.getByRole('button', { name: 'Send review' }).click();
  await expect(form.getByRole('status')).toContainText('Your review will appear once the store has checked it');
  const [review] = await rows(app, 'SELECT rating, body, status, display_name FROM reviews WHERE tenant_id = $1', [app.tenant.id]);
  expect(review).toEqual({ rating: 4, body: 'Warm light <b>and</b> solid', status: 'pending', display_name: 'Ravi' });
  await page.reload();
  await expect(page.locator('form[data-review-form]')).toHaveCount(0);
  await expect(page.getByText('No reviews yet')).toBeVisible();
});

test('S-87: the points page shows what is on the way and the invite link, in the seller’s brand', async ({ page }) => {
  await loyaltyOn(app, { referralEnabled: true, referrerPoints: 50 });
  const meera = await signedIn(app, { phone: '+919811122255', name: 'Meera' });
  const order = await ordered(app, meera, lamp.id);
  await markPaid(app, order.id);
  await advance(app, order.id, ['packed']);
  await signInBrowser(page, meera);
  await page.goto(`${app.base}/account/points`);
  await expect(page.getByRole('heading', { name: 'Your points' })).toBeVisible();
  await expect(page.getByText('10 points more are on the way.')).toBeVisible();
  await expect(page.locator('[data-refer-link]')).toHaveText(/\/refer\/[A-Z0-9]{8}$/);
  expect(/bhava/i.test(await page.content())).toBe(false);
});
