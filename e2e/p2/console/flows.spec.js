// What a seller does on the Phase 2 screens, in a real browser on a 360px phone, against the real API with the simulators behind it. Where
// a part is still being built elsewhere (reports, downloads, API keys), its answer is stood in for with data the contract's own schema accepts.
import { test, expect } from '@playwright/test';
import { ReachGuardStatus, AccountHealth } from '../../../src/contracts/api/reach-guard.js';
import { ComplianceStatus } from '../../../src/contracts/api/compliance.js';
import { page as pageOf } from '../../../src/contracts/api/common.js';
import { ApiKey, ApiKeyCreated, FunnelResults, ReportDownload } from '../../../src/contracts/api/reports.js';
import { addP2Shop, dayAgo, liveReel, openP2World, shopper, unique } from '../../../test/p2/spec-p2/support.js';
import { PHONE, expectHealthy, json, open, sideways, toast, watch } from './support.js';

test.use({ viewport: PHONE });

const SLUG = 'console-p2-flows';
let world;
let shop;
let manager;

test.beforeAll(async () => {
  // The worker asks for jobs four times a second rather than every 15 ms, so it doesn't crowd out the screens on the one in-memory database.
  world = await openP2World({ defaultTenant: SLUG, overrides: { queuePollMs: 250 } });
  shop = await addP2Shop(world, { slug: SLUG });
  await shop.setCollectingSince(dayAgo(200));
  manager = await shop.addManager();
});
test.afterAll(async () => {
  await world?.close();
});

/** A fixture is only used once the contract's own schema has accepted it, so a stand-in can never drift from the real answer. */
function valid(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`fixture does not match the contract: ${JSON.stringify(parsed.error.issues)}`);
  return value;
}

const thresholds = { reachDropPercent: 60, mediaDropPercent: 50, clearPercent: 80 };
const guardStatus = (changes = {}) => valid(ReachGuardStatus, {
  state: 'tripped', since: new Date().toISOString(), message: 'Reach is down 45% vs your usual. Reach often dips after a holiday, a change in what you post, or fewer posts.',
  settledDays: 28, mediaCounted: 10, baselineReach: 10000, thresholds, trip: null,
  slowMode: { active: true, trigger: 'reach_drop', until: new Date(Date.now() + 86_400_000).toISOString(), canOverride: true, restoring: false }, lastEvaluatedAt: new Date().toISOString(),
  ...changes,
});

test('N-01, N-03, N-36: account insights on a phone: cached days, the last 2 flagged, a gap says No data, and Refresh now says how old they are', async ({ page }) => {
  const days = (n, value) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, value]));
  await shop.seedDays('views', days(28, 2400));
  await shop.seedDays('comments', { 3: 10, 4: null, 5: 7 });
  const problems = watch(page, world);
  await open(page, world, shop.owner, '/analytics');

  await expect(page.getByText('Views (replaces impressions)').first()).toBeVisible();
  await expect(page.getByText(/may still change/).first()).toBeVisible();
  await expect(page.getByText(/Last updated/).first()).toBeVisible();
  await expect(page.getByText('From Instagram/Facebook').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Views \(replaces impressions\)/, pressed: true })).toBeVisible();

  await page.getByRole('button', { name: /^Comments/ }).click();
  await expect(page.getByRole('button', { name: /^Comments/, pressed: true })).toBeVisible();
  const day = page.getByRole('list', { name: 'Comments, day by day' }).getByRole('listitem').filter({ hasText: new RegExp(`^${Number(dayAgo(4).slice(8))} `) }).first();
  await expect(day).toContainText('No data');
  await expect(page.getByText(/Total leaves out \d+ days? with no data/).first()).toBeVisible();

  const refresh = page.getByRole('button', { name: 'Refresh now' });
  await refresh.click();
  await expect(page.locator('.an-message')).not.toBeEmpty();
  await refresh.click();
  await expect(page.locator('.an-message')).toHaveText(/Updated (just now|\d+ min ago)/);
  await expectHealthy(page);
  expect(problems).toEqual([]);
});

test('N-23 on screen: a drop in reach offers the owner an override, only once "override" is typed, and says nothing of shadowbans', async ({ page }) => {
  await page.route(/\/api\/v1\/reach-guard$/, (route) => route.fulfill(json(guardStatus())));
  let sent = null;
  const after = valid(ComplianceStatus, { paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 0, gates: [] });
  await page.route(/\/api\/v1\/compliance\/slow-mode\/override$/, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill(json(after));
  });
  await open(page, world, shop.owner, '/reach-guard');
  await expect(page.getByText(/Reach is down \d+% vs your usual/)).toBeVisible();
  await expect(page.getByText(/shadow.?ban/i)).toHaveCount(0);
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Override slow mode' }).click();
  const dialog = page.getByRole('dialog', { name: 'Override slow mode?' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Confirm override' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox').fill('overide');
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox').fill('Override');
  await expect(confirm).toBeEnabled();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await confirm.click();
  await expect(toast(page, 'Slow mode is off')).toBeVisible();
  expect(sent).toEqual({ confirmation: 'Override' });
  await expect(dialog).toBeHidden();
});

test('PRD 7.6: a trip is a banner on Home, in Reach Guard\'s own words, with the way to it', async ({ page }) => {
  await page.route(/\/api\/v1\/reach-guard$/, (route) => route.fulfill(json(guardStatus())));
  await open(page, world, shop.owner, '');
  await expect(page.getByText(/Reach is down 45% vs your usual/)).toBeVisible();
  await page.getByRole('link', { name: 'Open Reach Guard' }).click();
  await expect(page.getByRole('heading', { name: 'Reach has dropped' })).toBeVisible();
  await page.unroute(/\/api\/v1\/reach-guard$/);
  await page.goto(`${world.base}/admin`);
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Reach Guard' })).toHaveCount(0);
});

test('N-27, N-28: a manager is told the override is the owner\'s, and nobody is offered one when Instagram, not reach, started slow mode', async ({ page }) => {
  await page.route(/\/api\/v1\/reach-guard$/, (route) => route.fulfill(json(guardStatus())));
  await open(page, world, manager, '/reach-guard');
  await expect(page.getByText('Only the owner can override slow mode.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Override/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save thresholds' })).toHaveCount(0);
  await expect(page.getByText(/Owner only\. The owner can change these\./)).toBeVisible();

  await page.unroute(/\/api\/v1\/reach-guard$/);
  await page.route(/\/api\/v1\/reach-guard$/, (route) => route.fulfill(json(guardStatus({ state: 'watch', message: 'Instagram asked Bhava to slow down for a while.', slowMode: { active: true, trigger: 'buc_80002', until: null, canOverride: false, restoring: false } }))));
  await page.context().clearCookies();
  await open(page, world, shop.owner, '/reach-guard');
  await expect(page.getByRole('heading', { name: 'Watching closely' })).toBeVisible();
  await expect(page.getByText('Slow mode can only be overridden when a drop in reach started it.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Override/ })).toHaveCount(0);
});

test('Learning and Permission needed read plainly, with the way to fix the second', async ({ page }) => {
  await open(page, world, shop.owner, '/reach-guard');
  await expect(page.getByRole('heading', { name: 'Learning your usual reach' })).toBeVisible();
  await expect(page.getByText(/of 14 settled days of reach/)).toBeVisible();
  await expectHealthy(page);

  await page.route(/\/api\/v1\/reach-guard$/, (route) => route.fulfill(json(guardStatus({ state: 'permission_needed', message: 'Permission needed. Bhava can’t read your Instagram insights.', slowMode: { active: true, trigger: 'insights_denied', until: null, canOverride: false, restoring: false } }))));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Permission needed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reconnect Instagram' })).toHaveAttribute('href', '/admin/connect');
  await expectHealthy(page);
});

test('N-31 on screen: a score of 0 lists the rejected connection first, with Reconnect Instagram', async ({ page }) => {
  const health = valid(AccountHealth, {
    score: 0, band: 'at_risk', computedAt: new Date().toISOString(),
    deductions: [
      { code: 'usage_75', points: -10, message: 'Instagram’s usage limit was 80% used.', fix: 'Bhava slows down on its own.' },
      { code: 'token_rejected', points: -100, message: 'Instagram no longer accepts this connection, so automations are on hold.', fix: 'Reconnect Instagram' },
    ],
  });
  await page.route(/\/api\/v1\/account-health$/, (route) => route.fulfill(json(health)));
  await open(page, world, shop.owner, '/account-health');
  await expect(page.getByText('0', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('At risk')).toBeVisible();
  const reasons = page.getByRole('list', { name: 'What lowers your score, worst first' }).getByRole('listitem');
  await expect(reasons.first()).toContainText('no longer accepts this connection');
  await expect(page.getByRole('link', { name: 'Reconnect Instagram' })).toBeVisible();
  await expectHealthy(page);
});

test('N-51, N-52, N-54: Explore on a phone: by city, leaving out direct visits, saved, pinned, and on Home', async ({ page }) => {
  await shop.seedSessions([{ count: 30, source: 'bio_link', city: 'Pune' }, { count: 20, source: 'whatsapp', city: 'Mumbai' }, { count: 5, source: 'direct', city: 'Pune' }]);
  const name = `Cities ${unique()}`;
  await open(page, world, shop.owner, '/explore');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row', { name: /Bio link/ })).toBeVisible();

  await page.getByLabel('Break down by', { exact: true }).selectOption('city');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByLabel('Keep or leave out').selectOption('exclude');
  await page.getByLabel('Value').selectOption('direct');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const pune = page.getByRole('row', { name: /^Pune/ });
  await expect(pune).toContainText('30');
  await expect(page.getByRole('row', { name: /^Mumbai/ })).toContainText('20');
  await expect(page.locator('tfoot')).toContainText('50');
  await expect(page.getByRole('columnheader', { name: /Sessions/ })).toContainText('Measured by Bhava');
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Save view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save this view' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(toast(page, 'View saved.')).toBeVisible();
  await page.getByRole('button', { name: `Pin ${name} to Home` }).click();
  await expect(toast(page, 'Pinned to Home.')).toBeVisible();

  await page.goto(`${world.base}/admin`);
  const pinned = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pinned views' }) });
  await expect(pinned.getByRole('heading', { name })).toBeVisible();
  await expect(pinned.getByRole('row', { name: /^Pune/ })).toContainText('30');
  await expectHealthy(page);
});

test('PRD 7.12: a funnel built on the phone opens with its steps, and a step the plan leaves out says Needs tier 3', async ({ page }) => {
  const name = `Path ${unique()}`;
  await open(page, world, shop.owner, '/funnels');
  await page.getByRole('link', { name: 'New funnel' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Add a step' }).click();
  await expect(page.getByLabel('Step 3', { exact: true })).toHaveValue('add_to_cart');
  await page.getByRole('button', { name: 'Save funnel' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('1. Landing page view')).toBeVisible();
  await expect(page.getByText('3. Add to cart')).toBeVisible();
  await expectHealthy(page);

  const id = Number(new URL(page.url()).pathname.split('/').at(-1));
  const results = valid(FunnelResults, {
    funnelId: id, countBy: 'session', source: 'bhava', lastUpdatedAt: new Date().toISOString(), breakdown: [],
    steps: [
      { kind: 'landing_view', count: 200, stepRate: null, dropOff: null, previous: null, unavailable: false, message: null },
      { kind: 'product_tap', count: 90, stepRate: 0.45, dropOff: 110, previous: null, unavailable: false, message: null },
      { kind: 'add_to_cart', count: 0, stepRate: null, dropOff: null, previous: null, unavailable: true, message: 'Needs tier 3' },
    ],
  });
  await page.route(/\/api\/v1\/funnels\/\d+\/results/, (route) => route.fulfill(json(results)));
  await page.reload();
  await expect(page.getByText('Needs tier 3')).toBeVisible();
  await expect(page.getByText('45% of the step before, 110 dropped off')).toBeVisible();
});

test('N-14: a one-tap Amazon reel\'s funnel says why a step is empty, and labels each step', async ({ page }) => {
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap' });
  await shop.seedFunnel(auto.mediaId, { comments: 25, dms: 24, linkType: 'amazon', linkMode: 'one_tap' });
  await shop.settle();
  await open(page, world, shop.owner, `/analytics/funnels/${auto.mediaId}`);
  await expect(page.getByText('Measured by Bhava').first()).toBeVisible();
  await expect(page.getByText('not available for this link type').first()).toBeVisible();
  await expect(page.getByText(/Amazon, one tap/)).toBeVisible();
  await expect(page.getByText('96% of comments')).toBeVisible();
  await expectHealthy(page);
});

test('N-48: the real-time panel counts the shoppers on the site now', async ({ page }) => {
  for (let i = 0; i < 3; i++) await shopper(world, shop).send({ name: 'landing_view', path: '/r/launch', pageKind: 'landing', pageRef: 'launch', src: 'bio_link' });
  await open(page, world, shop.owner, '/traffic');
  const now = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Right now' }) });
  await expect(now.locator('.an-score-number')).toHaveText(/^[1-9]\d*$/, { timeout: 20_000 });
  await expect(now.getByText(/on your pages in the last 30 minutes/)).toBeVisible();
  await expectHealthy(page);
});

test('PRD 7.14: the owner turns on a Meta Pixel; the token is kept and never shown back', async ({ page }) => {
  await open(page, world, shop.owner, '/traffic/tags');
  await page.getByRole('switch', { name: 'Use my Meta Pixel' }).check({ force: true });
  await page.getByLabel('Pixel ID').fill('12ab');
  await page.getByRole('button', { name: 'Save tags' }).click();
  await expect(page.getByText('Enter the Pixel ID: 5 to 20 digits')).toBeVisible();
  await page.getByLabel('Pixel ID').fill('123456789');
  await page.getByLabel('Conversions API token').fill('token-1234567890');
  await page.getByRole('button', { name: 'Save tags' }).click();
  await expect(toast(page, 'Tags saved.')).toBeVisible();
  await expect(page.getByLabel('Conversions API token')).toHaveValue('');
  await expect(page.getByText('A token is saved. Paste a new one only to replace it.')).toBeVisible();
  expect(await page.content()).not.toContain('token-1234567890');
  await expectHealthy(page);
});

test('N-63 and 7.14: a manager meets "Owner only" on API keys and pixels, with nothing to press', async ({ page }) => {
  await open(page, world, manager, '/settings/api-keys');
  await expect(page.getByRole('heading', { name: 'Owner only' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create|New key/i })).toHaveCount(0);
  await page.goto(`${world.base}/admin/traffic/tags`);
  await expect(page.getByRole('heading', { name: 'Owner only' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save tags' })).toHaveCount(0);
  await expectHealthy(page);
});

test('PRD 7.13: the owner makes a key and sees it once, with a way to copy it', async ({ page }) => {
  const created = valid(ApiKeyCreated, { id: 4, name: 'Sheets', prefix: 'bhv_ab12', scope: 'analytics:read', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, key: 'bhv_ab12cd34ef56gh78ij90' });
  const list = valid(pageOf(ApiKey), { items: [{ ...created, key: undefined }].map(({ key, ...rest }) => rest), nextCursor: null });
  let body = null;
  await page.route(/\/api\/v1\/api-keys(\?|$)/, (route) => {
    if (route.request().method() === 'POST') {
      body = route.request().postDataJSON();
      return route.fulfill(json(created, 201));
    }
    return route.fulfill(json(list));
  });
  await open(page, world, shop.owner, '/settings/api-keys');
  await page.getByLabel('Name').fill('Sheets');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText(created.key)).toBeVisible();
  await expect(page.getByText(/won’t be shown again/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy key' })).toBeVisible();
  expect(body).toEqual({ name: 'Sheets' });
  await expectHealthy(page);
  await page.getByRole('button', { name: 'I’ve copied it' }).click();
  await expect(page.getByText(created.key)).toHaveCount(0);
  await expect(page.getByText('bhv_ab12…', { exact: false })).toBeVisible();
});

test('N-81: Reports offers summary files in CSV and Excel and no raw event log; a ready file opens from this site', async ({ page }) => {
  const ready = valid(ReportDownload, { id: 77, source: 'account_daily', format: 'csv', status: 'ready', background: false, rowCount: 28, fileUrl: '/report-files/77', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  let asked = null;
  await page.route(/\/api\/v1\/downloads$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    asked = route.request().postDataJSON();
    return route.fulfill(json(ready, 201));
  });
  await open(page, world, shop.owner, '/reports');
  await expect(page.getByText(/raw event/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Excel' }).first()).toBeVisible();
  await page.getByRole('group', { name: 'Download Account figures by day' }).getByRole('button', { name: 'CSV' }).click();
  await expect(page.getByRole('link', { name: 'Open the CSV file' })).toHaveAttribute('href', '/report-files/77');
  expect(asked).toMatchObject({ source: 'account_daily', format: 'csv' });
  expect(asked.from <= asked.to).toBe(true);
  await expectHealthy(page);
});

test('every Phase 2 screen fits a 360px phone without sideways scrolling', async ({ page }) => {
  await open(page, world, shop.owner, '/analytics');
  for (const path of ['/analytics', '/analytics/content', '/analytics/stories', '/analytics/audience', '/analytics/top', '/analytics/funnels', '/analytics/sources', '/traffic', '/explore', '/funnels', '/cohorts', '/traffic/tags', '/reach-guard', '/account-health', '/reports', '/reports/scheduled', '/settings/api-keys']) {
    await page.goto(`${world.base}/admin${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.spinner')).toHaveCount(0, { timeout: 15_000 });
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }
});
