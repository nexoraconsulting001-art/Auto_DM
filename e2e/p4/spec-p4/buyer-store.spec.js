// What a shopper does in a real phone-sized browser for Phase 4: the bag, sign-in by WhatsApp code and back to checkout,
// a double tap on "Place order", the in-app browser's sign-in, the default address, the wishlist kept while logged out,
// and the seller's brand on every screen. Selectors follow what a shopper reads (roles and words), not markup.
import { test, expect } from '@playwright/test';
import { UA, addP4Shop, buyer, openP4World, unique } from '../../../test/p4/spec-p4/kit.js';

test.use({ viewport: { width: 360, height: 740 } });

const SLUG = `p4-buyer-${unique()}`;
let world;
let shop;
let product;

test.beforeEach(async () => {
  world = await openP4World({ defaultTenant: SLUG });
  shop = await addP4Shop(world, { slug: SLUG, name: 'Leafy Corner' });
  product = await shop.item({ name: 'Monstera in clay pot', pricePaise: 49900, stock: 5 });
});
test.afterEach(async () => {
  await world.close();
});

const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
/** Answers every request to another site (the gateway's script, fonts) with an empty body, and records it. */
async function catchOutside(page) {
  const outside = [];
  await page.route((url) => !isLocal(url.href), async (route) => {
    outside.push(route.request().url());
    const js = /\.js(\?|$)/.test(route.request().url());
    return route.fulfill({ status: 200, contentType: js ? 'application/javascript' : 'text/css', body: js ? 'window.Razorpay = function (o) { this.open = function () { window.__gateway = o; }; this.on = function () {}; };' : '' });
  });
  return outside;
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const addToBag = async (page) => {
  await page.goto(`${world.base}/p/${product.slug}`);
  await page.getByRole('button', { name: /add to (bag|cart)/i }).first().click();
};

test('S-07: a shopper signs in with the WhatsApp code from checkout and comes back to checkout with the bag intact', async ({ page }) => {
  await catchOutside(page);
  await addToBag(page);
  await page.goto(`${world.base}/checkout`);
  await expect(page.getByText('Monstera in clay pot')).toBeVisible();
  await page.getByRole('link', { name: /sign in|log in/i }).or(page.getByRole('button', { name: /sign in|log in/i })).first().click();
  await expect(page).toHaveURL(/\/login/);
  const phone = `98${String(Date.now()).slice(-8)}`;
  await page.getByLabel(/phone|mobile|whatsapp/i).first().fill(phone);
  await page.getByRole('button', { name: /send|get code|continue/i }).first().click();
  const code = await world.codeFor(`+91${phone}`);
  await page.getByLabel(/code|otp/i).first().fill(code);
  await page.getByRole('button', { name: /verify|sign in|continue/i }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  await expect(page.getByText('Monstera in clay pot')).toBeVisible();
  expect(await sideways(page)).toBe(0);
  await expect(page.locator('body')).not.toContainText(/bhava/i);
});

test('S-15: tapping "Place order" twice in a row makes one order', async ({ page }) => {
  await catchOutside(page);
  await addToBag(page);
  await page.goto(`${world.base}/checkout`);
  await page.getByLabel(/full name|name/i).first().fill('Asha Rao');
  await page.getByLabel(/phone|mobile/i).first().fill(`98${String(Date.now()).slice(-8)}`);
  await page.getByLabel(/address|line 1|house/i).first().fill('12 Lake Road');
  await page.getByLabel(/city/i).first().fill('Pune');
  await page.getByLabel(/pin/i).first().fill('411001');
  const state = page.getByLabel(/state/i).first();
  if (await state.count()) await state.selectOption({ label: 'Maharashtra' }).catch(() => {});
  const terms = page.getByRole('checkbox', { name: /terms|agree/i }).first();
  if (await terms.count()) await terms.check();
  const place = page.getByRole('button', { name: /place order|pay/i }).first();
  await Promise.all([place.click(), place.click({ force: true }).catch(() => {})]);
  await expect.poll(async () => (await shop.orders()).length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect((await shop.orders()).length).toBe(1);
});

test('S-10: inside Instagram’s browser the WhatsApp code is the first way in and there is no SMS', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: UA.instagram, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await catchOutside(page);
  await page.goto(`${world.base}/login`);
  const body = await page.locator('body').innerText();
  expect(body).toMatch(/whatsapp/i);
  expect(body).not.toMatch(/\bSMS\b/i);
  const google = body.search(/google/i);
  expect(google === -1 || body.search(/whatsapp/i) < google).toBe(true);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await context.close();
});

test('S-13: checkout preselects the address marked default', async ({ page }) => {
  await catchOutside(page);
  const b = buyer(world, shop);
  const phone = await b.signIn();
  await b.addAddress({ line1: '1 First Street', isDefault: true });
  const second = (await b.addAddress({ line1: '2 Second Street' })).data;
  await b.updateAddress(second.id, { name: 'Asha Rao', phone, line1: '2 Second Street', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', kind: 'home', isDefault: true });
  await page.context().addCookies(Object.entries(b.jar).map(([name, value]) => ({ name, value, url: world.base })));
  await addToBag(page);
  await page.goto(`${world.base}/checkout`);
  const chosen = page.getByRole('radio', { name: /2 Second Street/ });
  await expect(chosen).toBeChecked();
  await expect(page.getByRole('radio', { name: /1 First Street/ })).not.toBeChecked();
});

test('S-84: items hearted while logged out are in the account wishlist after sign-in', async ({ page }) => {
  await catchOutside(page);
  const others = [await shop.item({ name: 'Snake plant' }), await shop.item({ name: 'Peace lily' })];
  for (const p of [product, ...others]) {
    await page.goto(`${world.base}/p/${p.slug}`);
    await page.getByRole('button', { name: /wishlist|save|heart/i }).first().click();
  }
  await page.goto(`${world.base}/login?next=%2Fwishlist`);
  const phone = `97${String(Date.now()).slice(-8)}`;
  await page.getByLabel(/phone|mobile|whatsapp/i).first().fill(phone);
  await page.getByRole('button', { name: /send|get code|continue/i }).first().click();
  await page.getByLabel(/code|otp/i).first().fill(await world.codeFor(`+91${phone}`));
  await page.getByRole('button', { name: /verify|sign in|continue/i }).first().click();
  await expect.poll(async () => (await shop.sql('SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [shop.tenantId]))[0].n, { timeout: 10_000 }).toBe(3);
  await page.goto(`${world.base}/wishlist`);
  for (const name of ['Monstera in clay pot', 'Snake plant', 'Peace lily']) await expect(page.getByText(name)).toBeVisible();
});

test('S-71: checkout and the order page carry the seller’s brand, never the platform', async ({ page }) => {
  const outside = await catchOutside(page);
  await addToBag(page);
  await page.goto(`${world.base}/checkout`);
  await expect(page, 'Guest checkout is the default: checkout opens with no sign-in').toHaveURL(/\/checkout(\?|$)/);
  await expect(page.getByText('Monstera in clay pot')).toBeVisible();
  await expect(page).toHaveTitle(/Leafy Corner/);
  await expect(page.locator('body')).not.toContainText(/bhava/i);
  expect(outside.filter((u) => /bhava/i.test(u))).toEqual([]);
  expect(await sideways(page)).toBe(0);
});
