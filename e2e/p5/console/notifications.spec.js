// Notifications in a real phone-sized browser (PRD 5.13, 10.5): the in-app list from Bhava, newest first, each person's
// own; opening one marks it read and goes to what it is about when the console has a page for it; and the choices per
// kind and channel, with quiet hours, saved for this person in this business.
import { test, expect } from '@playwright/test';
import { PHONE, expectHealthy, openWorld, ownWorker, panel, signInWithCode, toast } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P5ConsoleNotifications') });

let world;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
});
test.afterAll(async () => {
  await world?.close();
});

test('the list: nothing yet, then this person\'s own notifications, read one by one or all at once', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  const manager = await world.person(tenant, { role: 'manager', name: 'Vikram Rao' });
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/notifications') });
  await expect(page.getByRole('heading', { name: 'Nothing new' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await expectHealthy(page);

  await world.notify(tenant, owner.userId, 'token.expiring', { data: { days: 7 } });
  await world.notify(tenant, owner.userId, 'device.signed_in');
  await world.notify(tenant, manager.userId, 'reach_guard.alert');
  await page.reload();
  await expect(page.getByRole('heading', { name: '2 unread notifications' })).toBeVisible();
  const rows = page.locator('.acct-note');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('New sign-in to your account');
  await expect(page.getByText('Reach Guard paused sending')).toHaveCount(0);
  await expectHealthy(page);

  // One about a page the console doesn't have only goes from unread to read.
  await rows.filter({ hasText: 'soon' }).click();
  await expect(page.getByRole('heading', { name: '1 unread notification' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/notifications$/);

  // The unread filter, then one that opens its page.
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page).toHaveURL(/\/admin\/settings\/devices$/);
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Nothing unread' })).toBeVisible();

  await world.notify(tenant, owner.userId, 'reach_guard.alert');
  await world.notify(tenant, owner.userId, 'dm.usage_80', { data: { percent: 80 } });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '2 unread notifications' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await expect(rows).toHaveCount(4);
  const [{ unread }] = await world.app.db.platform.query('SELECT count(*)::int AS unread FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [tenant.id, owner.userId]);
  expect(unread).toBe(0);
  const [{ theirs }] = await world.app.db.platform.query('SELECT count(*)::int AS theirs FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [tenant.id, manager.userId]);
  expect(theirs, 'someone else\'s list is left alone').toBe(1);
});

test('quiet hours: saved for this person, crossing midnight, and never from and to the same time', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/notifications/settings') });
  const quiet = panel(page, 'Quiet hours');
  await expect(quiet.getByText('Off: push and WhatsApp come at any hour.')).toBeVisible();
  await expectHealthy(page);

  await quiet.getByText('Hold push and WhatsApp at night').click();
  await quiet.getByLabel('From').fill('23:00');
  await quiet.getByLabel('To').fill('23:00');
  await quiet.getByRole('button', { name: 'Save quiet hours' }).click();
  await expect(quiet.getByText('Choose a different time from the start')).toBeVisible();
  await expectHealthy(page);

  await quiet.getByLabel('To').fill('06:30');
  await quiet.getByRole('button', { name: 'Save quiet hours' }).click();
  await expect(toast(page, 'Quiet hours saved.')).toBeVisible();
  await expect(quiet.getByText('On: from 23:00 to 06:30 the next morning, push and WhatsApp wait.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(quiet.getByLabel('From')).toHaveValue('23:00');
  await expect(quiet.getByLabel('To')).toHaveValue('06:30');
  const [saved] = await world.app.db.platform.query('SELECT quiet_enabled, quiet_from, quiet_to FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2', [tenant.id, owner.userId]);
  expect(saved).toMatchObject({ quiet_enabled: true, quiet_from: '23:00', quiet_to: '06:30' });
});

test('choices per kind and channel: one switch saves at once, a channel nobody set up is shown as such, and security notices stay on', async ({ page }) => {
  const { tenant, owner } = await world.shop();
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/notifications/settings') });
  const kinds = panel(page, 'What you hear about');
  const stopped = kinds.getByRole('region', { name: 'A connection stopped working' });
  await expect(stopped.getByText('Urgent')).toBeVisible();
  const whatsapp = stopped.getByRole('switch', { name: 'WhatsApp' });
  await expect(whatsapp).toBeChecked();
  await expect(whatsapp).toBeEnabled();
  // Nothing sends push or email in this world, so those are shown and can't be switched.
  await expect(stopped.getByRole('switch', { name: 'Email (not set up yet)' })).toBeDisabled();
  await expectHealthy(page);

  await whatsapp.uncheck();
  await expect(whatsapp).not.toBeChecked();
  await expect.poll(async () => (await world.app.db.platform.query('SELECT events FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2', [tenant.id, owner.userId]))[0]?.events?.['token.invalid']?.whatsapp).toBe(false);
  await page.reload();
  await expect(kinds.getByRole('region', { name: 'A connection stopped working' }).getByRole('switch', { name: 'WhatsApp' })).not.toBeChecked();

  const signIns = kinds.getByRole('region', { name: 'New sign-ins' });
  await expect(signIns.getByText('A security notice: it always reaches you and can’t be turned off.')).toBeVisible();
  await expect(signIns.getByRole('switch')).toHaveCount(0);
});

test('a choice the server refuses is put back and its reason shown', async ({ page }) => {
  const { owner } = await world.shop();
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl('/admin/notifications/settings') });
  await page.route(/\/api\/v1\/notifications\/prefs$/, (route) => (route.request().method() === 'PUT'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'This notification is not sent by WhatsApp.', code: 'validation_failed' }) })
    : route.continue()));
  const kinds = panel(page, 'What you hear about');
  const whatsapp = kinds.getByRole('region', { name: 'A connection stopped working' }).getByRole('switch', { name: 'WhatsApp' });
  // The switch moves at once and moves back when the server refuses, so this is a click, not uncheck().
  await whatsapp.click();
  await expect(kinds.getByRole('alert')).toHaveText('This notification is not sent by WhatsApp.');
  await expect(whatsapp).toBeChecked();
  await expectHealthy(page);
});
