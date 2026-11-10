// Every Phase 1 screen's loading, error and empty states, forced from the browser's side, on the smallest phone.
import { test, expect } from '@playwright/test';
import { addShop, openWorld } from '../../../test/p1/spec-p1/support.js';
import { PHONE, SLUG, expectHealthy, open } from './support.js';

test.use({ viewport: PHONE });

const SERVER_FAULT = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on our side. Please try again.', code: 'internal' }) };

// Where each state is, the call it waits on, and what it says while loading, when that fails, and once it works.
const SCREENS = [
  { name: 'automation list', path: '/automations', api: /\/api\/v1\/automations(\?|$)/, loading: 'Loading your automations', failed: 'We couldn’t load your automations', ready: 'No automations yet' },
  { name: 'builder grid', path: '/automations/new', api: /\/api\/v1\/instagram\/media/, loading: 'Loading your posts', failed: 'We couldn’t load your posts', ready: 'No posts found' },
  { name: 'inbox', path: '/inbox', api: /\/api\/v1\/inbox\/threads/, loading: 'Loading your conversations', failed: 'We couldn’t load your conversations', ready: 'No conversations yet' },
  { name: 'needs a human', path: '/inbox/needs-human', api: /\/api\/v1\/inbox\/needs-human/, loading: 'Loading what needs you', failed: 'We couldn’t load what needs you', ready: 'All caught up' },
  { name: 'compliance status', path: '/compliance', api: /\/api\/v1\/compliance\/status/, loading: 'Checking your account', failed: 'We couldn’t check your account', ready: 'Sending normally' },
  { name: 'waiting messages', path: '/compliance', api: /\/api\/v1\/compliance\/held-jobs/, loading: 'Loading waiting messages', failed: 'We couldn’t load waiting messages', ready: 'Nothing is waiting' },
  { name: 'compliance log', path: '/compliance/log', api: /\/api\/v1\/compliance\/activity/, loading: 'Loading the compliance log', failed: 'We couldn’t load the compliance log', ready: 'Nothing logged yet' },
  { name: 'rules', path: '/compliance/settings', api: /\/api\/v1\/compliance\/settings$/, loading: 'Loading your rules', failed: 'We couldn’t load your rules', ready: 'How messages go out' },
  { name: 'word lists', path: '/compliance/settings', api: /\/api\/v1\/compliance\/words/, loading: 'Loading this list', failed: 'We couldn’t load this list', ready: 'No words of your own yet' },
  { name: 'connect', path: '/connect', api: /\/api\/v1\/instagram\/connection/, loading: 'Checking your Instagram connection', failed: 'We couldn’t check your Instagram connection', ready: 'What Bhava can do' },
];

let world;
let shop;
test.beforeAll(async () => {
  world = await openWorld({ defaultTenant: SLUG });
  shop = await addShop(world, { slug: SLUG });
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
    await expect(page.getByRole('status').filter({ hasText: screen.loading })).toBeVisible();
    mode = 'fail';
    release();

    await expect(page.getByRole('heading', { name: screen.failed })).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);

    mode = 'pass';
    await page.getByRole('alert').filter({ hasText: screen.failed }).getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: screen.ready })).toBeVisible();
    await expectHealthy(page);
  });
}

test('an automation or chat that isn\'t there reads as missing', async ({ page }) => {
  await open(page, world, shop.owner, '/automations/999999');
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await page.goto(`${world.base}/admin/inbox/threads/999999`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
});

test('"Why no DM?" says when there is nothing to look up, and when nothing was recorded', async ({ page }) => {
  await open(page, world, shop.owner, '/inbox/why-no-dm');
  await expect(page.getByRole('heading', { name: 'Nothing to look up yet' })).toBeVisible();
  await page.getByLabel('Comment ID').fill('no-such-comment');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing recorded for that comment' })).toBeVisible();
  await expectHealthy(page);
});

test('a mistyped filter in the address shows the whole log, not an error', async ({ page }) => {
  await open(page, world, shop.owner, '/compliance/log?outcome=nope&automationId=abc');
  await expect(page.getByRole('heading', { name: 'Nothing logged yet' })).toBeVisible();
});
