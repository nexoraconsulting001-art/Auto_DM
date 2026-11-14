// The Phase 7 console screens' own rules (PRD 3, 5.6, 5.7, 5.12, 5.17, 5.20, 6.11, 6.12): the pure parts of each screen, the
// values written in the console equal to the server's, the forms' checks agree with the server's schemas, the plan prompt, and the
// rules every file keeps (no price typed into a screen, every call made exists in the API client). Reads the source, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '../../../shared/api-client/index.js';
import { routes } from '../../../src/contracts/api/index.js';
import { AI_OUTCOMES, AI_THRESHOLD as SERVER_THRESHOLD, WHATSAPP_LIMITS, WHATSAPP_OPTIN_SOURCES } from '../../../src/contracts/addons.js';
import { ACCOUNT_TYPES as SERVER_TYPES, METERS, PLANS, SIGNUP_STEPS as SERVER_STEPS } from '../../../src/contracts/billing.js';
import { WHATSAPP_OPTIN_PURPOSES } from '../../../src/contracts/compliance.js';
import { KYC_STATES, OWN_KEY_PROVIDERS as SERVER_PROVIDERS, STEP_NAMES, STEP_STATUSES } from '../../../src/contracts/onboarding.js';
import { CHANGE_STATES, SERVICES } from '../../../src/contracts/services.js';
import { BillingCatalog, BillingUsage, PickupAddress } from '../../../src/contracts/api/index.js';
import { OwnKeys, SetupChecklist } from '../../../src/contracts/api/ops.js';
import { SignupAutomationResult, SignupStart, SignupFirstAutomation, SignupStatus } from '../../../src/contracts/api/billing.js';
import { WhatsappKeywordsSave } from '../../../src/contracts/api/addons.js';
import * as billing from '../../../console/src/features/billing/contract.js';
import { REFUSAL_EVENT, installUpgradeWatch } from '../../../console/src/features/billing/upgrade-watch.js';
import * as signup from '../../../console/src/features/signup/model.js';
import * as setup from '../../../console/src/features/setup/model.js';
import * as ai from '../../../console/src/features/ai-replies/model.js';
import * as wa from '../../../console/src/features/whatsapp/model.js';
import { parseSignupMessage } from '../../../console/src/features/whatsapp/embedded.js';
import * as feed from '../../../console/src/features/team-feed/model.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FEATURES = ['billing', 'signup', 'setup', 'referrals', 'ai-replies', 'whatsapp', 'team-feed'];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const files = FEATURES.flatMap((name) => walk(path.join(repoRoot, 'console/src/features', name))).filter((file) => /\.(jsx?|css)$/.test(file))
  .map((file) => ({ name: path.relative(path.join(repoRoot, 'console/src/features'), file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const code = files.filter(({ name }) => /\.jsx?$/.test(name));

const addon = (over) => ({ code: 'x', name: 'X', kind: 'addon', pricePaise: 10_000, cycle: 'monthly', feature: null, minPlan: 't1', includedFrom: null, meter: null, units: null, many: false, available: true, unavailable: null, ...over });
const CATALOG = BillingCatalog.parse({
  plans: PLANS.map((code, rank) => ({ code, name: code.toUpperCase(), rank, monthlyPaise: rank * 100_000, yearlyPaise: rank * 1_000_000, includedDms: rank === 5 ? null : 500 * (rank + 1), current: code === 't2' })),
  addons: [addon({ code: 'ai_replies', name: 'AI replies', includedFrom: 't4', feature: 'ai_replies' }), addon({ code: 'whatsapp', name: 'WhatsApp', includedFrom: 't5', feature: 'whatsapp_automation' }), addon({ code: 'dm_pack', name: 'DM pack', kind: 'pack', cycle: 'one_time', meter: 'dms', units: 1000 })],
  taxRateBp: 1800,
  offer: null,
});

test('values written in the console equal the server’s', () => {
  assert.deepEqual([...billing.PLAN_CODES], [...PLANS]);
  assert.deepEqual(Object.keys(billing.METER_LABELS), [...METERS]);
  assert.deepEqual([...signup.ACCOUNT_TYPES], [...SERVER_TYPES]);
  assert.deepEqual([...signup.SIGNUP_STEPS], [...SERVER_STEPS]);
  assert.deepEqual([...setup.OWN_KEY_PROVIDERS], [...SERVER_PROVIDERS]);
  assert.deepEqual(Object.keys(setup.KYC_WORDS).sort(), [...KYC_STATES].sort());
  assert.deepEqual(Object.keys(ai.OUTCOME_WORDS).sort(), [...AI_OUTCOMES].sort());
  assert.deepEqual([ai.AI_THRESHOLD.min, ai.AI_THRESHOLD.max], [SERVER_THRESHOLD.min, SERVER_THRESHOLD.max]);
  assert.deepEqual(wa.LIMITS, { keywordSets: WHATSAPP_LIMITS.keywordSets, keywordsPerSet: WHATSAPP_LIMITS.keywordsPerSet, keywordChars: WHATSAPP_LIMITS.keywordChars, messageChars: WHATSAPP_LIMITS.messageChars });
  assert.deepEqual([...wa.OPTIN_PURPOSES], [...WHATSAPP_OPTIN_PURPOSES]);
  assert.deepEqual(Object.keys(wa.SOURCE_WORDS).sort(), [...WHATSAPP_OPTIN_SOURCES].sort());
  assert.deepEqual(feed.SERVICE_KEYS, [...SERVICES]);
  assert.deepEqual(feed.STATE_KEYS, [...CHANGE_STATES]);
  assert.deepEqual(['plan.feature_off', 'plan.limit_reached'], [billing.PLAN_OFF, billing.LIMIT_REACHED]);
  for (const step of STEP_STATUSES) assert.ok(setup.statusView(step).badge, `a word for ${step}`);
  for (const id of STEP_NAMES) assert.ok(typeof id === 'string');
});

test('plan changes: kind, what switches off, and prices worked out from the server’s own two', () => {
  assert.equal(billing.changeKind(CATALOG, 't2', 't3'), 'upgrade');
  assert.equal(billing.changeKind(CATALOG, 't2', 't1'), 'downgrade');
  assert.equal(billing.changeKind(CATALOG, 't2', 't2'), 'same');
  assert.deepEqual(billing.switchesOff(CATALOG, 't5', 't3'), ['AI replies', 'WhatsApp']);
  assert.deepEqual(billing.switchesOff(CATALOG, 't5', 't4'), ['WhatsApp']);
  assert.deepEqual(billing.switchesOff(CATALOG, 't4', 't5'), [], 'an upgrade switches nothing off');
  assert.deepEqual(billing.switchesOff(CATALOG, 't2', 't1'), [], 'what the old plan never had does not switch off');
  const t2 = billing.planNamed(CATALOG, 't2');
  assert.equal(billing.priceFor(t2, 'monthly'), t2.monthlyPaise);
  assert.equal(billing.priceFor(t2, 'yearly'), t2.yearlyPaise);
  assert.equal(billing.yearlySaving(t2), t2.monthlyPaise * 12 - t2.yearlyPaise);
  assert.equal(billing.yearlySaving({ monthlyPaise: 100, yearlyPaise: 5000 }), 0, 'never a negative saving');
  const keys = new Set(Array.from({ length: 20 }, () => billing.newRequestKey()));
  assert.equal(keys.size, 20);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{8,80}$/, 'the key shape the server asks for');
});

test('the DM meter: tone, text and an unlimited plan', () => {
  const usage = BillingUsage.parse({
    month: '2026-11-01', resetsAt: '2026-12-01T00:00:00.000Z', heldDms: 2, canBuyPacks: true,
    meters: [
      { meter: 'dms', used: 410, included: 500, packUnits: 0, allowance: 500, left: 90, percent: 82, over: false },
      { meter: 'whatsapp_messages', used: 10, included: null, packUnits: 0, allowance: null, left: null, percent: 0, over: false },
      { meter: 'ai_units', used: 600, included: 500, packUnits: 0, allowance: 500, left: 0, percent: 120, over: true },
    ],
  });
  const [dms, whatsapp, aiUnits] = usage.meters.map(billing.meterView);
  assert.deepEqual([dms.tone, dms.percent, dms.text], ['warn', 82, '410 of 500 used']);
  assert.deepEqual([whatsapp.unlimited, whatsapp.left], [true, null]);
  assert.deepEqual([aiUnits.tone, aiUnits.percent], ['bad', 100], 'a bar never runs past its end');
});

test('upgrade prompts say what the server said, and only for the two plan refusals', () => {
  const off = { status: 403, code: 'plan.feature_off', plan: 't3', feature: 'coupons' };
  const full = { status: 403, code: 'plan.limit_reached', plan: 't2', feature: 'staff.seats', limit: 3, used: 3 };
  assert.ok(billing.isFeatureOff(off) && !billing.isLimitReached(off) && billing.isPlanProblem(off));
  assert.ok(billing.isLimitReached(full) && billing.isPlanProblem(full));
  for (const other of [{ status: 403, code: 'forbidden' }, { status: 403, code: 'reauth_required' }, { status: 401, code: 'plan.feature_off' }, null]) assert.equal(billing.isPlanProblem(other), false);
  assert.match(billing.promptText(off, { planNameOf: () => 'Growth' }).body, /Growth includes it/);
  assert.match(billing.promptText(full).body, /used all 3/);
  assert.ok(billing.needsReauth({ code: 'reauth_required' }));
  assert.ok(billing.safeFileUrl('https://files.example/x.pdf') && billing.safeFileUrl('/files/x.pdf'));
  for (const bad of ['javascript:alert(1)', '//evil.example/x', 'data:text/html,x', '', undefined, 'http://plain.example']) assert.equal(billing.safeFileUrl(bad), false, String(bad));
});

test('the watcher raises one event for each plan refusal and leaves every other answer alone', async () => {
  const target = new EventTarget();
  const answers = [];
  const reply = (status, body, url = 'http://x.test/api/v1/faq') => {
    const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  target.fetch = async () => answers.shift();
  assert.equal(installUpgradeWatch(target), true);
  assert.equal(installUpgradeWatch(target), false, 'installed once');
  const seen = [];
  target.addEventListener(REFUSAL_EVENT, (event) => seen.push(event.detail));

  answers.push(reply(403, { error: 'Not on your plan', code: 'plan.feature_off', feature: 'ai_replies', plan: 't4' }));
  const first = await target.fetch('/api/v1/faq');
  assert.equal(first.status, 403);
  assert.equal((await first.json()).code, 'plan.feature_off', 'the screen can still read the answer');
  answers.push(reply(403, { error: 'Full', code: 'plan.limit_reached', feature: 'staff.seats', plan: 't2', limit: 3, used: 3 }));
  await target.fetch('/api/v1/team/invites');
  answers.push(reply(403, { error: 'No', code: 'forbidden' }));
  await target.fetch('/api/v1/faq');
  answers.push(reply(403, 'not json at all'));
  await target.fetch('/api/v1/faq');
  answers.push(reply(403, { code: 'plan.feature_off' }, 'http://other.example/page'));
  await target.fetch('http://other.example/page');
  answers.push(reply(200, { items: [] }));
  await target.fetch('/api/v1/faq');
  assert.deepEqual(seen.map((s) => [s.code, s.feature, s.plan]), [['plan.feature_off', 'ai_replies', 't4'], ['plan.limit_reached', 'staff.seats', 't2']]);
});

test('sign-up: the screen follows the server’s steps, and the forms agree with the server’s schemas', () => {
  const status = (over) => SignupStatus.parse({ mode: 'public', signedIn: true, open: true, runToken: 'run', tenantId: null, accountType: null, steps: [], next: 'account_type', ...over });
  const at = '2026-11-14T10:00:00.000Z';
  const steps = (...names) => names.map((step) => ({ step, at }));
  assert.equal(signup.screenFor(null), 'loading');
  assert.equal(signup.screenFor(status({ signedIn: false })), 'signin');
  assert.equal(signup.screenFor(status({ open: false })), 'closed');
  assert.equal(signup.screenFor(status({ steps: steps('opened', 'signed_in') })), 'type');
  assert.equal(signup.screenFor(status({ tenantId: 4, steps: steps('opened', 'signed_in', 'account_type') })), 'instagram');
  assert.equal(signup.screenFor(status({ tenantId: 4, steps: steps('account_type', 'instagram_connected', 'automation_drafted') })), 'automation');
  assert.equal(signup.screenFor(status({ tenantId: 4, steps: steps('account_type', 'instagram_connected', 'automation_live') })), 'finish');
  assert.equal(signup.screenFor(status({ tenantId: 4, open: false, steps: steps('finished') })), 'done');

  const start = { accountType: 'seller', name: ' Kesar Kitchen ' };
  assert.deepEqual(signup.checkStart(start), {});
  assert.ok(SignupStart.safeParse({ ...start, name: start.name.trim() }).success);
  assert.deepEqual(Object.keys(signup.checkStart({ accountType: '', name: ' ' })).sort(), ['accountType', 'name']);
  assert.equal(SignupStart.safeParse({ accountType: 'x', name: 'A' }).success, false);

  const automation = { mediaId: '17900', keyword: 'LINK', link: 'https://kesar.in/p' };
  assert.deepEqual(signup.checkAutomation(automation), {});
  assert.ok(SignupFirstAutomation.safeParse({ runToken: 'r', ...automation }).success);
  for (const bad of [{ mediaId: '' }, { keyword: '  ' }, { link: 'http://kesar.in' }, { link: 'kesar.in' }]) {
    assert.ok(Object.keys(signup.checkAutomation({ ...automation, ...bad })).length, JSON.stringify(bad));
  }
  const result = SignupAutomationResult.parse({ automationId: null, live: false, problems: [{ field: 'link', reason: 'link.shortener', message: 'Use your own link, not a shortened one.' }] });
  assert.deepEqual(signup.problemsByField(result.problems), { link: 'Use your own link, not a shortened one.' });
  assert.equal(signup.minutes(10 * 60_000), 10);
});

test('setup: progress counts only required steps, and the address and key forms agree with the server', () => {
  const step = (name, status, required = true) => ({ step: name, label: name, required, status, checkedAt: null, code: '', reason: '', fix: '' });
  const checklist = SetupChecklist.parse({ plan: 't3', done: false, checkoutOpen: false, kyc: null, steps: [step('instagram', 'done'), step('terms', 'done'), step('payments', 'waiting'), step('shipping', 'pending'), step('own_keys', 'pending', false)] });
  assert.deepEqual([setup.progress(checklist).done, setup.progress(checklist).total, setup.progress(checklist).next.step], [2, 4, 'payments']);
  const address = { name: 'Asha Rao', phone: '9876543210', email: '', line1: '12 Raja Park', line2: '', city: 'Jaipur', state: 'Rajasthan', pincode: '302004' };
  assert.deepEqual(setup.checkPickup(address), {});
  assert.ok(PickupAddress.safeParse(address).success);
  for (const bad of [{ phone: '12345' }, { pincode: '3020' }, { line1: ' ' }, { email: 'nope' }, { city: '' }]) {
    assert.ok(Object.keys(setup.checkPickup({ ...address, ...bad })).length, JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(setup.EMPTY_PICKUP), Object.keys(address));
  const keys = { provider: 'razorpay', keyId: 'rzp_test_abc', keySecret: 'secret-value' };
  assert.deepEqual(setup.checkKeys(keys), {});
  assert.ok(OwnKeys.safeParse(keys).success);
  assert.deepEqual(Object.keys(setup.checkKeys({ provider: 'x', keyId: '', keySecret: '' })).sort(), ['keyId', 'keySecret', 'provider']);
});

test('AI replies: the checks, the words for every reason a test answer would not be sent', () => {
  assert.deepEqual(ai.checkFaq({ question: 'Delivery time?', answer: '3 days' }), {});
  assert.deepEqual(Object.keys(ai.checkFaq({ question: '', answer: 'x'.repeat(1001) })).sort(), ['answer', 'question']);
  assert.equal(ai.checkQuestion('   '), 'Write a question.');
  assert.equal(ai.checkQuestion('hi'), '');
  assert.ok(ai.thresholdOk(0.8) && ai.thresholdOk(0.5) && ai.thresholdOk(1) && !ai.thresholdOk(0.49) && !ai.thresholdOk(NaN));
  for (const reason of ['ai.low_confidence', 'ai.ungrounded', 'ai.handoff', 'ai.provider_failed']) assert.ok(!ai.reasonWords(reason).includes('ai.'), reason);
  assert.equal(ai.percent(0.834), '83%');
  assert.equal(ai.percent(null), 'No score');
});

test('WhatsApp keyword sets: exactly one of a reel or a link, and what the form sends passes the server’s schema', () => {
  const link = { ...wa.blankSet(), keywordsText: ' link, LINK ,price', target: 'link', linkUrl: 'https://kesar.in/p', message: 'Here: {link}' };
  const reel = { ...wa.blankSet(), id: 7, keywordsText: 'shop', target: 'reel', reelId: '12', linkUrl: 'https://ignored.example' };
  assert.deepEqual(wa.checkSets([link, reel]), {});
  assert.deepEqual(wa.toServer(link), { keywords: ['link', 'LINK', 'price'], reelId: null, linkUrl: 'https://kesar.in/p', message: 'Here: {link}', active: true });
  assert.deepEqual(wa.toServer(reel), { id: 7, keywords: ['shop'], reelId: 12, linkUrl: '', message: '', active: true }, 'a reel set sends no link');
  assert.ok(WhatsappKeywordsSave.safeParse({ items: [link, reel].map(wa.toServer) }).success);
  const bad = wa.checkSets([{ ...link, keywordsText: '' }, { ...link, linkUrl: 'http://x.example' }, { ...reel, reelId: '' }]);
  assert.deepEqual(Object.keys(bad).sort(), ['0.keywords', '1.linkUrl', '2.reelId']);
  assert.equal(wa.checkSets(Array.from({ length: 51 }, () => link)).list, 'Use 50 keyword sets or fewer.');
  assert.deepEqual(wa.move([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(wa.move([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.equal(wa.fromServer({ id: 3, keywords: ['a', 'b'], reelId: 9, linkUrl: '', message: '', active: false }).target, 'reel');
});

test('WhatsApp sign-up messages count only from Meta’s own origin', () => {
  const finish = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '12345678', phone_number_id: '87654321' } };
  assert.deepEqual(parseSignupMessage({ origin: 'https://www.facebook.com', data: JSON.stringify(finish) }), { done: true, wabaId: '12345678', phoneNumberId: '87654321' });
  assert.deepEqual(parseSignupMessage({ origin: 'https://web.facebook.com', data: finish }), { done: true, wabaId: '12345678', phoneNumberId: '87654321' });
  assert.deepEqual(parseSignupMessage({ origin: 'https://www.facebook.com', data: { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL' } }), { done: false });
  assert.equal(parseSignupMessage({ origin: 'https://evil.example', data: finish }), null);
  assert.equal(parseSignupMessage({ origin: 'https://www.facebook.com', data: 'not json' }), null);
  assert.equal(parseSignupMessage({ origin: 'https://www.facebook.com', data: { type: 'OTHER' } }), null);
});

test('the team feed offers undo, approve and reject only where they can work, and shows a short summary', () => {
  const change = (over) => ({ id: 1, service: 'reel_management', taskRef: 'T-1', routeId: 'automations.update', target: 'LINK', before: { keyword: 'a', active: true }, after: { keyword: 'b', active: true }, state: 'applied', canUndo: true, createdAt: '2026-11-14T10:00:00.000Z', decidedAt: null, undoneAt: null, ...over });
  assert.deepEqual(feed.actionsFor(change({})), ['undo']);
  assert.deepEqual(feed.actionsFor(change({ canUndo: false })), []);
  assert.deepEqual(feed.actionsFor(change({ state: 'draft', canUndo: false })), ['approve', 'reject']);
  for (const state of ['rejected', 'undone']) assert.deepEqual(feed.actionsFor(change({ state })), []);
  assert.deepEqual(feed.summarize(change({})), [{ field: 'keyword', before: 'a', after: 'b' }]);
  assert.equal(feed.summarize(change({ before: null, after: { name: 'x'.repeat(200) } }))[0].after.length, 70, 'long values are cut');
  assert.equal(feed.summarize(change({ before: null, after: null })).length, 0);
  assert.equal(feed.actionWords('automations.update'), 'Changed an automation');
  assert.equal(feed.actionWords('products.create'), 'Added a product');
});

test('every call a screen makes is a real API client method and a real route', () => {
  const client = createApiClient({ baseUrl: 'http://x.test/api/v1', fetch: async () => new Response('{}') });
  const known = Object.values(routes).length;
  assert.ok(known > 100);
  const used = new Set();
  for (const { text } of code) for (const [, group, method] of text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)\b/g)) used.add(`${group}.${method}`);
  assert.ok(used.size >= 30, `the screens make ${used.size} calls`);
  for (const call of used) {
    const [group, method] = call.split('.');
    assert.equal(typeof client[group]?.[method], 'function', `api.${call} exists`);
  }
  for (const route of ['billing.change', 'billing.addItem', 'billing.removeItem', 'billing.paymentMethod', 'setup.ownKeys', 'whatsapp.connectStart', 'whatsapp.connectFinish', 'whatsapp.disconnect']) {
    assert.equal(routes[route].fresh, true, `${route} is a fresh route`);
  }
});

test('no price, limit or plan name is typed into a screen, and money is changed only behind a fresh check', () => {
  for (const { name, text } of code) {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(stripped, /[₹]\s*\d/, `${name}: a rupee amount written in a screen`);
    assert.doesNotMatch(stripped, /\bRs\.?\s*\d/, `${name}: an amount written in a screen`);
    assert.doesNotMatch(stripped, /formatPaise\(\s*\d/, `${name}: a literal amount passed to the formatter`);
    assert.doesNotMatch(stripped, /(Paise|pricePaise|amount)\s*[:=]\s*\d{2,}/, `${name}: a literal amount`);
    assert.doesNotMatch(stripped, /\b(Starter|Growth|Pro|Business)\s+plan\b/i, `${name}: a plan name written in a screen`);
    assert.doesNotMatch(stripped, /console\.(log|info|debug)/, `${name}: logs`);
    assert.doesNotMatch(stripped, /dangerouslySetInnerHTML/, `${name}: raw HTML`);
  }
  const page = code.find(({ name }) => name === 'billing/BillingPage.jsx').text;
  for (const call of ['api.billing.change', 'api.billing.addItem', 'api.billing.removeItem', 'api.billing.paymentMethod']) {
    const at = page.indexOf(call);
    assert.ok(at > 0, call);
    assert.match(page.slice(Math.max(0, at - 160), at), /money\.run\(|fresh\.run\(/, `${call} runs behind the fresh check`);
  }
  assert.doesNotMatch(page, /card(Number|Cvv|Expiry)|type="(password|tel)"[^>]*card/i, 'no card fields: the payment method opens the provider’s page');
});

test('every screen has its loading, empty and failed states, and each feature registers a route', () => {
  const pages = code.filter(({ name }) => /Page\.jsx$/.test(name));
  assert.equal(pages.length, FEATURES.length);
  for (const { name, text } of pages) {
    assert.match(text, /Screen|ErrorState|isError/, `${name}: failed state`);
    assert.match(text, /Spinner|Screen/, `${name}: loading state`);
  }
  for (const feature of FEATURES) {
    const index = code.find(({ name }) => name === `${feature}/index.jsx`);
    assert.ok(index, `${feature} registers itself`);
    assert.match(index.text, /access:/, `${feature} names who may open it`);
    assert.match(index.text, /routes: \[\{ path: '/, `${feature} has a route`);
  }
  for (const name of ['ai-replies/AiRepliesPage.jsx', 'whatsapp/WhatsappPage.jsx', 'team-feed/TeamFeedPage.jsx', 'billing/BillingPage.jsx']) {
    assert.match(code.find((file) => file.name === name).text, /EmptyState/, `${name}: empty state`);
  }
});

test('the test question shows sources and score and sends nothing', () => {
  const text = code.find(({ name }) => name === 'ai-replies/AiRepliesPage.jsx').text;
  assert.match(text, /api\.aiReplies\.testQuestion/);
  assert.match(text, /Sources/);
  assert.match(text, /percent\(result\.score\)/);
  assert.match(text, /Nothing is sent to anyone/);
  assert.doesNotMatch(text, /api\.(inbox|dm|messages|send)\./, 'the screen has no route that sends');
});
