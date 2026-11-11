// What a seller does on the Phase 3 screens, in a real browser on a 360px phone, against the real API and worker with the Meta, website
// and Shopify simulators behind them. Nothing here leaves this machine.
import { test, expect } from '@playwright/test';
import { addP3Shop, creatorPage, csvText, jsonLdPage, leadFormOn, openP3World, setTier, submitLead } from '../../../test/p3/spec-p3/kit.js';
import { PHONE, expectHealthy, open, ownWorker, panel, settled, toast, watch } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P3ConsoleFlows') });
test.setTimeout(120_000);

const SLUG = 'console-p3-flows';
let world;
let shop;

test.beforeAll(async () => {
  // The worker asks for jobs four times a second rather than every 15 ms, so it doesn't crowd out the screens on the one in-memory database.
  world = await openP3World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP3Shop(world, { slug: SLUG, name: 'Flow Shop' });
});
test.afterAll(async () => {
  await world?.close();
});

const field = (page, name) => page.getByLabel(name, { exact: true });

test('K-01, K-02, K-03: a product is added by hand with sizes, its MRP can\'t be below its price, and the catalog shows it with its discount', async ({ page }) => {
  const problems = watch(page, world);
  await open(page, world, shop.owner, '/catalog/new');
  await field(page, 'Name').fill('Brass diya set');
  await field(page, 'Price (₹)').first().fill('500');
  await field(page, 'MRP (₹)').first().fill('400');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.getByText('MRP can’t be lower than the price')).toBeVisible();
  await expectHealthy(page);

  await field(page, 'MRP (₹)').first().fill('625');
  await page.getByRole('button', { name: 'Add an option' }).click();
  await field(page, 'Option 1').fill('Size');
  await page.getByLabel('Add to values of size').fill('Small, Large');
  await page.getByLabel('Add to values of size').press('Enter');
  const variants = page.getByRole('group', { name: 'Variants' });
  await expect(variants.getByRole('group')).toHaveCount(2);
  await variants.getByRole('group', { name: 'Large' }).getByLabel('Price (₹)').fill('650');
  await variants.getByRole('group', { name: 'Large' }).getByLabel('MRP (₹)').fill('');
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(toast(page, 'Product added.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/catalog\/\d+$/);

  const [saved] = (await shop.products()).filter((product) => product.name === 'Brass diya set');
  const detail = await shop.getProduct(saved.id);
  expect(detail.pricePaise).toBe(50000);
  expect(detail.mrpPaise).toBe(62500);
  expect(detail.variants.map((variant) => [variant.optionValues.join(), variant.pricePaise]).sort()).toEqual([['Large', 65000], ['Small', 50000]]);

  await page.goto(`${world.base}/admin/catalog`);
  const row = page.getByRole('link', { name: /Brass diya set/ });
  await expect(row).toContainText('₹500');
  await expect(row).toContainText('₹625');
  await expect(row).toContainText('-20%');
  await expectHealthy(page);
  expect(problems).toEqual([]);
});

test('8.8: saving a new description sends the description only, so an imported price stays the importer\'s', async ({ page }) => {
  const product = await shop.product({ name: 'Copper tumbler', pricePaise: 34900 });
  await open(page, world, shop.owner, `/catalog/${product.id}`);
  await field(page, 'Description').fill('Hand-beaten copper.');
  const sent = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith(`/api/v1/products/${product.id}`));
  await page.getByRole('button', { name: 'Save product' }).click();
  expect(Object.keys((await sent).postDataJSON())).toEqual(['description']);
  await expect(toast(page, 'Saved.')).toBeVisible();
  expect((await shop.getProduct(product.id)).description).toBe('Hand-beaten copper.');
});

test('8.3, 8.7: a pasted link is read into a draft, nothing is saved until the owner checks it, and the homepage is turned away with the reason', async ({ page }) => {
  world.sites.page('shop.example', '/products/console-lamp', { body: jsonLdPage({ name: 'Console lamp', price: '899.00' }) });
  const before = (await shop.products()).length;
  await open(page, world, shop.owner, '/imports');
  await field(page, 'Product link').fill('https://shop.example/products/console-lamp');
  await page.getByRole('button', { name: 'Read this page' }).click();
  await expect(page.getByRole('heading', { name: 'We read this product' })).toBeVisible({ timeout: 30_000 });
  const review = page.getByRole('form', { name: 'Check this product' });
  await expect(review.getByLabel('Name', { exact: true })).toHaveValue('Console lamp');
  await expect(review.getByLabel('Price (₹)', { exact: true })).toHaveValue('899');
  expect((await shop.products()).length, 'reading a page saves nothing').toBe(before);
  await expectHealthy(page);

  await review.getByLabel('Name', { exact: true }).fill('Console lamp, brass');
  await review.getByRole('button', { name: 'Save to catalog' }).click();
  await expect(toast(page, 'Saved to your catalog.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/catalog\/\d+$/);
  await expect(page.getByRole('heading', { name: 'From your website' })).toBeVisible();
  const saved = (await shop.products()).find((product) => product.name === 'Console lamp, brass');
  expect(saved.externalUrl).toBe('https://shop.example/products/console-lamp');
  expect(saved.pricePaise).toBe(89900);

  // The same link again is the product it already is (K-11), and the homepage is not a product (8.7).
  await page.goto(`${world.base}/admin/imports`);
  await field(page, 'Product link').fill('https://shop.example/products/console-lamp');
  await page.getByRole('button', { name: 'Read this page' }).click();
  await expect(page.getByRole('heading', { name: 'This product is already in your catalog' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open the product' })).toHaveAttribute('href', `/admin/catalog/${saved.id}`);

  await field(page, 'Product link').fill('https://shop.example/');
  await page.getByRole('button', { name: 'Read this page' }).click();
  await expect(page.getByText('This looks like the homepage, not a product.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Add the details yourself' })).toBeVisible();
  await expectHealthy(page);
  expect((await shop.products()).filter((product) => product.externalUrl === 'https://shop.example/')).toEqual([]);
});

test('8.6: more than 25 links are refused before anything is sent, and pasted links run in the background with a result for each', async ({ page }) => {
  world.sites.page('shop.example', '/products/bulk-one', { body: jsonLdPage({ name: 'Bulk one', price: '120' }) });
  world.sites.page('shop.example', '/products/bulk-two', { body: jsonLdPage({ name: 'Bulk two', price: '240' }) });
  await open(page, world, shop.owner, '/imports?way=bulk');
  const links = field(page, 'Product links');
  let asked = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/imports/bulk')) asked += 1;
  });
  await links.fill(Array.from({ length: 26 }, (_, i) => `https://shop.example/products/n${i}`).join('\n'));
  await page.getByRole('button', { name: 'Import these links' }).click();
  await expect(page.getByText('Paste up to 25 links at a time. You pasted 26.')).toBeVisible();
  expect(asked).toBe(0);

  await links.fill('https://shop.example/products/bulk-one\nhttps://shop.example/products/bulk-two\nhttps://shop.example/');
  await page.getByRole('button', { name: 'Import these links' }).click();
  await expect(page).toHaveURL(/\/admin\/imports\/\d+$/);
  await expect(page.getByText('Finished', { exact: true })).toBeVisible({ timeout: 90_000 });
  const items = page.getByRole('list', { name: 'Products in this import' });
  await expect(items.getByRole('listitem')).toHaveCount(3);
  await expect(items.getByRole('listitem').filter({ hasText: 'This looks like the homepage, not a product.' })).toContainText('Stopped by the quality check');
  await settled(page);
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Need a look' }).click();
  await expect(items.getByRole('listitem')).toHaveCount(1);
});

test('8.6: a CSV file is uploaded from the phone and each row gets a result', async ({ page }) => {
  const csv = csvText([
    { title: 'CSV kettle', url: 'https://shop.example/products/csv-kettle', price: '1,299', mrp: '1,499', in_stock: 'yes' },
    { title: 'CSV with no price', url: 'https://shop.example/products/csv-no-price', price: '' },
  ]);
  await open(page, world, shop.owner, '/imports?way=csv');
  await expect(page.getByText('title, url, price, mrp, images, category, sku, in_stock, options')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import this file' })).toBeDisabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(page.getByText('products.csv')).toBeVisible();
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Import this file' }).click();
  await expect(page).toHaveURL(/\/admin\/imports\/\d+$/);
  await expect(page.getByText('Finished', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('list', { name: 'Products in this import' }).getByRole('listitem')).toHaveCount(2);
  expect((await shop.products()).find((product) => product.name === 'CSV kettle')?.pricePaise).toBe(129900);
  await expectHealthy(page);
});

test('8.5: a Shopify store is imported from its address, and the import\'s page says what happened', async ({ page }) => {
  await world.shopify.post('/storefront/generate', { count: 6 });
  await open(page, world, shop.owner, '/imports?way=shopify');
  await field(page, 'Store address').fill('plants.example');
  await page.getByRole('button', { name: 'Import this store' }).click();
  await expect(page).toHaveURL(/\/admin\/imports\/\d+$/);
  await expect(page.getByText('Finished', { exact: true })).toBeVisible({ timeout: 110_000 });
  await expect(page.getByRole('list', { name: 'Products in this import' }).getByRole('listitem')).toHaveCount(6);
  expect((await shop.products('source=shopify')).length).toBe(6);
  await settled(page);
  await expectHealthy(page);

  await page.goto(`${world.base}/admin/catalog?source=shopify`);
  await expect(page.getByRole('region', { name: 'Products' }).getByRole('link')).toHaveCount(6);
  await expect(page.getByRole('region', { name: 'Products' })).toContainText('From Shopify');
  await expectHealthy(page);
});

test('8.10, K-30, K-32: a landing page is made for a reel with products in the picked order, and shows its own direct link', async ({ page }) => {
  const first = await shop.product({ name: 'Page product one' });
  const second = await shop.product({ name: 'Page product two' });
  await shop.reel({ caption: 'Diwali picks for the console' });
  await open(page, world, shop.owner, '/pages/new');
  await page.getByRole('button', { name: 'Pick Diwali picks for the console' }).click();
  await page.getByRole('button', { name: 'Make the page' }).click();
  await expect(page.getByText('Pick at least 1 product')).toBeVisible();

  await page.getByRole('button', { name: 'Add from catalog' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add from catalog' });
  await sheet.getByRole('button', { name: `Add ${second.name}` }).click();
  await sheet.getByRole('button', { name: `Add ${first.name}` }).click();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('list', { name: 'Products on this page' }).getByRole('listitem')).toHaveText([/Page product two/, /Page product one/]);
  await field(page, 'Headline').fill('Diwali picks');
  await expectHealthy(page);
  await page.getByRole('button', { name: 'Make the page' }).click();
  await expect(toast(page, 'Page made.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/pages\/\d+$/);

  const id = Number(page.url().split('/').pop());
  const saved = await shop.must('GET', `/pages/${id}`);
  expect(saved.products.map((product) => product.id)).toEqual([second.id, first.id]);
  const link = panel(page, 'This page’s link');
  await expect(link).toContainText(saved.url);
  expect(new URL(saved.url).pathname).toBe(`/r/${saved.slug}`);
  await expect(link.getByRole('link', { name: 'Open' })).toHaveAttribute('href', saved.url);
  await settled(page);
  await expectHealthy(page);

  // The order is the owner's to change.
  await page.getByRole('button', { name: 'Move Page product one up' }).click();
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(toast(page, 'Page saved.')).toBeVisible();
  expect((await shop.must('GET', `/pages/${id}`)).products.map((product) => product.id)).toEqual([first.id, second.id]);

  await page.goto(`${world.base}/admin/pages`);
  await expect(page.getByRole('link', { name: /Diwali picks/ })).toContainText('Instagram reel · 2 products');
  await expectHealthy(page);
});

test('K-41: on tier 1 a page shows one product, and the form says so as a plan matter', async ({ page }) => {
  const one = await shop.product({ name: 'Only product' });
  const two = await shop.product({ name: 'Second product' });
  const made = await shop.page({ productIds: [one.id], caption: 'Tier one reel', headline: 'Tier one page' });
  await setTier(world, shop, 't1');
  try {
    await open(page, world, shop.owner, `/pages/${made.id}`);
    await expect(page.getByText('Your plan shows 1 product on a page. A higher plan shows up to 20.')).toBeVisible();
    await page.getByRole('button', { name: 'Add from catalog' }).click();
    const sheet = page.getByRole('dialog', { name: 'Add from catalog' });
    await expect(sheet.getByText('This page is full. Remove a product to add another.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: `Add ${two.name}` })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await settled(page);
    await expectHealthy(page);
  } finally {
    await setTier(world, shop, 't3');
  }
});

test('F-102, F-103, F-106: a look is picked and used, nothing but the look changes, and the seller\'s own words are saved', async ({ page }) => {
  const before = { products: await shop.products(), pages: (await shop.must('GET', '/pages?limit=100')).items };
  const theme = await shop.must('GET', '/theme');
  const presets = (await shop.must('GET', '/theme/presets')).items;
  const next = presets.find((preset) => preset.code !== theme.preset);
  await open(page, world, shop.owner, '/look');
  const looks = page.getByRole('radiogroup', { name: 'Pick a look' });
  await expect(looks.getByRole('radio')).toHaveCount(presets.length);
  await expect(looks.getByRole('radio', { checked: true })).toContainText(theme.presetName);
  await settled(page);
  await expectHealthy(page);

  await looks.getByRole('radio', { name: new RegExp(next.name) }).click();
  await expect(page.getByRole('img', { name: `A sketch of your page in the ${next.name} look` })).toBeVisible();
  await expectHealthy(page);
  await page.getByRole('button', { name: `Use ${next.name}` }).click();
  await expect(toast(page, `Your shop now wears ${next.name}.`)).toBeVisible();
  await expect(looks.getByRole('radio', { checked: true })).toContainText('Your look now');
  expect((await shop.must('GET', '/theme')).preset).toBe(next.code);
  expect(await shop.products()).toEqual(before.products);
  expect((await shop.must('GET', '/pages?limit=100')).items).toEqual(before.pages);

  await field(page, 'Seal words').fill('Made by hand');
  await page.getByLabel('Add to strip lines').fill('Free delivery, Cash on delivery');
  await page.getByLabel('Add to strip lines').press('Enter');
  await page.getByRole('button', { name: 'Save words' }).click();
  await expect(toast(page, 'Words saved.')).toBeVisible();
  const saved = await shop.must('GET', '/theme');
  expect([saved.sealText, saved.tickerItems]).toEqual(['Made by hand', ['Free delivery', 'Cash on delivery']]);
  await expect(page.getByRole('img', { name: /A sketch of your page/ })).toContainText('Made by hand');
  await settled(page);
  await expectHealthy(page);
});

test('8.9: a look is read from the seller\'s website, shown for checking, and used only when the owner says so', async ({ page }) => {
  await open(page, world, shop.owner, '/look');
  const before = await shop.must('GET', '/theme');
  await field(page, 'Your website').fill('brand.example');
  await page.getByRole('button', { name: 'Read my website' }).click();
  const reads = page.getByRole('list', { name: 'Websites we read' });
  await expect(reads.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await expect(reads.getByRole('listitem').first()).toContainText('brand.example');
  expect((await shop.must('GET', '/theme')).colors, 'reading changes nothing').toEqual(before.colors);
  await settled(page);
  await expectHealthy(page);

  await reads.getByRole('button', { name: 'Use these colours and fonts' }).click();
  await expect(toast(page, 'Your shop now wears your website’s look.')).toBeVisible();
  expect((await shop.must('GET', '/theme')).source).toBe('website');
  await expect(reads.getByRole('listitem').first()).toContainText('In use');
});

test('8.13, K-43 to K-46: reels are arranged in a category, the order is saved whole, a reel is pinned, and a window is set', async ({ page }) => {
  const category = await shop.category('Console festive');
  const pages = [];
  for (const headline of ['Alpha reel', 'Beta reel', 'Gamma reel']) pages.push(await shop.page({ caption: headline, headline }));
  await shop.addToCategory(category.id, pages.map((item) => item.id));
  await open(page, world, shop.owner, `/categories/${category.id}/reels`);
  const list = page.getByRole('list', { name: 'Reel order' });
  await expect(list.getByRole('listitem')).toHaveText([/Alpha reel/, /Beta reel/, /Gamma reel/]);
  await expect(page.getByRole('button', { name: 'Order saved' })).toBeDisabled();
  await settled(page);
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Move Gamma reel up' }).click();
  await page.getByRole('button', { name: 'Move Gamma reel up' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/Gamma reel/, /Alpha reel/, /Beta reel/]);
  expect((await shop.sequence(category.id)).map((item) => item.pageId), 'moving saves nothing by itself').toEqual(pages.map((item) => item.id));
  await page.getByRole('button', { name: 'Save order' }).click();
  await expect(toast(page, 'Order saved.')).toBeVisible();
  expect((await shop.sequence(category.id)).map((item) => item.pageId)).toEqual([pages[2].id, pages[0].id, pages[1].id]);

  await page.getByRole('button', { name: 'Pin to top: Beta reel' }).click();
  await expect(toast(page, 'Pinned to the top.')).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveText([/Beta reel.*Pinned/, /Gamma reel/, /Alpha reel/]);
  await expect(page.getByRole('button', { name: 'Move Beta reel down' })).toBeDisabled();
  await page.getByRole('button', { name: 'Unpin Beta reel' }).click();
  await expect(toast(page, 'Unpinned. It is back in its old place.')).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveText([/Gamma reel/, /Alpha reel/, /Beta reel/]);

  await page.getByRole('button', { name: 'Timing of Alpha reel' }).click();
  const timing = page.getByRole('form', { name: 'When Alpha reel shows' });
  const tomorrow = new Date(Date.now() + 86_400_000);
  const stamp = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T09:00`;
  await timing.getByLabel('Show from').fill(stamp);
  await expectHealthy(page);
  await timing.getByRole('button', { name: 'Save times' }).click();
  await expect(toast(page, 'Times saved.')).toBeVisible();
  const alpha = (await shop.sequence(category.id)).find((item) => item.pageId === pages[0].id);
  expect([alpha.live, alpha.hiddenReason]).toEqual([false, 'before_window']);
  await expect(list.getByRole('listitem').filter({ hasText: 'Alpha reel' })).toContainText('Shows from');
  await expect(list.getByRole('listitem').filter({ hasText: 'Alpha reel' })).toContainText('Not showing');
  await expect(list.getByRole('listitem')).toHaveText([/Gamma reel/, /Alpha reel/, /Beta reel/]);
  await settled(page);
  await expectHealthy(page);
});

test('K-47 to K-49: a rule is added in a sentence, applied to existing reels, and a reel the owner took out is not added back', async ({ page }) => {
  const category = await shop.category('Console rules');
  const matching = await shop.page({ caption: 'Monsoon sale on brass', headline: 'Monsoon reel' });
  await open(page, world, shop.owner, `/categories/${category.id}/reels`);
  const add = page.getByRole('form', { name: 'Add a rule' });
  await add.getByRole('button', { name: 'Add rule' }).click();
  await expect(add.getByText('Type the word')).toBeVisible();
  await add.getByLabel('Word').fill('monsoon');
  await add.getByRole('button', { name: 'Add rule' }).click();
  const rules = page.getByRole('list', { name: 'Rules' });
  await expect(rules.getByRole('listitem')).toContainText('New reels with “monsoon” in the caption join at the top');
  await settled(page);
  await expectHealthy(page);

  await rules.getByRole('button', { name: /^Apply to existing reels/ }).click();
  await expect(toast(page, '1 reel added.')).toBeVisible();
  const list = page.getByRole('list', { name: 'Reel order' });
  await expect(list.getByRole('listitem')).toHaveText([/Monsoon reel/]);
  await expect(list).toContainText('Added by a rule');

  await page.getByRole('button', { name: 'Take out Monsoon reel' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Take it out' }).click();
  await expect(toast(page, 'Taken out.')).toBeVisible();
  await expect(page.getByText('No reels in this category yet')).toBeVisible();
  await rules.getByRole('button', { name: /^Apply to existing reels/ }).click();
  await expect(toast(page, 'No other reels match.')).toBeVisible();
  expect(await shop.sequence(category.id)).toEqual([]);
  expect(matching.id).toBeGreaterThan(0);
});

test('8.14, K-50: the creator page gets its name and its link for the bio; a name the store uses is refused as it is typed', async ({ page }) => {
  await open(page, world, shop.owner, '/creator-page');
  await expect(page.getByText('Choose a name below and save to get your page’s link.')).toBeVisible();
  await field(page, 'Page name').fill('shop');
  await expect(page.getByText('That name is taken by a page of the store')).toBeVisible();
  await expectHealthy(page);
  await field(page, 'Page name').fill('Flow Maker');
  await page.getByRole('switch', { name: 'Page is live' }).check();
  await field(page, 'About').fill('Brass, copper and festive finds.');
  await page.getByRole('button', { name: 'Save creator page' }).click();
  await expect(toast(page, 'Creator page saved.')).toBeVisible();
  const saved = await shop.must('GET', '/creator-page');
  expect([saved.slug, saved.enabled, saved.bio]).toEqual(['flow-maker', true, 'Brass, copper and festive finds.']);
  const link = panel(page, 'Your link for the bio');
  await expect(link).toContainText(saved.url);
  expect(new URL(saved.url).pathname).toBe('/flow-maker');
  await expect(link.getByRole('link', { name: 'Open' })).toHaveAttribute('href', saved.url);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await settled(page);
  await expectHealthy(page);
  expect((await shop.open('/flow-maker')).status).toBe(200);
});

test('8.15, K-55, K-58: the lead form is switched on with its wording, a lead shows what they agreed to, and a withdrawal is recorded', async ({ page }) => {
  const other = await addP3Shop(world, { slug: `${SLUG}-none`, name: 'Other Shop' });
  await leadFormOn(other, 'creator', { channels: ['email'] });
  const theirs = await creatorPage(other, { slug: 'other-maker' });
  await submitLead(world, other, `/${theirs.slug}`, { firstName: 'Zoya', email: 'zoya@example.com' });

  await open(page, world, shop.owner, '/leads/form');
  await page.getByRole('button', { name: 'WhatsApp' }).click();
  await page.getByRole('button', { name: 'Write the wording' }).click();
  await expect(toast(page, 'New wording saved.')).toBeVisible();
  await expect(page.getByText(/^Wording 1, for WhatsApp\./)).toBeVisible();
  const creator = page.getByRole('form', { name: 'Creator page' });
  await creator.getByRole('switch').check();
  await creator.getByLabel('Line above the form').fill('Get first look at new drops');
  await creator.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Saved.')).toBeVisible();
  const forms = await shop.must('GET', '/lead-forms');
  expect(forms.items.find((item) => item.surface === 'creator')).toEqual({ surface: 'creator', enabled: true, offerLine: 'Get first look at new drops' });
  await settled(page);
  await expectHealthy(page);

  const mine = await shop.must('GET', '/creator-page');
  const slug = mine.slug || (await creatorPage(shop, { slug: 'flow-leads' })).slug;
  if (!mine.enabled) await shop.must('PATCH', '/creator-page', { enabled: true });
  const sent = await submitLead(world, shop, `/${slug}`, { firstName: 'Asha', phone: '9800000001' });
  expect(sent.landed.status).toBe(200);

  await page.goto(`${world.base}/admin/leads`);
  const leads = page.getByRole('list', { name: 'Leads' });
  await expect(leads.getByRole('listitem')).toHaveCount(1);
  await expect(leads).toContainText('Asha');
  await expect(leads).toContainText('WhatsApp: agreed');
  await expect(leads, 'another business\'s lead is never here').not.toContainText('Zoya');
  await settled(page);
  await expectHealthy(page);

  await page.getByRole('button', { name: 'They withdrew consent: Asha' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record it' }).click();
  await expect(toast(page, 'Recorded. They won’t be contacted.')).toBeVisible();
  await expect(leads).toContainText('WhatsApp: withdrawn');
  await expect(leads).toContainText('Don’t contact');
  await page.getByRole('button', { name: 'Consent withdrawn' }).click();
  await expect(leads.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'May be contacted' }).click();
  await expect(page.getByText('No leads match')).toBeVisible();

  await page.getByRole('button', { name: 'Make file' }).click();
  await expect(toast(page, 'Your file is ready below.')).toBeVisible();
  const files = page.getByRole('list', { name: 'Files' });
  await expect(files.getByRole('listitem').first()).toContainText('Excel file · 1 lead');
  await expect(files.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /^\/[\w/-]+/);
  expect((await shop.audit('leads.downloaded')).length).toBe(1);
  await expectHealthy(page);
});
