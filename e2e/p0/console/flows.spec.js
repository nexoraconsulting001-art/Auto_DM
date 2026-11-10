// A seller doing each job in the console, on a 360 px phone, through the real API and a real session.
import { test, expect } from '@playwright/test';
import { REEL_ID, seedReel } from '../../../test/helpers.js';
import { bindTenant } from '../../../src/repos/index.js';
import { PHONE, PNG, goToMore, open, placeOrder, startConsoleApp, status, watch } from './support.js';

test.use({ viewport: PHONE });

let app;
test.beforeEach(async () => {
  app = await startConsoleApp();
});
test.afterEach(() => app.close());

test('the dashboard shows the numbers and a setup checklist that ticks itself off and can be hidden', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app);
  await expect(page.getByRole('heading', { name: 'Hello, Store' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your store' })).toBeVisible();
  await expect(page.getByText('1 of 6 done')).toBeVisible(); // Instagram is connected in the test app

  await app.repos.products.create({ name: 'Mug', price: '99', active: 'on' });
  await page.reload();
  await expect(page.getByText('2 of 6 done')).toBeVisible();
  await page.getByRole('link', { name: 'Choose a reel' }).click();
  await expect(page).toHaveURL(/\/admin\/reels$/);

  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Hide this' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your store' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hello, Store' })).toBeVisible();
  await expect(page.getByText('From feeling to price')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your store' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('money on the dashboard is the orders\' paise, shown as rupees', async ({ page }) => {
  const { products } = await seedReel(app.repos, { n: 1 });
  const order = await placeOrder(app, { productId: products[0].id, qty: 2 });
  await app.repos.orders.setStatus(order.id, 'paid');
  await open(page, app);
  await expect(page.locator('.flow-tile-hi .flow-value')).toHaveText('₹249'); // 2 x ₹100 + ₹49 delivery
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await page.getByRole('link', { name: /1 paid order to ship/ }).click();
  await expect(page).toHaveURL(/\/admin\/orders\?status=paid$/);
  await expect(page.getByRole('button', { name: 'Paid', pressed: true })).toBeVisible();
});

test('a product is added with an uploaded photo, edited, found by search and deleted', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app, '/products/new');
  await expect(page.getByRole('heading', { name: 'Add product' })).toBeVisible();

  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByText('Name is required')).toBeVisible();
  await expect(page.getByText('Price is required')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Cotton kurta');
  await page.getByLabel('Price (₹)').fill('1,299.50');
  await page.getByLabel('MRP (₹)').fill('1999');
  await page.getByLabel('Choices').fill('S, M');
  await page.getByLabel('Stock').fill('7');
  await page.getByLabel('Upload photos').setInputFiles({ name: 'kurta.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Cotton kurta' })).toBeVisible();

  const [saved] = await app.repos.products.list();
  expect(saved.price_paise).toBe(129950);
  expect(saved.mrp_paise).toBe(199900);
  expect(saved.stock).toBe(7);
  expect(saved.option_values).toEqual(['S', 'M']);
  expect(saved.images[0]).toMatch(/^\/media\//);

  await page.getByLabel('Price (₹)').fill('999');
  await page.getByRole('button', { name: 'Save product' }).click();
  await expect(status(page, 'Saved.')).toBeVisible();
  expect((await app.repos.products.get(saved.id)).price_paise).toBe(99900);

  await page.getByRole('link', { name: 'Products', exact: true }).first().click();
  await page.getByLabel('Search products').fill('zzz');
  await expect(page.getByRole('heading', { name: 'No products match' })).toBeVisible();
  await page.getByLabel('Search products').fill('cotton');
  await page.getByRole('link', { name: /Cotton kurta/ }).click();

  await page.getByRole('button', { name: 'Delete product' }).click();
  await page.getByRole('button', { name: 'Keep it' }).click();
  expect(await app.repos.products.get(saved.id)).not.toBeNull();
  await page.getByRole('button', { name: 'Delete product' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete product' }).click();
  await expect(page).toHaveURL(/\/admin\/products$/);
  await expect(page.getByRole('heading', { name: 'Your catalog is empty' })).toBeVisible();
  expect(await app.repos.products.get(saved.id)).toBeNull();
  expect(problems).toEqual([]);
});

test('a photo that can\'t be used says why, and the form keeps going', async ({ page }) => {
  await open(page, app, '/products/new');
  await page.getByLabel('Upload photos').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('notes.txt isn’t a JPG, PNG, WebP or GIF image.')).toBeVisible();
  await page.getByLabel('Or paste a photo link').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByText('Paste a link that starts with https://')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo 1' })).toHaveCount(0);
  await page.getByLabel('Name', { exact: true }).fill('Still here');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Still here');
});

test('categories are added with a picture, put in order, linked to a product and deleted', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app, '/categories');
  await expect(page.getByRole('heading', { name: 'No categories yet' })).toBeVisible();

  await page.getByRole('link', { name: 'Add your first category' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kitchen');
  await page.getByLabel('Upload image').setInputFiles({ name: 'k.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'Image' })).toBeVisible();
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page).toHaveURL(/\/admin\/categories\/\d+$/);
  await expect(page.getByRole('heading', { name: 'No products yet' })).toBeVisible();

  await page.getByRole('link', { name: 'Categories' }).first().click();
  await page.getByRole('link', { name: 'Add category' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Bedding');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page).toHaveURL(/\/admin\/categories\/\d+$/);

  await page.getByRole('link', { name: 'Categories' }).first().click();
  const names = page.locator('.rank .list-row-title');
  await expect(names).toHaveText(['Kitchen', 'Bedding']);
  await page.getByRole('button', { name: 'Move Bedding up' }).click();
  await expect(names).toHaveText(['Bedding', 'Kitchen']);
  await page.reload();
  await expect(names).toHaveText(['Bedding', 'Kitchen']);
  const [first, second] = await app.repos.categories.list();
  expect([first.name, second.name]).toEqual(['Bedding', 'Kitchen']);

  await page.goto(`${app.base}/admin/products/new`);
  await page.getByLabel('Name', { exact: true }).fill('Pan');
  await page.getByLabel('Price (₹)').fill('99');
  await page.getByRole('button', { name: 'Kitchen', exact: true }).click();
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);
  await expect(page.getByRole('button', { name: 'Kitchen', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.goto(`${app.base}/admin/categories/${second.id}`);
  await expect(page.getByRole('link', { name: 'Pan' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete category' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete category' }).click();
  await expect(page).toHaveURL(/\/admin\/categories$/);
  await expect(names).toHaveText(['Bedding']);
  expect((await app.repos.products.list())[0].name).toBe('Pan');
  expect(problems).toEqual([]);
});

test('a reel gets a store: products in order, a keyword, a DM preview in the seller\'s name, then removed', async ({ page }) => {
  const problems = watch(page, app);
  const pot = await app.repos.products.create({ name: 'Brass pot', price: '100', active: 'on' });
  const lamp = await app.repos.products.create({ name: 'Brass lamp', price: '200', active: 'on' });
  await open(page, app, '/reels');
  await expect(page.getByText('Not set up')).toBeVisible();

  await page.getByRole('link', { name: 'Set up store', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up reel store' })).toBeVisible();
  await expect(page.getByText('Off by default.')).toBeVisible();
  await expect(page.locator('.dm-name')).toHaveText('Test store');
  await expect(page.locator('.dm')).toContainText('Hey @asha!');
  await expect(page.locator('.dm')).not.toContainText(/bhava/i);

  await page.getByRole('button', { name: 'Create reel store' }).click();
  await expect(page.getByText('Add a headline')).toBeVisible();
  await expect(page.getByText('Pick at least 1 product for this reel')).toBeVisible();

  await page.getByLabel('Headline').fill('The brass edit');
  await page.getByLabel('Add a keyword').fill('BRASS');
  await page.getByLabel('Add a keyword').press('Enter');
  await expect(page.locator('.keyword')).toHaveText(['LINK', 'BRASS']);
  await page.getByRole('button', { name: 'Remove keyword LINK' }).click();

  await page.getByRole('button', { name: 'Add from catalog' }).click();
  await page.getByRole('button', { name: 'Add Brass pot' }).click();
  await page.getByLabel('Search your catalog').fill('lamp');
  await page.getByRole('button', { name: 'Add Brass lamp' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Move Brass lamp up' }).click();
  await expect(page.getByText('2 / 20')).toBeVisible();

  await page.getByRole('button', { name: 'Create reel store' }).click();
  await expect(page.getByRole('heading', { name: 'Edit reel store' })).toBeVisible();

  const saved = await app.repos.reels.get(REEL_ID);
  expect(saved.products.map((p) => p.id)).toEqual([lamp.id, pot.id]);
  expect(saved.keywords).toEqual(['BRASS']);
  expect(saved.public_reply).toBe('');
  expect(saved.caption).toBe('Brunch look');

  await page.reload();
  await expect(page.getByLabel('Headline')).toHaveValue('The brass edit');
  await page.getByRole('link', { name: 'Reels' }).first().click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Edit store', exact: true }).click();
  await page.getByRole('button', { name: 'Remove reel store' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove reel store' }).click();
  await expect(page).toHaveURL(/\/admin\/reels$/);
  await expect(page.getByText('Not set up')).toBeVisible();
  expect(await app.repos.reels.get(REEL_ID)).toBeNull();
  expect(await app.repos.products.get(pot.id)).not.toBeNull();
  expect(problems).toEqual([]);
});

test('a reel link opened cold finds its Instagram post, and a post that isn\'t there is a plain not-found', async ({ page }) => {
  await open(page, app, `/reels/${REEL_ID}`);
  await expect(page.getByRole('heading', { name: 'Set up reel store' })).toBeVisible();
  await expect(page.getByText('Brunch look')).toBeVisible();
  await page.goto(`${app.base}/admin/reels/999`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
});

test('an order is found, opened and moved along; cancelling restocks and can\'t be undone', async ({ page }) => {
  const problems = watch(page, app);
  const { products } = await seedReel(app.repos, { n: 1, stock: '5' });
  const order = await placeOrder(app, { productId: products[0].id, qty: 2 });
  await open(page, app, '/orders');
  await expect(page.getByRole('link', { name: new RegExp(order.order_number) })).toBeVisible();

  await page.getByRole('button', { name: 'Shipped', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No orders match' })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Order no., name or phone').fill('Asha');
  await page.getByRole('link', { name: new RegExp(order.order_number) }).click();

  await expect(page.getByRole('heading', { name: order.order_number })).toBeVisible();
  await expect(page.getByText('12 MG Road')).toBeVisible();
  await expect(page.locator('.totals-grand dd')).toHaveText('₹249');
  await expect(page.getByRole('link', { name: 'Message on WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/919876543210\?text=/);

  await page.getByLabel('Status').selectOption('shipped');
  await page.getByLabel('Internal note').fill('AWB 12345');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status(page, 'Order updated.')).toBeVisible();
  await expect(page.getByText('Shipped', { exact: true }).first()).toBeVisible();
  let saved = await app.repos.orders.get(order.id);
  expect(saved.status).toBe('shipped');
  expect(saved.notes).toBe('AWB 12345');

  await page.getByLabel('Status').selectOption('cancelled');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status(page, 'Order updated.')).toBeVisible();
  await expect(page.getByLabel('Status')).toHaveValue('cancelled');
  expect((await app.repos.products.get(products[0].id)).stock).toBe(5);

  await page.getByLabel('Status').selectOption('paid');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('can’t be reopened');
  saved = await app.repos.orders.get(order.id);
  expect(saved.status).toBe('cancelled');
  // The failure the form shows is the only error; the browser logging a failed request is not a fault in the page.
  expect(problems.filter((line) => !/400/.test(line))).toEqual([]);
});

test('R-01: another business\'s order, product, category and reel are simply not found', async ({ page }) => {
  const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
  const leaf = bindTenant(app.platform, other);
  const { products } = await seedReel(leaf, { n: 1 });
  const category = await leaf.categories.save(null, { name: 'Secret shelf', visible: 'on' });
  const order = await leaf.orders.create({ items: [{ productId: products[0].id, qty: 1 }], customer: { name: 'Bob Secret', phone: '9876543211', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' } }, await leaf.settings.getAll());

  await open(page, app, `/orders/${order.id}`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  for (const path of [`/products/${products[0].id}`, `/categories/${category.id}`]) {
    await page.goto(`${app.base}/admin${path}`);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Secret');
  }
});

test('a customer\'s password is reset and shown once', async ({ page }) => {
  const problems = watch(page, app);
  const shopper = await app.repos.users.create({ name: 'Ravi Kumar', phone: '9123456780', password: 'first1' });
  await open(page, app, '/customers');
  await expect(page.getByText('Ravi Kumar')).toBeVisible();
  await page.getByLabel('Search by name or number').fill('zzz');
  await expect(page.getByRole('heading', { name: 'No customers match' })).toBeVisible();
  await page.getByLabel('Search by name or number').fill('ravi');

  await page.getByRole('button', { name: 'Reset password for Ravi Kumar' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await app.repos.users.verify('9123456780', 'first1')).toBeTruthy();

  await page.getByRole('button', { name: 'Reset password for Ravi Kumar' }).click();
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('heading', { name: 'New password for Ravi Kumar' })).toBeVisible();
  const fresh = await page.locator('.reset-password code').textContent();
  expect(await app.repos.users.verify('9123456780', fresh)).toBeTruthy();
  expect(shopper.role).toBe('customer');

  await page.reload();
  await expect(page.getByText('Ravi Kumar')).toBeVisible();
  await expect(page.locator('.reset-password')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('DM activity says what happened to each comment', async ({ page }) => {
  await seedReel(app.repos, { n: 1 });
  await app.repos.activity.log({ commentId: 'c1', reelId: REEL_ID, username: 'asha', text: 'LINK please', result: 'skip:no-keyword' });
  await app.repos.activity.log({ commentId: 'c2', reelId: REEL_ID, username: 'ben', text: 'hello', result: 'error', error: 'Instagram said no' });
  await open(page, app);
  await goToMore(page, 'DM activity');
  await expect(page.getByRole('heading', { name: 'DM activity' })).toBeVisible();
  await expect(page.getByText('@asha')).toBeVisible();
  await expect(page.getByText('No keyword')).toBeVisible();
  await expect(page.getByText('Instagram said no')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Brunch edit' }).first()).toBeVisible();
});

test('settings save, with delivery in paise and the UPI details on their own', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app);
  await goToMore(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Store name')).toHaveValue('My store');

  await page.getByLabel('Store name').fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Store name is required')).toBeVisible();

  await page.getByLabel('Store name').fill('Kesar Home');
  await page.getByLabel('Instagram handle').fill('@kesar');
  await page.getByLabel('Delivery fee (₹)').fill('49.50');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid email, or leave it empty');
  await page.getByLabel('Email').fill('hello@kesar.example');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(status(page, 'Settings saved.')).toBeVisible();
  let saved = await app.repos.settings.getAll();
  expect(saved.store_name).toBe('Kesar Home');
  expect(saved.instagram_handle).toBe('kesar');
  expect(saved.shipping_fee_paise).toBe('4950');

  await page.getByLabel('UPI ID shown on the QR').fill('kesar@upi');
  await page.getByRole('button', { name: 'Save payment details' }).click();
  await expect(status(page, 'Payment details saved.')).toBeVisible();
  saved = await app.repos.settings.getAll();
  expect(saved.upi_id).toBe('kesar@upi');

  await expect(page.getByText('@shop')).toBeVisible();
  // The 400 from the invalid email above is the browser's own log line; the page handled it.
  expect(problems.filter((line) => !/400/.test(line))).toEqual([]);
});

test('the brand kit changes the look, refuses unreadable colours, and only the workspace picks up the logo', async ({ page }) => {
  const problems = watch(page, app);
  await open(page, app);
  await goToMore(page, 'Brand kit');
  await expect(page.getByRole('heading', { name: 'Brand kit' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Utsav/ })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('radio', { name: /Mitti/ }).click();
  await expect(page.getByRole('radio', { name: /Mitti/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Save brand kit' }).click();
  await expect(status(page, 'Brand kit saved.')).toBeVisible();
  expect((await app.repos.brandKit.get()).preset).toBe('mitti');

  await page.getByLabel('Buttons', { exact: true }).fill('#777777');
  await page.getByLabel('Text on buttons', { exact: true }).fill('#888888');
  await page.getByRole('button', { name: 'Save brand kit' }).click();
  await expect(page.getByText(/need a contrast of at least 4\.5:1/)).toBeVisible();
  expect((await app.repos.brandKit.get()).colors.primary).not.toBe('#777777');

  await page.getByLabel('Buttons', { exact: true }).fill('#234D33');
  await page.getByLabel('Text on buttons', { exact: true }).fill('#FFFFFF');
  await page.getByLabel('Upload logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'Logo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save brand kit' }).click();
  await expect(status(page, 'Brand kit saved.')).toBeVisible();
  const kit = await app.repos.brandKit.get();
  expect(kit.colors.primary).toBe('#234D33');
  expect(kit.logoUrl).toMatch(/^\/media\//);

  await expect(page.locator('.shell-top .avatar img')).toHaveAttribute('src', kit.logoUrl);
  await expect(page.locator('.shell-mark')).toHaveAttribute('alt', 'Bhava');
  expect(problems).toEqual([]);
});

test('U-02: staff get only what they are allowed: the menu is empty and a direct link is refused', async ({ page }) => {
  await app.repos.users.create({ name: 'Sita Staff', phone: '9000000003', password: 'secret1', role: 'staff' });
  await open(page, app, '', { phone: '9000000003', password: 'secret1' });
  await expect(page.getByRole('heading', { name: 'Your console is ready' })).toBeVisible();
  await expect(page.locator('.tabbar').getByRole('link', { name: 'Orders' })).toHaveCount(0);
  await page.goto(`${app.base}/admin/automations`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await page.goto(`${app.base}/admin/reels`);
  await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
  await page.goto(`${app.base}/admin/settings`);
  await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
});

test('signing in from the store\'s own login page lands in the console, already signed in', async ({ page }) => {
  await page.goto(`${app.base}/login`);
  await page.getByLabel(/mobile/i).fill('9000000001');
  await page.getByLabel(/password/i).fill('owner-pass');
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { name: 'Hello, Store' })).toBeVisible();
  // A cookie session opened on the store page can still save: the console learns the CSRF token from the API.
  await page.goto(`${app.base}/admin/products/new`);
  await page.getByLabel('Name', { exact: true }).fill('From store login');
  await page.getByLabel('Price (₹)').fill('5');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);
});
