// The console's own sign-in page in a real phone-sized browser (PRD 5.11, 10.3): Continue with Google and a 6-digit code
// from Bhava's WhatsApp number, never a password unless the server still has PASSWORD_LOGIN, never SMS; "Use Google
// sign-in" for a phone with no WhatsApp; a deep link that survives signing in; and the refusal on a business's own address
// for someone who has no account there. P-11, F-117, F-118, F-109 (the console's half).
import { test, expect } from '@playwright/test';
import { OWNER } from '../../../test/helpers.js';
import { PHONE, expectHealthy, newPhone, openWorld, ownWorker, signInWithCode, unique, watch } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleSignIn') });

const signedInAs = (page) => page.evaluate(async () => {
  const res = await fetch('/api/v1/auth/me');
  return res.ok ? res.json() : { status: res.status };
});

test.describe('with PASSWORD_LOGIN off, as in production', () => {
  let world;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    world = await openWorld();
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('P-11: on the sign-in host the console offers Google and a WhatsApp code, with no password field and no SMS, under Bhava\'s name', async ({ page }) => {
    const problems = watch(page);
    await page.goto(world.signInUrl('/admin'));
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByLabel('WhatsApp number')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send code on WhatsApp' })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\bSMS\b|text message|password/i);
    await expect(page.getByRole('img', { name: 'Bhava' })).toBeVisible();
    await expectHealthy(page);
    expect(problems).toEqual([]);
  });

  test('F-117: a code from Bhava\'s WhatsApp number signs a seller in, a wrong one is refused, and the deep link they opened stays', async ({ page, context }) => {
    const { tenant, owner } = await world.shop({ name: `Neem Tree ${unique()}` });
    await world.freshCodes();
    await page.goto(world.signInUrl('/admin/settings/devices'));
    await page.getByLabel('WhatsApp number').fill('12345');
    await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
    await expect(page.getByText('Enter your mobile number, such as 98765 43210, or with its country code.')).toBeVisible();

    await page.getByLabel('WhatsApp number').fill(owner.phone);
    await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible();
    await expect(page.getByText(/We sent a code on WhatsApp to \+91 ••••• •\d{4}/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send a new code' })).toBeDisabled();
    await expect(page.getByText(/You can ask again in \d+ s\./)).toBeVisible();
    await expectHealthy(page);

    const code = await world.code(owner.phone);
    await page.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('didn’t');
    await expect(page.getByLabel('6-digit code')).toHaveValue('');

    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/admin\/settings\/devices$/);
    // This browser signed in as a device of its own, so Devices lists it and can sign it out.
    await expect(page.getByText('This device')).toBeVisible();
    await expect(page.getByText('Chrome on Android').first()).toBeVisible();

    const me = await signedInAs(page);
    expect(me.business.id).toBe(tenant.id);
    expect(me.user.role).toBe('owner');
    const session = (await context.cookies()).find((c) => c.httpOnly && c.domain.endsWith('localhost'));
    expect(session, 'The console session is an httpOnly cookie').toBeTruthy();
  });

  test('F-118: a phone that gets no code on WhatsApp is offered Google sign-in, which signs them in', async ({ page }) => {
    const sub = `g-${unique()}`;
    await world.google.post('/next-user', { sub, email: `${sub}@gmail.example`, name: 'Meera Joshi' });
    await world.freshCodes();
    await page.goto(world.signInUrl('/admin'));
    await page.getByLabel('WhatsApp number').fill(newPhone());
    await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
    await expect(page.getByText('Didn’t get it?')).toBeVisible();
    const google = page.getByRole('link', { name: 'Use Google sign-in' });
    await expect(google).toBeVisible();
    expect(await google.getAttribute('href')).toMatch(/^\/auth\/google\/start\?target=web&next=%2Fadmin$/);
    await google.click();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached({ timeout: 20_000 });
    const me = await signedInAs(page);
    expect(me.user.name).toBe('Meera Joshi');
  });

  test('F-109: Continue with Google signs a new person in to a Creator business on the Free plan, with no password anywhere', async ({ page }) => {
    const sub = `g-${unique()}`;
    await world.google.post('/next-user', { sub, email: `${sub}@gmail.example`, name: 'Kabir Sen' });
    await page.goto(world.signInUrl('/admin'));
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached({ timeout: 20_000 });
    const me = await signedInAs(page);
    expect(me.business.accountType).toBe('creator');
    expect(me.user.role).toBe('owner');
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test('on a business\'s own address: a WhatsApp code and no Google (it starts only on the sign-in host), and no password', async ({ page }) => {
    await page.goto(world.shopUrl('/admin'));
    await expect(page.getByLabel('WhatsApp number')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expectHealthy(page);

    await signInWithCode(page, world, OWNER.phone, { url: world.shopUrl('/admin') });
    const me = await signedInAs(page);
    expect(me.business.id).toBe(world.app.tenant.id);
  });

  test('on a business\'s own address, someone with no account there is told so in the server\'s words', async ({ page }) => {
    const { owner } = await world.shop();
    await world.freshCodes();
    await page.goto(world.shopUrl('/admin'));
    await page.getByLabel('WhatsApp number').fill(owner.phone);
    await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
    await page.getByLabel('6-digit code').fill(await world.code(owner.phone));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('You don’t have an account at this business');
    await expectHealthy(page);
  });
});

test.describe('with PASSWORD_LOGIN on (tests and local runs)', () => {
  let world;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    world = await openWorld({ passwordLogin: true });
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('P-11: the password form shows on a business\'s own address only, and never on the sign-in host', async ({ page, browser }) => {
    await page.goto(world.shopUrl('/admin'));
    await expect(page.getByRole('heading', { name: 'Sign in with a password' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('WhatsApp number')).toBeVisible();
    await expectHealthy(page);
    await page.getByLabel('Mobile number').fill(OWNER.phone);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached({ timeout: 20_000 });

    const other = await browser.newContext({ viewport: PHONE });
    const fresh = await other.newPage();
    try {
      await fresh.goto(world.signInUrl('/admin'));
      await expect(fresh.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
      await expect(fresh.locator('input[type="password"]')).toHaveCount(0);
      await expect(fresh.getByRole('heading', { name: 'Sign in with a password' })).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});
