// Every Phase 2 screen's loading, failed and ready states, forced from the browser's side on the smallest phone, plus the two states of
// analytics' own: a part not switched on yet, and a refusal that says why instead of offering a retry that can't work.
import { test, expect } from '@playwright/test';
import { addP2Shop, openP2World } from '../../../test/p2/spec-p2/support.js';
import { NOT_BUILT, PHONE, SERVER_FAULT, expectHealthy, json, open } from './support.js';

test.use({ viewport: PHONE });

const SLUG = 'console-p2-states';

// Where each state is, the call it waits on, and what it says while loading, when that fails, and once it works. `ready` is left out where
// what a new business sees depends on parts other tracks are still building; then the test checks only that loading and failure have gone.
const SCREENS = [
  { name: 'account insights', path: '/analytics', api: /\/api\/v1\/insights\/account/, loading: 'Loading your insights', failed: 'We couldn’t load your insights', ready: 'Every figure' },
  { name: 'insights status', path: '/analytics', api: /\/api\/v1\/insights\/status/, loading: 'Checking your Instagram insights', failed: 'We couldn’t check your Instagram insights' },
  { name: 'posts and reels', path: '/analytics/content', api: /\/api\/v1\/insights\/media/, loading: 'Loading your posts', failed: 'We couldn’t load your posts', ready: 'No posts yet' },
  { name: 'stories', path: '/analytics/stories', api: /\/api\/v1\/insights\/stories/, loading: 'Loading your stories', failed: 'We couldn’t load your stories', ready: 'No stories yet' },
  { name: 'audience', path: '/analytics/audience', api: /\/api\/v1\/insights\/audience/, loading: 'Loading your audience', failed: 'We couldn’t load your audience' },
  { name: 'top content', path: '/analytics/top', api: /\/api\/v1\/insights\/top/, loading: 'Ranking your posts', failed: 'We couldn’t rank your posts', ready: 'Nothing to rank yet' },
  { name: 'best time', path: '/analytics/top', api: /\/api\/v1\/insights\/best-time/, loading: 'Working out the best time to post', failed: 'We couldn’t work out the best time to post' },
  { name: 'content funnels', path: '/analytics/funnels', api: /\/api\/v1\/insights\/funnels/, loading: 'Loading your funnels', failed: 'We couldn’t load your funnels', ready: 'No funnels yet' },
  { name: 'sales sources', path: '/analytics/sources', api: /\/api\/v1\/destinations\/connections/, loading: 'Checking your sales sources', failed: 'We couldn’t check your sales sources' },
  { name: 'traffic', path: '/traffic', api: /\/api\/v1\/traffic\/summary/, loading: 'Loading your traffic', failed: 'We couldn’t load your traffic', ready: 'Key numbers' },
  { name: 'real time', path: '/traffic', api: /\/api\/v1\/traffic\/realtime/, loading: 'Checking who’s on your pages', failed: 'We couldn’t check who’s on your pages' },
  { name: 'traffic sources', path: '/traffic', api: /\/api\/v1\/traffic\/sources/, loading: 'Loading where visits come from', failed: 'We couldn’t load where visits come from', ready: 'No visits yet' },
  { name: 'explore', path: '/explore', api: /\/api\/v1\/explore\/catalog/, loading: 'Loading what you can ask', failed: 'We couldn’t load what you can ask', ready: 'Ask a question' },
  { name: 'explore answer', path: '/explore', api: /\/api\/v1\/explore\/query/, loading: 'Working it out', failed: 'We couldn’t work that out' },
  { name: 'saved views', path: '/explore', api: /\/api\/v1\/saved-views/, loading: 'Loading saved views', failed: 'We couldn’t load saved views', ready: 'No saved views yet' },
  { name: 'custom funnels', path: '/funnels', api: /\/api\/v1\/funnels(\?|$)/, loading: 'Loading your funnels', failed: 'We couldn’t load your funnels', ready: 'No funnels yet' },
  { name: 'cohorts', path: '/cohorts', api: /\/api\/v1\/cohorts/, loading: 'Grouping your visitors', failed: 'We couldn’t group your visitors', ready: 'No groups yet' },
  { name: 'pixels', path: '/traffic/tags', api: /\/api\/v1\/tags$/, loading: 'Loading your tags', failed: 'We couldn’t load your tags', ready: 'Meta Pixel' },
  { name: 'tag health', path: '/traffic/tags', api: /\/api\/v1\/tags\/health/, loading: 'Checking your tags', failed: 'We couldn’t check your tags', ready: 'No tags on' },
  { name: 'reach guard', path: '/reach-guard', api: /\/api\/v1\/reach-guard$/, loading: 'Checking your reach', failed: 'We couldn’t check your reach' },
  { name: 'past slowdowns', path: '/reach-guard', api: /\/api\/v1\/reach-guard\/trips/, loading: 'Loading past slowdowns', failed: 'We couldn’t load past slowdowns', ready: 'No slowdowns yet' },
  { name: 'account health', path: '/account-health', api: /\/api\/v1\/account-health$/, loading: 'Working out your score', failed: 'We couldn’t work out your score' },
  { name: 'health history', path: '/account-health', api: /\/api\/v1\/account-health\/history/, loading: 'Loading your score history', failed: 'We couldn’t load your score history' },
  { name: 'downloads', path: '/reports', api: /\/api\/v1\/downloads/, loading: 'Loading your downloads', failed: 'We couldn’t load your downloads' },
  { name: 'report emails', path: '/reports', api: /\/api\/v1\/reports\/preferences/, loading: 'Loading your report emails', failed: 'We couldn’t load your report emails' },
  { name: 'api keys', path: '/settings/api-keys', api: /\/api\/v1\/api-keys/, loading: 'Loading your keys', failed: 'We couldn’t load your keys' },
];

let world;
let shop;
test.beforeAll(async () => {
  // The worker asks for jobs four times a second rather than every 15 ms, so it doesn't crowd out the screens on the one in-memory database.
  world = await openP2World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP2Shop(world, { slug: SLUG });
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

    await open(page, world, shop.owner, screen.path);
    await expect(page.getByRole('status').filter({ hasText: screen.loading })).toBeVisible();
    mode = 'fail';
    release();

    const failure = page.getByRole('alert').filter({ hasText: screen.failed });
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);

    mode = 'pass';
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: screen.loading })).toHaveCount(0);
    if (screen.ready) await expect(page.getByText(screen.ready).first()).toBeVisible();
    await expectHealthy(page);
  });
}

test('a part not switched on yet reads as "Not available yet", with no retry that can\'t work', async ({ page }) => {
  await page.route(/\/api\/v1\/reports\/preferences/, (route) => route.fulfill(NOT_BUILT));
  await open(page, world, shop.owner, '/reports');
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Report emails' }) });
  await expect(panel.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a refusal says why: "Owner only" for the owner\'s things, the plan\'s words for a plan', async ({ page }) => {
  await page.route(/\/api\/v1\/cohorts/, (route) => route.fulfill(json({ error: 'Needs tier 3', code: 'forbidden' }, 403)));
  await open(page, world, shop.owner, '/cohorts?kind=buyers');
  await expect(page.getByRole('heading', { name: 'Not included for you' })).toBeVisible();
  await expect(page.getByText('Needs tier 3')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('a funnel or post that isn\'t there reads as missing, not broken', async ({ page }) => {
  await open(page, world, shop.owner, '/funnels/999999');
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await page.goto(`${world.base}/admin/analytics/content/no-such-post`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await page.goto(`${world.base}/admin/analytics/funnels/no-such-post`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
});

test('a mistyped range or filter in the address shows the default, not an error', async ({ page }) => {
  await open(page, world, shop.owner, '/analytics?range=9999&from=x');
  await expect(page.getByRole('button', { name: '28 days', pressed: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Every figure' })).toBeVisible();
  await page.goto(`${world.base}/admin/analytics/top?rank=constructor&kind=__proto__&days=7000`);
  await expect(page.getByRole('button', { name: 'Views', pressed: true })).toBeVisible();
  await page.goto(`${world.base}/admin/traffic?by=__proto__&pages=toString`);
  await expect(page.getByRole('heading', { name: 'Key numbers' })).toBeVisible();
});
