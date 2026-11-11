// The web sign-in page in a real phone-sized browser (PRD 5.11, 10.3): Bhava's page on the sign-in host, a WhatsApp
// code from the platform's number and no password, ending in a console session.
import { expect, test } from '@playwright/test';
import { accountsApp, sellerCodeFor } from '../../../test/p5/accounts/support.js';
import { OWNER } from '../../../test/helpers.js';

let app;
test.beforeAll(async () => {
  // The sign-in host is the address the browser opens.
  app = await accountsApp({ overrides: { platformAppHost: '127.0.0.1' } });
});
test.afterAll(async () => {
  await app?.close();
});

test('P-11: the web sign-in offers a WhatsApp code and no password, and the code opens the console session', async ({ page }) => {
  await page.goto(`${app.base}/signin`);
  await expect(page.getByRole('heading', { name: 'Sign in to your business' })).toBeVisible();
  await expect(page.getByText('Bhava', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText(/SMS/)).toHaveCount(0);

  await page.getByLabel('WhatsApp number').fill(OWNER.phone);
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);

  await page.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('didn’t work');

  await page.getByLabel('6-digit code').fill(code);
  await Promise.all([page.waitForURL(/\/admin/), page.getByRole('button', { name: 'Sign in' }).click()]);
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json());
  expect(me.user.phone).toBe(OWNER.phone);
  expect(me.business.id).toBe(app.tenant.id);
});
