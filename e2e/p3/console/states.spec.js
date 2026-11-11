// Every Phase 3 console screen's loading, failed and ready states, forced from the browser's side on the smallest phone, plus the states
// of Phase 3's own: a feature the plan lacks, a part not switched on yet, a thing that isn't there, and what only a manager may open.
import { test, expect } from '@playwright/test';
import { addStaff } from '../../../test/p0/spec-p0/support.js';
import { addP3Shop, openP3World } from '../../../test/p3/spec-p3/kit.js';
import { NOT_BUILT, PHONE, SERVER_FAULT, callsDuring, expectHealthy, open, ownWorker, planRefusal, settled } from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P3ConsoleStates') });

const SLUG = 'console-p3-states';

let world;
let shop;
let category;

// Where each state is, the call it waits on, and what it says while loading, when that fails, and once it works for a business with nothing yet.
const SCREENS = [
  { name: 'catalog', path: '/catalog', api: /\/api\/v1\/products(\?|$)/, loading: 'Loading your catalog', failed: 'We couldn’t load your catalog', ready: 'Your catalog is empty' },
  { name: 're-checks', path: '/catalog/settings', api: /\/api\/v1\/catalog\/settings$/, loading: 'Loading your re-check settings', failed: 'We couldn’t load your re-check settings', ready: 'Nothing needs attention' },
  { name: 'imports', path: '/imports', api: /\/api\/v1\/imports(\?|$)/, loading: 'Loading your imports', failed: 'We couldn’t load your imports', ready: 'No imports yet' },
  { name: 'landing pages', path: '/pages', api: /\/api\/v1\/pages(\?|$)/, loading: 'Loading your pages', failed: 'We couldn’t load your pages', ready: 'No landing pages yet' },
  { name: 'posts to make a page for', path: '/pages/new', api: /\/api\/v1\/page-media/, loading: 'Loading your posts', failed: 'We couldn’t load your posts', ready: 'No posts found' },
  { name: 'page settings', path: '/pages/settings', api: /\/api\/v1\/page-settings$/, loading: 'Loading your page settings', failed: 'We couldn’t load your page settings', ready: 'Order on WhatsApp' },
  { name: 'page layout', path: '/pages/layout', api: /\/api\/v1\/page-blocks/, loading: 'Loading this layout', failed: 'We couldn’t load this layout', ready: 'This is the standard layout' },
  { name: 'shop look', path: '/look', api: /\/api\/v1\/theme$/, loading: 'Loading your look', failed: 'We couldn’t load your look', ready: 'Pick a look made for what you sell' },
  { name: 'the looks', path: '/look', api: /\/api\/v1\/theme\/presets$/, loading: 'Loading the looks', failed: 'We couldn’t load the looks', ready: 'How shoppers see it' },
  { name: 'website reads', path: '/look', api: /\/api\/v1\/theme\/site-reads/, loading: 'Loading what we read before', failed: 'We couldn’t load what we read before', ready: 'No website read yet' },
  { name: 'categories', path: '/categories', api: /\/api\/v1\/categories(\?|$)/, loading: 'Loading your categories', failed: 'We couldn’t load your categories', ready: 'Festive' },
  { name: 'reel order', path: () => `/categories/${category.id}/reels`, api: /\/api\/v1\/categories\/\d+\/reels$/, loading: 'Loading the reel order', failed: 'We couldn’t load the reel order', ready: 'No reels in this category yet' },
  { name: 'auto-join rules', path: () => `/categories/${category.id}/reels`, api: /\/api\/v1\/categories\/\d+\/rules$/, loading: 'Loading the rules', failed: 'We couldn’t load the rules', ready: 'No rules yet' },
  { name: 'creator page', path: '/creator-page', api: /\/api\/v1\/creator-page$/, loading: 'Loading your creator page', failed: 'We couldn’t load your creator page', ready: 'Choose a name below' },
  { name: 'creator shelves', path: '/creator-page', api: /\/api\/v1\/categories(\?|$)/, loading: 'Loading your categories', failed: 'We couldn’t load your categories', ready: 'Festive' },
  { name: 'leads', path: '/leads', api: /\/api\/v1\/leads(\?|$)/, loading: 'Loading your leads', failed: 'We couldn’t load your leads', ready: 'No leads yet' },
  { name: 'lead files', path: '/leads', api: /\/api\/v1\/lead-downloads/, loading: 'Loading your files', failed: 'We couldn’t load your files', ready: 'No files yet' },
  { name: 'lead form', path: '/leads/form', api: /\/api\/v1\/lead-forms$/, loading: 'Loading your lead form', failed: 'We couldn’t load your lead form', ready: 'What shoppers agree to' },
];

test.beforeAll(async () => {
  // The worker asks for jobs four times a second rather than every 15 ms, so it doesn't crowd out the screens on the one in-memory database.
  world = await openP3World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP3Shop(world, { slug: SLUG });
  category = await shop.category('Festive');
});
test.afterAll(async () => {
  await world?.close();
});

for (const screen of SCREENS) {
  test(`${screen.name}: loading, then a way back from a failure, then ready`, async ({ page }) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let mode = 'hold';
    await page.route(screen.api, async (route) => {
      if (mode === 'hold') await held;
      if (mode === 'fail') return route.fulfill(SERVER_FAULT);
      return route.continue();
    });

    await open(page, world, shop.owner, typeof screen.path === 'function' ? screen.path() : screen.path);
    await expect(page.getByRole('status').filter({ hasText: screen.loading }).first()).toBeVisible();
    mode = 'fail';
    release();

    const failure = page.getByRole('alert').filter({ hasText: screen.failed }).first();
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);

    mode = 'pass';
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: screen.loading })).toHaveCount(0);
    await expect(page.getByText(screen.ready).first()).toBeVisible();
    await settled(page);
    await expectHealthy(page);
  });
}

test('a feature the plan lacks reads as that, with the server\'s words and no retry that can\'t work', async ({ page }) => {
  await page.route(/\/api\/v1\/categories\/\d+\/reels$/, (route) => route.fulfill(planRefusal('Reel order isn’t on your plan.')));
  await open(page, world, shop.owner, `/categories/${category.id}/reels`);
  await expect(page.getByRole('heading', { name: 'This isn’t on your plan' })).toBeVisible();
  await expect(page.getByText('Reel order isn’t on your plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectHealthy(page);
});

test('a part not switched on yet says so, and offers no retry', async ({ page }) => {
  await page.route(/\/api\/v1\/theme\/site-reads/, (route) => route.fulfill(NOT_BUILT));
  await open(page, world, shop.owner, '/look');
  await expect(page.getByRole('heading', { name: 'This isn’t switched on yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByText('Pick a look made for what you sell')).toBeVisible();
});

test('a product, page, import or category that isn\'t there reads as missing, not broken', async ({ page }) => {
  await open(page, world, shop.owner, '/catalog/999999');
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  for (const path of ['/pages/999999', '/imports/999999', '/categories/999999/reels']) {
    await page.goto(`${world.base}/admin${path}`);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
});

test('a mistyped filter in the address shows the default list, not an error', async ({ page }) => {
  await open(page, world, shop.owner, '/catalog?status=nonsense&source=elsewhere&category=abc');
  await expect(page.getByRole('button', { name: 'All', exact: true, pressed: true })).toBeVisible();
  await expect(page.getByText('Your catalog is empty')).toBeVisible();
  await page.goto(`${world.base}/admin/leads?source=nowhere&consent=maybe`);
  await expect(page.getByText('No leads yet')).toBeVisible();
  await page.goto(`${world.base}/admin/pages/layout?surface=moon`);
  await expect(page.getByRole('button', { name: 'Reel and post pages', pressed: true })).toBeVisible();
});

test('staff with the catalog permission see the catalog screens, and are neither shown nor sent a manager\'s settings', async ({ page }) => {
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  await open(page, world, staff, '/pages');
  await expect(page.getByText('No landing pages yet')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Landing page settings' })).toHaveCount(0);

  for (const path of ['/pages/settings', '/pages/layout']) {
    const calls = await callsDuring(page, async () => {
      await page.goto(`${world.base}/admin${path}`);
      await expect(page.getByRole('heading', { name: 'Only the owner or a manager can change this' })).toBeVisible();
    });
    expect(calls.filter((call) => /page-settings|page-blocks/.test(call))).toEqual([]);
  }
  // The look, the creator page and leads are not theirs to open at all.
  for (const path of ['/look', '/creator-page', '/leads', '/leads/form']) {
    const calls = await callsDuring(page, async () => {
      await page.goto(`${world.base}/admin${path}`);
      await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    });
    expect(calls.filter((call) => /\/(theme|creator-page|leads|lead-forms|lead-downloads)/.test(call)), path).toEqual([]);
  }
});

test('staff who may read leads see them, without the form, the files or the delete button', async ({ page }) => {
  const staff = await addStaff(world, shop, { permissions: ['customers'] });
  const calls = await callsDuring(page, async () => {
    await open(page, world, staff, '/leads');
    await expect(page.getByText('No leads yet')).toBeVisible();
  });
  await expect(page.getByRole('heading', { name: 'Download your leads' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Leads pages' })).toHaveCount(0);
  expect(calls.filter((call) => /lead-downloads|lead-forms/.test(call))).toEqual([]);
});
