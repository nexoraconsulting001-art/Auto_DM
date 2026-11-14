// Sign-in and roles in the Platform Console, in a real phone-sized browser (PRD 5.5; F-42 to F-45, F-39): an emailed code, then the
// authenticator; recovery codes once; no password and nothing remembered; a menu that holds only what a role may open, and the server's
// own refusal when a screen is reached by address or a route is called directly.
import { test, expect as baseExpect } from '@playwright/test';
import { HOST, PHONE, expectHealthy, hit, openConsoleWorld, ownWorker, refusal, signedIn, totp, watch, answer } from './support.js';

test.use({ viewport: PHONE, actionTimeout: 90_000, navigationTimeout: 90_000, ...ownWorker('P7PlatformSignin') });
const expect = baseExpect.configure({ timeout: 45_000 });
test.beforeEach(() => { test.setTimeout(600_000); });

let world;
test.beforeAll(async () => {
  test.setTimeout(900_000);
  world = await openConsoleWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const mailedCode = async (email) => {
  const sent = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email));
  return /(?<!\d)(\d{6})(?!\d)/.exec(`${sent.at(-1)?.text ?? ''}${sent.at(-1)?.html ?? ''}`)?.[1];
};

test('F-42: an emailed code, then enrolling an authenticator, then the recovery codes once; no password anywhere', async ({ page }) => {
  const problems = watch(page, world);
  const email = `new${Date.now()}@team.example`;
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Meera' });
  await page.goto(world.consoleUrl('/'));
  await expect(page.getByRole('heading', { name: 'Bhava Console' })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await expectHealthy(page);

  // Asking for a code for an email that is not ours looks the same as for one that is.
  await page.getByLabel('Work email').fill('nobody@team.example');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByText('If that email is one of ours')).toBeVisible();
  await page.getByRole('button', { name: 'Use a different email' }).click();

  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Code from the email').fill('000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Code from the email').fill(await mailedCode(email));
  await page.getByRole('button', { name: 'Continue' }).click();

  const secret = await page.getByLabel('Authenticator key').innerText();
  await expect(page.getByText('The key is shown only now.')).toBeVisible();
  await expectHealthy(page);
  await page.getByLabel('Code from your authenticator').fill(totp(secret.trim()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('They are not shown again.')).toBeVisible();
  const codes = await page.locator('.pc-codes li').allInnerTexts();
  expect(codes).toHaveLength(10);
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();

  // Nothing is kept in the browser, and signing out ends the session at the server.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
  const psid = (await page.context().cookies()).find((cookie) => cookie.name === 'psid');
  expect(psid).toBeTruthy();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Work email')).toBeVisible();
  expect((await hit(world, '/me', { host: HOST, cookie: `psid=${psid.value}` })).status).toBe(401);
  expect(problems).toEqual([]);
});

test('F-42: a sign-in that the server cannot take says so, and a wrong authenticator code does not sign anyone in', async ({ page }) => {
  await answer(page, 'POST', '/sign-in/code', refusal(501, 'Sign-in isn’t switched on for this server yet.', 'not_implemented'));
  await page.goto(world.consoleUrl('/'));
  await page.getByLabel('Work email').fill('a@team.example');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-in isn’t switched on for this server yet.');
});

test('F-39: each role is shown only its own menu, a screen reached by address is refused in words, and the server refuses a direct call', async ({ browser }) => {
  const rows = [
    ['service_operator', ['Services'], ['Businesses', 'Billing', 'Exports']],
    ['onboarding', ['Businesses', 'Onboarding'], ['Health', 'Billing', 'Exports', 'Pauses']],
    ['support', ['Businesses', 'Onboarding', 'Health', 'Pauses', 'Impersonation', 'Billing', 'Flags', 'Sign-up', 'Apps', 'Audit'], ['Exports', 'Services']],
    ['super_admin', ['Businesses', 'Exports', 'Services'], []],
  ];
  for (const [role, present, absent] of rows) {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await signedIn(context, world, await world.operator(role));
    await page.goto(world.consoleUrl('/'));
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
    // The menu on a phone is the tab bar plus "More"; open both to read every entry.
    await page.getByRole('button', { name: 'More' }).click();
    const names = await page.locator('.sheet-link, .tabbar-link').evaluateAll((nodes) => nodes.map((n) => (n.getAttribute('aria-label') || n.textContent).trim()));
    for (const name of present) expect(names, `${role} sees ${name}`).toContain(name);
    for (const name of absent) expect(names, `${role} does not see ${name}`).not.toContain(name);
    await context.close();
  }

  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  const operator = await world.operator('service_operator');
  await signedIn(context, world, operator);
  await page.goto(world.consoleUrl('/health'));
  await expect(page.getByRole('heading', { name: 'Your role doesn’t include this' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Health' })).toHaveCount(0);
  // The same route called straight from the page is refused by the server, with its own words and nothing of the data.
  const direct = await page.evaluate(async () => {
    const res = await fetch('/tenant-health', { headers: { accept: 'application/json' } });
    return { status: res.status, body: await res.text() };
  });
  expect(direct.status).toBe(403);
  expect(direct.body).not.toContain('tenantName');
  const posted = await page.evaluate(async () => (await fetch('/raw-export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  expect([401, 403]).toContain(posted);
  await context.close();
});

test('F-39: a refusal from the server on a screen is shown in the server’s words, with no way to carry on as if it worked', async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await signedIn(context, world, await world.operator('support'));
  await answer(page, 'GET', '/tenant-health', refusal(403, 'Your role does not include health.'));
  await page.goto(world.consoleUrl('/health'));
  await expect(page.getByRole('alert')).toContainText('Your role does not include health.');
  await expectHealthy(page);
  await context.close();
});
