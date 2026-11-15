// Q-13: showcase feedback in the Platform Console, in a real phone-sized browser: logged per business, tracked to fixed, and
// shown escaped. The routes are tested over HTTP in test/p8/spec-p8; this is what a person sees.
import { test, expect } from '@playwright/test';

const { HOST, hit, openConsoleWorld, ownWorker, signedIn, watch, PHONE, expectHealthy } = await import('../../p7/platform/support.js');

test.use({ viewport: PHONE, ...ownWorker('P8Feedback') });

let world;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await openConsoleWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const unique = () => Math.random().toString(36).slice(2, 8);

async function logFeedback(operator, tenantId, body) {
  const me = (await hit(world, '/me', { host: HOST, cookie: operator.cookie })).json();
  const res = await hit(world, `/tenants/${tenantId}/feedback`, { host: HOST, method: 'POST', cookie: operator.cookie, headers: { 'x-csrf-token': me.csrf }, body });
  expect(res.status, res.text).toBe(201);
  return { csrf: me.csrf, item: res.json() };
}

async function business(name) {
  return world.platform.tenants.create({ slug: `fb-${unique()}`, name: `${name} ${unique()}`, plan: 't3' });
}

test('Q-13: the feedback screen lists each item with its business, who said it, where, how bad and its state, and shows the words as text', async ({ page }) => {
  const operator = await world.operator('support');
  const a = await business('Feedback Alpha');
  const b = await business('Feedback Beta');
  const markup = `<img src=x onerror="window.__fed=1"> <b>bold</b> ${unique()}`;
  await logFeedback(operator, a.id, { saidBy: 'The owner', area: 'Orders', text: markup, severity: 'high' });
  await logFeedback(operator, b.id, { saidBy: 'A shopper', area: 'Checkout', text: `Beta words ${unique()}`, severity: 'low' });
  const problems = watch(page, world);
  await signedIn(page.context(), world, operator);
  await page.goto(world.consoleUrl('/feedback'));
  await expect(page.getByText(a.name).first()).toBeVisible();
  await expect(page.getByText(b.name).first()).toBeVisible();
  await expect(page.getByText('The owner').first()).toBeVisible();
  await expect(page.getByText('Orders').first()).toBeVisible();
  await expect(page.getByText(/high/i).first()).toBeVisible();
  await expect(page.getByText(/\bnew\b/i).first()).toBeVisible();
  await expect(page.getByText('<b>bold</b>', { exact: false }).first(), 'markup is shown as the characters that were typed').toBeVisible();
  expect(await page.evaluate(() => window.__fed), 'nothing in the feedback ran').toBeUndefined();
  expect(await page.locator('main img[src="x"], .feedback img[src="x"], img[src="x"]').count(), 'no image was made from the words').toBe(0);
  expect(await page.locator('main b, .feedback b').filter({ hasText: /^bold$/ }).count(), 'no bold element was made from the words').toBe(0);
  await expectHealthy(page);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Q-13: an item tracked to fixed shows what fixed it, and the screen can be filtered to one business', async ({ page }) => {
  const operator = await world.operator('super_admin');
  const a = await business('Tracked Alpha');
  const b = await business('Tracked Beta');
  const { item, csrf } = await logFeedback(operator, a.id, { saidBy: 'The owner', area: 'Inbox', text: `Fix me ${unique()}`, severity: 'blocker' });
  await logFeedback(operator, b.id, { saidBy: 'The owner', area: 'Insights', text: `Other business ${unique()}`, severity: 'low' });
  const fixed = await hit(world, `/feedback/${item.id}`, { host: HOST, method: 'PATCH', cookie: operator.cookie, headers: { 'x-csrf-token': csrf }, body: { state: 'fixed', fixedIn: 'abc1234' } });
  expect(fixed.status, fixed.text).toBe(200);
  await signedIn(page.context(), world, operator);
  await page.goto(world.consoleUrl('/feedback'));
  await expect(page.getByText('abc1234').first()).toBeVisible();
  await expect(page.getByText(/fixed/i).first()).toBeVisible();
  const picker = page.getByRole('combobox', { name: /business|tenant/i }).first();
  if (await picker.count()) {
    await picker.selectOption({ label: a.name }).catch(() => picker.selectOption({ value: String(a.id) }));
    await expect(page.getByText(b.name)).toHaveCount(0);
    await expect(page.getByText(a.name).first()).toBeVisible();
  } else {
    await page.goto(world.consoleUrl(`/feedback?tenantId=${a.id}`));
    await expect(page.getByText(b.name)).toHaveCount(0);
  }
});

test('Q-13: a platform user without the support or super admin role is turned away from the screen and sees no feedback', async ({ page }) => {
  const admin = await world.operator('super_admin');
  const a = await business('Hidden Alpha');
  const secret = `secret-${unique()}`;
  await logFeedback(admin, a.id, { saidBy: 'The owner', area: 'Orders', text: secret, severity: 'medium' });
  const onboarder = await world.operator('onboarding');
  await signedIn(page.context(), world, onboarder);
  await page.goto(world.consoleUrl('/feedback'));
  await page.waitForLoadState('networkidle');
  expect(await page.locator('body').innerText()).not.toContain(secret);
  const api = await hit(world, '/feedback', { host: HOST, cookie: onboarder.cookie });
  expect(api.status).toBe(403);
  expect(api.text).not.toContain(secret);
  const me = (await hit(world, '/me', { host: HOST, cookie: onboarder.cookie })).json();
  const change = await hit(world, '/feedback/1', { host: HOST, method: 'PATCH', cookie: onboarder.cookie, headers: { 'x-csrf-token': me.csrf }, body: { state: 'planned' } });
  expect(change.status, 'a platform user without the role cannot change the state').toBe(403);
});
