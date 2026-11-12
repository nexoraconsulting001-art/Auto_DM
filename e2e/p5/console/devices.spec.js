// Settings > Devices in a real phone-sized browser (PRD 10.2, 10.3): every phone and browser signed in to the person's
// account, and signing one out, which ends that browser's open console without a reload there, and the owner app's
// session at once. Signing this browser itself out ends this session. P-08 (the console's half).
import { test, expect } from '@playwright/test';
import { PHONE, expectHealthy, openWorld, ownWorker, panel, signInWithCode, toast } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleDevices') });

let world;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
});
test.afterAll(async () => {
  await world?.close();
});

test('P-08: a browser signed out under Devices is signed out of its open console within 60 s, without a reload there', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { owner } = await world.shop();
  const otherContext = await browser.newContext({ viewport: PHONE, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0' });
  const there = await otherContext.newPage();
  try {
    await signInWithCode(there, world, owner.phone, { url: world.signInUrl('/admin/orders') });
    await there.evaluate(() => {
      window.stillThisPage = true;
    });
    const app = await world.appSession(owner.phone);

    await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/devices') });
    const list = panel(page, 'Signed in');
    await expect(list.getByText('Edge on Windows')).toBeVisible();
    await expect(list.getByText('Pixel 8')).toBeVisible();
    await expect(list.getByText('Bhava for Business 1.0.0')).toBeVisible();
    await expect(list.getByText('This device')).toHaveCount(1);
    await expectHealthy(page);

    await list.getByRole('button', { name: 'Sign out Edge on Windows' }).click();
    const ask = page.getByRole('dialog', { name: 'Sign out Edge on Windows?' });
    await expect(ask).toContainText('signed out of every business at once');
    await ask.getByRole('button', { name: 'Sign it out' }).click();
    await expect(toast(page, 'Edge on Windows is signed out.')).toBeVisible();
    await expect(list.getByText('Edge on Windows')).toHaveCount(0);

    await expect(there.getByLabel('WhatsApp number')).toBeVisible({ timeout: 60_000 });
    await expect(there.getByText('You were signed out.', { exact: false })).toBeVisible();
    expect(await there.evaluate(() => window.stillThisPage), 'the page was not reloaded').toBe(true);
    await expectHealthy(there);

    // The phone is signed out the same way, at its next call.
    expect((await app.send('GET', '/auth/me')).status).toBe(200);
    await list.getByRole('button', { name: 'Sign out Pixel 8' }).click();
    await page.getByRole('dialog', { name: 'Sign out Pixel 8?' }).getByRole('button', { name: 'Sign it out' }).click();
    await expect(list.getByText('Pixel 8')).toHaveCount(0);
    expect((await app.send('GET', '/auth/me')).status).toBe(401);
    // This browser is still signed in.
    await page.reload();
    await expect(list.getByText('This device')).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test('signing out this browser itself ends this session, and nothing is asked first but "are you sure"', async ({ page }) => {
  const { owner } = await world.shop();
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/devices') });
  await world.stale();
  const list = panel(page, 'Signed in');
  await list.getByRole('button', { name: /^Sign out / }).click();
  const ask = page.getByRole('dialog', { name: /^Sign out .*\?$/ });
  await expect(ask).toContainText('This is the device you’re using.');
  await ask.getByRole('button', { name: 'Sign it out' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toHaveCount(0);
  await expect(page.getByLabel('WhatsApp number')).toBeVisible({ timeout: 15_000 });
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status);
  expect(me).toBe(401);
});
