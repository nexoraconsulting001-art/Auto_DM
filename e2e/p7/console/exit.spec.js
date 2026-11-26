// The Phase 7 console exit check, on the real app and its simulators with nothing mocked (PRD 3, 5.12, 5.20): a person signs up in the
// browser as a seller (name, Instagram, the first automation), meets a Free-plan limit and is shown an upgrade, upgrades through the
// provider's page, and sees the invoice for it and downloads it. Needs a console build (npm run build:console).
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

// The app runs inside Playwright's worker: sharp and semver are loaded with require first (see e2e/p7/spec-p7/plan.spec.js).
const require = createRequire(import.meta.url);
require('semver');
require('sharp');
const { APP, appSignIn, authorize, charge, finishConnect, hit, invoicesOf, newPhone, one, openBillingWorld, setSignup, sql, unique } = await import('../../../test/p7/spec-p7/support.js');

test.use({
  viewport: { width: 360, height: 740 },
  actionTimeout: 15_000,
  navigationTimeout: 20_000,
  launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=*.shops.example;*.localhost;127.0.0.1', '--host-resolver-rules=MAP *.shops.example 127.0.0.1', '--disable-features=P7ConsoleExit'] },
});
test.setTimeout(240_000);

let world;
let port;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await openBillingWorld({ overrides: { passwordLogin: true, queuePollMs: 250, platformWhatsappPhoneId: '1000', platformWhatsappToken: 'sim-whatsapp-token', linkCheckFetch: async () => new Response(null, { status: 200 }) } });
  port = new URL(world.base).port;
  await setSignup(world, 'public');
});
test.afterAll(async () => {
  await world?.close();
});

const numericId = () => String(17_841_400_000_000_000n + BigInt(crypto.randomInt(1, 2 ** 30)) * 1000n);
const at = (host, path) => `http://${host}:${port}${path}`;

/** The browser's session on `host`, as signing in there with a WhatsApp code leaves it. */
async function cookieFor(context, person, host) {
  const [name, ...rest] = person.cookie.split('=');
  await context.addCookies([{ name, value: rest.join('='), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
}

test('sign up, hit a Free-plan limit, upgrade, and see the invoice', async ({ page, context }) => {
  // 1. Sign up on the sign-in host, in the browser.
  const phone = newPhone();
  const person = await appSignIn(world, phone);
  await cookieFor(context, person, APP);
  await page.goto(at(APP, '/admin/signup'));
  await expect(page.getByRole('heading', { name: 'Set up Bhava' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel(/Seller/).check();
  await page.getByLabel('Shop name').fill(`Kesar ${unique()}`);
  const started = page.waitForResponse((res) => res.url().endsWith('/api/v1/signup') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue' }).click();
  const { tenantId, host, runToken } = await (await started).json();
  expect(tenantId && host && runToken).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Connect your Instagram' })).toBeVisible();

  // 2. Instagram connects through Meta's simulator, as its owner on the business's own address.
  await sql(world, `INSERT INTO compliance_settings (tenant_id, subject_salt, access_level, app_role_ok, privacy_url_ok_at, deletion_callback_ok_at, gate_passed_at) VALUES ($1, $2, 'advanced', true, now(), now(), now()) ON CONFLICT (tenant_id) DO UPDATE SET access_level = 'advanced', app_role_ok = true, gate_passed_at = now()`, [tenantId, crypto.randomBytes(8).toString('hex')]);
  const igUserId = numericId();
  await world.meta.post('/accounts', { igUserId, username: `kesar_${unique()}`, subscribedFields: ['comments', 'messages', 'messaging_postbacks', 'mentions'], appRole: true });
  const owner = await appSignIn(world, phone, host);
  await world.meta.post('/oauth/next', { igUserId });
  const connect = await owner.call('POST', '/instagram/connect', {});
  expect(connect.status).toBe(200);
  const consent = await fetch(connect.data.authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  // Meta's return ends in a finish step (the account is taken only when the starter finishes it), as the sign-up's own tests do it.
  const done = await hit(world, `${back.pathname}${back.search}`, { host });
  expect(await finishConnect(world, done, { send: owner.call, cookie: owner.cookie, host })).toBe('connected');
  const reel = numericId();
  await world.meta.post('/media', { igUserId, productType: 'REELS', caption: 'First reel', id: reel });

  // 3. The guided first automation, in the browser.
  await page.reload();
  // The server logged the connected account, so the run resumes at the first automation.
  await expect(page.getByRole('heading', { name: 'Your first automation' })).toBeVisible();
  await page.getByRole('button', { name: 'First reel' }).click();
  await page.getByLabel('Keyword').fill('LINK');
  await page.getByLabel('Link to send').fill('https://example.com/shop');
  await page.getByRole('button', { name: 'Make it live' }).click();
  await expect(page.getByRole('heading', { name: 'You are ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish sign-up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Bhava' })).toBeVisible();
  expect((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [tenantId])).plan).toBe('free');

  // 4. On the Free plan the AI replies are not on: the server refuses the save, and the console shows an upgrade.
  await cookieFor(context, owner, host);
  await page.goto(at(host, '/admin/ai-replies'));
  await expect(page.getByRole('heading', { name: 'FAQ and AI replies' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Add an answer' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add an answer' });
  await sheet.getByLabel('Question', { exact: true }).fill('Do you ship to Goa?');
  await sheet.getByLabel('Answer', { exact: true }).fill('Yes, in four days.');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('upgrade-bar')).toContainText('not on your plan');
  expect((await one(world, 'SELECT count(*)::int AS n FROM faq_entries WHERE tenant_id = $1', [tenantId]).catch(() => ({ n: 0 }))).n).toBe(0);
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  // 5. Upgrade: the console shows the server's plans, and the payment is on the provider's own page.
  const catalog = (await owner.call('GET', '/billing/catalog')).data;
  const t1 = catalog.plans.find((plan) => plan.code === 't1');
  await page.getByTestId('upgrade-prompt').getByRole('link', { name: 'See plans' }).click();
  await expect(page.getByTestId('current-plan')).toBeVisible();
  await expect(page.getByTestId('plan-t1')).toContainText(t1.name);
  await page.getByRole('button', { name: `Upgrade to ${t1.name}` }).click();
  const hosted = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).port !== port);
  const changed = page.waitForResponse((res) => res.url().endsWith('/api/v1/billing/change'));
  await page.getByRole('dialog', { name: `Move up to ${t1.name}` }).getByRole('button', { name: 'Upgrade', exact: true }).click();
  expect((await changed).status()).toBe(200);
  await hosted;

  // The payer finishes the provider's page and the provider takes the first charge.
  await authorize(world, { tenantId });
  await charge(world, { tenantId });
  const invoice = await world.until(async () => (await invoicesOf(world, { tenantId }))[0]);
  expect(invoice).toBeTruthy();

  // 6. The invoice is on the billing screen, and downloads.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => { window.__opened.push(String(url)); return null; };
  });
  await page.goto(at(host, '/admin/billing'));
  await expect(page.getByTestId('current-plan')).toHaveText(t1.name);
  await expect(page.getByTestId('invoice').first()).toContainText(invoice.number);
  await expect(page.getByTestId('invoice').first()).toContainText('Paid');
  await page.getByTestId('invoice').first().getByRole('button', { name: /^Download/ }).click();
  await expect.poll(() => page.evaluate(() => window.__opened.length)).toBe(1);
  const download = await page.evaluate(async () => {
    const res = await fetch(window.__opened[0]);
    return { status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength };
  });
  expect(download.status).toBe(200);
  expect(download.type).toMatch(/pdf/);
  expect(download.bytes).toBeGreaterThan(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
