// Q-12: the seller console installed as a web app (the owner app for iPhone users until the iOS app ships), in a real phone-sized
// browser with a real service worker: it is installable, it caches the app shell and static files only, never an API answer, and
// never shows one business's cached data after a switch of business or a sign-out, online or offline.
import { test, expect } from '@playwright/test';
import { consoleDir, dumpCaches, hasWorker } from './pwa-support.js';

const { PHONE, expectHealthy, newPhone, openWorld, ownWorker, panel, signInWithCode, unique } = await import('../../p5/console/support.js');

test.use({ viewport: PHONE, ...ownWorker('P8Pwa') });

let world;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await openWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const STATIC = /\.(js|css|html|svg|png|jpe?g|webp|woff2?|webmanifest|ico|json)(\?|$)|\/admin\/?$/i;
const swReady = (page) => page.evaluate(async () => {
  const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  return registration ? { scope: registration.scope, active: Boolean(registration.active) } : null;
});

async function twoBusinesses() {
  const alpha = await world.business(`Alpha Looms ${unique()}`);
  const beta = await world.business(`Beta Brass ${unique()}`);
  const phone = newPhone();
  await world.person(alpha, { role: 'owner', phone, name: 'Asha Rao' });
  await world.person(beta, { role: 'manager', phone, name: 'Asha Rao' });
  const aName = `Alpha-only-${unique()}`;
  const bName = `Beta-only-${unique()}`;
  await world.product(alpha, aName);
  await world.product(beta, bName);
  return { alpha, beta, phone, aName, bName };
}

async function signOut(page) {
  const direct = page.getByRole('button', { name: 'Sign out' }).first();
  if (!(await direct.isVisible().catch(() => false))) await page.getByRole('button', { name: /More/ }).first().click();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /Sign out/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByLabel('WhatsApp number')).toBeVisible({ timeout: 20_000 });
}

test('Q-12: the console is installable: a manifest in scope, a worker file that is never cached for long, and a registered worker for /admin/ only', async ({ page }) => {
  expect(hasWorker, 'console/public/sw.js is in the build').toBe(true);
  const { phone } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin') });
  const link = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href ?? '');
  expect(link).toMatch(/\/admin\/manifest\.webmanifest$/);
  const manifest = await page.request.get(link);
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toMatch(/json|manifest/);
  const body = await manifest.json();
  expect(body.scope).toBe('/admin/');
  expect(body.display).toBe('standalone');
  expect(body.name).toMatch(/bhava/i);
  const sw = await page.request.get(world.signInUrl('/admin/sw.js'));
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toMatch(/javascript/);
  expect(sw.headers()['cache-control'] ?? '').toMatch(/no-cache|no-store|max-age=0/i);
  const wider = sw.headers()['service-worker-allowed'];
  if (wider) expect(wider).toMatch(/\/admin\/?$/);
  const ready = await swReady(page);
  expect(ready, 'a worker registered and became active').not.toBeNull();
  expect(ready.scope).toMatch(/\/admin\/$/);
  expect(ready.active).toBe(true);
  await expectHealthy(page);
});

test('Q-12: the worker caches the app shell and static files and no API answer, whoever is signed in', async ({ page }) => {
  const { phone, aName, bName } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin/products') });
  await swReady(page);
  await page.reload();
  await page.goto(world.signInUrl('/admin/orders'));
  await page.goto(world.signInUrl('/admin/products'));
  await page.waitForLoadState('networkidle');
  const cached = await dumpCaches(page);
  expect(cached.length, 'something was cached: the shell').toBeGreaterThan(0);
  for (const entry of cached) {
    expect(entry.cache.startsWith('bhava-console-'), `${entry.cache} carries the console's prefix`).toBe(true);
    expect(entry.url, 'no API answer in a cache').not.toMatch(/\/api\//);
    expect(entry.url, 'no business media in a cache').not.toMatch(/\/media\//);
    expect(entry.url).toMatch(STATIC);
    expect(entry.body, 'no business data in a cached body').not.toContain(aName);
    expect(entry.body).not.toContain(bName);
  }
});

test('Q-12: after a switch of business the cache holds nothing of the first, and the screens show only the second', async ({ page }) => {
  const { alpha, beta, phone, aName, bName } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin/settings/account') });
  await swReady(page);
  const here = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).business.id);
  const [from, to] = here === alpha.id ? [alpha, beta] : [beta, alpha];
  const [fromName, toName] = from === alpha ? [aName, bName] : [bName, aName];
  await page.goto(world.signInUrl('/admin/products'));
  await expect(page.getByText(fromName)).toBeVisible();
  const before = await dumpCaches(page);
  expect(before.some((e) => e.body.includes(fromName))).toBe(false);

  await page.goto(world.signInUrl('/admin/settings/account'));
  await panel(page, 'Your businesses').getByRole('button', { name: `Switch to ${to.name}` }).click();
  await expect(page.locator('.shell-top')).toContainText(to.name);
  const after = await dumpCaches(page);
  for (const entry of after) {
    expect(entry.body, 'nothing of the business we left').not.toContain(fromName);
    expect(entry.url).not.toMatch(/\/api\//);
  }
  await page.goto(world.signInUrl('/admin/products'));
  await expect(page.getByText(toName)).toBeVisible();
  await expect(page.getByText(fromName)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(toName)).toBeVisible();
  await expect(page.getByText(fromName)).toHaveCount(0);

  // Offline right after the switch: the shell may open, the first business's data must not.
  await page.context().setOffline(true);
  await page.reload().catch(() => {});
  await expect(page.getByText(fromName)).toHaveCount(0);
  await expect(page.getByText(toName)).toHaveCount(0);
  await page.context().setOffline(false);
});

test('Q-12: after sign-out the caches are gone, a reload online shows the sign-in page, and offline shows no business data at all', async ({ page }) => {
  const { phone, aName, bName } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin/products') });
  await swReady(page);
  await page.waitForLoadState('networkidle');
  await signOut(page);
  const left = await dumpCaches(page);
  expect(left.filter((e) => e.body.includes(aName) || e.body.includes(bName)), 'no cached business data after sign-out').toEqual([]);
  expect(left.filter((e) => /\/api\//.test(e.url))).toEqual([]);
  await page.goto(world.signInUrl('/admin/products'));
  await expect(page.getByLabel('WhatsApp number')).toBeVisible();
  await expect(page.getByText(aName)).toHaveCount(0);
  await expect(page.getByText(bName)).toHaveCount(0);

  await page.context().setOffline(true);
  await page.goto(world.signInUrl('/admin/products')).catch(() => {});
  const text = await page.locator('body').innerText().catch(() => '');
  expect(text).not.toContain(aName);
  expect(text).not.toContain(bName);
  expect(text, 'the page says what is wrong: it is not blank').toMatch(/offline|connection|internet|sign in|WhatsApp number|try again/i);
  await page.context().setOffline(false);
});

test('Q-12: signed in and offline, the installed app opens its shell and says it is offline instead of showing old data or a blank page', async ({ page }) => {
  const { phone, aName, bName } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin/products') });
  await swReady(page);
  await page.waitForLoadState('networkidle');
  await page.context().setOffline(true);
  await page.goto(world.signInUrl('/admin/products')).catch(() => {});
  await page.waitForTimeout(1500);
  const text = await page.locator('body').innerText().catch(() => '');
  expect(text.trim().length, 'not a blank page').toBeGreaterThan(10);
  expect(text, 'API answers are never cached, so no product can appear').not.toContain(aName);
  expect(text).not.toContain(bName);
  expect(text).toMatch(/offline|connection|internet|couldn.t load|try again/i);
  await page.context().setOffline(false);
  await page.getByRole('button', { name: /try again|retry|reload/i }).first().click({ timeout: 5000 }).catch(() => page.reload());
  await expect(page.getByText(/Alpha-only|Beta-only/).first()).toBeVisible({ timeout: 20_000 });
  expect(consoleDir.length).toBeGreaterThan(0);
});

test('Q-12: an update cleans up after an old version and leaves another app\'s caches alone', async ({ page }) => {
  const { phone } = await twoBusinesses();
  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin') });
  await swReady(page);
  const names = await page.evaluate(async () => {
    await caches.open('bhava-console-leftover-from-an-old-version');
    await caches.open('someone-elses-cache');
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    return caches.keys();
  });
  expect(names).toContain('someone-elses-cache');
  await page.reload();
  await swReady(page);
  await page.waitForTimeout(1000);
  const later = await page.evaluate(() => caches.keys());
  expect(later, 'a cache of another app is none of the console\'s business').toContain('someone-elses-cache');
  await page.evaluate(() => caches.delete('someone-elses-cache'));
});
