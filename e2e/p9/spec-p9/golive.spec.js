// G-15 and G-17 as a person sees them, in a real phone-sized browser: the go-live screen in the Platform Console, and the
// sign-up switch refusing public while a blocking item is missing, then letting a super admin force it with a second reason.
// The routes are tested over HTTP in test/p9/spec-p9/golive.test.js; this is the screen. Nothing leaves this machine.
import { test, expect } from '@playwright/test';
import { GOLIVE_ITEMS } from '../../../src/contracts/golive.js';

const { expectHealthy, openConsoleWorld, ownWorker, PHONE, sheet, signedIn, watch } = await import('../../p7/platform/support.js');

test.use({ viewport: PHONE, ...ownWorker('P9GoLive') });

let world;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await openConsoleWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('G-15: the go-live screen lists every item as ready or missing with who must act, blocking ones first, the verdict, and no value of any setting', async ({ page }) => {
  const operator = await world.operator('support');
  const problems = watch(page, world);
  await signedIn(page.context(), world, operator);
  await page.goto(world.consoleUrl('/golive'));
  const blocking = GOLIVE_ITEMS.filter((i) => i.blocks);
  await expect(page.getByText(blocking[0].title).first()).toBeVisible({ timeout: 20_000 });
  for (const item of GOLIVE_ITEMS.filter((i) => i.check.kind === 'attestation')) await expect(page.getByText(item.title).first()).toBeVisible();
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).toMatch(/not ready/i);
  expect(text).toMatch(/missing/i);
  expect(text).toMatch(/\bus\b/i);
  expect(text).toMatch(/\byou\b|\bfounder\b|\buser\b/i);
  const firstBlocking = text.indexOf(blocking[0].title);
  const firstOptional = text.indexOf(GOLIVE_ITEMS.find((i) => !i.blocks && i.check.kind !== 'per_business').title);
  expect(firstBlocking, 'blocking items come first').toBeLessThan(firstOptional);
  expect(text).not.toMatch(/rzp_(live|test)_|EAA[A-Za-z0-9]{20,}|-----BEGIN|postgres:\/\//);
  expect(await sideways(page), 'no sideways scroll on a phone').toBeLessThanOrEqual(0);
  await expectHealthy(page);
  expect(problems).toEqual([]);
});

test('G-15: someone without a role for it does not see the go-live screen', async ({ page }) => {
  const operator = await world.operator('onboarding');
  await signedIn(page.context(), world, operator);
  await page.goto(world.consoleUrl('/golive'));
  await expect(page.getByText(GOLIVE_ITEMS[0].title)).toHaveCount(0);
});

test('G-17: public is refused while an item is missing, the screen names what is missing, and forcing it asks for a second reason and sends both', async ({ page }) => {
  const operator = await world.operator('super_admin');
  await signedIn(page.context(), world, operator);
  const sent = [];
  const openState = { mode: 'public', freePerInstagram: 1, dailyCap: null, updatedAt: new Date().toISOString() };
  await page.route('**/signup', async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const body = request.postDataJSON();
    sent.push(body);
    if (!body.force) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Sign-up cannot open to the public yet.', code: 'conflict', fields: { golive: 'meta.app_live, hosting.tls' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(openState) });
  });
  await page.goto(world.consoleUrl('/signup'));
  await page.getByRole('button', { name: 'Change who can sign up' }).click();
  const dialog = sheet(page, 'Change who can sign up');
  await dialog.getByLabel('Sign-up is').selectOption('public');
  await dialog.getByLabel(/Reason|What needs to change|What changed/).first().fill('launch day');
  await dialog.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.getByText(/meta\.app_live|Meta app is in Live mode/i).first()).toBeVisible();
  expect(sent.length).toBe(1);
  expect(sent[0].force ?? false).toBe(false);
  const second = page.getByLabel(/second reason|why (it|you) (is|are) opening anyway|force reason/i);
  await expect(second).toBeVisible();
  const forceButton = page.getByRole('button', { name: /open anyway|force|change anyway/i });
  await expect(forceButton, 'forcing needs its own reason').toBeDisabled();
  await second.fill('   ');
  await expect(forceButton).toBeDisabled();
  await second.fill('the founder accepted the open items');
  await expect(forceButton).toBeEnabled();
  await forceButton.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ mode: 'public', reason: 'launch day', force: true, forceReason: 'the founder accepted the open items' });
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test('G-17: a support user is not offered the sign-up switch', async ({ page }) => {
  const operator = await world.operator('support');
  await signedIn(page.context(), world, operator);
  await page.goto(world.consoleUrl('/signup'));
  await expect(page.getByRole('button', { name: 'Change who can sign up' })).toHaveCount(0);
});
