// Rehearsal of screencast script sc-01 (docs/go-live/meta-app-review/pack.json): the reviewer signs in with the review login, connects
// Instagram on the simulator's consent screen, sees the permissions granted, opens the privacy policy and disconnects. Playwright saves
// a video of the run. The simulators stand in for Meta; nothing leaves this machine. The user records the real one on the real app.
import { expect, test } from '@playwright/test';
import { startApp } from '../../../test/helpers.js';
import { withTenant } from '../../../src/tenancy.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { INSTAGRAM_SCOPES } from '../../../src/adapters/meta/login.js';
import { PHONE, VIDEO, scriptOf } from './script.js';

const script = scriptOf('sc-01-instagram-connect');
const APP = { id: 'bhava-ig-app', secret: 'secret' };
const IG_USER = '17841400000000011';
const USERNAME = 'kesar.sarees';
const REVIEW = { slug: 'default', phone: '9123456780', code: 'review-code-1' };

test.use({ viewport: PHONE, video: VIDEO });

let sim;
let app;

test.beforeAll(async () => {
  sim = await createMeta({ app: APP }).start();
  app = await startApp({ overrides: { graphBaseUrl: sim.url, igAppId: APP.id, platformDomain: '', publicBaseUrl: '', metaCallbackBaseUrl: '', metaReview: REVIEW } });
  await app.db.platform.query(`DELETE FROM ig_accounts WHERE ig_user_id = 'ME'`);
  await sim.post('/accounts', { igUserId: IG_USER, username: USERNAME });
  await expect.poll(() => withTenant(app.tenant, () => app.platform.users.findByPhone(REVIEW.phone))).toBeTruthy();
});

test.afterAll(async () => {
  app?.close();
  await sim?.close();
});

test('sc-01: every step of the Instagram connect script can be walked, and every permission the code asks for is shown', async ({ page }) => {
  const [signIn, connect, allowed, privacy, disconnect] = script.steps;

  await test.step(signIn.tap, async () => {
    await page.goto(`${app.base}/review`);
    await page.getByLabel('Mobile number').fill(REVIEW.phone);
    await page.getByLabel('Review code').fill(REVIEW.code);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('No account is connected yet.')).toBeVisible();
  });

  await test.step(connect.tap, async () => {
    // The simulator's consent screen is Instagram's own page here; the redirect is followed in the same tab.
    await page.getByRole('button', { name: 'Connect Instagram', exact: true }).click();
  });

  await test.step(allowed.tap, async () => {
    await expect(page).toHaveURL(/\/review\?instagram=connected(#_)?$/);
    await expect(page.getByRole('status')).toHaveText('Instagram is connected.');
    await expect(page.getByText(`@${USERNAME}`)).toBeVisible();
    // The script says "a table of every permission that was granted": every one the code asks for.
    for (const scope of INSTAGRAM_SCOPES) await expect(page.getByRole('cell', { name: scope })).toBeVisible();
  });

  await test.step(privacy.tap, async () => {
    await page.getByRole('link', { name: 'privacy policy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { name: 'How to delete your data' })).toBeVisible();
  });

  await test.step(disconnect.tap, async () => {
    await page.goBack();
    await page.getByRole('button', { name: 'Disconnect Instagram' }).click();
    await expect(page.getByRole('status')).toHaveText('Instagram is disconnected. The access token has been deleted.');
    await expect(page.getByText('No account is connected yet.')).toBeVisible();
  });
});
