// Settings > Team in a real phone-sized browser (PRD 5.11): the last owner can't be demoted or removed from the screen,
// and when it is tried anyway the server's refusal is what shows; a change asks for a fresh WhatsApp code first; staff
// permissions; someone removed here is signed out of their open console without a reload; and staff are neither shown
// the screen nor answered by its API. F-49, F-47, P-12 (the console's half).
import { test, expect } from '@playwright/test';
import { PHONE, confirmItsYou, expectHealthy, newPhone, openWorld, ownWorker, panel, signInWithCode, toast } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleTeam') });

const LAST_OWNER = 'A business needs at least one owner. Make someone else an owner first.';

let world;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
});
test.afterAll(async () => {
  await world?.close();
});

const roleOf = async (tenant, userId) => (await world.app.db.platform.query('SELECT role, permissions, removed_at FROM users WHERE tenant_id = $1 AND id = $2', [tenant.id, userId]))[0];

test('F-49: the only owner cannot be demoted or removed on the screen, and when it is tried anyway the server\'s refusal shows', async ({ page }) => {
  const { tenant, owner } = await world.shop({ ownerName: 'Asha Rao' });
  const second = await world.person(tenant, { role: 'owner', name: 'Vikram Rao' });

  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/team') });
  const people = panel(page, 'People');
  await expect(people.getByText('Vikram Rao')).toBeVisible();
  await expect(people.getByRole('button', { name: 'Remove Asha Rao' })).toBeVisible();
  await expectHealthy(page);

  // From another device the other owner is made a manager, so this screen is out of date: Asha is now the only owner.
  const app = await world.appSession(owner.phone, { tenantId: tenant.id });
  expect((await app.send('PATCH', `/team/${second.userId}`, { role: 'manager' })).status).toBe(200);

  await people.getByRole('button', { name: 'Change role of Asha Rao' }).click();
  const sheet = page.getByRole('dialog', { name: 'Role of Asha Rao' });
  await sheet.getByLabel('Role').selectOption('manager');
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet.getByRole('alert')).toHaveText(LAST_OWNER);
  expect((await roleOf(tenant, owner.userId)).role).toBe('owner');
  await expectHealthy(page);
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  // Read again, the screen knows: the role can't be changed, the reason is given, and there is no Remove.
  await page.reload();
  await expect(people.getByText('Manager', { exact: true })).toBeVisible();
  await expect(people.getByRole('button', { name: 'Remove Asha Rao' })).toHaveCount(0);
  await people.getByRole('button', { name: 'Change role of Asha Rao' }).click();
  await expect(sheet.getByText(LAST_OWNER)).toBeVisible();
  await expect(sheet.getByLabel('Role')).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expectHealthy(page);

  // Straight to the API, the answer is the same.
  for (const [method, body] of [['PATCH', { role: 'staff', permissions: ['orders'] }], ['DELETE', undefined]]) {
    const res = await app.send(method, `/team/${owner.userId}`, body);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(LAST_OWNER);
  }
  expect((await roleOf(tenant, owner.userId)).role).toBe('owner');
});

test('a change to the team asks for a fresh WhatsApp code first, and closing that check changes nothing', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  const staff = await world.person(tenant, { role: 'staff', permissions: ['orders'], name: 'Ravi Kumar' });
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/team') });
  await expect(panel(page, 'Waiting to join').getByText('No open invitations')).toBeVisible();

  // The sign-in counted as a check for a few minutes; after that, a change asks again.
  await world.stale();
  const invite = panel(page, 'Invite someone');
  await invite.getByLabel('Phone number or email').fill(newPhone());
  await invite.getByLabel('Role').selectOption('staff');
  await invite.getByRole('button', { name: 'Inbox' }).click();
  const sent = await world.sentCount();
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toBeVisible();
  await expect.poll(world.sentCount).toBe(sent + 1);
  await expectHealthy(page);

  // A wrong code is refused on the field and the sheet stays.
  const sheet = page.getByRole('dialog', { name: 'Confirm it’s you' });
  const code = await world.code(owner.phone);
  await sheet.getByLabel('Code from WhatsApp').fill(code === '000000' ? '111111' : '000000');
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  await expect(sheet.getByRole('alert')).toContainText('didn’t match');
  await confirmItsYou(page, world, owner.phone);

  await expect(toast(page, 'Invitation saved. They join when they next sign in with it.')).toBeVisible();
  const waiting = panel(page, 'Waiting to join');
  await expect(waiting.getByText('Phone number')).toBeVisible();
  await expect(waiting.getByText('Orders, Inbox')).toBeVisible();
  const [row] = await world.app.db.platform.query('SELECT role, permissions FROM team_invites WHERE tenant_id = $1', [tenant.id]);
  expect(row).toEqual({ role: 'staff', permissions: ['orders', 'inbox'] });

  // Once more, after the check has run out again: closing the sheet leaves Ravi as he was, with no error.
  await world.stale();
  await panel(page, 'People').getByRole('button', { name: 'Change role of Ravi Kumar' }).click();
  const roleSheet = page.getByRole('dialog', { name: 'Role of Ravi Kumar' });
  await roleSheet.getByLabel('Role').selectOption('manager');
  await roleSheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  await expect(roleSheet.getByRole('alert')).toHaveCount(0);
  expect((await roleOf(tenant, staff.userId)).role).toBe('staff');
});

test('an owner changes what a staff member can do, and the screen says it in words', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  const staff = await world.person(tenant, { role: 'staff', permissions: ['orders'], name: 'Ravi Kumar' });
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/team') });
  const people = panel(page, 'People');
  await expect(people.getByText('Orders', { exact: true })).toBeVisible();
  await expect(people.getByText('Not signed in yet')).toBeVisible();

  await people.getByRole('button', { name: 'Change role of Ravi Kumar' }).click();
  const sheet = page.getByRole('dialog', { name: 'Role of Ravi Kumar' });
  await sheet.getByRole('button', { name: 'Orders' }).click();
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Choose at least one thing they can do.');
  await sheet.getByRole('button', { name: 'Customers' }).click();
  await sheet.getByRole('button', { name: 'Inbox' }).click();
  await expect(sheet.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-pressed', 'true');
  await expectHealthy(page);
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet).toBeHidden();
  await expect(toast(page, 'Ravi Kumar role is saved.')).toBeVisible();
  await expect(people.getByText('Customers, Inbox')).toBeVisible();
  expect(await roleOf(tenant, staff.userId)).toMatchObject({ role: 'staff', permissions: ['customers', 'inbox'] });
});

test('F-47: someone removed on the Team screen is signed out of their open console within 60 s, without a reload there', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { tenant, owner } = await world.shop();
  const staff = await world.person(tenant, { role: 'staff', permissions: ['orders'], name: 'Ravi Kumar' });

  const theirs = await browser.newContext({ viewport: PHONE });
  const there = await theirs.newPage();
  try {
    await signInWithCode(there, world, staff.phone, { url: world.signInUrl('/admin/orders') });
    await expect(there.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
    // A mark that a reload would wipe.
    await there.evaluate(() => {
      window.stillThisPage = true;
    });

    await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/settings/team') });
    const people = panel(page, 'People');
    await people.getByRole('button', { name: 'Remove Ravi Kumar' }).click();
    const ask = page.getByRole('dialog', { name: 'Remove Ravi Kumar?' });
    await expect(ask).toContainText('signed out of the console and the app at once');
    await ask.getByRole('button', { name: 'Remove' }).click();
    await expect(toast(page, 'Ravi Kumar can no longer open this business. Their sessions have ended.')).toBeVisible();
    await expect(people.getByText('Ravi Kumar')).toHaveCount(0);
    expect((await roleOf(tenant, staff.userId)).removed_at).not.toBeNull();

    await expect(there.getByLabel('WhatsApp number')).toBeVisible({ timeout: 60_000 });
    await expect(there.getByText('You were signed out.', { exact: false })).toBeVisible();
    await expect(there.getByRole('heading', { name: 'Orders', level: 1 })).toHaveCount(0);
    expect(await there.evaluate(() => window.stillThisPage), 'the page was not reloaded').toBe(true);
    await expectHealthy(there);
  } finally {
    await theirs.close();
  }
});

test('P-12: staff are not shown Team, the page refuses them, and so does its API', async ({ page }) => {
  const { tenant } = await world.shop();
  const staff = await world.person(tenant, { role: 'staff', permissions: ['orders'], name: 'Ravi Kumar' });
  await signInWithCode(page, world, staff.phone, { url: world.signInUrl('/admin') });
  await expect(page.locator('a[href="/admin/settings/team"]')).toHaveCount(0);
  // What every seller has: their own devices, notifications and account.
  await expect(page.locator('a[href="/admin/settings/devices"]').first()).toBeAttached();
  await expect(page.locator('a[href="/admin/notifications"]').first()).toBeAttached();
  await expect(page.locator('a[href="/admin/settings/account"]').first()).toBeAttached();

  await page.goto(world.signInUrl('/admin/settings/team'));
  await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
  const answer = await page.evaluate(async () => {
    const res = await fetch('/api/v1/team');
    return { status: res.status, body: await res.json() };
  });
  expect(answer).toEqual({ status: 403, body: expect.objectContaining({ code: 'forbidden', error: 'Owner only.' }) });
});
