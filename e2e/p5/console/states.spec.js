// Every Phase 5 console screen's loading, failed and ready states, forced from the browser's side on the smallest phone:
// a spinner that says what it waits for, a failure that says what didn't load and offers Try again, then the screen
// itself, empty where a new seller has nothing yet. Each state is checked for sideways scrolling and serious axe findings.
import { test, expect } from '@playwright/test';
import { PHONE, SERVER_FAULT, expectHealthy, json, openWorld, ownWorker, signInWithCode } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleStates') });

const SCREENS = [
  { name: 'team', path: '/admin/settings/team', api: /\/api\/v1\/team(\?|$)/, loading: 'Loading your team', failed: 'We couldn’t load your team', ready: 'No open invitations' },
  { name: 'devices', path: '/admin/settings/devices', api: /\/api\/v1\/auth\/devices$/, loading: 'Loading your devices', failed: 'We couldn’t load your devices', ready: 'This device' },
  { name: 'notifications', path: '/admin/notifications', api: /\/api\/v1\/notifications(\?|$)/, loading: 'Loading your notifications', failed: 'We couldn’t load your notifications', ready: 'Nothing new' },
  { name: 'notification settings', path: '/admin/notifications/settings', api: /\/api\/v1\/notifications\/prefs$/, loading: 'Loading your choices', failed: 'We couldn’t load your choices', ready: 'Save quiet hours' },
  { name: 'your businesses', path: '/admin/settings/account', api: /\/api\/v1\/auth\/businesses$/, loading: 'Loading your businesses', failed: 'We couldn’t load your businesses', ready: 'Working here' },
];

let world;
let owner;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
  ({ owner } = await world.shop());
});
test.afterAll(async () => {
  await world?.close();
});

/** Holds the matching calls until released, then fails them or lets them through as `mode` says. */
async function control(page, pattern) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const state = { mode: 'hold', release };
  await page.route(pattern, async (route) => {
    if (state.mode === 'hold') await held;
    if (state.mode === 'fail') return route.fulfill(SERVER_FAULT);
    return route.continue();
  });
  return state;
}

for (const screen of SCREENS) {
  test(`${screen.name}: loading, then a way back from a failure, then ready`, async ({ page }) => {
    await signInWithCode(page, world, owner.phone);
    const state = await control(page, screen.api);
    await page.goto(world.signInUrl(screen.path));
    await expect(page.getByRole('status').filter({ hasText: screen.loading }).first()).toBeVisible();
    await expectHealthy(page);
    state.mode = 'fail';
    state.release();

    const failure = page.getByRole('alert').filter({ hasText: screen.failed }).first();
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);

    state.mode = 'pass';
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByText(screen.ready).first()).toBeVisible();
    await expectHealthy(page);
  });
}

test('devices: an account with no device listed says where devices come from', async ({ page }) => {
  await signInWithCode(page, world, owner.phone);
  await page.route(/\/api\/v1\/auth\/devices$/, (route) => route.fulfill(json({ devices: [] })));
  await page.goto(world.signInUrl('/admin/settings/devices'));
  await expect(page.getByRole('heading', { name: 'No devices listed yet' })).toBeVisible();
  await expectHealthy(page);
});

test('signing out a device that fails says so and keeps it listed', async ({ page }) => {
  await signInWithCode(page, world, owner.phone);
  await page.route(/\/api\/v1\/auth\/devices\/\d+$/, (route) => route.fulfill(SERVER_FAULT));
  await page.goto(world.signInUrl('/admin/settings/devices'));
  await page.getByRole('button', { name: /^Sign out / }).first().click();
  await page.getByRole('dialog', { name: /^Sign out .*\?$/ }).getByRole('button', { name: 'Sign it out' }).click();
  await expect(page.getByRole('alert')).toContainText('Something went wrong on our side');
  await expect(page.getByText('This device')).toBeVisible();
  await expectHealthy(page);
});

test('sign-in: it says it is getting ready while it asks the server what to offer, and works when that answer fails', async ({ page }) => {
  const state = await control(page, /\/api\/v1\/app\/requirements/);
  await page.goto(world.signInUrl('/admin'));
  await expect(page.getByRole('status').filter({ hasText: 'Getting sign-in ready' })).toBeVisible();
  await expectHealthy(page);
  state.mode = 'fail';
  state.release();
  // Without the server's answer the WhatsApp code is still offered: it is the way in.
  await expect(page.getByLabel('WhatsApp number')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expectHealthy(page);
});

test('sign-in: a server that can\'t send the code says so, and the number can be tried again', async ({ page }) => {
  await world.freshCodes();
  await page.route(/\/api\/v1\/auth\/start$/, (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many tries. Wait a while and try again.', code: 'rate_limited' }) }));
  await page.goto(world.signInUrl('/admin'));
  await page.getByLabel('WhatsApp number').fill(owner.phone);
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many tries. Wait a while and try again.');
  await expect(page.getByLabel('WhatsApp number')).toHaveValue(owner.phone);
  await expectHealthy(page);
});
