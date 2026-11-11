// The shopper's tracking page in a real phone browser (PRD 9.10, S-78): the link from a shipping message opens the seller's
// own page on its own address, shows where the parcel is as the courier's scans arrive, fits the phone, and names neither the
// courier aggregator nor the platform.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { openWorld } from '../../../test/p4/shipping/support.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(); a plain require first fixes it.
createRequire(import.meta.url)('sharp');

test('S-78 the tracking link shows the parcel moving, in the seller’s brand, on a phone', async ({ page }) => {
  const world = await openWorld(null);
  try {
    const { shop } = world;
    const order = await shop.placeOrder();
    const shipment = await shop.ship(order);
    const path = new URL(shipment.trackingUrl).pathname;

    await page.goto(`${world.base}${path}`);
    await expect(page.locator('h1, h2').filter({ hasText: 'Packed' }).first()).toBeVisible();
    await expect(page.getByText('Lamp House').first()).toBeVisible();
    await expect(page.getByText(shipment.awb)).toBeVisible();

    await shop.track(shipment.awb, 'PICKED UP', { location: 'Pune hub' });
    await shop.track(shipment.awb, 'OUT FOR DELIVERY', { location: 'Pune hub' });
    await page.reload();
    await expect(page.locator('h1, h2').filter({ hasText: 'Out for delivery' }).first()).toBeVisible();
    await expect(page.getByText('Picked up', { exact: true })).toBeVisible();
    await expect(page.getByText(/Pune hub/).first()).toBeVisible();

    expect(page.url()).toBe(`${world.base}${path}`);
    const content = await page.content();
    expect(content).not.toMatch(/shiprocket|bhava/i);
    expect(content).not.toMatch(/Asha|Lake Road|9876543210/);
    expect(await page.locator('iframe').count()).toBe(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.goto(`${world.base}/track/${'x'.repeat(24)}`);
    await expect(page.getByText('This tracking link isn’t valid.')).toBeVisible();
  } finally {
    await world.close();
  }
});
