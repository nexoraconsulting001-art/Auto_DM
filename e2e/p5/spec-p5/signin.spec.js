// What a seller does in a real phone-sized browser for Phase 5, on the sign-in host that belongs to no business: the web
// sign-in page offers Google and a WhatsApp code and never a password or SMS; a code from Bhava's WhatsApp number opens
// the console; someone removed from the team is signed out of the open console within 60 s; and an order confirmed in the
// app shows the same on the web. Selectors follow what a seller reads (roles and words), not markup. P-11, F-117, F-47, P-18.
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(): load it once first.
createRequire(import.meta.url)('sharp');

const { APP_HOST, addMember, addP4Shop, addSeller, codOrder, local10, openP5World, ownerApp, ownerPhone, unique } = await import('../../../test/p5/spec-p5/kit.js');

test.use({ viewport: { width: 360, height: 740 }, actionTimeout: 15_000, navigationTimeout: 20_000, launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--disable-features=P5SpecSignIn'] } });
test.setTimeout(180_000);

let world;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  // PASSWORD_LOGIN is on under node's test runner but not inside Playwright's worker; the earlier phases' setup helpers
  // still make each business through the Phase 0 password login, so it is turned on here for that scaffolding only.
  world = await openP5World({ overrides: { queuePollMs: 250, passwordLogin: true } });
});
test.afterAll(async () => {
  await world?.close();
});

const appUrl = (path) => `http://${APP_HOST}:${world.port}${path}`;
/**
 * A GET on the sign-in host with the browser's own cookies for it. Chromium sends *.localhost to loopback itself, but
 * page.request runs in node, whose lookup of app.bhava.localhost fails on Windows: so it goes to 127.0.0.1 and names the host.
 */
async function getAsBrowser(page, path) {
  const cookies = await page.context().cookies(appUrl(path));
  return page.request.get(`http://127.0.0.1:${world.port}${path}`, {
    headers: { host: `${APP_HOST}:${world.port}`, cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
}
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

/** Signs in on the web sign-in page with a WhatsApp code, as a seller would. */
async function signInOnTheWeb(page, phone) {
  const opened = await page.goto(appUrl('/signin'));
  expect(opened?.status(), 'The web sign-in page did not open').toBe(200);
  const whatsapp = page.getByRole('button', { name: /whatsapp/i }).or(page.getByRole('link', { name: /whatsapp/i }));
  if (await whatsapp.count()) await whatsapp.first().click();
  await page.getByLabel(/phone|mobile|whatsapp number/i).first().fill(local10(phone));
  const seen = (await world.sellerMessages(phone)).length;
  await page.getByRole('button', { name: /send|get (a |the )?code|continue/i }).first().click();
  const code = await world.sellerCode(phone, { after: seen, ms: 10_000 });
  expect(code, 'No code reached the number on WhatsApp').toBeTruthy();
  await page.getByLabel(/code/i).first().fill(code);
  await page.getByRole('button', { name: /verify|sign in|continue/i }).first().click();
  await expect(page).toHaveURL(/\/admin/, { timeout: 20_000 });
}

test('P-11: the web sign-in page offers Google and a WhatsApp code, with no password field and no SMS, under Bhava\'s name', async ({ page }) => {
  const outside = [];
  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname) && !url.hostname.endsWith('.localhost'), (route) => {
    outside.push(route.request().url());
    return route.fulfill({ status: 200, body: '' });
  });
  const opened = await page.goto(appUrl('/signin'));
  expect(opened?.status(), 'The web sign-in page did not open').toBe(200);
  await expect(page.getByRole('button', { name: /google/i }).or(page.getByRole('link', { name: /google/i })).first()).toBeVisible();
  await expect(page.getByText(/whatsapp/i).first()).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/\bSMS\b|text message|password/i);
  await expect(page.locator('body')).toContainText(/bhava/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(outside.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
});

test('F-117: a WhatsApp code from Bhava\'s number signs the owner in to the console of their business', async ({ page }) => {
  const shop = await addSeller(world, { name: 'Gulmohar Goods' });
  await signInOnTheWeb(page, ownerPhone(shop));
  const me = await getAsBrowser(page, '/api/v1/auth/me');
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.business.id).toBe(shop.tenantId);
  expect(body.user.role).toBe('owner');
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.httpOnly && c.domain.includes('localhost'));
  expect(session, 'The console session is not an httpOnly cookie').toBeTruthy();
});

test('F-47: someone removed from the team while the console is open is signed out of it within 60 s', async ({ page }) => {
  const shop = await addSeller(world, { name: `Kadam Crafts ${unique()}` });
  const staff = await addMember(shop, { role: 'staff', permissions: ['orders'] });
  await signInOnTheWeb(page, staff.phone);
  expect((await getAsBrowser(page, '/api/v1/orders')).status()).toBe(200);

  const owner = await ownerApp(world, shop);
  expect((await owner.send('DELETE', `/team/${staff.userId}`)).status).toBe(204);
  await expect.poll(async () => (await getAsBrowser(page, '/api/v1/orders')).status(), { timeout: 60_000, intervals: [500] }).toBe(401);
  await page.reload();
  await expect(page.getByText(/sign in|log in/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText(/Kadam Crafts/);
});

test('P-18: an order confirmed in the app shows the same status in the web console on refresh', async ({ page }) => {
  const shop = await addP4Shop(world, { name: 'Saffron Spoon' });
  await shop.codOn();
  const product = await shop.item({ name: 'Steel tiffin', pricePaise: 64900, stock: 5 });
  const placed = await codOrder(world, shop, [line(product)]);
  const order = await shop.order(placed.orderNumber);

  await signInOnTheWeb(page, ownerPhone(shop));
  const app = await ownerApp(world, shop);
  const detail = await app.send('GET', `/orders/${order.id}`);
  if (detail.data?.holdReason) await app.send('POST', `/orders/${order.id}/release-hold`);
  const confirmed = await app.send('POST', `/orders/${order.id}/advance`, { to: 'packed' });
  expect(confirmed.status).toBe(200);

  await page.goto(appUrl(`/admin/orders/${order.id}`));
  await expect(page.getByRole('heading', { name: new RegExp(order.order_number) }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main, body').first()).toContainText(/packed/i);
  await page.reload();
  await expect(page.locator('main, body').first()).toContainText(/packed/i);
});
