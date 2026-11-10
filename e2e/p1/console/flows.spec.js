// What a seller does on the Phase 1 screens, on the smallest phone, on the real API with the Meta simulator behind it.
import { test, expect } from '@playwright/test';
import { HOUR, MINUTE, SCOPES, addShop, addStaff, openWorld, savePublicReplies } from '../../../test/p1/spec-p1/support.js';
import { PHONE, SLUG, dialogButton, expectHealthy, open, toast } from './support.js';

test.use({ viewport: PHONE });

let world;
let shop;

test.beforeEach(async () => {
  world = await openWorld({ defaultTenant: SLUG });
});
test.afterEach(async () => {
  await world?.close();
});

const setUp = async (options = {}) => {
  shop = await addShop(world, { slug: SLUG, ...options });
  return shop;
};
const signIn = (page, path) => open(page, world, shop.owner, path);
const stateBadge = (page, label) => page.locator('.page-header').getByText(label, { exact: true });

/** A DM's webhook carries no username, and nothing fills one in yet, so these screens are given the name they would show. */
async function nameThePerson(person) {
  await shop.sql('UPDATE inbox_threads SET username = $2 WHERE tenant_id = $1', [shop.tenantId, person.username]);
  await shop.sql('UPDATE needs_human_items SET username = $2 WHERE tenant_id = $1', [shop.tenantId, person.username]);
}

async function fillBuilder(page, { caption, keyword = 'spice', message = 'Hi! Here is the box.' }) {
  await page.getByRole('button', { name: `Reel: ${caption}` }).click();
  await page.getByLabel('Add a keyword').fill(keyword);
  await page.getByLabel('Add a keyword').press('Enter');
  await page.getByLabel('Message, variant A').fill(message);
  await page.getByLabel('Link', { exact: true }).fill(shop.siteUrl('/p/spice-box'));
}

test('a seller builds an automation, tests it and takes it live', async ({ page }) => {
  await setUp();
  await shop.reel({ caption: 'Diwali spice box' });
  await signIn(page, '/automations');
  await expect(page.getByRole('heading', { name: 'No automations yet' })).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('link', { name: 'New automation' }).click();
  await expect(page.getByRole('button', { name: 'Reel: Diwali spice box' })).toBeVisible();
  await expectHealthy(page);
  await fillBuilder(page, { caption: 'Diwali spice box' });
  await expect(page.getByLabel('Name')).toHaveValue('Diwali spice box');
  await expect(page.locator('.keyword-list').getByText('spice')).toBeVisible();
  await expect(page.locator('.dm-text').first()).toHaveText('Hi! Here is the box.');
  await expectHealthy(page);

  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/automations\/\d+$/);
  await expect(stateBadge(page, 'Draft')).toBeVisible();
  const id = page.url().split('/').pop();
  const saved = await shop.call(`/automations/${id}`, 200);
  expect(saved).toMatchObject({ state: 'draft', keywords: ['spice'], linkMode: 'two_tap', publicReplyEnabled: false });
  expect(saved.triggers.map((t) => t.targetType)).toEqual(['reel']);

  await page.getByRole('button', { name: 'Start testing' }).click();
  await expect(stateBadge(page, 'Test')).toBeVisible();

  await page.getByRole('button', { name: 'Go live' }).click();
  await dialogButton(page, 'Go live').click();
  await expect(stateBadge(page, 'Live')).toBeVisible();
  expect((await shop.call(`/automations/${id}`, 200)).state).toBe('live');

  await page.getByRole('link', { name: 'DM automations' }).first().click();
  await expect(page.getByRole('link', { name: /Diwali spice box/ })).toBeVisible();
  await expectHealthy(page);
});

test('a second Save updates the same automation; it never makes another', async ({ page }) => {
  await setUp();
  await shop.reel({ caption: 'Only once' });
  await signIn(page, '/automations/new');
  await fillBuilder(page, { caption: 'Only once' });
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/automations\/\d+$/);
  await page.getByLabel('Name').fill('Renamed');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(toast(page, 'Saved.')).toBeVisible();
  const { items } = await shop.call('/automations', 200);
  expect(items.map((a) => a.name)).toEqual(['Renamed']);
});

test('the builder keeps its schedule, variants and follow-up across a reload', async ({ page }) => {
  await setUp();
  await shop.reel({ caption: 'Schedule me' });
  await signIn(page, '/automations/new');
  await fillBuilder(page, { caption: 'Schedule me' });
  await page.getByRole('button', { name: 'Add a variant' }).click();
  await page.getByLabel('Message, variant B').fill('Second wording.');
  await page.getByLabel('Daily from').fill('09:00');
  await page.getByLabel('Daily until').fill('21:00');
  await page.getByLabel('Starts').fill('2030-01-05T10:30');
  await page.getByRole('switch', { name: 'Send a follow-up' }).check();
  await page.getByLabel('Follow-up text').fill('Still keen?');
  await expect(page.getByText('Add a second version')).toHaveCount(0);
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/automations\/\d+$/);

  await page.reload();
  await expect(page.getByLabel('Daily from')).toHaveValue('09:00');
  await expect(page.getByLabel('Starts')).toHaveValue('2030-01-05T10:30');
  await expect(page.getByLabel('Follow-up text')).toHaveValue('Still keen?');
  await page.getByRole('button', { name: 'Variant B', exact: true }).click();
  await expect(page.getByLabel('Message, variant B')).toHaveValue('Second wording.');
  await expectHealthy(page);
});

test('the builder says what is wrong, once each', async ({ page }) => {
  await setUp();
  await shop.reel({ caption: 'Rules' });
  await signIn(page, '/automations/new');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Add at least one keyword')).toBeVisible();
  await expect(page.getByText('Give this automation a name')).toBeVisible();
  await expect(page.getByText('Write the message')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Please check the highlighted details.' })).toBeVisible();

  await page.getByLabel(/Public repl/i).check();
  await expect(page.getByText('Add at least 5 replies')).toBeVisible();

  await page.getByLabel('Message, variant A').fill('भ'.repeat(400));
  await expect(page.getByText('1,200 / 1,000 bytes')).toBeVisible();
  await expect(page.getByText('Keep the message to 1000 bytes')).toBeVisible();

  await page.getByLabel('Message, variant A').fill('Hi {first_name}, your link.');
  await expect(page.locator('.dm-text').first()).toHaveText('Hi Asha, your link.');
  await expect(page.getByText('If we don’t have their name: Hi, your link.')).toBeVisible();
  await expect(page.getByText(/\{first_name\}/)).toHaveCount(0);
  await expectHealthy(page);
});

test('C-31: with 5 public replies in the brand kit the toggle is simply on', async ({ page }) => {
  await setUp();
  await savePublicReplies(shop, 5);
  await shop.reel();
  await signIn(page, '/automations/new');
  await expect(page.getByRole('button', { name: /^Reel/ })).toBeVisible();
  await page.getByLabel(/Public repl/i).check();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Add at least 5 replies')).toHaveCount(0);
});

test('A-36: on Free, one tap stays off with the reason; a paid plan can pick it', async ({ page }) => {
  await setUp({ plan: 'free' });
  await shop.reel();
  await signIn(page, '/automations/new');
  await page.getByRole('button', { name: /One tap/ }).click();
  await expect(page.getByText('One tap needs a paid plan')).toBeVisible();
  await expect(page.getByRole('button', { name: /Two taps/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /One tap/ })).toHaveAttribute('aria-pressed', 'false');
});

test('A-36: a paid plan can pick one tap, and the second-message fields go away', async ({ page }) => {
  await setUp();
  await shop.reel();
  await signIn(page, '/automations/new');
  await expect(page.getByLabel('First button')).toBeVisible();
  await page.getByRole('button', { name: /One tap/ }).click();
  await expect(page.getByRole('button', { name: /One tap/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('First button')).toHaveCount(0);
  await expect(page.getByLabel('Button text')).toBeVisible();
});

test('A-48: an expired token offers one reconnect, and doesn\'t crash', async ({ page }) => {
  await setUp();
  await shop.reel();
  await world.meta.post('/tokens/expire', { token: shop.igToken });
  await signIn(page, '/automations/new');
  await expect(page.getByText('Reconnect Instagram')).toBeVisible();
  await expect(page.getByText('Reconnect Instagram')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Save/ })).toBeVisible();
  await expectHealthy(page);
});

test('testers: a code to DM, and a tester with a window can get the test', async ({ page }) => {
  await setUp();
  const automation = await shop.automate({ state: 'test' });
  await signIn(page, `/automations/${automation.id}`);
  await expect(page.getByRole('heading', { name: 'No testers yet' })).toBeVisible();
  await page.getByLabel('Who is testing? (optional)').fill('Asha');
  await page.getByRole('button', { name: 'Add tester' }).click();
  const code = (await page.locator('.tester-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expectHealthy(page);

  await shop.dm(world.fan(), code);
  await shop.settle();
  await page.reload();
  await expect(page.getByText('Can get a test now')).toBeVisible();
  await page.getByRole('button', { name: 'Send test to me' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Sent/ })).toBeVisible();
});

test('pause everything, then resume', async ({ page }) => {
  await setUp();
  await signIn(page, '/compliance');
  await expect(page.getByRole('heading', { name: 'Sending normally' })).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Pause everything' }).click();
  await expect(page.getByRole('dialog').getByText('Your store stays open.')).toBeVisible();
  await dialogButton(page, 'Keep it').click();
  expect((await shop.call('/compliance/status', 200)).paused).toBe(false);

  await page.getByRole('button', { name: 'Pause everything' }).click();
  await dialogButton(page, 'Pause everything').click();
  await expect(page.getByRole('heading', { name: 'You paused sending' })).toBeVisible();
  expect((await shop.call('/compliance/status', 200))).toMatchObject({ paused: true, pausedBy: 'owner', pauseStore: false });
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Resume sending' }).click();
  await expect(page.getByRole('heading', { name: 'Sending normally' })).toBeVisible();
  expect((await shop.call('/compliance/status', 200)).paused).toBe(false);
});

test('the kill switch can close the store too', async ({ page }) => {
  await setUp();
  await signIn(page, '/compliance');
  await page.getByRole('switch', { name: 'Also close my store to buyers' }).check();
  await page.getByRole('button', { name: 'Pause everything' }).click();
  await expect(page.getByRole('dialog').getByText('closed to buyers')).toBeVisible();
  await dialogButton(page, 'Pause everything').click();
  await expect(page.getByText('Messages have stopped and your store is closed to buyers.')).toBeVisible();
  expect((await shop.call('/compliance/status', 200)).pauseStore).toBe(true);
});

test('C-43: a pause by support tells the owner so, on Home and on the compliance screen, with no resume', async ({ page }) => {
  await setUp();
  await shop.sql(`UPDATE compliance_settings SET paused = true, paused_by = 'ops', paused_at = now() WHERE tenant_id = $1`, [shop.tenantId]);
  await signIn(page, '');
  await expect(page.getByText('Paused by support. Contact support.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume/i })).toHaveCount(0);
  await expectHealthy(page);

  await page.goto(`${world.base}/admin/compliance`);
  await expect(page.getByText('Paused by support. Contact support.')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Resume/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause everything' })).toHaveCount(0);
});

test('C-54: Home says slow mode is on and offers a reconnect when insights are denied', async ({ page }) => {
  await setUp({ scopes: [SCOPES.basic, SCOPES.messages, SCOPES.comments] });
  await signIn(page, '');
  await expect(page.getByText(/slow mode/i).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reconnect Instagram' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Reconnect Instagram' }).click();
  await expect(page).toHaveURL(/\/admin\/connect$/);
  await expect(page.getByText('Permission needed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Instagram' })).toBeVisible();
  await expectHealthy(page);
});

test('a healthy business sees no banner on Home', async ({ page }) => {
  await setUp();
  await signIn(page, '');
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('A-41: the log explains a capped comment, filters, and links to "Why no DM?"', async ({ page }) => {
  await setUp();
  const automation = await shop.automate();
  const from = world.fan();
  await shop.comment(automation.mediaId, { from });
  const capped = await shop.comment(automation.mediaId, { from });
  await shop.settle();

  await signIn(page, '/compliance/log');
  await expect(page.locator('.list-row-title').getByText('This person was already sent a DM for this post.')).toBeVisible();
  await expect(page.locator('.log-code').getByText('cap.per_media')).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Skipped', exact: true }).click();
  await expect(page).toHaveURL(/outcome=skipped/);
  await expect(page.locator('.list-row-title').getByText('This person was already sent a DM for this post.')).toBeVisible();
  await expect(page.locator('.list-row .badge').getByText('Sent', { exact: true })).toHaveCount(0);

  await page.goto(`${world.base}/admin/inbox/why-no-dm?commentId=${capped.id}`);
  await expect(page.getByText('This person already got a DM for this post.')).toBeVisible();
  await expect(page.getByText('cap.per_media')).toBeVisible();
  await expect(page.getByLabel('Comment ID')).toHaveValue(capped.id);
  await expectHealthy(page);
});

test('rules: dry run and a lower limit save; a higher limit is refused; a word can be added and removed', async ({ page }) => {
  await setUp();
  await signIn(page, '/compliance/settings');
  await page.getByRole('switch', { name: 'Dry run for the whole business' }).check();
  await page.getByLabel('DMs per person per day').fill('9');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('This can only be lowered. The most it can be is 3.')).toBeVisible();

  await page.getByLabel('DMs per person per day').fill('2');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(toast(page, 'Saved.')).toBeVisible();
  expect(await shop.call('/compliance/settings', 200)).toMatchObject({ dryRun: true, capOverrides: { 'cap.per_person_24h': 2 } });

  await page.getByLabel('Add a word').fill('nahi chahiye');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.keyword').getByText('nahi chahiye')).toBeVisible();
  await page.getByRole('button', { name: 'Remove nahi chahiye' }).click();
  await expect(page.locator('.keyword').getByText('nahi chahiye')).toHaveCount(0);
  await expectHealthy(page);
});

test('the inbox: open a chat, reply, see it paused, and clear Needs a human', async ({ page }) => {
  await setUp();
  const person = world.fan();
  await shop.dm(person, 'human');
  await shop.settle();
  await nameThePerson(person);
  await signIn(page, '/inbox');
  await expect(page.getByText(person.username)).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('link', { name: 'Needs a human' }).click();
  await expect(page.getByText(person.username)).toBeVisible();
  await expect(page.getByText('Asked for a person')).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('link', { name: 'Open chat' }).click();
  await expect(page.getByRole('heading', { name: `@${person.username}` })).toBeVisible();
  await page.getByLabel('Your reply').fill('I am here, how can I help?');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.locator('.bubble-out').getByText('I am here, how can I help?')).toBeVisible();
  await expect(page.getByText(/automation is paused here until/)).toBeVisible();
  await expect(page.getByLabel('Your reply')).toHaveValue('');
  await expectHealthy(page);

  await page.goto(`${world.base}/admin/inbox/needs-human`);
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(person.username)).toBeVisible();
});

test('A-39: after 23h55m the composer gives way, and a message is shown as text', async ({ page }) => {
  await setUp();
  const person = world.fan();
  await shop.dm(person, '<img src=x onerror="window.__xss=1">');
  await shop.settle();
  await nameThePerson(person);
  await world.travel(23 * HOUR + 55 * MINUTE);
  await signIn(page, '/inbox');
  await page.getByText(person.username).click();
  await expect(page.locator('.bubble-text').getByText('<img src=x onerror=')).toBeVisible();
  await expect(page.getByText('Reply in the Instagram app')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/i })).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expectHealthy(page);
});

test('connect: not connected starts Meta\'s login and comes back to this screen', async ({ page }) => {
  await setUp({ igConnected: false });
  await signIn(page, '/connect');
  await expect(page.getByRole('heading', { name: 'No account connected' })).toBeVisible();
  await expect(page.getByText('We never ask for your Instagram password.')).toBeVisible();
  await expectHealthy(page);

  let asked;
  await page.route(/\/api\/v1\/instagram\/connect$/, (route) => {
    asked = route.request().postDataJSON();
    return route.fulfill({ json: { authorizeUrl: `${world.base}/admin/connect?instagram=connected` } });
  });
  await page.getByRole('button', { name: 'Connect Instagram' }).click();
  await expect(page).toHaveURL(/instagram=connected/);
  expect(asked).toEqual({ returnTo: '/admin/connect' });
  await expect(page.getByText('Instagram is connected.')).toBeVisible();
});

test('connect: a lost connection offers reconnect; a healthy one offers disconnect', async ({ page }) => {
  await setUp();
  await signIn(page, '/connect');
  await expect(page.getByRole('heading', { name: `@${shop.slug}_ig` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Instagram' })).toHaveCount(0);
  await expectHealthy(page);

  await shop.sql(`UPDATE ig_accounts SET status = 'reconnect_needed' WHERE tenant_id = $1`, [shop.tenantId]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reconnect Instagram' })).toBeVisible();
  await expect(page.getByText('Needs reconnecting')).toBeVisible();
  await expectHealthy(page);

  await shop.sql(`UPDATE ig_accounts SET status = 'active' WHERE tenant_id = $1`, [shop.tenantId]);
  await page.reload();
  await page.getByRole('button', { name: 'Disconnect Instagram' }).click();
  await dialogButton(page, 'Disconnect').click();
  await expect(page.getByRole('heading', { name: 'No account connected' })).toBeVisible();
});

test('staff with only the inbox get the inbox, and none of the rest', async ({ page }) => {
  await setUp();
  const staff = await addStaff(world, shop, { permissions: ['inbox'] });
  await open(page, world, staff, '/inbox');
  await expect(page.getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  await expect(page.locator('.notice')).toHaveCount(0);
  await page.goto(`${world.base}/admin/compliance`);
  await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
  await page.goto(`${world.base}/admin/automations`);
  await expect(page.getByRole('heading', { name: 'You don’t have access to this' })).toBeVisible();
});

test('staff who can see automations can\'t reach the switches', async ({ page }) => {
  await setUp();
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  await open(page, world, staff, '/compliance');
  await expect(page.getByRole('heading', { name: 'Sending normally' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause everything' })).toHaveCount(0);
  await expect(page.getByText('Only the owner or a manager can change this.')).toBeVisible();
  await page.goto(`${world.base}/admin/connect`);
  await expect(page.getByRole('button', { name: 'Disconnect Instagram' })).toHaveCount(0);
});

test('every Phase 1 screen is in the menu', async ({ page }) => {
  await setUp();
  await signIn(page, '');
  await page.getByRole('button', { name: 'More' }).click();
  for (const name of ['DM automations', 'Inbox', 'Compliance', 'Instagram']) await expect(page.getByRole('dialog').getByRole('link', { name, exact: true })).toBeVisible();
  await expectHealthy(page);
});

test('one business never sees another\'s automations, chats or log', async ({ page }) => {
  await setUp();
  await signIn(page, '/automations');
  const other = await addShop(world, { slug: 'someone-else' });
  const theirs = await other.automate({ name: 'Their secret automation' });
  await other.dm(world.fan(), 'their private message');
  await other.settle();

  await page.goto(`${world.base}/admin/automations/${theirs.id}`);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await page.goto(`${world.base}/admin/automations`);
  await expect(page.getByRole('heading', { name: 'No automations yet' })).toBeVisible();
  await expect(page.getByText('Their secret automation')).toHaveCount(0);
  await page.goto(`${world.base}/admin/inbox`);
  await expect(page.getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  await page.goto(`${world.base}/admin/compliance/log`);
  await expect(page.getByRole('heading', { name: 'Compliance log' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: 'Open automation' })).toHaveCount(0); // this business's own Meta checks may be listed; no one's automation is
});
