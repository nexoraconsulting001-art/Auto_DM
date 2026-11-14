// Phase 7 in a real phone-sized browser, written from the PRD (3, 5.10, 5.12, 5.20): the Free creator page carries the
// made-with mark and loses it the moment the business pays (U-07, U-08, F-127); the seller console shows a Free account's
// automation limit with an upgrade and makes no fourth automation (F-123); and an operator's impersonation opens the
// owner's console under a banner, read-only, where a save is refused and nothing changes (F-42, F-43).
//
// Every business here has its own address under shops.example. Chromium is told to send those names to this machine and
// not to the dead proxy that keeps it off the internet. Needs a console build (npm run build:console).
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(), and semver requires itself in a
// circle: both are loaded with require first, then the app's test support.
const require = createRequire(import.meta.url);
require('semver');
require('sharp');
const { appSignIn, change, consoleUser, json, need, one, opCall, openBillingWorld, shopOn, sql, subscribe, unique } = await import('../../../test/p7/spec-p7/support.js');

test.use({
  viewport: { width: 360, height: 740 },
  actionTimeout: 15_000,
  navigationTimeout: 20_000,
  launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=*.shops.example;*.localhost;127.0.0.1', '--host-resolver-rules=MAP *.shops.example 127.0.0.1', '--disable-features=P7SpecPlan'] },
});
test.setTimeout(240_000);

const MARK = /Made with Bhava/i;
let world;
let port;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  // The earlier phases' setup makes each business through the Phase 0 password login, which is on under node's test runner
  // but not inside Playwright's worker: it is turned on here for that scaffolding only.
  world = await openBillingWorld({ overrides: { passwordLogin: true, queuePollMs: 250 } });
  port = new URL(world.base).port;
});
test.afterAll(async () => {
  await world?.close();
});

const at = (shop, path) => `http://${shop.host}:${port}${path}`;

/** Gives the browser the owner's console session on the business's own address, as signing in there would. */
async function signInOwner(context, shop) {
  const person = await appSignIn(world, shop.owner.phone, shop.host);
  const [name, ...rest] = person.cookie.split('=');
  await context.addCookies([{ name, value: rest.join('='), domain: shop.host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  return person;
}

test('U-07: a Free creator\'s page shows the made-with mark in its footer on a phone, and the DM the shopper gets has none', async ({ page }) => {
  const shop = await shopOn(world, 'free');
  const slug = `u7${unique()}`.slice(0, 20);
  need(await shop.send('PATCH', '/creator-page', { slug, enabled: true }), 200, 'Turning the creator page on');
  const opened = await page.goto(at(shop, `/${slug}`));
  expect(opened?.status()).toBe(200);
  const mark = page.getByText(MARK).first();
  await expect(mark).toBeVisible();
  // The mark sits at the foot of the page, not over the creator's own content.
  expect(await mark.evaluate((el) => Boolean(el.closest('footer')))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle();
  const sent = JSON.stringify(await shop.sent());
  expect(sent.length).toBeGreaterThan(2);
  expect(sent).not.toMatch(/bhava/i);
});

test('U-08: paying for tier 1 removes the mark at the next page load, at the same address', async ({ page }) => {
  const shop = await shopOn(world, 'free');
  const slug = `u8${unique()}`.slice(0, 20);
  need(await shop.send('PATCH', '/creator-page', { slug, enabled: true }), 200, 'Turning the creator page on');
  await page.goto(at(shop, `/${slug}`));
  await expect(page.getByText(MARK).first()).toBeVisible();
  await subscribe(world, shop, 't1');
  const again = await page.reload();
  expect(again?.status()).toBe(200);
  await expect(page.getByText(MARK)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/${slug}`);
});

test('F-123: in the seller console a Free account with three automations is shown its limit and an upgrade, and no fourth is made', async ({ page, context }) => {
  const shop = await shopOn(world, 'free');
  for (let i = 0; i < 3; i++) need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, `Automation ${i + 1}`);
  await signInOwner(context, shop);
  const opened = await page.goto(at(shop, '/admin/automations'));
  expect(opened?.status()).toBe(200);
  await expect(page.locator('body')).toContainText(/automation/i, { timeout: 20_000 });
  // Starting a fourth either is offered as an upgrade straight away or answers with one.
  const create = page.getByRole('button', { name: /new automation|create|add/i }).or(page.getByRole('link', { name: /new automation|create|add/i })).first();
  if (await create.count()) {
    await create.click();
    const save = page.getByRole('button', { name: /save|go live|create|publish/i }).first();
    if (await save.count() && await save.isEnabled()) await save.click().catch(() => {});
  }
  await expect(page.getByText(/upgrade/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).toContainText(/\b3\b/);
  const n = Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n);
  expect(n).toBe(3);
});

test('F-42: an operator\'s support session opens the owner\'s console under a read-only banner; a save there is refused and nothing changes', async ({ page }) => {
  const shop = await shopOn(world, 't3');
  const before = await one(world, 'SELECT store_name FROM settings WHERE tenant_id = $1', [shop.tenantId]).catch(() => null);
  const op = await consoleUser(world, 'support');
  const started = json(need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'ticket 4242' }), [200, 201], 'Starting a support session'));
  const url = new URL(started.url, at(shop, '/'));
  const opened = await page.goto(at(shop, `${url.pathname}${url.search}`));
  expect(opened?.status() ?? 200).toBeLessThan(400);
  await expect(page).toHaveURL(/\/admin/, { timeout: 20_000 });
  const banner = page.getByText(/support session|viewing as|impersonat|read-only|read only/i).first();
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).toContainText(/read-only|read only/i);
  // A save in read mode: the console shows the refusal and the database is as it was.
  await page.goto(at(shop, '/admin/settings'));
  const field = page.getByLabel(/store name|business name|name/i).first();
  if (await field.count() && await field.isEditable()) {
    await field.fill(`Changed by support ${unique()}`);
    const save = page.getByRole('button', { name: /save/i }).first();
    if (await save.count() && await save.isEnabled()) {
      await save.click();
      await expect(page.getByText(/read-only|read only|can.t|not allowed/i).first()).toBeVisible({ timeout: 15_000 });
    }
  }
  const after = await one(world, 'SELECT store_name FROM settings WHERE tenant_id = $1', [shop.tenantId]).catch(() => null);
  expect(after).toEqual(before);
  // The banner names no secret and the page never shows the owner's phone number in full.
  const ownerPhone = String(shop.owner.phone).replace(/\D/g, '').slice(-10);
  expect(await page.locator('body').innerText()).not.toContain(ownerPhone);
  void change; void sql;
});
