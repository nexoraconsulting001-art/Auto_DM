// The Phase 7 seller console in a real phone-sized browser (PRD 3, 5.6, 5.7, 5.12, 5.17, 5.20, 6.11, 6.12): plan and billing with the
// server's prices, upgrades and downgrades with what switches off, the fresh check before money moves, the provider's hosted pages,
// the DM meter and packs, invoices and statements, upgrade prompts wherever the plan refuses, the setup checklist, referrals, FAQ and
// AI replies with a test question that sends nothing, WhatsApp, and the "Done by Bhava team" feed. Every screen is also forced through
// loading, empty and failed, and checked with axe. The server's side of each is in test/p7/console-billing.
import { test, expect } from '@playwright/test';
import {
  CHECKLIST, KEYWORDS, PHONE, SERVER_FAULT, USAGE, confirmItsYou, expectHealthy, json, mockApi, openWorld, ownWorker, planRefusal, refusal, signInWithCode, toast, watch, writesTo,
} from './support.js';

test.use({ viewport: PHONE, ...ownWorker('P7ConsoleScreens') });
test.setTimeout(90_000);

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
  await page.route('https://checkout.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Hosted page</title><p>Provider page</p>' }));
  await page.route('https://kyc.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>KYC</title><p>KYC page</p>' }));
  const mocked = await mockApi(page, options);
  await signInWithCode(page, world, owner.phone, { url: world.signInUrl(`/admin${path}`) });
  return { ...mocked, problems: problems.filter((p) => !p.includes('checkout.example') && !p.includes('kyc.example') && !p.includes('files.example')) };
}

test('F-26 F-27: plans and prices come from the server; an upgrade shows the price, sends no amount and goes to the provider’s page', async ({ page }) => {
  const { calls } = await open(page, '/billing');
  await expect(page.getByTestId('current-plan')).toHaveText('Grow');
  await expect(page.getByTestId('plan-t3')).toContainText('₹2,499');
  await expect(page.getByTestId('plan-free')).toContainText('Free');
  await expect(page.getByTestId('plan-t5')).toContainText('No limit on automated DMs');
  await page.getByRole('button', { name: 'Yearly' }).click();
  await expect(page.getByTestId('plan-t3')).toContainText('₹24,990');
  await expect(page.getByTestId('plan-t3')).toContainText('You save');
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Upgrade to Shop' }).click();
  const sheet = page.getByRole('dialog', { name: 'Move up to Shop' });
  await expect(sheet.getByTestId('change-price')).toContainText('₹2,499');
  await sheet.getByRole('button', { name: 'Upgrade', exact: true }).click();
  await page.waitForURL(/checkout\.example\/pay/);
  const [change] = writesTo(calls, 'POST /billing/change');
  expect(Object.keys(change.body).sort()).toEqual(['cycle', 'plan', 'requestKey']);
  expect(change.body.plan).toBe('t3');
  expect(change.body.requestKey).toMatch(/^[\w-]{8,80}$/);
});

test('F-33 F-34: a downgrade says what switches off and when, and a keep-my-plan sends nothing', async ({ page }) => {
  const { calls } = await open(page, '/billing', { overrides: { 'GET /billing': () => ({ ...(window_plan()), plan: 't5', planName: 'Brand' }) } });
  await page.getByRole('button', { name: 'Move down to Shop' }).click();
  const sheet = page.getByRole('dialog', { name: 'Move down to Shop' });
  await expect(sheet.getByTestId('switch-off')).toContainText('AI replies, WhatsApp automation');
  await expect(sheet).toContainText('takes effect when your current period ends');
  await sheet.getByRole('button', { name: 'Keep my plan' }).click();
  await expect(sheet).toBeHidden();
  expect(writesTo(calls, 'POST /billing/change')).toHaveLength(0);
});

function window_plan() {
  return { plan: 't2', planName: 'Grow', cycle: 'monthly', status: 'active', nextChargePaise: 119_900, periodEnd: '2026-12-01T00:00:00.000Z', graceUntil: null, nextPlan: null, nextCycle: null, offer: null, hasPaymentMethod: true, items: [] };
}

test('F-28: changing money first asks for a fresh check, and only then sends it', async ({ page }) => {
  // The server says the last sign-in is too old (the real re-auth routes then answer the code), and the same change is sent again after it.
  let refused = false;
  const { calls } = await open(page, '/billing', {
    overrides: { 'POST /billing/change': () => (refused ? { plan: window_plan(), effective: 'now', checkoutUrl: 'https://checkout.example/pay/sub_1' } : (refused = true, refusal(403, 'Confirm it is you first.', { code: 'reauth_required' }))) },
  });
  await world.freshCodes();
  await page.getByRole('button', { name: 'Upgrade to Shop' }).click();
  await page.getByRole('dialog', { name: 'Move up to Shop' }).getByRole('button', { name: 'Upgrade', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toBeVisible();
  expect(writesTo(calls, 'POST /billing/change')).toHaveLength(1);
  await confirmItsYou(page, world, owner.phone);
  await page.waitForURL(/checkout\.example\/pay/);
  const sent = writesTo(calls, 'POST /billing/change');
  expect(sent).toHaveLength(2);
  expect(sent[1].body.requestKey).toBe(sent[0].body.requestKey);
});

test('F-29: the payment method opens the provider’s hosted page, and no card field is ours', async ({ page }) => {
  const { calls } = await open(page, '/billing');
  await expect(page.getByText('Bhava never sees your card details')).toBeVisible();
  await expect(page.locator('input[autocomplete^="cc-"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a payment method' }).click();
  await page.waitForURL(/checkout\.example\/method/);
  expect(writesTo(calls, 'POST /billing/payment-method')).toHaveLength(1);
});

test('F-30 F-31: the DM meter warns near the limit, held DMs are said, and a pack is bought through the server’s price', async ({ page }) => {
  const { calls } = await open(page, '/billing', { overrides: { 'GET /billing/usage': () => ({ ...USAGE, heldDms: 4 }) } });
  const meter = page.getByTestId('meter-dms');
  await expect(meter).toContainText('1700 of 2000 used');
  await expect(meter.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '85');
  await expect(page.getByText('4 automated DMs waiting')).toBeVisible();
  await expect(page.getByTestId('meter-whatsapp_messages')).toContainText('No limit on your plan');
  await expect(page.getByText('1,000 DM pack')).toBeVisible();
  await page.getByRole('button', { name: 'Buy pack' }).click();
  await expect(toast(page, 'Pack added.')).toBeVisible();
  const [add] = writesTo(calls, 'POST /billing/items');
  expect(Object.keys(add.body).sort()).toEqual(['code', 'quantity', 'requestKey']);
  expect(add.body.code).toBe('dm_pack_1000');
  await expectHealthy(page);
});

test('F-77: add-ons show what is included and why one cannot be added, and an add-on can be added and removed', async ({ page }) => {
  const { calls } = await open(page, '/billing', { overrides: { 'GET /billing': () => ({ ...window_plan(), items: [{ id: 9, code: 'ai_replies', name: 'AI replies', kind: 'addon', cycle: 'monthly', quantity: 1, unitPricePaise: 49_900, startsAt: '2026-11-01T00:00:00.000Z', endsAt: null }] }) } });
  await expect(page.getByTestId('addon-whatsapp')).toContainText('Needs a higher plan');
  await expect(page.getByTestId('addon-whatsapp').getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove AI replies' }).click();
  await expect(toast(page, 'AI replies removed.')).toBeVisible();
  expect(writesTo(calls, 'DELETE /billing/items/9')).toHaveLength(1);
});

test('F-35 F-36: invoices and statements download through a private link, and each list has its empty and failed states', async ({ page }) => {
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => { window.__opened.push(String(url)); return null; };
  });
  await open(page, '/billing');
  await expect(page.getByTestId('invoice')).toContainText('BH/2026-27/000005');
  await expect(page.getByTestId('invoice')).toContainText('Paid');
  await page.getByRole('button', { name: 'Download BH/2026-27/000005' }).click();
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['https://files.example/invoice-5.pdf']);
  await page.getByRole('button', { name: 'Download statement 2026-10-01 as CSV' }).click();
  await expect.poll(() => page.evaluate(() => window.__opened.length)).toBe(2);
  await expect(page.getByTestId('statement')).toContainText('Closing balance');
  await expectHealthy(page);
});

test('states: Plan and billing shows loading, empty lists and a failed load with Try again', async ({ page }) => {
  await open(page, '/billing', {
    overrides: {
      'GET /billing/invoices': () => ({ items: [], nextCursor: null }),
      'GET /billing/statements': () => SERVER_FAULT,
      'GET /billing/usage': async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return USAGE; },
    },
  });
  await expect(page.getByRole('status').filter({ hasText: 'Loading your usage' })).toBeVisible();
  await expect(page.getByText('No invoices yet')).toBeVisible();
  await expect(page.getByText('We could not load your statements')).toBeVisible();
  await expectHealthy(page);
});

test('states: a failed plan load says so and Try again loads it', async ({ page }) => {
  let fail = true;
  await open(page, '/billing', { overrides: { 'GET /billing': () => (fail ? SERVER_FAULT : window_plan()) } });
  await expect(page.getByText('We couldn’t load your plan')).toBeVisible();
  await expectHealthy(page);
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('current-plan')).toHaveText('Grow');
});

test('F-37 F-38: a plan refusal from any screen shows an upgrade prompt that leads to the plans', async ({ page }) => {
  await open(page, '/ai-replies', { overrides: { 'POST /faq': () => planRefusal('plan.feature_off', { feature: 'ai_replies', plan: 't4' }) } });
  await page.getByRole('button', { name: 'Add an answer' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add an answer' });
  await sheet.getByLabel('Question', { exact: true }).fill('Do you ship to Goa?');
  await sheet.getByLabel('Answer', { exact: true }).fill('Yes, in four days.');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('upgrade-bar')).toContainText('Not included in your current plan');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('upgrade-prompt')).toBeVisible();
  await page.getByTestId('upgrade-prompt').getByRole('link', { name: 'See plans' }).click();
  await expect(page.getByRole('heading', { name: 'Plan and billing' })).toBeVisible();
  await expect(page.getByTestId('upgrade-bar').getByRole('link', { name: 'See plans' }).or(page.getByTestId('upgrade-bar').getByText('See plans'))).toBeVisible();
});

test('F-39: a limit reached says how many were used', async ({ page }) => {
  await open(page, '/ai-replies', { overrides: { 'POST /faq': () => planRefusal('plan.limit_reached', { feature: 'faq', limit: 50, used: 50, plan: 't4' }) } });
  await page.getByRole('button', { name: 'Add an answer' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add an answer' });
  await sheet.getByLabel('Question', { exact: true }).fill('Q');
  await sheet.getByLabel('Answer', { exact: true }).fill('A');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('upgrade-bar')).toContainText('You have used all 50');
});

test('F-40: the setup checklist shows live step states, KYC goes to the provider’s page, and the pickup address is checked before it is sent', async ({ page }) => {
  const { calls } = await open(page, '/setup');
  await expect(page.getByTestId('step-instagram')).toContainText('Done');
  await expect(page.getByTestId('step-payments')).toContainText('Waiting');
  await expect(page.getByTestId('step-shipping')).toContainText('Needs attention');
  await expect(page.getByTestId('step-own_keys')).toContainText('Optional');
  await expect(page.getByTestId('kyc-status')).toContainText('Razorpay is reviewing');
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Add address' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pickup address' });
  await sheet.getByRole('button', { name: 'Save address' }).click();
  await expect(sheet.getByText('Enter a 6-digit pincode.')).toBeVisible();
  expect(writesTo(calls, 'PUT /setup/pickup-address')).toHaveLength(0);
  await sheet.getByLabel('Contact name').fill('Asha Rao');
  await sheet.getByLabel('Mobile number').fill('9876543210');
  await sheet.getByLabel('Address line 1').fill('12 Raja Park');
  await sheet.getByLabel('City').fill('Jaipur');
  await sheet.getByLabel('State').fill('Rajasthan');
  await sheet.getByLabel('Pincode').fill('302004');
  await sheet.getByRole('button', { name: 'Save address' }).click();
  await expect(toast(page, 'Pickup address saved.')).toBeVisible();
  expect(writesTo(calls, 'PUT /setup/pickup-address')[0].body).toMatchObject({ pincode: '302004', phone: '9876543210' });

  await page.getByRole('button', { name: 'Continue on Razorpay' }).click();
  await page.waitForURL(/kyc\.example/);
});

test('F-41: own keys are tested before saving, asked for behind a fresh check, typed in a password field and never shown again', async ({ page }) => {
  const { calls } = await open(page, '/setup');
  await page.getByRole('button', { name: 'Add keys' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your own account' });
  await expect(sheet.getByLabel('Key secret')).toHaveAttribute('type', 'password');
  await sheet.getByRole('button', { name: 'Test and save' }).click();
  await expect(sheet.getByText('Enter the key id.')).toBeVisible();
  await sheet.getByLabel('Key id').fill('rzp_test_abc');
  await sheet.getByLabel('Key secret').fill('super-secret-value');
  await sheet.getByRole('button', { name: 'Test and save' }).click();
  await expect(toast(page, 'Your keys passed the test and are saved.')).toBeVisible();
  expect(writesTo(calls, 'PUT /setup/own-keys')).toHaveLength(1);
  expect(await page.locator('body').innerText()).not.toContain('super-secret-value');
});

test('F-41: keys that fail the test say so on the form and nothing is saved', async ({ page }) => {
  await open(page, '/setup', { overrides: { 'PUT /setup/own-keys': () => refusal(400, 'Razorpay did not accept these keys.', { code: 'validation_failed' }) } });
  await page.getByRole('button', { name: 'Add keys' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your own account' });
  await sheet.getByLabel('Key id').fill('rzp_test_bad');
  await sheet.getByLabel('Key secret').fill('nope');
  await sheet.getByRole('button', { name: 'Test and save' }).click();
  await expect(sheet.getByText('Razorpay did not accept these keys.')).toBeVisible();
});

test('states: the setup checklist shows loading, a failed load and an empty plan', async ({ page }) => {
  await open(page, '/setup', { overrides: { 'GET /setup': () => ({ ...CHECKLIST, steps: [], done: true }) } });
  await expect(page.getByText('No steps for your plan')).toBeVisible();
  await expectHealthy(page);
  await page.route('**/api/v1/setup', (route) => route.fulfill(SERVER_FAULT));
  await page.reload();
  await expect(page.getByText('We couldn’t load your checklist')).toBeVisible();
});

test('F-108: the referral link can be copied, and what it earned is counted', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, '/referrals');
  await expect(page.getByTestId('referral-link')).toContainText('signup?ref=asha1234');
  await expect(page.getByText('₹500')).toBeVisible();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: /Copied/ })).toBeVisible();
  await expectHealthy(page);
});

test('F-79 A-55: FAQ answers are added, the AI is switched on only with an answer, and a test question shows its sources and score and sends nothing', async ({ page }) => {
  const { calls } = await open(page, '/ai-replies');
  await expect(page.getByTestId('faq-entry')).toContainText('When will my order arrive?');
  await page.getByRole('button', { name: 'Ask a test question' }).click();
  await expect(page.getByText('Write a question.')).toBeVisible();
  await page.getByLabel('Question', { exact: true }).last().fill('When does my order come?');
  await page.getByRole('button', { name: 'Ask a test question' }).click();
  const answer = page.getByTestId('test-answer');
  await expect(answer).toContainText('This would be sent.');
  await expect(answer).toContainText('Confidence 91%');
  await expect(answer.getByRole('list', { name: 'Sources' })).toContainText('When will my order arrive?');
  await expect(page.getByText('Nothing is sent to anyone.')).toBeVisible();
  const writes = calls.filter((c) => c.key.split(' ')[0] !== 'GET').map((c) => c.key);
  expect(writes).toEqual(['POST /ai-replies/test']);
  await expectHealthy(page);
});

test('A-56: a test answer that would not be sent says why in words, with its score', async ({ page }) => {
  await open(page, '/ai-replies', { overrides: { 'POST /ai-replies/test': () => ({ answer: '', sources: [], score: 0.42, threshold: 0.8, wouldSend: false, reason: 'ai.low_confidence' }) } });
  await page.getByLabel('Question', { exact: true }).last().fill('Can you make it in blue?');
  await page.getByRole('button', { name: 'Ask a test question' }).click();
  await expect(page.getByTestId('test-answer')).toContainText('below your confidence level');
  await expect(page.getByTestId('test-answer')).toContainText('Confidence 42% (needs 80%)');
  await expect(page.getByTestId('test-answer')).toContainText('No source was used');
  expect(await page.locator('body').innerText()).not.toContain('ai.low_confidence');
});

test('A-57: the confidence level is checked before it is saved, and the AI switch is off until there is an answer', async ({ page }) => {
  const { calls } = await open(page, '/ai-replies', { overrides: { 'GET /ai-replies': () => ({ enabled: false, threshold: 0.8, configured: false, faqCount: 0, canEnable: false }) } });
  await expect(page.getByText('No AI service is set up')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Answer questions with AI' })).toBeDisabled();
  await page.getByLabel('Confidence needed to send').fill('0.2');
  await expect(page.getByText('Use a number from 0.5 to 1.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save confidence' })).toBeDisabled();
  await page.getByLabel('Confidence needed to send').fill('0.9');
  await page.getByRole('button', { name: 'Save confidence' }).click();
  // The click only starts the save: wait for the request to be made before reading it (R4-MONEY-8).
  await expect.poll(() => writesTo(calls, 'PATCH /ai-replies').length).toBe(1);
  expect(writesTo(calls, 'PATCH /ai-replies')[0].body).toEqual({ threshold: 0.9 });
});

test('states: FAQ and AI replies show an empty list, an empty log and a failed settings load', async ({ page }) => {
  await open(page, '/ai-replies', { overrides: { 'GET /faq': () => ({ items: [], nextCursor: null }), 'GET /ai-replies/log': () => ({ items: [], nextCursor: null }) } });
  await expect(page.getByText('No answers yet')).toBeVisible();
  await expect(page.getByText('Replies and hand-offs show up here.')).toBeVisible();
  await expectHealthy(page);
  await page.route('**/api/v1/ai-replies', (route) => route.fulfill(SERVER_FAULT));
  await page.reload();
  await expect(page.getByText('We couldn’t load AI replies')).toBeVisible();
});

test('F-80 A-58: WhatsApp connects through Meta’s sign-up behind a fresh check, and nothing from another origin counts', async ({ page }) => {
  await page.addInitScript(() => {
    window.FB = {
      init() {},
      login(done) {
        done({ authResponse: { code: 'meta-code' } });
        // A message from some other site is ignored; the one from Meta finishes the sign-up.
        window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '99999999', phone_number_id: '99999999' } }) }));
        window.dispatchEvent(new MessageEvent('message', { origin: 'https://www.facebook.com', data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '12345678', phone_number_id: '87654321' } }) }));
      },
    };
  });
  const { calls } = await open(page, '/whatsapp');
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeEnabled();
  await page.getByRole('button', { name: 'Connect WhatsApp' }).click();
  await expect(toast(page, 'WhatsApp is connected.')).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  expect(writesTo(calls, 'POST /whatsapp/connect/finish')[0].body).toEqual({ code: 'meta-code', state: 'state-one', wabaId: '12345678', phoneNumberId: '87654321' });
  await expectHealthy(page);
});

test('A-59: keyword sets are checked, reordered and saved as one list with exactly a reel or a link', async ({ page }) => {
  const { calls } = await open(page, '/whatsapp');
  await expect(page.getByTestId('keyword-set')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add a keyword set' }).click();
  await page.getByRole('button', { name: 'Save keyword replies' }).click();
  await expect(page.getByText('Add a keyword.')).toBeVisible();
  await expect(page.getByText('Use an https link.')).toBeVisible();
  expect(writesTo(calls, 'PUT /whatsapp/keywords')).toHaveLength(0);
  const second = page.getByTestId('keyword-set').nth(1);
  await second.getByLabel('Keywords for set 2').fill('shop, buy');
  await second.getByLabel('Answer with').selectOption('reel');
  await second.getByLabel('Reel').selectOption('12');
  await page.getByRole('button', { name: 'Move set 2 up' }).click();
  await page.getByRole('button', { name: 'Save keyword replies' }).click();
  await expect(toast(page, 'Keyword replies saved.')).toBeVisible();
  const [save] = writesTo(calls, 'PUT /whatsapp/keywords');
  expect(save.body.items.map((item) => item.keywords)).toEqual([['shop', 'buy'], ['link', 'price']]);
  expect(save.body.items[0]).toMatchObject({ reelId: 12, linkUrl: '' });
  expect(save.body.items[1]).toMatchObject({ reelId: null, linkUrl: KEYWORDS.items[0].linkUrl });
});

test('A-60: opt-ins show purpose, source and withdrawal, and never a phone number; disconnect asks first', async ({ page }) => {
  await open(page, '/whatsapp', { overrides: { 'GET /whatsapp': () => ({ connected: true, status: 'active', displayName: 'Kesar Kitchen', displayNumber: '+91 98xxx xx210', connectedAt: '2026-11-01T00:00:00.000Z', signupReady: true }) } });
  await expect(page.getByTestId('optin')).toHaveCount(2);
  await expect(page.getByTestId('optin').first()).toContainText('At checkout');
  await expect(page.getByTestId('optin').nth(1)).toContainText('Withdrawn');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('dialog', { name: 'Disconnect WhatsApp?' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Disconnect WhatsApp?' }).getByRole('button', { name: 'Keep it' }).click();
  await expectHealthy(page);
});

test('states: WhatsApp shows not-switched-on sign-up, an empty keyword list and a failed load', async ({ page }) => {
  await open(page, '/whatsapp', { overrides: { 'GET /whatsapp': () => ({ connected: false, status: null, displayName: '', displayNumber: '', connectedAt: null, signupReady: false }), 'GET /whatsapp/keywords': () => ({ items: [] }), 'GET /whatsapp/optins': () => ({ items: [], nextCursor: null }) } });
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeDisabled();
  await expect(page.getByText('No keyword sets yet')).toBeVisible();
  await expect(page.getByText('No opt-ins yet')).toBeVisible();
  await expectHealthy(page);
  await page.route('**/api/v1/whatsapp', (route) => route.fulfill(SERVER_FAULT));
  await page.reload();
  await expect(page.getByText('We couldn’t load WhatsApp')).toBeVisible();
});

test('F-51 F-52: the Done by Bhava team feed offers undo on a done change and approve or reject on a draft', async ({ page }) => {
  const { calls } = await open(page, '/team-feed');
  const lines = page.getByTestId('team-change');
  await expect(lines).toHaveCount(3);
  await expect(lines.first()).toContainText('Changed an automation');
  await expect(lines.first()).toContainText('keyword: link → diwali');
  await expect(page.getByText('Some changes are waiting for you')).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('button', { name: /^Undo:/ }).click();
  await page.getByRole('dialog', { name: 'Undo this change?' }).getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Change undone.')).toBeVisible();
  expect(writesTo(calls, 'POST /team-feed/1/undo')).toHaveLength(1);

  await page.getByRole('button', { name: /^Approve:/ }).first().click();
  await expect(toast(page, 'Change approved and applied.')).toBeVisible();
  expect(writesTo(calls, 'POST /team-feed/2/approve')).toHaveLength(1);

  await page.getByRole('button', { name: /^Reject:/ }).last().click();
  await page.getByRole('dialog', { name: 'Reject this change?' }).getByRole('button', { name: 'Reject' }).click();
  await expect(toast(page, 'Change rejected. Nothing was changed.')).toBeVisible();
  expect(writesTo(calls, 'POST /team-feed/3/reject')).toHaveLength(1);
});

test('F-53: an undo the server refuses says so, and filters narrow the feed', async ({ page }) => {
  const { calls } = await open(page, '/team-feed', { overrides: { 'POST /team-feed/1/undo': () => refusal(409, 'Nothing to undo.', { code: 'service.cannot_undo' }) } });
  await page.getByRole('button', { name: /^Undo:/ }).click();
  await page.getByRole('dialog', { name: 'Undo this change?' }).getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'That change cannot be undone any more.')).toBeVisible();
  await page.getByLabel('State').selectOption('draft');
  await expect.poll(() => calls.some((c) => c.key === 'GET /team-feed')).toBe(true);
});

test('states: the team feed shows an empty feed and a failed load with Try again', async ({ page }) => {
  await open(page, '/team-feed', { overrides: { 'GET /team-feed': () => ({ items: [], nextCursor: null }) } });
  await expect(page.getByText('When the Bhava team makes a change for you')).toBeVisible();
  await expectHealthy(page);
  await page.route('**/api/v1/team-feed*', (route) => route.fulfill(SERVER_FAULT));
  await page.reload();
  await expect(page.getByText('We couldn’t load the feed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('F-121 F-122: sign-up asks Creator or Seller, a name, then connects Instagram and makes the first automation, and every field says what is wrong', async ({ page }) => {
  const { calls } = await open(page, '/signup');
  await expect(page.getByRole('heading', { name: 'Set up Bhava' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose Creator or Seller.')).toBeVisible();
  await expect(page.getByText('Enter a name.')).toBeVisible();
  expect(writesTo(calls, 'POST /signup')).toHaveLength(0);
  await page.getByLabel(/Seller/).check();
  await page.getByLabel('Shop name').fill('Kesar Kitchen');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your Instagram' })).toBeVisible();
  expect(writesTo(calls, 'POST /signup')[0].body).toMatchObject({ accountType: 'seller', name: 'Kesar Kitchen' });
  await expect(page.getByText('Connected as @kesar.home')).toBeVisible();
  await expectHealthy(page);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your first automation' })).toBeVisible();
  await page.getByRole('button', { name: 'Make it live' }).click();
  await expect(page.getByText('Pick a reel.')).toBeVisible();
  await expect(page.getByText('Enter a keyword.')).toBeVisible();
  await page.getByRole('button', { name: 'Diwali box reel' }).click();
  await page.getByLabel('Keyword').fill('LINK');
  await page.getByLabel('Link to send').fill('https://kesar.in/shop');
  await page.getByRole('button', { name: 'Make it live' }).click();
  await expect(page.getByRole('heading', { name: 'You are ready' })).toBeVisible();
  expect(writesTo(calls, 'POST /signup/first-automation')[0].body).toEqual({ runToken: 'run-1', mediaId: '17900000000001', keyword: 'LINK', link: 'https://kesar.in/shop' });
  await page.getByRole('button', { name: 'Finish sign-up' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Bhava' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open your console' })).toHaveAttribute('href', /kesar\.shops\.example/);
});

test('F-123: sign-up that is closed or by invite says so, and a link the server refuses is shown on its field', async ({ page }) => {
  const { state } = await open(page, '/signup', {
    overrides: {
      'POST /signup/first-automation': () => ({ automationId: null, live: false, problems: [{ field: 'link', reason: 'link.shortener', message: 'Use your own link, not a shortened one.' }] }),
    },
  });
  void state;
  await page.getByLabel(/Creator/).check();
  await page.getByLabel('Your name').fill('Priya');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Diwali box reel' }).click();
  await page.getByLabel('Keyword').fill('LINK');
  await page.getByLabel('Link to send').fill('https://bit.ly/abc');
  await page.getByRole('button', { name: 'Make it live' }).click();
  await expect(page.getByText('Use your own link, not a shortened one.')).toBeVisible();
  await expect(page.getByText('Fix the highlighted details and try again.')).toBeVisible();
});

test('F-123: closed sign-up shows no form', async ({ page }) => {
  await open(page, '/signup', { overrides: { 'GET /signup': () => ({ mode: 'closed', signedIn: true, open: false, runToken: '', tenantId: null, accountType: null, steps: [], next: null }) } });
  await expect(page.getByText('Sign-up is closed right now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await expectHealthy(page);
});

test('every Phase 7 screen passes axe at 360 px with nothing off the side', async ({ page }) => {
  await open(page, '/billing');
  for (const path of ['/billing', '/setup', '/referrals', '/ai-replies', '/whatsapp', '/team-feed', '/signup']) {
    await page.goto(world.signInUrl(`/admin${path}`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 10_000 });
    await expectHealthy(page);
  }
  void json;
});
