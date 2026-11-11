// What a seller does with Phase 4 orders, in a real browser on a 360 px phone, against the real API and worker with the gateway
// and courier simulators behind them: move an order along, cancel it and be prompted to refund, refund part of it with their
// password, book the courier, and what a manager is not offered.
import { test, expect } from '@playwright/test';
import { addP4Shop, buyer, openP4World, unique } from '../../../test/p4/spec-p4/kit.js';
import { PHONE, expectHealthy, line, open, orderBecomes, ownWorker, panel, toast, watch } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P4ConsoleOrders') });
test.setTimeout(180_000);

const SLUG = `console-p4-orders-${unique()}`.toLowerCase();
let world;
let shop;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  world = await openP4World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP4Shop(world, { slug: SLUG, name: 'Kesar Home' });
  await shop.invoiceReady();
});
test.afterAll(async () => {
  await world?.close();
});

const dialog = (page) => page.getByRole('dialog');

test('S-30, S-31, S-27: an order is packed, cancelled with a refund prompt, and part of it refunded by the owner with their password', async ({ page }) => {
  const problems = watch(page, world);
  const lamp = await shop.item({ name: 'Brass lamp', pricePaise: 99900, stock: 5 });
  const row = await buyer(world, shop).buy({ lines: [line(lamp)] });

  await open(page, world, shop.owner, '/orders');
  const link = page.getByRole('link', { name: new RegExp(row.order_number) });
  await expect(link).toContainText('New');
  await expect(link).toContainText('Paid');
  await expectHealthy(page);
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: row.order_number })).toBeVisible();

  // Only the moves the state machine allows from "New" are offered (S-30): never "Mark as delivered".
  const next = panel(page, 'Next step');
  await expect(next.getByRole('button', { name: 'Mark as packed' })).toBeVisible();
  await expect(next.getByRole('button', { name: 'Mark as delivered' })).toHaveCount(0);
  await next.getByRole('button', { name: 'Mark as packed' }).click();
  await expect(toast(page, 'Marked as packed.')).toBeVisible();
  await orderBecomes(shop, row.order_number, (o) => o.fulfilment_status === 'packed');
  await expect(panel(page, 'Timeline').getByText('Packed', { exact: true })).toBeVisible();
  await expectHealthy(page);

  // Cancelling a packed, paid order puts the stock back and asks for a refund (S-31).
  await next.getByRole('button', { name: 'Cancel order' }).click();
  await dialog(page).getByLabel('Reason').selectOption('out_of_stock');
  await dialog(page).getByRole('button', { name: 'Cancel order' }).click();
  await expect(toast(page, 'Order cancelled. Refund ₹999 to the customer.')).toBeVisible();
  await orderBecomes(shop, row.order_number, (o) => o.fulfilment_status === 'cancelled');
  expect(Number((await shop.stockOf(lamp.id)).stock) - Number((await shop.stockOf(lamp.id)).reserved)).toBe(5);
  const prompt = page.getByRole('status').filter({ hasText: 'This order was cancelled after it was paid.' });
  await expect(prompt).toContainText('Refund ₹999.');

  // A wrong password refunds nothing; the right one refunds Rs 200 of Rs 999 (S-27).
  await prompt.getByRole('button', { name: 'Refund ₹999' }).click();
  await expect(dialog(page).getByLabel('Amount (₹)')).toHaveValue('999');
  await dialog(page).getByLabel('Amount (₹)').fill('1000');
  await dialog(page).getByLabel('Your password').fill(shop.owner.password);
  await dialog(page).getByRole('button', { name: 'Refund now' }).click();
  await expect(dialog(page).getByText('You can refund at most ₹999')).toBeVisible();
  await dialog(page).getByLabel('Amount (₹)').fill('200');
  await dialog(page).getByLabel('Your password').fill('not-the-password');
  await dialog(page).getByRole('button', { name: 'Refund now' }).click();
  await expect(dialog(page).getByText('That password isn’t right').first()).toBeVisible();
  expect(await shop.refunds(row.id)).toEqual([]);
  await dialog(page).getByLabel('Your password').fill(shop.owner.password);
  await dialog(page).getByRole('button', { name: 'Refund now' }).click();
  await expect(toast(page, 'Refund of ₹200 started.')).toBeVisible();
  await orderBecomes(shop, row.order_number, (o) => o.payment_status === 'partially_refunded');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: row.order_number })).toBeVisible();
  await expect(page.locator('.page-header')).toContainText('Partially refunded');
  await expect(page.locator('.totals')).toContainText('Refunded₹200');
  await expect(panel(page, 'Refunds')).toContainText('₹200');
  const [refund] = await shop.refunds(row.id);
  expect(Number(refund.amount_paise)).toBe(20000);
  await expect(panel(page, 'Invoices')).toContainText('Credit note');
  await expectHealthy(page);
  expect(problems.filter((p) => !/status of 4\d\d/.test(p))).toEqual([]);
});

test('S-29: a manager sees the order and its refunds, but is offered no refund and no change to how the business is paid', async ({ page }) => {
  const manager = { name: 'Mina Manager', phone: `92${String(Date.now()).slice(-8)}`, password: 'manager-pass-1', role: 'manager' };
  await shop.repos.users.create(manager);
  const kettle = await shop.item({ name: 'Copper kettle', pricePaise: 150000, stock: 3 });
  const row = await buyer(world, shop).buy({ lines: [line(kettle)] });
  await shop.cancel(row.id, { reason: 'seller' });

  await open(page, world, manager, `/orders/${row.id}`);
  await expect(page.getByRole('heading', { level: 1, name: row.order_number })).toBeVisible();
  await expect(page.getByText('Only the owner can refund it.')).toBeVisible();
  await expect(panel(page, 'Refunds').getByText('Only the owner can refund.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Refund/ })).toHaveCount(0);
  await expectHealthy(page);

  await page.goto(`${world.base}/admin/payments`);
  await expect(page.getByText('Only the owner changes how the business is paid.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Switch to/ })).toHaveCount(0);
});

test('S-34, S-78: "Ready to ship" names a product with no weight, then books the courier with the seller\'s own tracking page', async ({ page }) => {
  const problems = watch(page, world);
  const vase = await shop.item({ name: 'Clay vase', pricePaise: 64900, stock: 4 });
  await shop.sql('UPDATE products SET weight_grams = NULL WHERE tenant_id = $1 AND id = $2', [shop.tenantId, vase.id]);
  const row = await buyer(world, shop).buy({ lines: [line(vase)] });

  await open(page, world, shop.owner, `/orders/${row.id}`);
  const shipping = panel(page, 'Shipping');
  await shipping.getByRole('button', { name: 'Ready to ship' }).click();
  await expect(shipping.getByRole('alert')).toContainText('Clay vase');
  expect(await shop.shipments(row.id)).toEqual([]);

  await shop.sql('UPDATE products SET weight_grams = 700 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, vase.id]);
  await shipping.getByRole('button', { name: 'Ready to ship' }).click();
  await expect(toast(page, 'Courier booked. The label is ready.')).toBeVisible();
  const [shipment] = await shop.shipments(row.id);
  expect(shipment.awb).toBeTruthy();
  await expect(shipping).toContainText(`AWB ${shipment.awb}`);
  await expect(shipping).toContainText(`Tracking page: http`);
  await expect(shipping).not.toContainText(/shiprocket/i);
  await expect(shipping.getByRole('button', { name: 'Copy tracking link' })).toBeVisible();
  await shipping.getByRole('button', { name: 'Get the label' }).click();
  await expect(shipping.getByRole('link', { name: 'Open the label' })).toBeVisible();
  await expect(shipping.getByRole('button', { name: 'Ready to ship' })).toHaveCount(0);
  await expectHealthy(page);
  expect(problems.filter((p) => !/status of 4\d\d/.test(p))).toEqual([]);
});

test('9.9: orders are filtered by where the parcel and the money are, and made into a file of this business\'s orders', async ({ page }) => {
  const bowl = await shop.item({ name: 'Steel bowl', pricePaise: 29900, stock: 9 });
  const row = await buyer(world, shop).buy({ lines: [line(bowl)] });
  await open(page, world, shop.owner, '/orders');
  await page.getByText('More filters').click();
  await page.getByLabel('Where the parcel is').selectOption('delivered');
  await expect(page.getByRole('heading', { name: 'No orders match' })).toBeVisible();
  await page.getByLabel('Where the parcel is').selectOption('new');
  await expect(page.getByRole('link', { name: new RegExp(row.order_number) })).toBeVisible();
  await page.getByLabel('Where the money is').selectOption('refunded');
  await expect(page.getByRole('heading', { name: 'No orders match' })).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.getByRole('heading', { name: 'No files yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Make the file' }).click();
  await expect(toast(page, 'Your file is ready.')).toBeVisible();
  const download = page.getByRole('link', { name: 'Download' }).first();
  await expect(download).toHaveAttribute('href', /^\/orders\/downloads\/\d+\/file$/);
  const csv = await page.evaluate(async (href) => (await fetch(href)).text(), await download.getAttribute('href'));
  expect(csv).toContain(row.order_number);
  await expectHealthy(page);
});
