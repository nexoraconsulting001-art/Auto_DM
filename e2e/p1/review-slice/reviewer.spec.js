// What a Meta reviewer does, in a real browser, on a phone: sign in with the review login, connect Instagram on the consent screen, see the result.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { startApp } from '../../../test/helpers.js';
import { withTenant } from '../../../src/tenancy.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';

const APP = { id: 'bhava-ig-app', secret: 'secret' }; // the app secret startApp configures
const IG_USER = '17841400000000011';
const USERNAME = 'kesar.sarees';
// With no address configured, the callback uses the address the browser came in on, which the simulator allows on loopback.
const REVIEW = { slug: 'default', phone: '9123456780', code: 'review-code-1' };

let sim;
let app;

test.beforeAll(async () => {
  sim = await createMeta({ app: APP }).start();
  app = await startApp({ overrides: { graphBaseUrl: sim.url, igAppId: APP.id, platformDomain: '', publicBaseUrl: '', metaCallbackBaseUrl: '', metaReview: REVIEW } });
  // startApp connects a made-up account to the default business, and this business starts with none.
  await app.db.platform.query(`DELETE FROM ig_accounts WHERE ig_user_id = 'ME'`);
  await sim.post('/accounts', { igUserId: IG_USER, username: USERNAME });
  await expect.poll(() => withTenant(app.tenant, () => app.platform.users.findByPhone(REVIEW.phone))).toBeTruthy();
});

test.afterAll(async () => {
  app?.close();
  await sim?.close();
});

const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('a reviewer signs in, connects Instagram and sees the whole flow, on a phone', async ({ page }) => {
  await page.goto(`${app.base}/review`);
  await expect(page.getByRole('heading', { name: 'Meta App Review' })).toBeVisible();
  expect(await seriousFindings(page)).toEqual([]);

  await page.getByLabel('Mobile number').fill(REVIEW.phone);
  await page.getByLabel('Review code').fill('not-the-code');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That number and code don’t match.');

  await page.getByLabel('Mobile number').fill(REVIEW.phone);
  await page.getByLabel('Review code').fill(REVIEW.code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('No account is connected yet.')).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousFindings(page)).toEqual([]);

  await page.getByRole('button', { name: 'Connect Instagram', exact: true }).click();
  await expect(page).toHaveURL(/\/review\?instagram=connected(#_)?$/); // Instagram's #_ survives the redirects
  await expect(page.getByRole('status')).toHaveText('Instagram is connected.');
  await expect(page.getByText(`@${USERNAME}`)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'instagram_business_manage_messages' })).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousFindings(page)).toEqual([]);

  await page.getByRole('link', { name: 'privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'How to delete your data' })).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousFindings(page)).toEqual([]);

  await page.goBack();
  await page.getByRole('button', { name: 'Disconnect Instagram' }).click();
  await expect(page.getByRole('status')).toHaveText('Instagram is disconnected. The access token has been deleted.');
  await expect(page.getByText('No account is connected yet.')).toBeVisible();
});
