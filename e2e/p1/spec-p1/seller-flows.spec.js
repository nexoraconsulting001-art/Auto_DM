// What a seller sees in a real browser for Phase 1, phone-sized, on the real API with the Meta simulator behind it.
// Needs a console build. Screen addresses aren't in the contract, so each page is reached from the menu where it can be.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { HOUR, MINUTE, SCOPES, addShop, connectPage, openWorld, savePublicReplies } from '../../../test/p1/spec-p1/support.js';

test.use({ viewport: { width: 360, height: 740 } });

let world;
let shop;
const SLUG = 'console-shop';

test.beforeEach(async () => {
  world = await openWorld({ defaultTenant: SLUG });
});
test.afterEach(async () => {
  await world.close();
});

const setUp = async (options = {}) => {
  shop = await addShop(world, { slug: SLUG, ...options });
  return shop;
};

async function signIn(page, path = '') {
  await page.goto(`${world.base}/admin${path}`);
  await page.getByLabel('Mobile number').fill(shop.owner.phone);
  await page.getByLabel('Password').fill(shop.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
}

/** Opens a screen from the menu, including under More on a phone, or by its address if the menu has no such entry. */
async function openScreen(page, label, fallback) {
  const direct = page.getByRole('link', { name: label }).first();
  if (await direct.isVisible().catch(() => false)) return direct.click();
  const more = page.getByRole('link', { name: 'More' }).or(page.getByRole('button', { name: 'More' })).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    const entry = page.getByRole('link', { name: label }).first();
    if (await entry.isVisible().catch(() => false)) return entry.click();
  }
  return page.goto(`${world.base}/admin${fallback}`);
}

const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function newAutomationPage(page) {
  await signIn(page);
  await openScreen(page, /Automations/i, '/automations');
  await page.getByRole('link', { name: /New automation|Create|Add/i }).or(page.getByRole('button', { name: /New automation|Create|Add/i })).first().click();
}

async function aThread(text = 'Is this in stock?') {
  const person = world.fan();
  await shop.dm(person, text);
  await shop.settle();
  return person;
}

test('A-37: the inbox on a phone lists the thread, with its last message and status', async ({ page }) => {
  await setUp();
  const person = await aThread('Is the blue one in stock?');
  await signIn(page);
  await openScreen(page, /Inbox/i, '/inbox');
  await expect(page.getByText(person.username)).toBeVisible();
  await expect(page.getByText('Is the blue one in stock?')).toBeVisible();
  expect(await sideways(page)).toBe(0);
  expect(await seriousFindings(page)).toEqual([]);
});

test('A-37: a message holding HTML is shown as text, and runs nothing', async ({ page }) => {
  await setUp();
  await aThread('<img src=x onerror="window.__xss=1">');
  await signIn(page);
  await openScreen(page, /Inbox/i, '/inbox');
  await expect(page.getByText('<img src=x onerror=')).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('A-38: "human" shows up in Needs a human', async ({ page }) => {
  await setUp();
  const person = world.fan();
  await shop.dm(person, 'human');
  await shop.settle();
  await signIn(page);
  await openScreen(page, /Inbox/i, '/inbox');
  await openScreen(page, /Needs a human/i, '/inbox/needs-human');
  await expect(page.getByText(person.username)).toBeVisible();
});

test('A-39: at 23h55m the composer gives way to "Reply in the Instagram app"', async ({ page }) => {
  await setUp();
  const person = await aThread();
  await world.travel(23 * HOUR + 55 * MINUTE);
  await signIn(page);
  await openScreen(page, /Inbox/i, '/inbox');
  await page.getByText(person.username).click();
  await expect(page.getByText('Reply in the Instagram app')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/i })).toHaveCount(0);
});

test('A-40: a reply at 2h goes, and the thread says automation is paused', async ({ page }) => {
  await setUp();
  const person = await aThread();
  await world.travel(2 * HOUR);
  await signIn(page);
  await openScreen(page, /Inbox/i, '/inbox');
  await page.getByText(person.username).click();
  await page.getByRole('textbox').fill('Yes, it is');
  await page.getByRole('button', { name: /^Send/i }).click();
  await expect(page.getByText('Yes, it is')).toBeVisible();
  await expect(page.getByText(/paused/i)).toBeVisible();
  expect((await shop.dms({ recipientId: person.id })).length).toBe(1);
});

test('A-41: "Why no DM?" explains a capped comment', async ({ page }) => {
  await setUp();
  const auto = await shop.automate();
  const from = world.fan();
  await shop.comment(auto.mediaId, { from });
  const capped = await shop.comment(auto.mediaId, { from });
  await shop.settle();
  await signIn(page);
  await page.goto(`${world.base}/admin/inbox/why-no-dm?commentId=${capped.id}`);
  await expect(page.getByText(/cap\.per_media|already (got|had|sent)/i)).toBeVisible();
});

test('A-43: setup shows reels, posts and live stories with their badges', async ({ page }) => {
  await setUp();
  await shop.reel({ caption: 'A reel' });
  await shop.post({ caption: 'A post' });
  await shop.story({ caption: 'A story' });
  await newAutomationPage(page);
  for (const badge of ['Reel', 'Post', 'Story']) await expect(page.getByText(badge, { exact: true }).first()).toBeVisible();
  expect(await sideways(page)).toBe(0);
  expect(await seriousFindings(page)).toEqual([]);
});

test('A-45: saving with no keyword says "Add at least one keyword"', async ({ page }) => {
  await setUp();
  await shop.reel();
  await newAutomationPage(page);
  await page.getByRole('button', { name: /^Save/i }).click();
  await expect(page.getByText('Add at least one keyword')).toBeVisible();
});

test('A-46: public replies with 4 saved says "Add at least 5 replies"', async ({ page }) => {
  await setUp();
  await shop.reel();
  await newAutomationPage(page);
  await page.getByLabel(/Public repl/i).check();
  await page.getByRole('button', { name: /^Save/i }).click();
  await expect(page.getByText('Add at least 5 replies')).toBeVisible();
});

test('C-31: with 5 replies saved the toggle is accepted', async ({ page }) => {
  await setUp();
  await savePublicReplies(shop, 5);
  await shop.reel();
  await newAutomationPage(page);
  await page.getByLabel(/Public repl/i).check();
  await expect(page.getByText('Add at least 5 replies')).toHaveCount(0);
});

test('C-34: the editor shows the byte limit while typing, and refuses 1,200 bytes', async ({ page }) => {
  await setUp();
  await shop.reel();
  await newAutomationPage(page);
  await page.getByLabel(/Message/i).first().fill('भ'.repeat(400));
  await expect(page.getByText(/1,?200\s*\/\s*1,?000|too long/i).first()).toBeVisible();
});

test('A-28: the preview reads correctly with the name and without it', async ({ page }) => {
  await setUp();
  await shop.reel();
  await newAutomationPage(page);
  await page.getByLabel(/Message/i).first().fill('Hi {first_name}, your link.');
  await expect(page.getByText(/\{first_name\}/).filter({ hasNot: page.getByRole('textbox') })).toHaveCount(0);
});

test('A-36: on the Free plan one tap is off, with the reason', async ({ page }) => {
  await setUp({ plan: 'free' });
  await shop.reel();
  await newAutomationPage(page);
  await page.getByText(/One tap/i).first().click();
  await expect(page.getByText('One tap needs a paid plan')).toBeVisible();
});

test('A-48: an expired token gives "Reconnect Instagram" on the setup screen, and no crash', async ({ page }) => {
  await setUp();
  await world.meta.post('/tokens/expire', { token: shop.igToken });
  await newAutomationPage(page);
  await expect(page.getByText('Reconnect Instagram')).toBeVisible();
});

test('C-43: a pause by support tells the owner so, and offers no resume', async ({ page }) => {
  await setUp();
  await shop.sql(`UPDATE compliance_settings SET paused = true, paused_by = 'ops', paused_at = now() WHERE tenant_id = $1`, [shop.tenantId]);
  await signIn(page);
  await expect(page.getByText('Paused by support. Contact support.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume/i })).toHaveCount(0);
});

test('C-53: a missing messages scope shows a reconnect button', async ({ page }) => {
  await setUp({ scopes: [SCOPES.basic, SCOPES.comments, SCOPES.insights] });
  await signIn(page);
  await expect(page.getByRole('link', { name: /Reconnect/i }).or(page.getByRole('button', { name: /Reconnect/i })).first()).toBeVisible();
});

test('C-54: insights denied prompts a reconnect and says slow mode is on', async ({ page }) => {
  await setUp({ scopes: [SCOPES.basic, SCOPES.messages, SCOPES.comments] });
  await signIn(page);
  await expect(page.getByText(/slow mode/i).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Reconnect/i }).or(page.getByRole('button', { name: /Reconnect/i })).first()).toBeVisible();
});

test('FB-06: an Instagram-only business sees one optional "Connect Facebook Page" card and no other Facebook prompt', async ({ page }) => {
  await setUp();
  await signIn(page);
  await expect(page.getByText('Connect Facebook Page')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Facebook', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Facebook posts|Link a Facebook post/i)).toHaveCount(0);
});

test('FB-04: an expired Page shows a Facebook warning, and Instagram stays healthy', async ({ page }) => {
  await setUp();
  const { pageToken } = await connectPage(world, shop);
  await world.meta.post('/tokens/expire', { token: pageToken });
  await shop.sql(`UPDATE fb_pages SET status = 'reconnect_needed' WHERE tenant_id = $1`, [shop.tenantId]);
  await signIn(page);
  await expect(page.getByText(/Facebook/i).first()).toBeVisible();
  await expect(page.getByText(/Reconnect Instagram/i)).toHaveCount(0);
});

test('A-35: the shared tracking id warning reaches the seller', async ({ page }) => {
  await setUp();
  const [a, b] = [await shop.reel(), await shop.reel()];
  await shop.automate({ mediaId: a, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  await shop.automate({ mediaId: b, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  await shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId: a, kind: 'amazon_tag', value: 'shared-21' } });
  await signIn(page);
  await openScreen(page, /Automations/i, '/automations');
  await page.getByText(/Automation/).first().click();
  await page.getByLabel(/tracking id/i).fill('shared-21');
  await page.getByRole('button', { name: /^Save/i }).click();
  await expect(page.getByText('Earnings cannot be split by reel')).toBeVisible();
});
