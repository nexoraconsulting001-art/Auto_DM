// Rehearsal of screencast script sc-04 (docs/go-live/meta-app-review/pack.json): the owner opens Analytics, taps a metric and taps
// Refresh now. Cached insight figures come from the Meta simulator's world; Playwright saves a video. Nothing leaves this machine.
import { expect, test } from '@playwright/test';
import { addP2Shop, dayAgo, openP2World } from '../../../test/p2/spec-p2/support.js';
import { expectHealthy, open, watch } from '../../p2/console/support.js';
import { PHONE, VIDEO, scriptOf } from './script.js';

const script = scriptOf('sc-04-insights');
test.use({ viewport: PHONE, video: VIDEO });

const SLUG = 'screencast-insights';
let world;
let shop;

test.beforeAll(async () => {
  world = await openP2World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP2Shop(world, { slug: SLUG });
  await shop.setCollectingSince(dayAgo(200));
});
test.afterAll(async () => {
  await world?.close();
});

test('sc-04: every step of the insights script can be walked', async ({ page }) => {
  const [analytics, metric, refresh] = script.steps;
  await shop.seedDays('views', Object.fromEntries(Array.from({ length: 28 }, (_, i) => [i, 2400])));
  await shop.seedDays('comments', { 3: 10, 4: null, 5: 7 });
  const problems = watch(page, world);

  await test.step(analytics.tap, async () => {
    await open(page, world, shop.owner, '/analytics');
    await expect(page.getByText(/Last updated/).first()).toBeVisible();
    await expect(page.getByText('From Instagram/Facebook').first()).toBeVisible();
    await expect(page.getByText(/may still change/).first()).toBeVisible();
  });

  await test.step(metric.tap, async () => {
    await page.getByRole('button', { name: /^Comments/ }).click();
    const day = page.getByRole('list', { name: 'Comments, day by day' }).getByRole('listitem').filter({ hasText: new RegExp(`^${Number(dayAgo(4).slice(8))} `) }).first();
    await expect(day).toContainText('No data');
  });

  await test.step(refresh.tap, async () => {
    const button = page.getByRole('button', { name: 'Refresh now' });
    await button.click();
    await button.click();
    await expect(page.locator('.an-message')).toHaveText(/Updated (just now|\d+ min ago)/);
  });

  await expectHealthy(page);
  expect(problems).toEqual([]);
});
