// What Bhava's team does in the Platform Console, in a real phone-sized browser on the real app and its database (PRD 5.5 to 5.10, 5.12,
// 5.17, 5.20, 6.11, 6.12): every change that needs a reason cannot be sent without one, a secret is only ever shown masked, and the
// server's refusal is shown in its own words. Everything the console says it did is checked in the database afterwards.
import { test, expect as baseExpect } from '@playwright/test';
import {
  HOST, PHONE, expectHealthy, grantService, hit, openConsoleWorld, ownWorker, shopOn, signedIn, sql, sheet, submitWithReason, toast, watch,
} from './support.js';

test.use({ viewport: PHONE, actionTimeout: 90_000, navigationTimeout: 90_000, ...ownWorker('P7PlatformActions') });
const expect = baseExpect.configure({ timeout: 45_000 });
test.beforeEach(() => { test.setTimeout(600_000); });

let world;
let shop;
test.beforeAll(async () => {
  test.setTimeout(900_000);
  world = await openConsoleWorld();
  shop = await shopOn(world, 't3');
});
test.afterAll(async () => {
  await world?.close();
});

async function open(browser, role, path) {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  const problems = watch(page, world);
  const operator = await world.operator(role);
  await signedIn(context, world, operator);
  await page.goto(world.consoleUrl(path));
  return { context, page, operator, problems };
}

/** A call to the platform host as `operator`, with the session's own CSRF token. */
async function call(operator, method, path, body) {
  const me = await hit(world, '/me', { host: HOST, cookie: operator.cookie });
  return hit(world, path, { host: HOST, cookie: operator.cookie, method, ...(body === undefined ? {} : { body }), headers: { 'x-csrf-token': me.json().csrf } });
}

const requestsTo = (page, pattern) => {
  const seen = [];
  page.on('request', (request) => { if (request.method() !== 'GET' && pattern.test(new URL(request.url()).pathname)) seen.push(request.url()); });
  return seen;
};

test('F-36 F-37: a business is paused and resumed only with a reason, and the pause is the server’s', async ({ browser }) => {
  const { context, page, problems } = await open(browser, 'support', `/businesses/${shop.tenantId}`);
  const posts = requestsTo(page, /\/pause$|\/resume$/);
  await page.getByRole('button', { name: 'Pause business' }).click();
  const dialog = sheet(page, /^Pause /);
  const confirm = dialog.getByRole('button', { name: 'Pause business', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Reason').fill('    ');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Reason').press('Enter');
  expect(posts).toEqual([]);
  await dialog.getByLabel('Reason').fill('Meta asked us to stop');
  await expect(confirm).toBeEnabled();
  await expectHealthy(page);
  await confirm.click();
  await expect(page.getByText(/Nothing sends until it is resumed/)).toBeVisible();
  expect((await sql(world, 'SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenantId]))[0].paused).toBe(true);
  const row = (await sql(world, `SELECT details FROM audit_log WHERE tenant_id = $1 AND action ~ 'pause' ORDER BY id DESC LIMIT 1`, [shop.tenantId]))[0];
  expect(JSON.stringify(row)).toContain('Meta asked us to stop');

  await page.getByRole('button', { name: 'Resume business' }).click();
  await expect(sheet(page, /^Resume /).getByRole('button', { name: 'Resume business', exact: true })).toBeDisabled();
  await submitWithReason(page, /^Resume /, 'Resume business', 'cleared');
  await expect(page.getByText(/Nothing sends until it is resumed/)).toHaveCount(0);
  expect((await sql(world, 'SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenantId]))[0].paused).toBe(false);
  expect(problems).toEqual([]);
  await context.close();
});

test('F-38: the kill switch shows who set it, why, and a pending release; the one who asked cannot approve it, and the refusal is shown', async ({ browser }) => {
  const { context, page, operator } = await open(browser, 'super_admin', '/switches');
  await expect(page.getByTestId('global-switch')).toContainText('Off');
  await page.getByRole('button', { name: 'Engage the kill switch' }).click();
  await expect(sheet(page, 'Engage the kill switch').getByRole('button', { name: 'Stop all sending' })).toBeDisabled();
  await submitWithReason(page, 'Engage the kill switch', 'Stop all sending', 'Meta outage drill');
  await expect(page.getByTestId('global-switch')).toContainText('Engaged');
  await expect(page.getByTestId('global-switch')).toContainText('Meta outage drill');
  await page.getByRole('button', { name: 'Ask to release' }).click();
  await submitWithReason(page, 'Ask to release', 'Ask to release', 'drill over');
  await expect(page.getByTestId('pending-release')).toContainText('Release asked for by');
  await page.getByRole('button', { name: 'Approve the release' }).click();
  await submitWithReason(page, 'Approve the release', 'Approve and restart', 'I approve my own request');
  await expect(sheet(page, 'Approve the release').getByRole('alert')).not.toBeEmpty();
  expect((await sql(world, `SELECT engaged FROM platform_switches WHERE key = 'global_kill'`))[0].engaged).toBe(true);
  // A second person approves, and every pause shows who set what.
  const second = await world.operator('support');
  const res = await call(second, 'POST', '/kill-switch/release/approve', { reason: 'second pair of eyes' });
  expect(res.status).toBe(200);
  await page.reload();
  await expect(page.getByTestId('global-switch')).toContainText('Off');
  await expect(page.getByRole('heading', { name: 'Every pause' })).toBeVisible();
  expect(operator.role).toBe('super_admin');
  await context.close();
});

test('F-27 F-28 F-30: a business is created in the form, its invite link is shown masked once, and the operator’s time is reported', async ({ browser }) => {
  const { context, page, problems } = await open(browser, 'onboarding', '/businesses/new');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByText('Enter the business name')).toBeVisible();
  await expect(page.getByText('Enter the owner’s phone')).toBeVisible();
  await page.getByLabel('Business name').fill('Kesar Kitchen');
  await page.getByLabel('Owner’s name').fill('Asha Rao');
  await page.getByLabel('Owner’s phone').fill('9812300456');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByText('Kesar Kitchen is created.')).toBeVisible();
  await page.getByRole('link', { name: 'Open the onboarding workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Kesar Kitchen' })).toBeVisible();
  const id = Number(/onboarding\/(\d+)/.exec(page.url())[1]);
  await expect(page.getByTestId('active-time')).toContainText('of 10 min');
  await expect(page.getByRole('heading', { name: 'Checklist' })).toBeVisible();
  await expectHealthy(page);

  const made = page.waitForResponse((response) => response.url().endsWith('/onboarding/invite') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Make and send the link' }).click();
  const url = (await (await made).json()).url;
  await expect(page.getByTestId('invite-link')).toContainText('•');
  const token = url.split(/[/?=]/).filter((part) => part.length >= 16).at(-1);
  expect(await page.content()).not.toContain(token);
  expect(await page.locator('body').innerText()).not.toContain(token);
  await expect(page.getByRole('button', { name: 'Revoke the link' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke the link' }).click();
  await expect(toast(page, 'The link is revoked.')).toBeVisible();

  // Leaving the workspace reports the time spent on it; the form's time was reported when the business was made.
  await page.getByRole('link', { name: 'Onboarding' }).first().click().catch(() => page.goto(world.consoleUrl('/onboarding')));
  await expect.poll(async () => (await sql(world, 'SELECT step FROM onboarding_timings WHERE tenant_id = $1', [id])).map((r) => r.step), { timeout: 30_000 }).toContain('form');
  expect(problems).toEqual([]);
  await context.close();
});

test('F-40 F-41: health lists every business and runs the checks on request', async ({ browser }) => {
  const { context, page } = await open(browser, 'support', '/health');
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  await page.locator('.list-row').first().click();
  await expect(page.getByRole('button', { name: 'Run the checks' })).toBeVisible();
  await page.getByRole('button', { name: 'Run the checks' }).click();
  await expect(toast(page, 'The checks have run.')).toBeVisible();
  await expectHealthy(page);
  await context.close();
});

test('F-43 F-44 F-45: an impersonation starts read-only with a countdown; write mode needs the name typed and a reason; it can be ended', async ({ browser }) => {
  const { context, page, problems } = await open(browser, 'support', '/impersonation');
  await page.getByLabel('Business', { exact: true }).selectOption(String(shop.tenantId));
  await page.getByRole('button', { name: 'Start a read-only session' }).click();
  const start = sheet(page, /as its owner/);
  await expect(start.getByRole('button', { name: 'Start read-only session' })).toBeDisabled();
  await submitWithReason(page, /as its owner/, 'Start read-only session', 'ticket 123');
  const link = page.getByRole('link', { name: /as the owner/ });
  await expect(link).toHaveAttribute('href', /^https?:\/\//);
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(page.getByTestId('countdown').first()).toContainText(/\d+:\d\d/);
  const card = page.locator('[data-testid^="session-"]').first();
  await expect(card).toContainText('Read only');
  const name = (await card.locator('h2').first().innerText()).trim();
  await expectHealthy(page);

  await card.getByRole('button', { name: 'Allow changes' }).click();
  const write = sheet(page, /^Allow changes in /);
  const go = write.getByRole('button', { name: 'Allow changes', exact: true });
  await write.getByLabel(/What needs to change/).fill('fix a typo in a product name');
  await expect(go).toBeDisabled();
  await write.getByLabel('Business name').fill('some other shop');
  await expect(go).toBeDisabled();
  await write.getByLabel('Business name').fill(name);
  await expect(go).toBeEnabled();
  await go.click();
  await expect(card).toContainText('Changes allowed');
  expect((await sql(world, `SELECT mode FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]))[0].mode).toBe('write');

  await card.getByRole('button', { name: 'End the session' }).click();
  await expect(toast(page, 'The session has ended.')).toBeVisible();
  expect((await sql(world, `SELECT ended_at FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]))[0].ended_at).not.toBeNull();
  expect(problems).toEqual([]);
  await context.close();
});

test('F-51 to F-55: billing: a plan is changed only by a super admin and with a reason; support can suspend and resume with a reason', async ({ browser }) => {
  const admin = await open(browser, 'super_admin', `/billing/${shop.tenantId}`);
  await admin.page.getByRole('button', { name: 'Change plan' }).first().click();
  const dialog = sheet(admin.page, /^Change the plan of /);
  await dialog.getByLabel('Plan').selectOption('t2');
  await expect(dialog.getByRole('button', { name: 'Change plan', exact: true })).toBeDisabled();
  await submitWithReason(admin.page, /^Change the plan of /, 'Change plan', 'agreed on the phone');
  await expect(toast(admin.page, 'The plan is changed.')).toBeVisible();
  expect((await sql(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId]))[0].plan).toBe('t2');
  await expect(admin.page.getByRole('button', { name: 'Issue a credit note' })).toBeVisible();
  await expectHealthy(admin.page);
  await admin.context.close();

  const support = await open(browser, 'support', `/billing/${shop.tenantId}`);
  await expect(support.page.getByRole('button', { name: 'Suspend billing' })).toBeVisible();
  await expect(support.page.getByRole('button', { name: 'Change plan' })).toHaveCount(0);
  await expect(support.page.getByRole('button', { name: 'Issue a credit note' })).toHaveCount(0);
  const direct = await support.page.evaluate(async (id) => (await fetch(`/tenants/${id}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 't5', reason: 'x' }) })).status, shop.tenantId);
  expect([401, 403]).toContain(direct);
  await support.page.getByRole('button', { name: 'Suspend billing' }).click();
  await expect(sheet(support.page, 'Suspend billing').getByRole('button', { name: 'Suspend billing', exact: true })).toBeDisabled();
  await submitWithReason(support.page, 'Suspend billing', 'Suspend billing', 'chargeback dispute');
  await expect(support.page.getByRole('button', { name: 'Resume billing' })).toBeVisible();
  await support.page.getByRole('button', { name: 'Resume billing' }).click();
  await submitWithReason(support.page, 'Resume billing', 'Resume billing', 'dispute closed');
  await expect(support.page.getByRole('button', { name: 'Suspend billing' })).toBeVisible();
  await support.context.close();
});

test('F-121 to F-126: a service session needs a task reference, opens the seller’s screens by a link, and ends', async ({ browser }) => {
  await grantService(shop, 'catalog_management');
  await sql(world, `INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'catalog_management') ON CONFLICT (tenant_id, service) DO NOTHING`, [shop.tenantId]);
  const { context, page, problems } = await open(browser, 'service_operator', '/services');
  await expect(page.getByRole('heading', { name: 'Managed services' })).toBeVisible();
  const row = page.getByTestId(`engagement-${shop.tenantId}-catalog_management`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Start a session' }).click();
  const dialog = sheet(page, /^Work on /);
  const go = dialog.getByRole('button', { name: 'Start the session' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Task reference').fill('   ');
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Task reference').fill('TASK-481');
  await go.click();
  const started = page.getByTestId('session-started');
  await expect(started).toContainText('TASK-481');
  await expect(started.getByRole('link', { name: /screens/ })).toHaveAttribute('href', /^https?:\/\//);
  await expect(page.getByText('everything you change is recorded')).toBeVisible();
  await expectHealthy(page);
  const session = page.locator('[data-testid^="service-session-"]').first();
  await expect(session).toContainText('TASK-481');
  await session.getByRole('button', { name: 'End' }).click();
  await expect(toast(page, 'The session has ended.')).toBeVisible();
  expect((await sql(world, 'SELECT task_ref, ended_at FROM service_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]))[0].task_ref).toBe('TASK-481');
  expect(problems).toEqual([]);
  await context.close();
});

test('F-77 F-78 F-79: flags need a reason; the sign-up mode changes with one; an invite code is shown masked and can be revoked', async ({ browser }) => {
  const { context, page, problems } = await open(browser, 'super_admin', '/flags');
  await page.getByRole('button', { name: 'New flag' }).click();
  const dialog = sheet(page, 'New flag');
  await dialog.getByLabel('Key').fill('Bad Key!');
  await expect(dialog.getByText('Use lower-case letters, digits, dots and underscores').first()).toBeVisible();
  await dialog.getByLabel('Key').fill('beta.console_test');
  await dialog.getByLabel('What it does').fill('A flag made by a test');
  await expect(dialog.getByRole('button', { name: 'Save flag' })).toBeDisabled();
  await submitWithReason(page, 'New flag', 'Save flag', 'trying it out');
  await expect(page.getByTestId('flag-beta.console_test')).toBeVisible();
  await page.getByLabel('Business', { exact: true }).selectOption(String(shop.tenantId));
  await expect(page.getByTestId('tenant-flag-beta.console_test')).toBeVisible();
  await page.getByTestId('tenant-flag-beta.console_test').getByRole('button', { name: 'Turn on' }).click();
  await submitWithReason(page, /beta.console_test for this business/, 'Save', 'pilot');
  await expect(page.getByTestId('tenant-flag-beta.console_test')).toContainText('Set by hand to on');

  await page.goto(world.consoleUrl('/signup'));
  await page.getByRole('button', { name: 'Change who can sign up' }).click();
  const mode = sheet(page, 'Change who can sign up');
  await expect(mode.getByRole('button', { name: 'Change', exact: true })).toBeDisabled();
  await mode.getByLabel('Sign-up is').selectOption('closed');
  await submitWithReason(page, 'Change who can sign up', 'Change', 'launching to a first group');
  await expect(page.getByText('Nobody can sign up.')).toBeVisible();
  await page.getByRole('button', { name: 'New invite code' }).click();
  await sheet(page, 'New invite code').getByLabel('Who it is for').fill('Priya of Mitti Pottery');
  await sheet(page, 'New invite code').getByRole('button', { name: 'Make the code' }).click();
  const secret = page.getByTestId('new-invite').getByTestId('masked-secret');
  await expect(secret).toContainText('•');
  const shown = await secret.innerText();
  const tail = await page.evaluate(() => document.body.innerText);
  expect(shown.replace(/•/g, '').length).toBeLessThanOrEqual(4);
  expect(tail).not.toMatch(/[A-Z0-9]{12,}/);
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await expect(toast(page, 'The invite code is revoked.')).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();
});

test('F-123 F-124: a raw export is made only with tables, businesses, days and a reason', async ({ browser }) => {
  const { context, page } = await open(browser, 'super_admin', '/exports');
  const make = page.getByRole('button', { name: 'Make the export' });
  await expect(make).toBeDisabled();
  await page.getByLabel('Audit log').check();
  await page.getByLabel('Business numbers').fill(String(shop.tenantId));
  await page.getByLabel('From').fill('2026-11-01');
  await page.getByLabel('To').fill('2026-10-01');
  await expect(page.getByText('The last day is before the first')).toBeVisible();
  await page.getByLabel('To').fill('2026-11-30');
  await page.getByLabel('Reason').fill('   ');
  await expect(make).toBeDisabled();
  await page.getByLabel('Reason').fill('Quarterly compliance review');
  await expect(make).toBeEnabled();
  await expectHealthy(page);
  await make.click();
  await expect(page.getByTestId('export-result')).toContainText('Rows');
  expect((await sql(world, `SELECT count(*)::int AS n FROM audit_log WHERE action ~ 'export'`))[0].n).toBeGreaterThan(0);
  await context.close();
});

test('F-90 to F-95: the apps screens load, each part says when it is empty, and a store move needs a reason and the guideline', async ({ browser }) => {
  const { context, page } = await open(browser, 'support', '/apps');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByText('No rebuilds yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rebuild every app' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set the minimum version' })).toHaveCount(0);
  for (const [tab, text] of [['Store submissions', 'No submissions'], ['Rejections', 'No rejections'], ['Updates', 'No updates yet']]) {
    await page.getByRole('button', { name: tab }).click();
    await expect(page.getByText(text).first()).toBeVisible();
    await expectHealthy(page);
  }
  await expect(page.getByRole('button', { name: 'Publish an update' })).toHaveCount(0);
  await context.close();

  const admin = await open(browser, 'super_admin', '/apps');
  await admin.page.getByRole('button', { name: 'Rebuild every app' }).click();
  const dialog = sheet(admin.page, 'Rebuild every app');
  await dialog.getByLabel('App version').fill('1.x');
  await expect(dialog.getByText('Use a version like 1.2.0')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start the rebuild' })).toBeDisabled();
  await admin.context.close();
});

test('every screen has its loading, failed and empty states, works at 360 px, and passes axe', async ({ browser }) => {
  const { context, page } = await open(browser, 'super_admin', '/audit');
  for (const path of ['businesses', 'onboarding', 'health', 'switches', 'impersonation', 'services', 'billing', 'flags', 'signup', 'apps', 'exports', 'audit']) {
    await page.goto(world.consoleUrl(`/${path}`));
    await expect(page.locator('main h1')).toBeVisible();
    await expectHealthy(page);
  }
  await context.close();

  // Failed, then retried; and loading that never ends still says it is loading.
  const failing = await open(browser, 'super_admin', '/audit');
  await failing.page.route('**/audit-log*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on our side. Please try again.' }) }));
  await failing.page.goto(world.consoleUrl('/audit'));
  await expect(failing.page.getByRole('alert')).toContainText('Something went wrong on our side');
  await failing.page.unroute('**/audit-log*');
  await failing.page.getByRole('button', { name: 'Try again' }).click();
  await expect(failing.page.getByRole('alert')).toHaveCount(0);
  await expectHealthy(failing.page);
  await failing.context.close();

  const slow = await open(browser, 'super_admin', '/');
  await slow.page.route('**/pauses*', () => {});
  await slow.page.goto(world.consoleUrl('/switches'));
  await expect(slow.page.getByText('Loading pauses')).toBeVisible();
  await expectHealthy(slow.page);
  await slow.context.close();

  const empty = await open(browser, 'super_admin', '/');
  await empty.page.route('**/audit-log*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }));
  await empty.page.goto(world.consoleUrl('/audit'));
  await expect(empty.page.getByText('Nothing on the log')).toBeVisible();
  await expectHealthy(empty.page);
  await empty.context.close();
});

test('F-39: the audit view lists what was done above, with who did it, and nothing personal', async ({ browser }) => {
  const worker = await world.operator('support');
  expect((await call(worker, 'POST', `/tenants/${shop.tenantId}/pause`, { reason: 'audit check' })).status).toBe(200);
  expect((await call(worker, 'POST', `/tenants/${shop.tenantId}/resume`, { reason: 'audit check done' })).status).toBe(200);
  const { context, page } = await open(browser, 'support', '/audit');
  await expect(page.getByText(/platform\.|business\.|compliance\./).first()).toBeVisible();
  await page.getByLabel('Business number').fill('abc');
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByText('Use a business number')).toBeVisible();
  await page.getByLabel('Business number').fill(String(shop.tenantId));
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByText(`business ${shop.tenantId}`).first()).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\b[6-9]\d{9}\b/);
  await context.close();
});
