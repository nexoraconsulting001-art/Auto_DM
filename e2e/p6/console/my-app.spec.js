// "My app" in a real phone-sized browser (PRD 10.7 to 10.14; P-27 to P-66): the app fields with live messages that name the field,
// builds and their failures, the store-account steps with their warnings and the fresh check before a key, the listing editor with
// the store's limit as you type, a rejection's guideline and playbook, the offer composer with the weekly cap, and push keys that
// are masked and never come back. Every screen is also forced through loading, failed and empty, and checked with axe.
import { test, expect } from '@playwright/test';
import {
  BOTH, CREDENTIALS, PEM, PHONE, SERVER_FAULT, access, confirmItsYou, defaults, expectHealthy, json, mockApi, openWorld, ownWorker, refusal, sideways, signInWithCode, toast, watch, writesTo,
} from './support.js';

const NL = String.fromCharCode(10);
test.use({ viewport: PHONE, ...ownWorker('P6ConsoleApps') });

let world;
let owner;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await openWorld();
  ({ owner } = await world.shop());
});
test.afterAll(async () => {
  await world?.close();
});

/** Mocks the area, signs in and opens `path` under /admin. */
async function open(page, path, options = {}) {
  const problems = watch(page);
  const mocked = await mockApi(page, options);
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl(`/admin${path}`) });
  return { ...mocked, problems };
}

test('P-33: the app fields say which field is wrong as you type, and a save sends only what changed', async ({ page }) => {
  const { calls, problems } = await open(page, '/my-app');
  const name = page.getByLabel('App name');
  await expect(name).toHaveValue('Kesar Kitchen');
  await name.fill('K'.repeat(34));
  await expect(page.getByText('App name is 34 characters. The most is 30.')).toBeVisible();
  await page.getByLabel('Support email').fill('not-an-email');
  await expect(page.getByText('Support email: enter a valid email address.')).toBeVisible();
  await page.getByLabel('Privacy policy link').fill('http://kesar.in/privacy');
  await expect(page.getByText('Privacy policy link: use a link that starts with https://')).toBeVisible();
  await expectHealthy(page);
  expect(await sideways(page)).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText(/Please check: App name is 34 characters/)).toBeVisible();
  expect(writesTo(calls, 'PUT /app-publishing')).toHaveLength(0);

  await name.fill('Kesar Kitchen Foods');
  await page.getByLabel('Support email').fill('hello@kesar.in');
  await page.getByLabel('Privacy policy link').fill('https://kesar.in/privacy');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(toast(page, 'Your app details are saved.')).toBeVisible();
  expect(writesTo(calls, 'PUT /app-publishing').map((c) => c.body)).toEqual([{ appName: 'Kesar Kitchen Foods' }]);
  expect(problems).toEqual([]);
});

test('P-34 P-35: the server’s refusal is shown on the field it names, and Check my app lists what is missing', async ({ page }) => {
  await open(page, '/my-app', {
    overrides: { 'PUT /app-publishing': () => refusal(400, 'Please check the highlighted details.', { code: 'validation', fields: { shopDomain: 'Use one of your own store addresses.' } }) },
  });
  await page.getByLabel('Store web address').fill('other.example.com');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('.field-error', { hasText: 'Use one of your own store addresses.' })).toBeVisible();
  await page.getByRole('button', { name: 'Check my app' }).click();
  await expect(page.getByText('The privacy policy link must start with https://.')).toBeVisible();
});

test('P-36: the build list shows a failure’s step and field, and an owner can request a build for the platforms on the plan', async ({ page }) => {
  const { calls } = await open(page, '/my-app', { config: BOTH });
  await expect(page.getByText('Stopped at: Checking your app details. Give your app a name. (App name)')).toBeVisible();
  await page.getByLabel('iPhone and iPad').check();
  await page.getByRole('button', { name: 'Build my app' }).click();
  await expect(toast(page, 'Your build is queued.')).toBeVisible();
  const [build] = writesTo(calls, 'POST /app-publishing/builds');
  expect(build.body.platforms.sort()).toEqual(['android', 'ios']);
  expect(build.body.requestKey).toMatch(/^[\w-]{8,80}$/);
});

test('P-27: a platform the plan lacks shows an upgrade prompt, never a build box or its fields', async ({ page }) => {
  const { calls } = await open(page, '/my-app');
  await expect(page.getByTestId('upgrade-ios').first()).toContainText('Not on your plan');
  await expect(page.getByLabel('iOS bundle ID')).toHaveCount(0);
  await expect(page.getByLabel('iPhone and iPad')).toHaveCount(0);
  await expectHealthy(page);

  await page.goto(world.signInUrl('/admin/my-app/listing/ios'));
  await expect(page.getByTestId('upgrade-ios')).toBeVisible();
  expect(calls.some((c) => c.key === 'GET /app-listing/ios')).toBe(false);
  await expectHealthy(page);

  // The same call made straight to the server answers with its own refusal, which reads as an upgrade note and not as a failure.
  await page.goto(world.signInUrl('/admin/my-app/stores'));
  await expect(page.getByTestId('upgrade-ios')).toBeVisible();
});

test('P-27: the server’s plan refusal reads as an upgrade note, not as a failure', async ({ page }) => {
  await open(page, '/my-app/review', {
    config: BOTH,
    overrides: { 'GET /app-publishing/submissions': () => refusal(403, 'Your plan does not include the iOS app.', { reason: 'plan.not_included' }) },
  });
  await expect(page.getByRole('heading', { name: 'This isn’t on your plan' })).toBeVisible();
  await expect(page.getByText('Your plan does not include the iOS app.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expectHealthy(page);
});

test('P-37 P-38 P-39: the store steps show their warnings and waits, a personal Play account adds the closed test, and the check names the role', async ({ page }) => {
  const { calls } = await open(page, '/my-app/stores', { config: BOTH });
  await expect(page.getByText('It can take a few days to be approved.').first()).toBeVisible();
  await expect(page.getByTestId('service-account-email')).toHaveText('push@bhava-play.example.com');
  await page.getByRole('radio', { name: 'Personal' }).first().check();
  await expect(page.getByText('Google asks a personal account for 12 testers who stay for 14 days in a row before it can publish.')).toBeVisible();
  await expectHealthy(page);
  expect(await sideways(page)).toBeLessThanOrEqual(0);

  await page.getByRole('radio', { name: 'Organisation' }).nth(1).check();
  await expect(page.getByLabel('D-U-N-S number')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Look up or apply for a D-U-N-S number' })).toHaveAttribute('rel', /noopener/);

  await page.getByRole('button', { name: 'Check access' }).first().click();
  await expect(page.getByText('The role we found (Viewer) is too low. We need Release manager.')).toBeVisible();
  expect(writesTo(calls, 'POST /store-access/android/check')).toHaveLength(1);
});

test('P-40: the store account form asks for a key, never a password; the key is masked, needs a fresh check, and is cleared once sent', async ({ page }) => {
  let first = true;
  const { calls } = await open(page, '/my-app/stores', {
    config: BOTH,
    overrides: {
      'PUT /store-access/ios': ({ body }) => {
        if (first) {
          first = false;
          return refusal(403, 'Confirm it’s you first.', { code: 'reauth_required' });
        }
        return access('ios', { credential: { kind: 'asc_api_key', keyId: body.ascKey.keyId, issuerId: body.ascKey.issuerId, keyLast4: '3F2A', set: true } });
      },
    },
  });
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel(/password|passcode|apple id/i)).toHaveCount(0);
  await expect(page.getByText('We never ask for your Apple or Google password').first()).toBeVisible();

  const key = page.getByLabel('Private key (.p8 file)');
  expect(await key.evaluate((el) => getComputedStyle(el).webkitTextSecurity)).toBe('disc');
  expect(await key.getAttribute('autocomplete')).toBe('off');
  await page.getByLabel('Key ID').fill('ABCDE12345');
  await page.getByLabel('Issuer ID').fill('57246542-96fe-1a63-e053-0824d011072a');
  await key.fill('password: hunter2');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText(/never ask for your Apple password/).last()).toBeVisible();
  expect(writesTo(calls, 'PUT /store-access/ios')).toHaveLength(0);

  await key.fill(PEM);
  await page.getByRole('button', { name: 'Save key' }).click();
  await confirmItsYou(page, world, owner.phone);
  await expect(toast(page, 'Your App Store Connect key is saved. It cannot be read back.')).toBeVisible();
  await expect(key).toHaveValue('');
  await expect(page.getByLabel('Key ID')).toHaveValue('');
  const sent = writesTo(calls, 'PUT /store-access/ios');
  expect(sent.length).toBe(2); // refused for a stale session, then sent after the code
  const { privateKey, ...rest } = sent.at(-1).body.ascKey;
  expect(rest).toEqual({ keyId: 'ABCDE12345', issuerId: '57246542-96fe-1a63-e053-0824d011072a' });
  expect(privateKey.split(NL).slice(1, -1).join('')).toBe(PEM.split(NL)[1]); // the same key, its lines re-wrapped
  await expect(page.getByText('ends in 3F2A')).toBeVisible();
  expect(await page.content()).not.toContain('MIGTAgEAMBMGByqGSM49AgEG');
  await expectHealthy(page);
});

test('P-48: the listing editor shows the store’s limit as you type and will not save what the store would refuse', async ({ page }) => {
  const { calls } = await open(page, '/my-app/listing/android');
  await expect(page.getByText('6 of 80 characters')).toBeVisible();
  const short = page.getByLabel('Short description');
  await short.fill('x'.repeat(92));
  await expect(page.getByText('Short description is 92 characters. Google Play allows 80.')).toBeVisible();
  await page.getByRole('button', { name: 'Save listing' }).click();
  await expect(page.getByText(/Please check: Short description is 92 characters/)).toBeVisible();
  expect(writesTo(calls, 'PUT /app-listing/android')).toHaveLength(0);

  await short.fill('Fresh spices, delivered');
  await page.getByLabel('Title').fill('Bhava Foods');
  await expect(page.getByText('Title must name your business only.')).toBeVisible();
  await page.getByLabel('Title').fill('Kesar Kitchen');
  await page.getByRole('button', { name: 'Save listing' }).click();
  await expect(toast(page, 'Your Google Play listing is saved.')).toBeVisible();
  expect(Object.keys(writesTo(calls, 'PUT /app-listing/android')[0].body).sort()).toEqual(['fullDescription', 'shortDescription', 'title', 'whatsNew']);
  await expect(page.getByText('Add at least 2 screenshots.')).toBeVisible();
  await expectHealthy(page);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test('P-56: a rejection shows its guideline, the store’s words and the playbook’s next step', async ({ page }) => {
  await open(page, '/my-app/review');
  await expect(page.getByText('Apps made from a template')).toBeVisible();
  await expect(page.getByText('Guideline 4.2.6', { exact: true })).toBeVisible();
  await expect(page.getByText('Your app looks like a template.')).toBeVisible();
  await expect(page.getByText(/We show what is yours/)).toBeVisible();
  await expect(page.getByText(/We are fixing the store’s point about guideline 4\.2\.6/)).toBeVisible();
  await page.getByText(/Checks before sending: some failed/).click();
  await expect(page.getByText(/native screens \(guideline 4\.2\)/)).toBeVisible();
  await expectHealthy(page);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test('P-59: the offer composer shows the weekly cap, checks as you type, asks first, and a capped send is kept as not sent', async ({ page }) => {
  let capped = false;
  const { calls } = await open(page, '/my-app/offers', {
    overrides: { 'POST /push-campaigns': () => (capped ? refusal(409, 'Weekly offer limit reached', { code: 'conflict' }) : json({ id: 9, title: 'Diwali sale', body: 'Flat 20% off sweets', couponCode: null, linkPath: '/c/sale', status: 'queued', blockReason: '', audienceCount: 25, sentCount: 0, cappedCount: 0, failedCount: 0, createdAt: '2026-11-12T10:00:00.000Z', sentAt: null }, 202)) },
  });
  await expect(page.getByTestId('weekly-cap')).toContainText('at most 2 offers a week');
  await expect(page.getByText('Push keys are not set for iPhone and iPad')).toBeVisible();
  await page.getByLabel('Title').fill('Call 9876543210');
  await page.getByLabel('Message').fill('x'.repeat(190));
  await expect(page.getByText('Message is 190 characters. The most is 178.')).toBeVisible();
  await page.getByRole('button', { name: 'Send offer' }).click();
  await expect(page.getByText(/Please check/)).toBeVisible();
  expect(writesTo(calls, 'POST /push-campaigns')).toHaveLength(0);
  await expectHealthy(page);

  await page.getByLabel('Title').fill('Diwali sale');
  await page.getByLabel('Message').fill('Flat 20% off sweets');
  await page.getByLabel('Opens this page').fill('/c/sale');
  await page.getByRole('button', { name: 'Send offer' }).click();
  const ask = page.getByRole('dialog', { name: 'Send this offer?' });
  await expect(ask).toContainText('about 25 shoppers');
  await ask.getByRole('button', { name: 'Not yet' }).click();
  expect(writesTo(calls, 'POST /push-campaigns')).toHaveLength(0);
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.getByRole('dialog', { name: 'Send this offer?' }).getByRole('button', { name: 'Send offer' }).click();
  await expect(toast(page, 'Your offer is on its way.')).toBeVisible();
  expect(writesTo(calls, 'POST /push-campaigns')[0].body).toMatchObject({ title: 'Diwali sale', body: 'Flat 20% off sweets', linkPath: '/c/sale' });

  capped = true;
  await page.getByLabel('Title').fill('Second offer');
  await page.getByLabel('Message').fill('Another one');
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.getByRole('dialog', { name: 'Send this offer?' }).getByRole('button', { name: 'Send offer' }).click();
  await expect(page.getByText(/Weekly offer limit reached\. The offer is kept in your list below as not sent\./)).toBeVisible();
});

test('P-60 P-61: push keys are masked, need a fresh check, are checked without being echoed, and are gone from the page once sent', async ({ page }) => {
  let first = true;
  const { calls } = await open(page, '/my-app/push-keys', {
    config: BOTH,
    overrides: { 'PUT /push-credentials': () => { if (first) { first = false; return refusal(403, 'Confirm it’s you first.', { code: 'reauth_required' }); } return CREDENTIALS; } },
  });
  await expect(page.getByText(/A key is saved for project kesar-app/)).toBeVisible();
  const box = page.getByLabel('Service account file (JSON)');
  await expect(box).toHaveValue('');
  expect(await box.evaluate((el) => getComputedStyle(el).webkitTextSecurity)).toBe('disc');
  await box.fill('{"type":"user","private_key":"LEAK-ME"}');
  await page.getByRole('button', { name: 'Save Firebase key' }).click();
  await expect(page.getByText(/must be the service account key file/)).toBeVisible();
  await expect(page.locator('.field-error')).not.toContainText('LEAK-ME');
  expect(writesTo(calls, 'PUT /push-credentials')).toHaveLength(0);

  const account = JSON.stringify({ type: 'service_account', project_id: 'kesar-app', client_email: 'push@kesar-app.iam.example.com', private_key: PEM });
  await box.fill(account);
  await page.getByRole('button', { name: 'Save Firebase key' }).click();
  await confirmItsYou(page, world, owner.phone);
  await expect(toast(page, 'Your Firebase key is saved. It cannot be read back.')).toBeVisible();
  await expect(box).toHaveValue('');
  expect(writesTo(calls, 'PUT /push-credentials').at(-1).body).toEqual({ fcm: { serviceAccount: account } });
  expect(await page.content()).not.toContain('MIGTAgEAMBMGByqGSM49AgEG');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('MIGTAgEAMBMGByqGSM49AgEG');
  await expectHealthy(page);
});

test('P-61: a manager is told push keys are the owner’s and the server is not asked for them', async ({ page }) => {
  const manager = await world.person((await world.shop()).tenant, { role: 'manager' });
  const problems = watch(page);
  const { calls } = await mockApi(page);
  await signInWithCode(page, world, manager.phone, { url: world.signInUrl('/admin/my-app/push-keys') });
  await expect(page.getByRole('heading', { name: 'Only the owner can set push keys' })).toBeVisible();
  expect(calls.some((c) => c.key === 'GET /push-credentials')).toBe(false);
  await expectHealthy(page);
  expect(problems).toEqual([]);
});

const SCREENS = [
  { name: 'app details', path: '/my-app', route: 'GET /app-publishing', loading: 'Loading your app', failed: 'We couldn’t load your app', ready: 'App name' },
  { name: 'store accounts', path: '/my-app/stores', route: 'GET /store-access', loading: 'Loading your store accounts', failed: 'We couldn’t load your store accounts', ready: 'Account type' },
  { name: 'store listing', path: '/my-app/listing/android', route: 'GET /app-listing/android', loading: 'Loading your listing', failed: 'We couldn’t load your listing', ready: 'Short description' },
  { name: 'review status', path: '/my-app/review', route: 'GET /app-publishing/submissions', loading: 'Loading your review status', failed: 'We couldn’t load your review status', ready: 'Apps made from a template' },
  { name: 'offers', path: '/my-app/offers', route: 'GET /push-campaigns/summary', loading: 'Loading your offers', failed: 'We couldn’t load your offers', ready: 'New offer' },
  { name: 'push keys', path: '/my-app/push-keys', route: 'GET /push-credentials', loading: 'Loading your push keys', failed: 'We couldn’t load your push keys', ready: 'Android: Firebase service account' },
];

for (const screen of SCREENS) {
  test(`${screen.name}: loading, then a way back from a failure, then ready`, async ({ page }) => {
    let mode = 'hold';
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const mocked = await mockApi(page, {
      overrides: { [screen.route]: async () => { if (mode === 'hold') await held; return mode === 'fail' ? SERVER_FAULT : defaultsFor(mocked.state, screen.route); } },
    });
    await signInWithCode(page, world, owner.phone, { url: world.signInUrl(`/admin${screen.path}`) });
    await expect(page.getByRole('status').filter({ hasText: screen.loading }).first()).toBeVisible();
    await expectHealthy(page);
    mode = 'fail';
    release();
    const failure = page.getByRole('alert').filter({ hasText: screen.failed }).first();
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectHealthy(page);
    mode = 'pass';
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: screen.failed })).toHaveCount(0);
    await expect(page.getByText(screen.ready).first()).toBeVisible();
    await expectHealthy(page);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
}

function defaultsFor(state, key) {
  return defaults(state)[key]({ body: null });
}

test('empty states: no builds, no offers sent yet, no store pictures, nothing sent to a store', async ({ page }) => {
  const empty = () => ({ items: [], nextCursor: null });
  await open(page, '/my-app', {
    overrides: {
      'GET /app-publishing/builds': empty, 'GET /push-campaigns': empty, 'GET /app-publishing/submissions': () => ({ items: [] }), 'GET /app-listing/android/assets': () => ({ items: [] }),
    },
  });
  await expect(page.getByText('No builds yet. Fill in your details, then build your app.')).toBeVisible();
  await expectHealthy(page);
  await page.goto(world.signInUrl('/admin/my-app/offers'));
  await expect(page.getByText('You have not sent an offer yet.')).toBeVisible();
  await expectHealthy(page);
  await page.goto(world.signInUrl('/admin/my-app/review'));
  await expect(page.getByText(/Nothing has been sent to a store yet/)).toBeVisible();
  await expectHealthy(page);
  await page.goto(world.signInUrl('/admin/my-app/listing/android'));
  await expect(page.getByText(/No pictures yet/)).toBeVisible();
  await expectHealthy(page);
});
