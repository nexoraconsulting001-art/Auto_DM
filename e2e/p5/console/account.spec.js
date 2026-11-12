// Settings > Your account in a real phone-sized browser (PRD 5.11, 10.3, 10.6): the business switcher, which lists exactly
// the person's businesses and shows only the chosen one's data; adding a WhatsApp number or Google as another way in, after a
// fresh check; and Delete my account, which signs the person out everywhere and shows the timeline. P-09, P-10, P-26 (the
// console's half).
import { test, expect } from '@playwright/test';
import { PHONE, confirmItsYou, expectHealthy, newPhone, openWorld, ownWorker, panel, signInWithCode, toast, unique } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleAccount') });

let world;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const masked = (phone) => `+91 ••••• •${String(phone).slice(-4)}`;

test('P-09, P-10: the switcher lists exactly the person\'s businesses, and switching shows only the new one\'s products', async ({ page }) => {
  const alpha = await world.business(`Alpha Looms ${unique()}`);
  const beta = await world.business(`Beta Brass ${unique()}`);
  const gamma = await world.business(`Gamma Glass ${unique()}`);
  const phone = newPhone();
  await world.person(alpha, { role: 'owner', phone, name: 'Asha Rao' });
  await world.person(beta, { role: 'manager', phone, name: 'Asha Rao' });
  await world.person(gamma, { role: 'owner', name: 'Someone Else' });
  await world.product(alpha, 'Only in Alpha');
  await world.product(beta, 'Only in Beta');
  await world.product(gamma, 'Only in Gamma');

  await signInWithCode(page, world, phone, { url: world.signInUrl('/admin/settings/account') });
  const switcher = panel(page, 'Your businesses');
  await expect(switcher.locator('.acct-row')).toHaveCount(2);
  await expect(switcher.getByText(alpha.name)).toBeVisible();
  await expect(switcher.getByText(beta.name)).toBeVisible();
  await expect(page.getByText(gamma.name)).toHaveCount(0);
  await expect(switcher.getByText('Working here')).toHaveCount(1);
  await expectHealthy(page);

  const here = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).business.id);
  const [from, to] = here === alpha.id ? [alpha, beta] : [beta, alpha];
  const product = (business) => (business === alpha ? 'Only in Alpha' : 'Only in Beta');

  await page.goto(world.signInUrl('/admin/products'));
  await expect(page.getByText(product(from))).toBeVisible();

  await page.goto(world.signInUrl('/admin/settings/account'));
  await switcher.getByRole('button', { name: `Switch to ${to.name}` }).click();
  await expect(toast(page, `Now working in ${to.name}.`)).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('.shell-top')).toContainText(to.name);

  await page.goto(world.signInUrl('/admin/products'));
  await expect(page.getByText(product(to))).toBeVisible();
  await expect(page.getByText(product(from))).toHaveCount(0);
  await expect(page.getByText('Only in Gamma')).toHaveCount(0);

  // The choice is this tab's: a reload stays in it.
  await page.reload();
  await expect(page.getByText(product(to))).toBeVisible();
  await expect(page.locator('.shell-top')).toContainText(to.name);
});

test('adding a WhatsApp number as another way in: a fresh check of the old one, then a code to the new one', async ({ page }) => {
  const { owner } = await world.shop();
  const added = newPhone();
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/account') });
  const ways = panel(page, 'Ways to sign in');
  await expect(ways.getByText(masked(owner.phone))).toBeVisible();

  await world.stale();
  await ways.getByRole('button', { name: 'Add a WhatsApp number' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a WhatsApp number' });
  await sheet.getByLabel('WhatsApp number to add').fill(added);
  await sheet.getByRole('button', { name: 'Send code' }).click();
  await confirmItsYou(page, world, owner.phone);
  await expect(sheet.getByText(`We sent a code on WhatsApp to ${masked(added)}.`)).toBeVisible();
  await expectHealthy(page);

  const code = await world.code(added);
  await sheet.getByLabel('Code from WhatsApp').fill(code === '000000' ? '111111' : '000000');
  await sheet.getByRole('button', { name: 'Add number' }).click();
  await expect(sheet.getByRole('alert')).toContainText('didn’t match');
  await sheet.getByLabel('Code from WhatsApp').fill(code);
  await sheet.getByRole('button', { name: 'Add number' }).click();
  await expect(sheet).toBeHidden();
  await expect(ways.getByText('Added. You can now sign in with any of these.')).toBeVisible();
  await expect(ways.getByText(masked(added), { exact: false })).toBeVisible();
  await expect(ways.getByText(masked(owner.phone), { exact: false })).toBeVisible();
});

test('linking Google as another way in, through Google\'s page and back, so either opens the same account', async ({ page, browser }) => {
  const { tenant, owner } = await world.shop();
  const sub = `g-${unique()}`;
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/account') });
  await world.google.post('/next-user', { sub, email: `kavya.${sub}@gmail.example`, name: 'Kavya' });
  const ways = panel(page, 'Ways to sign in');
  await ways.getByRole('button', { name: 'Link Google' }).click();
  await expect(ways.getByText('Google is linked. You can now sign in with either.')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/admin\/settings\/account$/);
  await expect(ways.getByText('k•••@gmail.example', { exact: false })).toBeVisible();
  await expect(ways.getByRole('button', { name: 'Link Google' })).toHaveCount(0);

  // Google now opens this account, in another browser.
  const other = await browser.newContext({ viewport: PHONE });
  const there = await other.newPage();
  try {
    await world.google.post('/next-user', { sub, email: `kavya.${sub}@gmail.example`, name: 'Kavya' });
    await there.goto(world.signInUrl('/admin'));
    await there.getByRole('link', { name: 'Continue with Google' }).click();
    await expect(there.getByRole('navigation', { name: 'Main' }).first()).toBeAttached({ timeout: 20_000 });
    const me = await there.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()));
    expect(me.business.id).toBe(tenant.id);
    expect(me.user.id).toBe(owner.userId);
  } finally {
    await other.close();
  }
});

test('P-26: Delete my account asks for DELETE and a fresh code, signs out every device, and shows the timeline', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  const app = await world.appSession(owner.phone, { tenantId: tenant.id });
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/account') });
  await world.stale();

  const danger = panel(page, 'Delete my account');
  await danger.getByRole('button', { name: 'Delete my account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Delete your account?' });
  await sheet.getByLabel('Type DELETE to confirm').fill('delete');
  await sheet.getByRole('button', { name: 'Yes, delete my account' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Type DELETE to confirm');
  await expectHealthy(page);
  await sheet.getByLabel('Type DELETE to confirm').fill('DELETE');
  await sheet.getByRole('button', { name: 'Yes, delete my account' }).click();
  await confirmItsYou(page, world, owner.phone);

  await expect(page.getByRole('heading', { name: 'Your account will be deleted' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Asked on /)).toBeVisible();
  await expect(page.getByText('Signed out everywhere')).toBeVisible();
  await expect(page.getByText(/^Deleted on /)).toBeVisible();
  await expect(page.getByLabel('WhatsApp number')).toBeVisible();
  await expectHealthy(page);

  expect((await app.send('GET', '/auth/me')).status).toBe(401);
  const [asked] = await world.app.db.platform.query(`SELECT status, due_at - requested_at AS grace FROM account_deletion_requests r JOIN users u ON u.person_id = r.person_id WHERE u.tenant_id = $1 AND u.id = $2`, [tenant.id, owner.userId]);
  expect(asked.status).toBe('requested');
  const audit = await world.app.db.platform.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'account.deletion_requested'`, [tenant.id]);
  expect(audit).toHaveLength(1);
  const told = await world.app.db.platform.query(`SELECT audience FROM alerts WHERE tenant_id = $1 AND kind = 'account.deletion_requested'`, [tenant.id]);
  expect(told.map((a) => a.audience)).toEqual(['ops']);

  // Signing in again before the date cancels it, and the timeline is gone.
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/account') });
  const [after] = await world.app.db.platform.query(`SELECT status FROM account_deletion_requests r JOIN users u ON u.person_id = r.person_id WHERE u.tenant_id = $1 AND u.id = $2`, [tenant.id, owner.userId]);
  expect(after.status).toBe('cancelled');
  await page.getByRole('navigation', { name: 'Main' }).first().waitFor({ state: 'attached' });
  await expect(page.getByRole('heading', { name: 'Your account will be deleted' })).toHaveCount(0);
});
