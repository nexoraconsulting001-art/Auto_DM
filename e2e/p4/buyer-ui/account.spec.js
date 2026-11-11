// The shopper's own side of the store in a real phone browser inside Instagram (PRD 9.2, 9.3, 9.4, 9.10, 9.13, 9.17, 9.19,
// 9.20): signing in with a WhatsApp code, the account with its orders, tracking and invoices, cancelling before shipment,
// asking for a return with a photo, reviewing what arrived, the wishlist, and the bag following the shopper to Chrome.
// Every screen is checked with axe (WCAG 2.1 AA and 2.2 target size), at 360 px, and for the platform's name. Orders are
// placed and moved along through the store's own API and the simulators, as the seller and the gateway would; the browser
// does what the shopper does.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { PLATFORM_NAME, PRODUCT_NAME, SHOP_NAME, UA, buyer, newPhone, openStore, pdfText, png } from '../../../test/p4/buyer-ui/support.js';
import { PHONE, checkScreen, standInGateway } from './browser.js';

createRequire(import.meta.url)('sharp');

test.use({ userAgent: UA.instagram, viewport: PHONE });
test.describe.configure({ timeout: 150_000 });

let store;
test.beforeEach(async () => {
  store = await openStore();
});
test.afterEach(async () => {
  await store?.world.close();
});

/** Signs in on the sign-in page with a WhatsApp code, as the shopper does. Lands on `next`. */
async function signIn(page, phone, next = '/account') {
  const { world } = store;
  await page.goto(`${world.base}/login?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await checkScreen(page, 'Sign in, asking for the number');
  await page.getByLabel('WhatsApp number').fill(phone.slice(3));
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await checkScreen(page, 'Sign in, asking for the code');
  await page.getByLabel('6-digit code').fill(await world.codeFor(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${world.base}${next}`);
}

/** The same shopper on the API, with the browser's cookies: places and pays orders as the checkout page would. */
async function apiShopper(page, phone) {
  const { world, shop } = store;
  const b = buyer(world, shop);
  for (const c of await page.context().cookies()) b.jar[c.name] = c.value;
  await b.open('/account');
  b.phone = phone;
  return b;
}

const address = (phone) => ({ name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' });

test('the store’s pages offer a way to sign in and to the account, and checkout offers it too', async ({ page }) => {
  const { world, plant } = store;
  await standInGateway(page);
  await page.goto(`${world.base}/p/${plant.slug}`);
  const header = page.locator('header');
  await expect(header.getByRole('link', { name: /sign in|account|log in/i }), 'The store’s header has no way to sign in or reach the account').toHaveCount(1);
  await page.locator('label:has(input[name="variant"])').first().click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await page.goto(`${world.base}/checkout`);
  const link = page.getByRole('main').getByRole('link', { name: /sign in|log in/i });
  await expect(link, 'Checkout offers no sign-in (S-07)').toHaveCount(1);
  expect(new URL(await link.getAttribute('href'), world.base).searchParams.get('next')).toBe('/checkout');
});

test('a shopper signs in with a WhatsApp code and finds each order with its tracking and its invoice', async ({ page }) => {
  const { world, shop, plant, size, pot } = store;
  const phone = newPhone();
  await standInGateway(page);
  await signIn(page, phone);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hi');
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  expect(await page.locator('main').innerText(), 'The account shows the full phone number').not.toContain(phone.slice(3));
  await checkScreen(page, 'The account, with no orders');

  const b = await apiShopper(page, phone);
  const shipped = await b.buy({ lines: [{ productId: plant.id, variantId: size.M, qty: 1 }], address: address(phone) });
  const shipment = await shop.ship(shipped);
  await world.quiet(600);
  const confirmed = await b.buy({ lines: [{ productId: pot.id, variantId: null, qty: 2 }], address: address(phone) });

  await page.reload();
  await expect(page.getByRole('link', { name: new RegExp(shipped.order_number) })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(confirmed.order_number) })).toBeVisible();
  await checkScreen(page, 'The account, with orders');

  await page.getByRole('link', { name: 'See all' }).click();
  await expect(page).toHaveURL(/\/account\/orders$/);
  await checkScreen(page, 'All orders');

  await page.getByRole('link', { name: new RegExp(shipped.order_number) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Order ${shipped.order_number}`);
  await expect(page.getByText(PRODUCT_NAME)).toBeVisible();
  await checkScreen(page, 'An order in the account');

  // The invoice opens as a PDF on the store's own address and names the seller, never the platform.
  const invoice = page.getByRole('link', { name: /Invoice/ });
  await expect(invoice).toHaveCount(1);
  const pdf = await page.request.get(new URL(await invoice.getAttribute('href'), world.base).href);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toMatch(/application\/pdf/);
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const words = pdfText(bytes);
  expect(words, 'The invoice PDF could be read: it names the seller').toContain(SHOP_NAME);
  expect(words.match(PLATFORM_NAME)?.[0] ?? null, 'The invoice PDF names the platform').toBeNull();

  // 9.17 and 9.10: the account shows orders with tracking, on the seller's own page. One tap from the order shows where the
  // parcel is: the courier's status and the tracking number.
  const track = page.getByRole('main').getByRole('link', { name: /track/i });
  await expect(track, 'A shipped order in the account has no tracking link (9.17)').toHaveCount(1);
  await track.click();
  await expect(page.getByText(shipment.awb), 'Tracking from the account shows no tracking number').toBeVisible();
  await expect(page.getByRole('heading', { name: 'Packed' }), 'Tracking from the account shows no courier status').toBeVisible();
  await checkScreen(page, 'Tracking, from the account');
});

test('a shopper cancels an order before it ships, from the order’s own page', async ({ page }) => {
  const { world, shop, pot } = store;
  const phone = newPhone();
  await standInGateway(page);
  await signIn(page, phone);
  const b = await apiShopper(page, phone);
  const order = await b.buy({ lines: [{ productId: pot.id, variantId: null, qty: 1 }], address: address(phone) });
  await page.goto(`${world.base}/order/${order.placed.token}`);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await checkScreen(page, 'The order page, before shipping');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel this order' }).click();
  await expect(page.getByRole('heading', { name: 'Order cancelled' })).toBeVisible();
  await expect(page.getByText(/refunded/)).toBeVisible();
  await checkScreen(page, 'The order page, cancelled');
  const row = await shop.order(order.order_number);
  expect(row.fulfilment_status).toBe('cancelled');
});

test('a delivered order: a return needs a photo, then goes in; and the product can be reviewed', async ({ page }) => {
  const { world, shop, plant, size } = store;
  const phone = newPhone();
  await standInGateway(page);
  await signIn(page, phone);
  const b = await apiShopper(page, phone);
  const order = await b.delivered({ lines: [{ productId: plant.id, variantId: size.L, qty: 1 }], address: address(phone) });

  await page.goto(`${world.base}/account/orders/${encodeURIComponent(order.order_number)}`);
  await page.getByRole('link', { name: 'Return an item' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Return an item');
  await checkScreen(page, 'The return form');
  await page.getByLabel('What’s wrong with it?').fill('A leaf arrived torn.');
  await page.getByRole('button', { name: 'Ask for a return' }).click();
  await expect(page.getByRole('alert')).toHaveText('Add a photo or video of the item');
  await checkScreen(page, 'The return form, with its error');
  await page.getByLabel('A photo or short video of the item').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: png({ width: 64, height: 64, color: '#3B7A57' }) });
  await page.getByRole('button', { name: 'Ask for a return' }).click();
  await expect(page.getByText('We have your request.')).toBeVisible();
  await checkScreen(page, 'The return, sent');
  const returns = await shop.sql('SELECT status FROM returns WHERE tenant_id = $1', [shop.tenantId]);
  expect(returns.map((r) => r.status)).toEqual(['requested']);

  await page.goto(`${world.base}/p/${plant.slug}`);
  const form = page.locator('form[data-review-form]');
  await expect(form, 'A shopper whose order was delivered can review the product').toBeVisible();
  await checkScreen(page, 'The product page with the review form');
  await form.getByRole('button', { name: 'Send review' }).click();
  await expect(form.getByRole('alert')).toHaveText('Choose from 1 to 5 stars.');
  await form.getByText('★★★★★').click();
  await form.getByLabel(/What did you think/).fill('Healthy plant, lovely pot.');
  await form.getByRole('button', { name: 'Send review' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Thank you.' })).toBeVisible();
  await checkScreen(page, 'The product page, review sent');
  const reviews = await shop.sql('SELECT rating, status FROM reviews WHERE tenant_id = $1', [shop.tenantId]);
  expect(reviews.map((r) => Number(r.rating))).toEqual([5]);
});

test('the wishlist: a heart saved while signed out is in the account after the WhatsApp code', async ({ page }) => {
  const { world, shop, pot } = store;
  const phone = newPhone();
  await standInGateway(page);
  await page.goto(`${world.base}/p/${pot.slug}`);
  const heart = page.getByRole('button', { name: 'Save to wishlist', exact: true });
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await heart.click();
  await expect(page.getByRole('button', { name: 'Remove from wishlist', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await checkScreen(page, 'The product page, saved to the wishlist');

  await page.goto(`${world.base}/wishlist`);
  await expect(page.getByText('Terracotta planter')).toBeVisible();
  await checkScreen(page, 'The wishlist, signed out');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fwishlist$|\/login\?next=\/wishlist$/);
  await page.getByLabel('WhatsApp number').fill(phone.slice(3));
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByLabel('6-digit code').fill(await world.codeFor(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${world.base}/wishlist`);
  await expect(page.getByText('Terracotta planter')).toBeVisible();
  await expect.poll(async () => (await shop.sql('SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [shop.tenantId]))[0].n).toBe(1);
  await checkScreen(page, 'The wishlist, signed in');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.locator('[data-bag-count]').first()).toHaveText('1');
});

test('the bag follows the shopper from Instagram’s browser to Chrome once they sign in there too (9.2, S-06)', async ({ page, browser }) => {
  const { world, shop, plant, size, pot } = store;
  const phone = newPhone();
  await standInGateway(page);
  // Inside Instagram: a size of the plant and two planters, then sign in from the bag.
  await page.goto(`${world.base}/p/${plant.slug}`);
  await page.locator(`label:has(input[name="variant"][value="${size.L}"])`).click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await page.goto(`${world.base}/p/${pot.slug}`);
  await page.getByLabel('Quantity').selectOption('2');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.locator('[data-bag-count]').first()).toHaveText('3');
  await signIn(page, phone, '/cart');
  await expect(page.locator('[data-lines] li')).toHaveCount(2);
  await expect.poll(async () => (await shop.sql(
    'SELECT coalesce(sum(l.qty), 0)::int AS n FROM cart_lines l JOIN carts c ON c.tenant_id = l.tenant_id AND c.id = l.cart_id WHERE c.tenant_id = $1',
    [shop.tenantId],
  ))[0].n, { message: 'The bag was not mirrored to the store after sign-in' }).toBe(3);

  // The shopper opens the store in Chrome, whose storage is its own, and signs in with the same number.
  const chrome = await browser.newContext({ userAgent: UA.phone, viewport: PHONE });
  try {
    const other = await chrome.newPage();
    await standInGateway(other);
    await other.goto(`${world.base}/login?next=${encodeURIComponent('/cart')}`);
    await other.getByLabel('WhatsApp number').fill(phone.slice(3));
    await other.getByRole('button', { name: 'Send code on WhatsApp' }).click();
    await other.getByLabel('6-digit code').fill(await world.codeFor(phone));
    await other.getByRole('button', { name: 'Sign in' }).click();
    await other.waitForURL(`${world.base}/cart`);
    await expect(other.locator('[data-lines] li')).toHaveCount(2);
    await expect(other.locator('[data-lines]')).toContainText(PRODUCT_NAME);
    await expect(other.locator('[data-lines]')).toContainText('Terracotta planter');
    await expect(other.locator('[data-bag-count]').first()).toHaveText('3');
    await checkScreen(other, 'The bag in Chrome, after signing in');
  } finally {
    await chrome.close();
  }
});
