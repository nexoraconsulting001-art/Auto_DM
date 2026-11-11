// Every look a seller can pick (the five theme presets, PRD 5.18 and 5.19) on every screen of the buyer's journey, in a
// real phone browser inside Instagram: the reel's page, the product, the bag, checkout, sign-in, the order page and the
// tracking page each pass axe (WCAG 2.1 AA and 2.2 target size, colour contrast included), fit 360 px and show the
// seller's name only.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { PRESETS } from '../../../test/p3/spec-p3/kit.js';
import { SHOP_NAME, UA, buyer, openStore, pathOf } from '../../../test/p4/buyer-ui/support.js';
import { PHONE, checkScreen, standInGateway } from './browser.js';

createRequire(import.meta.url)('sharp');

test.use({ userAgent: UA.instagram, viewport: PHONE });
test.describe.configure({ timeout: 300_000 });

test('each of the five looks reads well on every screen of the journey', async ({ page }) => {
  const store = await openStore();
  try {
    const { world, shop, plant, pot, size, reel } = store;
    const b = buyer(world, shop);
    const waiting = await b.order({ lines: [{ productId: pot.id, variantId: null, qty: 1 }] });
    const paid = await b.buy({ lines: [{ productId: plant.id, variantId: size.M, qty: 1 }] });
    const shipment = await shop.ship(paid);
    await standInGateway(page);
    await page.goto(`${world.base}/p/${pot.slug}`);
    await page.getByRole('button', { name: 'Add to bag' }).click();
    await expect(page.locator('[data-bag-count]').first()).toHaveText('1');

    const screens = [
      ['the reel’s page', `/r/${reel.slug}`, (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ['the product page', `/r/${reel.slug}/p/${plant.slug}`, (p) => expect(p.getByRole('button', { name: 'Add to bag' })).toBeVisible()],
      ['the store’s home', '/', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ['the shop, sorted', '/shop?sort=price-asc', (p) => expect(p.locator('.grid .tile').first()).toBeVisible()],
      ['search results', '/search?q=planter', (p) => expect(p.getByText('Terracotta planter').first()).toBeVisible()],
      ['the wishlist', '/wishlist', (p) => expect(p.locator('main')).toBeVisible()],
      ['the bag', '/cart', (p) => expect(p.locator('[data-lines] li')).toHaveCount(1)],
      ['checkout', '/checkout', (p) => expect(p.locator('[data-row="total"] [data-amount]')).toHaveText(/₹/)],
      ['sign-in', '/login', (p) => expect(p.getByRole('heading', { level: 1 })).toHaveText('Sign in')],
      ['an order waiting for payment', `/order/${waiting.token}`, (p) => expect(p.getByRole('heading', { name: 'Waiting for payment' })).toBeVisible()],
      ['a confirmed order', `/order/${paid.placed.token}`, (p) => expect(p.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()],
      ['the tracking page', pathOf(shipment.trackingUrl), (p) => expect(p.getByText(shipment.awb)).toBeVisible()],
    ];
    for (const preset of PRESETS) {
      await shop.must('PUT', '/theme', { preset, tuneAccent: true }, 200, `Choosing the ${preset} look`);
      for (const [what, path, ready] of screens) {
        await page.goto(`${world.base}${path}`);
        await ready(page);
        await expect(page).toHaveTitle(new RegExp(SHOP_NAME));
        await checkScreen(page, `${preset}: ${what}`);
      }
    }
  } finally {
    await store.world.close();
  }
});
