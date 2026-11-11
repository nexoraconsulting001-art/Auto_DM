// A real browser on a phone: sign in with a WhatsApp code, save an address, choose which messages to get, and answer the
// cookie banner, declining as easily as accepting. Every page wears the seller's brand only.
import { expect, test } from '@playwright/test';
import { world } from '../../../test/p4/shoppers/support.js';

test('a shopper signs in with a WhatsApp code, saves an address and chooses their messages, all on the phone', async ({ page }) => {
  const w = await world({ google: false });
  try {
    await page.goto(`${w.app.base}/login?next=/account`);
    await expect(page.locator('h1')).toHaveText('Sign in');
    expect(await page.content()).not.toMatch(/bhava|\bSMS\b/i);
    await page.fill('#otp-phone', '98765 43210');
    await page.click('#otp-send');
    await expect(page.locator('#otp-step-code')).toBeVisible();
    await expect.poll(() => w.lastCode('9876543210')).toMatch(/^[0-9]{6}$/);
    await page.fill('#otp-code', '000000');
    await page.click('#otp-verify');
    await expect(page.locator('#otp-error')).toContainText('isn’t right');
    await page.fill('#otp-code', await w.lastCode('9876543210'));
    await page.check('#opt-updates');
    await page.click('#otp-verify');
    await page.waitForURL(`${w.app.base}/account`);
    await expect(page.locator('h1')).toContainText('Hi');
    await expect(page.locator('#c-ou-wa')).toBeChecked();
    await expect(page.locator('#c-mk-wa')).not.toBeChecked();

    // An address, with the PIN rule shown in place.
    await page.click('#addr-add');
    await page.fill('#addr-name', 'Asha K');
    await page.fill('#addr-phone', '9876543210');
    await page.fill('#addr-line1', '12 MG Road');
    await page.fill('#addr-city', 'Pune');
    await page.selectOption('#addr-state', '27');
    await page.fill('#addr-pincode', '012345');
    await page.click('#addr-form button[type=submit]');
    await expect(page.locator('#addr-error')).toHaveText('Enter a 6-digit PIN code');
    await page.fill('#addr-pincode', '411001');
    await page.click('#addr-form button[type=submit]');
    await expect(page.locator('text=12 MG Road')).toBeVisible();
    await expect(page.locator('.badge', { hasText: 'Default' })).toBeVisible();

    await page.check('#c-mk-em');
    await page.click('#consent-form button[type=submit]');
    await expect(page.locator('#consent-done')).toHaveText('Saved.');
    await page.reload();
    await expect(page.locator('#c-mk-em')).toBeChecked();
    expect(await page.content()).not.toMatch(/bhava/i);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } finally {
    await w.close();
  }
});

test('the cookie banner offers Allow and Don’t allow alike, and declining hides it for good', async ({ page }) => {
  const w = await world({ google: false });
  try {
    await w.app.repos.entitlements.setOverride('tags.pixels', { enabled: true });
    await w.app.db.platform.query(`INSERT INTO tag_settings (tenant_id, meta_enabled, meta_pixel_id) VALUES ($1, true, '123456789012345')`, [w.app.tenant.id]);
    await page.goto(`${w.app.base}/`);
    const banner = page.locator('#cookie-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Test store would like to use cookies');
    const allow = await banner.locator('[data-cookie="1"]').boundingBox();
    const decline = await banner.locator('[data-cookie="0"]').boundingBox();
    expect(Math.abs(allow.width - decline.width)).toBeLessThan(2);
    expect(Math.abs(allow.height - decline.height)).toBeLessThan(2);
    await banner.locator('[data-cookie="0"]').click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#cookie-banner')).toHaveCount(0);
  } finally {
    await w.close();
  }
});
