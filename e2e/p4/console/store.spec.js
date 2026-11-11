// The rest of the Phase 4 console in a real browser on a 360 px phone, against the real API and worker with every store
// simulator behind it: coupons, stock, payment options, courier settings, reviews, returns with proof, loyalty shown only with
// the add-on, a shopper's data deleted on request, and messages to shoppers by WhatsApp and email only.
import { test, expect } from '@playwright/test';
import { addP4Shop, buyer, openP4World, proofPhoto, unique } from '../../../test/p4/spec-p4/kit.js';
import { PHONE, expectHealthy, line, open, ownWorker, panel, toast, watch } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P4ConsoleStore') });
test.setTimeout(180_000);

const SLUG = `console-p4-store-${unique()}`.toLowerCase();
let world;
let shop;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  world = await openP4World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP4Shop(world, { slug: SLUG, name: 'Leaf and Clay' });
});
test.afterAll(async () => {
  await world?.close();
});

const dialog = (page) => page.getByRole('dialog');
const field = (page, name) => page.getByLabel(name, { exact: true });

async function deliveredTo(product) {
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.delivered({ lines: [line(product)] });
  const [item] = await shop.orderItems(row.id);
  return { b, row, item };
}

test('S-45: a coupon for a reel is made as the API takes it and shows as running', async ({ page }) => {
  const problems = watch(page, world);
  await open(page, world, shop.owner, '/coupons');
  await expect(page.getByRole('heading', { name: 'No coupons yet' })).toBeVisible();
  await expectHealthy(page);
  await page.getByRole('link', { name: 'Make your first coupon' }).click();
  await field(page, 'Code').fill('reel10');
  await field(page, 'Percentage off (%)').fill('10');
  await field(page, 'Most it takes off (₹)').fill('150');
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Make coupon' }).click();
  await expect(toast(page, 'Coupon made.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/coupons\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Not used yet' })).toBeVisible();
  const [coupon] = await shop.sql('SELECT * FROM coupons WHERE tenant_id = $1 AND code = $2', [shop.tenantId, 'REEL10']);
  expect([coupon.kind, Number(coupon.percent_bp), Number(coupon.max_discount_paise)]).toEqual(['percent', 1000, 15000]);

  // The same code again is refused by the server, and said so on the form.
  await page.goto(`${world.base}/admin/coupons/new`);
  await field(page, 'Code').fill('REEL10');
  await field(page, 'Percentage off (%)').fill('5');
  await page.getByRole('button', { name: 'Make coupon' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  expect((await shop.sql('SELECT id FROM coupons WHERE tenant_id = $1', [shop.tenantId])).length).toBe(1);

  await page.goto(`${world.base}/admin/coupons`);
  const row = page.getByRole('link', { name: /REEL10/ });
  await expect(row).toContainText('10% off, up to ₹150');
  await expect(row).toContainText('Running');
  expect(problems.filter((p) => !/status of 4\d\d/.test(p))).toEqual([]);
});

test('9.12: stock is set by hand, held stock shows apart, and the change is in its history', async ({ page }) => {
  const pot = await shop.item({ name: 'Terracotta pot', pricePaise: 39900, stock: 5 });
  await open(page, world, shop.owner, '/inventory');
  await page.getByLabel('Product name or SKU').fill('Terracotta');
  const change = page.getByRole('button', { name: 'Change stock of Terracotta pot' });
  await expect(change).toBeVisible();
  await expect(page.getByText('On hand 5')).toBeVisible();
  await change.click();
  await field(page, 'On hand').fill('7');
  await dialog(page).getByRole('button', { name: 'Save stock' }).click();
  await expect(toast(page, 'Stock saved.')).toBeVisible();
  expect(Number((await shop.stockOf(pot.id)).stock)).toBe(7);

  await change.click();
  await dialog(page).getByText('Add or take away').click();
  await field(page, 'Add, or take away with a minus').fill('-9');
  await dialog(page).getByRole('button', { name: 'Save stock' }).click();
  await expect(dialog(page).getByText('Only 7 on hand')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  expect(Number((await shop.stockOf(pot.id)).stock)).toBe(7);

  await page.getByRole('link', { name: 'History of Terracotta pot' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Stock changes: Terracotta pot' })).toBeVisible();
  await expect(page.getByText('Changed by hand')).toBeVisible();
  await expect(page.getByText('+2')).toBeVisible();
  await expectHealthy(page);
});

test('9.5, 9.6: payment options are saved in rupees and stored in paise; the courier settings keep the pickup address', async ({ page }) => {
  await open(page, world, shop.owner, '/payments');
  await expect(page.getByText('Bhava-managed').first()).toBeVisible();
  const ways = page.getByRole('form', { name: 'Ways to pay' });
  const cod = ways.getByRole('switch', { name: 'Offer cash on delivery' });
  if (!(await cod.isChecked())) await cod.check();
  await ways.getByLabel('Cash on delivery fee (₹)').fill('29.50');
  await ways.getByLabel('Largest order for cash on delivery (₹)').fill('5000');
  await ways.getByLabel('Only these PIN codes').fill('41100');
  await ways.getByRole('button', { name: 'Save payment options' }).click();
  await expect(ways.getByText('41100 isn’t a 6-digit PIN code')).toBeVisible();
  await ways.getByLabel('Only these PIN codes').fill('411001, 411002');
  await ways.getByRole('button', { name: 'Save payment options' }).click();
  await expect(toast(page, 'Payment options saved.')).toBeVisible();
  const saved = await shop.must('GET', '/payment-settings');
  expect([saved.cod, saved.codFeePaise, saved.codMaxOrderPaise, saved.codPincodes]).toEqual([true, 2950, 500000, ['411001', '411002']]);
  await expectHealthy(page);

  await page.getByRole('link', { name: 'Statement' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Statement' })).toBeVisible();
  await expect(page.getByText('Bhava takes no commission on sales.')).toBeVisible();
  await expectHealthy(page);

  await page.goto(`${world.base}/admin/shipping`);
  await expect(field(page, 'Name on the label')).toHaveValue(shop.pickup.pickupName);
  await field(page, 'City').fill('Pimpri');
  await page.getByRole('button', { name: 'Save shipping settings' }).click();
  await expect(toast(page, 'Shipping settings saved.')).toBeVisible();
  expect((await shop.must('GET', '/shipping-settings')).pickupCity).toBe('Pimpri');
  await page.getByLabel('PIN code to check').fill('560001');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText(/^560001:/)).toBeVisible();
  await expectHealthy(page);
});

test('S-82, S-83: a review waits for the owner, who approves it, replies once, and can hide it', async ({ page }) => {
  const bell = await shop.item({ name: 'Temple bell', pricePaise: 50000, stock: 5 });
  const { b, row } = await deliveredTo(bell);
  const res = await b.review({ orderNumber: row.order_number, productId: bell.id, rating: 4, body: 'Rings clear and long.' });
  expect(res.status).toBeLessThan(300);

  await open(page, world, shop.owner, '/reviews?status=pending');
  const card = page.getByRole('region', { name: /Review of Temple bell/ });
  await expect(card).toContainText('Rings clear and long.');
  await expect(card.getByRole('img', { name: '4 out of 5 stars' })).toBeVisible();
  await expectHealthy(page);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(toast(page, 'Review approved. It shows on the product page.')).toBeVisible();
  await expect.poll(async () => (await shop.sql('SELECT status FROM reviews WHERE tenant_id = $1 AND product_id = $2', [shop.tenantId, bell.id]))[0].status).toBe('approved');

  await page.goto(`${world.base}/admin/reviews`);
  const approved = page.getByRole('region', { name: /Review of Temple bell/ });
  await approved.getByRole('button', { name: 'Reply' }).click();
  await field(page, 'Your reply').fill('Thank you for ringing it in!');
  await dialog(page).getByRole('button', { name: 'Post reply' }).click();
  await expect(toast(page, 'Reply posted.')).toBeVisible();
  await expect(approved).toContainText('Thank you for ringing it in!');
  await approved.getByRole('button', { name: 'Hide' }).click();
  await expect(toast(page, 'Review hidden. It no longer counts in the average.')).toBeVisible();
  await expect.poll(async () => (await shop.sql('SELECT status FROM reviews WHERE tenant_id = $1 AND product_id = $2', [shop.tenantId, bell.id]))[0].status).toBe('hidden');
  await expect(approved).toContainText('Hidden');
});

test('9.17, S-58: a return with a photo is approved, and the item received not fit to sell stays out of stock', async ({ page }) => {
  await shop.returnsOn({ windowDays: 7, proof: 'either' });
  const kurta = await shop.item({ name: 'Linen kurta', pricePaise: 99900, stock: 5 });
  const { b, row, item } = await deliveredTo(kurta);
  const asked = await b.askReturn(row.order_number, { fields: { reason: 'The seam is torn', resolution: 'refund', items: JSON.stringify([{ orderItemId: item.id, qty: 1 }]) }, files: [proofPhoto()] });
  expect(asked.status).toBeLessThan(300);
  const stockBefore = Number((await shop.stockOf(kurta.id)).stock);

  await open(page, world, shop.owner, '/returns');
  await page.getByRole('link', { name: new RegExp(`Order ${row.order_number}`) }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Return for ${row.order_number}` })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo 1 from the customer' })).toBeVisible();
  await expect(page.getByText('“The seam is torn”')).toBeVisible();
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect(toast(page, 'Approved. The pickup is booked.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Received, not restockable' })).toBeVisible();
  await page.getByRole('button', { name: 'Received, not restockable' }).click();
  await dialog(page).getByRole('button', { name: 'Yes, not restockable' }).click();
  await expect(toast(page, 'Marked as received.')).toBeVisible();
  await expect(page.getByText('Not fit to sell')).toBeVisible();
  expect(Number((await shop.stockOf(kurta.id)).stock)).toBe(stockBefore);
  await expect(page.getByRole('button', { name: 'Refund the customer' })).toBeVisible();
  await expectHealthy(page);
});

test('S-91: the loyalty screens show only when the add-on is on', async ({ page }) => {
  await open(page, world, shop.owner, '/customers/shoppers');
  await expect(page.getByRole('heading', { level: 1, name: 'Shoppers' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Customers area' }).getByRole('link', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Loyalty' })).toHaveCount(0);
  await page.goto(`${world.base}/admin/loyalty`);
  await expect(page.getByRole('heading', { name: 'This isn’t on your plan' })).toBeVisible();

  await shop.loyaltyOn();
  await page.goto(`${world.base}/admin/customers/shoppers`);
  await page.getByRole('navigation', { name: 'Customers area' }).getByRole('link', { name: 'Loyalty' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Loyalty points' })).toBeVisible();
  await page.getByRole('link', { name: 'Point rules' }).click();
  await expect(field(page, 'Points earned')).toHaveValue('1');
  await expect(field(page, 'For every (₹)')).toHaveValue('100');
  await expectHealthy(page);
});

test('S-63, S-104: a shopper shows with this business\'s orders only, and the owner deletes their data on request', async ({ page }) => {
  const mat = await shop.item({ name: 'Jute mat', pricePaise: 25000, stock: 5 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  await b.buy({ lines: [line(mat)] });
  const [me] = await shop.sql('SELECT id FROM shoppers WHERE tenant_id = $1 AND phone = $2', [shop.tenantId, phone]);

  await open(page, world, shop.owner, '/customers/shoppers');
  const row = page.locator(`a[href="/admin/customers/shoppers/${me.id}"]`);
  await expect(row).toContainText('Signed in');
  await row.click();
  await expect(page.getByText('WhatsApp offers')).toBeVisible();
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Delete their data' }).click();
  await dialog(page).getByRole('button', { name: 'Delete their data' }).click();
  await expect(toast(page, 'Deletion started. Track it under Data requests.')).toBeVisible();
  const requests = await shop.sql('SELECT kind, source FROM data_requests WHERE tenant_id = $1', [shop.tenantId]);
  expect(requests).toEqual([expect.objectContaining({ kind: 'erasure', source: 'seller' })]);
  await page.goto(`${world.base}/admin/customers/data-requests`);
  await expect(page.getByText('Made by you')).toBeVisible();
  await expectHealthy(page);
});

test('S-96, S-53: messages go by WhatsApp and email only with WhatsApp\'s price at cost, and a template in review reads "Template pending"', async ({ page }) => {
  await shop.templateStatus('order_paid', 'pending');
  await world.wa.post('/templates/enforce', { on: true });
  try {
    const plate = await shop.item({ name: 'Brass plate', pricePaise: 45000, stock: 5 });
    const row = await buyer(world, shop).buy({ lines: [line(plate)], email: `asha${unique()}@mail.example` });
    await world.until(async () => (await shop.alertsOf(row.id, 'paid')).some((a) => a.channel === 'whatsapp' && a.status === 'skipped'), 15_000);

    await open(page, world, shop.owner, '/store-settings/messages');
    const updates = page.getByRole('form', { name: 'Order updates' });
    await expect(updates.getByRole('switch', { name: 'WhatsApp' })).toBeVisible();
    await expect(updates.getByRole('switch', { name: 'Email' })).toBeVisible();
    await expect(updates.getByRole('switch')).toHaveCount(2);
    await expect(page.locator('body')).not.toContainText(/\bSMS\b/);
    await expect(page.getByRole('heading', { name: 'WhatsApp price per message' })).toBeVisible();
    await expect(page.getByText('passed on at cost with no markup')).toBeVisible();
    await expect(panel(page, 'Recent order updates')).toContainText('Template pending');
    await expectHealthy(page);

    await page.goto(`${world.base}/admin/orders/${row.id}`);
    await expect(panel(page, 'Messages to the customer')).toContainText('Template pending');
  } finally {
    await world.wa.post('/templates/enforce', { on: false });
  }
});
