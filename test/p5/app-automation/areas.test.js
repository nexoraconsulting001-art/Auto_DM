// The owner app's automation side (PRD 10.4 parity; 5.11 and 5.13 for who sees what): home, automations, inbox,
// connect, compliance, links, alerts, activity, reels and domains. The screens are tested with jest beside the code
// (npm run test:apps); these run with the server's tests and load only modules that need no React Native, reading
// the rest as text. Each checks the app against the contract the server is built from, so the two cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { COMPLIANCE_LIMITS, OUTCOMES, REASON_CODES } from '../../../src/contracts/compliance.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { AUTOMATION_STATES, AutomationInput, LINK_TYPES as API_LINK_TYPES, TRIGGER_TYPES } from '../../../src/contracts/api/automations.js';
import { ReelSave } from '../../../src/contracts/api/reels.js';
import { checkParity, readPending } from '../../../tools/parity-check.mjs';
import {
  LIMITS, LINK_TYPES, STATES, TRIGGERS, byteLength, draftWarnings, formToAutomation, inputToIso, isoToInput, launchChecks, newForm, stateMoves, toggleMedia,
  trackingChanges, triggersFor,
} from '../../../apps/owner/src/features/automations/form.js';
import { NEW_REEL, formToReel } from '../../../apps/owner/src/features/reels/form.js';
import { OUTCOME_CODES, REASON_CODES as APP_REASONS, REASON_STRINGS, describeReason } from '../../../apps/owner/src/features/compliance/reasons.js';
import { LOWERABLE_CAPS, statusNotices } from '../../../apps/owner/src/features/compliance/notices.js';
import { checklistView, needsYou } from '../../../apps/owner/src/features/home/views.js';
import { alertLink } from '../../../apps/owner/src/features/alerts/links.js';
import { isMetaLogin } from '../../../apps/owner/src/features/connect/connection.js';
import { isCommentId } from '../../../apps/owner/src/features/inbox/views.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const { readAppFeatures, readConsolePages } = require('../../../tools/parity-read.cjs');

export const AREAS = ['home', 'automations', 'inbox', 'connect', 'compliance', 'links', 'alerts', 'activity', 'reels', 'domains'];
/** The route groups and console pages these areas answer for (PRD 10.4's parity list: automations, test mode, the inbox, alerts). */
export const GROUPS = ['automations.', 'testers.', 'iceBreakers.', 'inbox.', 'compliance.', 'instagram.', 'facebook.', 'links.', 'measurementIds.', 'alerts.', 'activity.', 'reels.', 'domains.'];
export const SINGLES = ['stats.dashboard', 'accountHealth.get', 'settings.setup'];
export const PAGES = /^console:\/(|activity|automations(\/:id)?|compliance(\/log|\/settings)?|connect|inbox(\/.*)?|reels(\/:id)?)$/;
const ours = (id) => GROUPS.some((group) => id.startsWith(group)) || SINGLES.includes(id) || PAGES.test(id);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = (area) => fs.readdirSync(path.join(ROOT, 'apps/owner/src/features', area)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'testing.js').map((f) => [`${area}/${f}`, read(`apps/owner/src/features/${area}/${f}`)]);
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---- parity (PRD 10.4, P-14, P-16) ----

test('P-16 every seller route and console page in these areas has an app screen, and each id a feature lists is real', () => {
  const app = readAppFeatures(ROOT);
  assert.deepEqual(app.problems, []);
  const pages = readConsolePages(ROOT).pages;
  const features = app.features.filter((feature) => AREAS.includes(feature.name));
  assert.equal(features.length, AREAS.length);
  const known = new Set([...routeList.map((route) => route.id), ...pages.map((page) => page.id)]);
  for (const feature of features) for (const id of feature.routeIds) assert.ok(known.has(id), `${feature.name} lists "${id}", which is not a route or a page`);

  const required = [...routeList.filter((route) => !route.consoleOnly).map((route) => route.id), ...pages.map((page) => page.id)].filter(ours);
  const mapped = new Set(app.features.flatMap((feature) => feature.routeIds));
  assert.deepEqual(required.filter((id) => !mapped.has(id)), [], 'a route or page in these areas has no app screen');
  assert.ok(required.includes('inbox.reply') && required.includes('console:/inbox/needs-human') && required.includes('testers.createCode'));
});

test('P-14 with what these areas map taken off the allowance, the parity check finds nothing missing here and nothing unknown', () => {
  const app = readAppFeatures(ROOT);
  const pending = readPending(ROOT);
  const mapped = new Set(app.features.flatMap((feature) => feature.routeIds));
  const trimmed = { ...pending, routes: pending.routes.filter((id) => !mapped.has(id)), pages: pending.pages.filter((id) => !mapped.has(id)) };
  const result = checkParity({ routes: routeList.map((route) => ({ ...route })), pages: readConsolePages(ROOT).pages, features: app.features, pending: trimmed });
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.missing.filter(ours), []);
  assert.deepEqual(result.stale, []);
});

// ---- the builder's rules agree with the contract ----

test('the builder’s limits, states, triggers and link types are the contract’s', () => {
  for (const name of ['textBytes', 'buttonTitleChars', 'keywordsMax', 'variantsMax', 'publicReplyMinVariants']) assert.equal(LIMITS[name], COMPLIANCE_LIMITS[name], name);
  assert.equal(LIMITS.followupMinMinutes * 60_000, COMPLIANCE_LIMITS.followupMinDelayMs);
  assert.deepEqual([...STATES], [...AUTOMATION_STATES]);
  assert.deepEqual(TRIGGERS.map((trigger) => trigger.value), [...TRIGGER_TYPES]);
  assert.deepEqual([...LINK_TYPES], [...API_LINK_TYPES]);
  for (const state of AUTOMATION_STATES) for (const next of stateMoves(state)) assert.ok(AUTOMATION_STATES.includes(next));
  const ice = /ICE_BREAKERS_MAX = (\d+)/.exec(read('apps/owner/src/features/automations/IceBreakersScreen.js'));
  assert.equal(Number(ice[1]), COMPLIANCE_LIMITS.iceBreakersMax);
});

function filled(changes = {}) {
  const form = { ...newForm(), name: 'Diwali box', keywords: ['SPICE'], linkUrl: 'https://kesar.example.com/spice', ...changes };
  form.variants = changes.variants ?? [{ label: 'A', body: 'Hi {first_name}! Here it is.', buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] }];
  return { ...form, ...toggleMedia(form, { id: '1790001', type: 'reel', caption: 'Spice box', permalink: '', thumbnailUrl: '' }), name: form.name };
}

test('a filled-in builder makes a body the API accepts, schedule and dry run included', () => {
  const { body, errors } = formToAutomation(filled({ dryRun: true, startsAt: '2026-12-01 09:00', endsAt: '2026-12-10 21:30', dailyStart: '09:00', dailyEnd: '21:00', keywordDraft: 'diya' }));
  assert.equal(errors, undefined);
  const parsed = AutomationInput.parse(body);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.keywords, ['SPICE', 'diya']);
  assert.equal(parsed.schedule.startsAt, '2026-12-01T09:00:00+05:30');
  assert.equal(parsed.triggers[0].mediaId, '1790001');
});

test('the builder reports every problem at once, as string keys, and sends nothing', () => {
  const { errors, body } = formToAutomation({ ...newForm(), followupEnabled: true, followupDelayMinutes: '5', dailyStart: '09:00', linkButtonTitle: 'x'.repeat(21) });
  assert.equal(body, undefined);
  assert.deepEqual(Object.keys(errors).sort(), ['followupDelayMinutes', 'followupText', 'keywords', 'linkButtonTitle', 'name', 'schedule', 'variants']);
  assert.equal(errors.schedule.key, 'automations.error.bothTimes');
  const tooLong = formToAutomation(filled({ variants: [{ label: 'A', body: 'क'.repeat(334), buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] }] }));
  assert.equal(tooLong.errors.variants.key, 'automations.error.tooLong'); // 334 Hindi letters are 1,002 bytes
  assert.equal(formToAutomation(filled({ endsAt: '2026-12-01 09:00', startsAt: '2026-12-02 09:00' })).errors.schedule.key, 'automations.error.endAfterStart');
  assert.equal(formToAutomation(filled({ startsAt: '2026-02-30 09:00' })).errors.startsAt.key, 'automations.error.when');
  assert.equal(formToAutomation(filled({ matchMode: 'any' })).errors.anyModeAcknowledged.key, 'automations.error.acknowledge');
  assert.equal(formToAutomation(filled({ publicReplyEnabled: true }), { replyCount: 2 }).errors.publicReplyEnabled.key, 'automations.error.replies');
});

test('bytes are counted the way Meta counts them, and India time survives a round trip', () => {
  for (const text of ['hello', 'नमस्ते', '👋 hi', '']) assert.equal(byteLength(text), Buffer.byteLength(text, 'utf8'));
  assert.equal(isoToInput(inputToIso('2026-12-01 09:05')), '2026-12-01 09:05');
  assert.equal(isoToInput('2026-12-01T00:00:00Z'), '2026-12-01 05:30');
  assert.equal(inputToIso(''), null);
});

test('warnings, launch checks, the plan’s triggers and the per-reel ids follow the console’s rules', () => {
  const warnings = draftWarnings(filled({ keywords: ['hi'], matchMode: 'keywords', variants: [{ label: 'A', body: 'Get it {url}', buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] }] }));
  assert.deepEqual(warnings.map((w) => w.code), ['single_variant', 'short_keyword', 'two_tap_url']);
  assert.ok(launchChecks(filled()).every((check) => check.ok));
  assert.equal(launchChecks({ ...newForm() }).find((check) => check.key === 'automations.check.media').ok, false);
  assert.deepEqual(triggersFor({ 'triggers.story_dm': false }).map((t) => t.value), ['comment', 'dm_keyword', 'dm_welcome']);
  assert.equal(triggersFor(null).length, 5);
  const amazon = filled({ linkType: 'amazon', trackingId: 'kesar-21', discountCode: '' });
  assert.deepEqual(trackingChanges(amazon, [{ id: 4, kind: 'discount_code', value: 'DIWALI' }]), [{ op: 'create', mediaId: '1790001', kind: 'amazon_tag', value: 'kesar-21' }, { op: 'remove', id: 4 }]);
  assert.deepEqual(trackingChanges({ ...amazon, media: [] }, []), []);
});

test('a reel store’s body is one the API accepts, and the default DM names only the seller', () => {
  const { body } = formToReel({ ...NEW_REEL, headline: 'Spice box', products: [{ id: 3 }], keywordDraft: 'spice' }, { permalink: 'https://www.instagram.com/reel/a', caption: 'c' });
  assert.deepEqual(ReelSave.parse(body).productIds, [3]);
  assert.doesNotMatch(NEW_REEL.dmMessage, /bhava/i);
  assert.doesNotMatch(`${newForm().tapButtonTitle} ${newForm().linkButtonTitle}`, /bhava/i);
});

// ---- the compliance engine's words ----

test('every reason code and outcome the engine sends has a sentence, in English and Hindi, the console’s English', () => {
  const missing = REASON_CODES.filter((code) => !APP_REASONS.includes(code));
  assert.deepEqual(missing, [], 'reason codes the app has no words for');
  for (const outcome of OUTCOMES) assert.ok(OUTCOME_CODES.includes(outcome), outcome);
  assert.deepEqual(Object.keys(REASON_STRINGS.hi).sort(), Object.keys(REASON_STRINGS.en).sort());
  const consoleWords = JSON.parse(read('console/src/features/compliance/reasons.json'));
  const t = (key) => REASON_STRINGS.en[key] ?? key;
  for (const [code, text] of Object.entries(consoleWords.reasons ?? {})) {
    if (typeof text === 'string' && APP_REASONS.includes(code)) assert.equal(describeReason(t, code), text, code);
  }
  for (const { code, max } of LOWERABLE_CAPS) assert.ok(REASON_CODES.includes(code) && max > 0, code);
});

test('the notices put a pause by support first and never offer it a resume', () => {
  const notices = statusNotices({ status: { paused: true, canResume: false, globalPause: false, breaker: 'closed', slowMode: { active: false } } });
  assert.deepEqual(notices.map((n) => [n.key, n.tone, Boolean(n.action)]), [['paused', 'bad', false]]);
});

// ---- the small rules each screen keeps ----

test('home, alerts, connect and the inbox keep to their rules', () => {
  assert.equal(checklistView({ dismissed: false, steps: [{ key: 'instagram', done: true }] }).visible, false);
  assert.deepEqual(needsYou({ stats: { toConfirm: 2, toShip: 0 }, waiting: null, user: { role: 'staff', permissions: ['analytics'] } }), []);
  assert.equal(alertLink({ kind: 'thread.handoff', target: '31' }), '/inbox/threads/31');
  assert.equal(alertLink({ kind: 'thread.handoff', target: '31/../../x' }), null);
  assert.equal(isMetaLogin('https://www.instagram.com/oauth/authorize?x=1'), true);
  assert.equal(isMetaLogin('https://instagram.com.attacker.example/oauth'), false);
  assert.equal(isMetaLogin('intent://www.instagram.com'), false);
  assert.equal(isCommentId('17895695668004550'), true);
  assert.equal(isCommentId('a/b'), false);
});

// ---- read as text: what the screens may never do ----

test('nothing in these areas logs, opens a web view, keeps tokens or data outside the cache, or links through a redirect', () => {
  for (const area of AREAS) {
    for (const [file, text] of sources(area)) {
      const code = withoutComments(text);
      assert.doesNotMatch(code, /\bconsole\.(log|info|warn|error|debug)\b/, `${file} writes to the console`);
      assert.doesNotMatch(code, /react-native-webview|<WebView/, `${file} draws a web view`);
      assert.doesNotMatch(code, /AsyncStorage|expo-secure-store|expo-sqlite/, `${file} keeps data outside the offline cache`);
      assert.doesNotMatch(code, /\/r\/\$\{|bit\.ly|tinyurl|redirect\?/, `${file} builds a short or redirect link`);
    }
  }
});

test('what a shopper would see from these screens never names the platform; the seller’s own screens may (P-67)', async () => {
  const { default: words } = await import('../../../apps/owner/src/features/automations/strings.js');
  // The DM previews' stand-in words and the defaults that become a shopper's DM.
  const shopperFacing = ['automations.preview.linkDefault', 'automations.link.type.bhava_page'];
  for (const locale of ['en', 'hi']) for (const key of shopperFacing) assert.doesNotMatch(words[locale][key], /bhava/i, key);
  const reels = read('apps/owner/src/features/reels/index.js');
  for (const key of ['reels.previewEmpty', 'reels.dmHint']) {
    const lines = reels.split('\n').filter((line) => line.trim().startsWith(`'${key}':`));
    assert.equal(lines.length, 2, `${key} in English and Hindi`);
    for (const line of lines) assert.doesNotMatch(line, /bhava/i, key);
  }
  for (const file of ['automations/panels.js', 'reels/ReelScreen.js']) {
    const preview = withoutComments(read(`apps/owner/src/features/${file}`));
    assert.ok(preview.includes('business?.name'), `${file} shows the seller's name in its DM preview`);
    assert.doesNotMatch(preview, /APP_NAME|Bhava/, `${file} names the platform in a DM preview`);
  }
});

test('the connect screen opens Meta’s login in an auth session in the system browser', () => {
  const screen = withoutComments(read('apps/owner/src/features/connect/ConnectScreen.js'));
  assert.match(screen, /openAuthSessionAsync\(authorizeUrl, OWNER_APP_CALLBACK\)/);
  assert.match(screen, /isMetaLogin\(authorizeUrl\)/);
});
