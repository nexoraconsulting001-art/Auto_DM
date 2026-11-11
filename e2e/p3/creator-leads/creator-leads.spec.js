// A real browser on a phone: the creator page loads its later tiles as the shopper scrolls and counts a bio visit, and the lead
// form can't be sent until the box is ticked.
import { expect, test } from '@playwright/test';
import { addCategory, addPage, startWorld } from '../../../test/p3/creator-leads/support.js';

const patch = async (world, path, body) => {
  const res = await world.api(path, { method: 'PATCH', body });
  expect(res.status).toBe(200);
  return res.body;
};

test('the creator page shows 12 tiles, loads the rest on scroll, and a tile opens its landing page as a bio visit', async ({ page }) => {
  const world = await startWorld();
  try {
    await world.repos.settings.update({ store_name: 'Zari & Co' });
    const kitchen = await addCategory(world, 'Kitchen');
    const pages = [];
    for (let i = 0; i < 15; i++) {
      const reel = await addPage(world, { headline: `Kitchen ${i + 1}` });
      pages.push(reel);
      expect((await world.api(`/categories/${kitchen.id}/reels`, { method: 'POST', body: { pageId: reel.id } })).status).toBe(200);
    }
    await patch(world, '/creator-page', { slug: 'zari', enabled: true, displayName: 'Zari picks' });

    const hits = [];
    page.on('request', (request) => {
      if (request.url().includes('/_t/e')) hits.push(request.postDataJSON());
    });
    const document_ = await page.goto(`${world.base}/zari`);
    expect(document_.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('Zari picks');
    // Twelve tiles came with the page; the other three arrive when the end of the shelf is reached.
    expect((await document_.text()).match(/class="reel-tile"/g).length).toBe(12);
    await page.locator('.reel-tile').last().scrollIntoViewIfNeeded();
    await expect(page.locator('.reel-tile')).toHaveCount(15);
    await expect(page.locator('[data-more]')).toHaveCount(0);
    expect(await page.content()).not.toMatch(/bhava/i);
    await expect.poll(() => hits.some((h) => h.pageKind === 'creator')).toBe(true);

    // No sideways scroll on a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // A tile is a plain link to the landing page: no hop in between.
    const first = page.locator('.reel-tile').first();
    await expect(first).toHaveAttribute('href', `/r/${pages[0].slug}?utm_source=instagram&utm_medium=bio`);
    const [landing] = await Promise.all([page.waitForResponse((r) => r.url().includes(`/r/${pages[0].slug}`)), first.click()]);
    expect(landing.status()).toBe(200);
    expect(landing.request().redirectedFrom()).toBeNull();
    await expect.poll(() => hits.filter((h) => h.name === 'landing_view').map((h) => h.utm?.medium)).toEqual(['bio']);
  } finally {
    world.close();
  }
});

test('the lead form can’t be sent with the box unticked, and sends once it is', async ({ page }) => {
  const world = await startWorld();
  try {
    await world.repos.settings.update({ store_name: 'Zari & Co' });
    await patch(world, '/lead-forms', { surface: 'landing', enabled: true, offerLine: 'Be first to hear about new drops' });
    const leads = () => world.db.platform.query('SELECT first_name, phone FROM leads');

    await page.goto(`${world.base}/lead`);
    await expect(page.getByText('I agree that Zari & Co may contact me about offers by WhatsApp or email.')).toBeVisible();
    await expect(page.locator('input[name="consent"]')).not.toBeChecked();
    await expect(page.locator('input[name="company_website"]')).not.toBeInViewport();
    await page.getByLabel('First name').fill('Asha');
    await page.getByLabel('Phone number').fill('98765 43210');

    // The browser itself refuses to send while the box is empty.
    await page.getByRole('button', { name: 'Send' }).click();
    expect(await page.locator('input[name="consent"]').evaluate((el) => el.validity.valueMissing)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/lead');
    await expect(page.locator('h1')).toHaveText('Stay in touch');
    expect((await leads()).length).toBe(0);

    await page.locator('input[name="consent"]').check();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('h1')).toHaveText('Thank you');
    await expect(page.getByText('Zari & Co has your details')).toBeVisible();
    expect(await page.content()).not.toMatch(/bhava/i);
    expect(await leads()).toEqual([{ first_name: 'Asha', phone: '+919876543210' }]);

    // The shopper's own link: stop, in two taps.
    await page.getByRole('link', { name: 'Withdraw or delete your details' }).click();
    await page.getByRole('button', { name: 'Delete my details' }).click();
    await expect(page.locator('h1')).toHaveText('Done');
    expect((await leads()).length).toBe(0);
  } finally {
    world.close();
  }
});
