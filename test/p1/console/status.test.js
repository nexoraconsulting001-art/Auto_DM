// What the status banners, the compliance log, the connect screen and the inbox say, and that their lists match the server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ReturnTo, CONNECTION_STATUSES } from '../../../src/contracts/api/instagram.js';
import { WORD_LISTS as API_WORD_LISTS } from '../../../src/contracts/api/compliance.js';
import { NEEDS_HUMAN_KINDS, THREAD_STATUSES } from '../../../src/contracts/api/inbox.js';
import { COMPLIANCE_LIMITS as L, OUTCOMES, REASON_CODES, REASON_CODE_FAMILIES } from '../../../src/contracts/compliance.js';
import { GATE_LABELS, LOWERABLE_CAPS, SUPPORT_PAUSE, WORD_LISTS, capsToOverrides, logFilters, offersFacebook, overallStatus, overridesToCaps, statusNotices } from '../../../console/src/features/compliance/notices.js';
import { OUTCOME_CODES, REASON_LIST, describeOutcome, describeReason } from '../../../console/src/features/compliance/reasons.js';
import { RETURN_TO, SCOPE_LABELS, connectionView, returnBanner } from '../../../console/src/features/connect/connection.js';
import { MESSAGE_KIND, NEEDS_HUMAN_KIND, THREAD_FILTERS, THREAD_STATUS, handle, pauseLine } from '../../../console/src/features/inbox/views.js';

const BASIC = 'instagram_business_basic';
const MESSAGES = 'instagram_business_manage_messages';
const COMMENTS = 'instagram_business_manage_comments';
const INSIGHTS = 'instagram_business_manage_insights';

const healthyStatus = (changes = {}) => ({ paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 0, gates: [], ...changes });
const healthyConnection = (changes = {}) => ({ status: 'active', igUserId: '1', username: 'shop', loginKind: 'instagram', scopes: [BASIC, MESSAGES, COMMENTS, INSIGHTS], missingScopes: [], insightsGranted: true, tokenExpiresAt: new Date(Date.now() + 50 * 86_400_000).toISOString(), health: 'ok', webhooksSubscribed: true, ...changes });
const facebookOff = { enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null };

const keys = (notices) => notices.map((notice) => notice.key);
const params = (query) => new URLSearchParams(query);

test('PRD 4.16: every reason code and outcome has words, and nothing else does', () => {
  assert.deepEqual([...REASON_LIST].sort(), [...REASON_CODES].sort());
  assert.deepEqual([...OUTCOME_CODES].sort(), [...OUTCOMES].sort());
  for (const code of REASON_CODES) assert.notEqual(describeReason(code), code, `${code} is only its own name`);
  for (const code of OUTCOMES) assert.notEqual(describeOutcome(code).label, code, code);
});

test('no reason is empty, and a code the console doesn\'t know is shown as it is', () => {
  assert.equal(describeReason(''), '');
  assert.equal(describeReason('brand.new'), 'brand.new');
  assert.deepEqual(describeOutcome('brand_new'), { label: 'brand_new', tone: 'neutral' });
  assert.deepEqual(describeOutcome('gate.passed'), { label: 'Noted', tone: 'neutral' }, 'a row that records an event, not a send');
  assert.equal(describeReason('__proto__'), '__proto__', 'not a property of the table');
});

test('a healthy business sees no banner at all', () => {
  assert.deepEqual(statusNotices({ status: healthyStatus(), connection: healthyConnection(), facebook: facebookOff }), []);
});

test('nothing is claimed while the answers are still loading or have failed', () => {
  assert.deepEqual(statusNotices({}), []);
});

test('C-43: a pause by support says so, with no way to lift it', () => {
  for (const pausedBy of ['ops', 'billing']) {
    const [notice] = statusNotices({ status: healthyStatus({ paused: true, pausedBy, canResume: false }) });
    assert.equal(notice.text, SUPPORT_PAUSE);
    assert.equal(notice.text, 'Paused by support. Contact support.');
    assert.equal(notice.action, undefined);
  }
});

test('the owner\'s own pause points at where to lift it', () => {
  const [notice] = statusNotices({ status: healthyStatus({ paused: true, pausedBy: 'owner', canResume: true }) });
  assert.equal(notice.action.to, '/compliance');
});

test('one lost connection is one banner, however many signals report it', () => {
  const notices = statusNotices({ status: healthyStatus({ reconnectNeeded: true }), connection: healthyConnection({ status: 'reconnect_needed', missingScopes: [MESSAGES] }) });
  assert.deepEqual(keys(notices), ['reconnect']);
  assert.equal(notices[0].action.label, 'Reconnect Instagram');
  assert.equal(notices[0].action.to, '/connect');
  assert.deepEqual(keys(statusNotices({ connection: healthyConnection({ status: 'deauthorized' }) })), ['reconnect']);
});

test('a business that never connected gets no reconnect banner: Home already asks it to connect', () => {
  assert.deepEqual(statusNotices({ status: healthyStatus(), connection: { ...healthyConnection(), status: 'not_connected', missingScopes: [MESSAGES], insightsGranted: false } }), []);
});

test('C-53: a missing messages permission asks for a reconnect and names it', () => {
  const [notice] = statusNotices({ connection: healthyConnection({ scopes: [BASIC, COMMENTS, INSIGHTS], missingScopes: [MESSAGES] }) });
  assert.equal(notice.key, 'scopes');
  assert.match(notice.text, /messages/);
  assert.equal(notice.action.label, 'Reconnect Instagram');
});

test('C-54: insights denied says slow mode is on, once, and asks for a reconnect', () => {
  const notices = statusNotices({ status: healthyStatus({ slowMode: { active: true, until: null, canOverride: false } }), connection: healthyConnection({ scopes: [BASIC, MESSAGES, COMMENTS], missingScopes: [INSIGHTS], insightsGranted: false }) });
  assert.deepEqual(keys(notices), ['insights']);
  assert.match(notices[0].text, /slow mode/i);
  assert.equal(notices[0].action.label, 'Reconnect Instagram');
});

test('a connection running out warns before it breaks, counting the days', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const expiring = (days, health) => statusNotices({ now, connection: healthyConnection({ health, tokenExpiresAt: new Date(now + days * 86_400_000).toISOString() }) })[0];
  assert.match(expiring(10, 'amber').text, /10 days/);
  assert.equal(expiring(10, 'amber').tone, 'warn');
  assert.match(expiring(1, 'red').text, /1 day /);
  assert.equal(expiring(1, 'red').tone, 'bad');
});

test('FB-04: a lost Page warns about the Page, and leaves Instagram out of it', () => {
  const notices = statusNotices({ status: healthyStatus(), connection: healthyConnection(), facebook: { ...facebookOff, enabled: true, status: 'reconnect_needed' } });
  assert.deepEqual(keys(notices), ['facebook']);
  assert.match(notices[0].text, /Facebook/);
  assert.doesNotMatch(JSON.stringify(notices), /Reconnect Instagram/i);
});

test('FB-06: one optional Facebook card, only when Facebook is on and no Page is connected', () => {
  assert.equal(offersFacebook({ ...facebookOff, enabled: true }), true);
  assert.equal(offersFacebook(facebookOff), false);
  assert.equal(offersFacebook({ ...facebookOff, enabled: true, status: 'active' }), false);
  assert.equal(offersFacebook(undefined), false, 'a server without Facebook yet offers nothing');
  assert.deepEqual(statusNotices({ facebook: { ...facebookOff, enabled: true } }), [], 'the card is the only prompt');
});

test('the worst thing comes first', () => {
  const notices = statusNotices({ status: healthyStatus({ globalPause: true, paused: true, pausedBy: 'owner', reconnectNeeded: true, breaker: 'open', slowMode: { active: true, until: null, canOverride: false } }) });
  assert.deepEqual(keys(notices), ['global', 'paused', 'reconnect', 'breaker', 'slow']);
});

test('the headline matches what is stopping things', () => {
  assert.equal(overallStatus(healthyStatus()).title, 'Sending normally');
  assert.equal(overallStatus(healthyStatus({ paused: true, canResume: true })).title, 'You paused sending');
  assert.equal(overallStatus(healthyStatus({ paused: true, canResume: false })).title, 'Paused by support');
  assert.equal(overallStatus(healthyStatus({ globalPause: true, paused: true })).title, 'Paused by Bhava');
  assert.equal(overallStatus(healthyStatus({ reconnectNeeded: true })).title, 'Waiting for Instagram');
  assert.equal(overallStatus(healthyStatus({ breaker: 'half_open' })).title, 'Stopped after errors');
  assert.equal(overallStatus(healthyStatus({ slowMode: { active: true, until: null, canOverride: false } })).title, 'Sending slowly');
});

test('every gate has words, and the caps offered are the server\'s', () => {
  assert.deepEqual(Object.keys(GATE_LABELS).sort(), REASON_CODE_FAMILIES.gate.filter((code) => code !== 'gate.passed').sort());
  assert.deepEqual(Object.fromEntries(LOWERABLE_CAPS.map((cap) => [cap.code, cap.max])), {
    'cap.per_person_24h': L.capPerPerson24h,
    'cap.dm_replies_24h': L.capDmReplies24h,
    'cap.public_reply_media_h': L.publicRepliesPerMediaHour,
    'cap.public_reply_tenant_h': L.publicRepliesPerTenantHour,
  });
  for (const { code } of LOWERABLE_CAPS) assert.ok(REASON_CODE_FAMILIES.cap.includes(code), code);
  assert.deepEqual(WORD_LISTS.map((list) => list.code).sort(), [...API_WORD_LISTS].sort());
});

test('PRD 4.7: a limit can be lowered and never raised', () => {
  assert.deepEqual(capsToOverrides({ 'cap.per_person_24h': '2', 'cap.dm_replies_24h': '' }), { overrides: { 'cap.per_person_24h': 2 } });
  assert.deepEqual(capsToOverrides({ 'cap.per_person_24h': '0' }), { overrides: { 'cap.per_person_24h': 0 } }, 'zero is a real limit');
  assert.match(capsToOverrides({ 'cap.per_person_24h': '4' }).errors['cap.per_person_24h'], /most it can be is 3/);
  for (const bad of ['-1', '1.5', 'two']) assert.ok(capsToOverrides({ 'cap.per_person_24h': bad }).errors, bad);
});

test('saved limits show in the boxes, and a limit never set stays empty', () => {
  const boxes = overridesToCaps({ 'cap.per_person_24h': 0 });
  assert.equal(boxes['cap.per_person_24h'], '0');
  assert.equal(boxes['cap.dm_replies_24h'], '');
});

test('the log sends only filters the API can accept', () => {
  assert.deepEqual(logFilters(params('outcome=skipped&reason=cap.per_media&automationId=12&mediaId=abc')), { outcome: 'skipped', reason: 'cap.per_media', automationId: '12', mediaId: 'abc' });
  assert.deepEqual(logFilters(params('outcome=nope&reason=nope&automationId=abc')), {});
  assert.deepEqual(logFilters(params('automationId=0')), {});
  assert.deepEqual(logFilters(params(`mediaId=${'x'.repeat(81)}`)), {});
  assert.deepEqual(logFilters(params('')), {});
});

test('each connection state has a heading, a badge and the right button', () => {
  for (const status of CONNECTION_STATUSES) {
    const view = connectionView(healthyConnection({ status }));
    assert.ok(view.title && view.badge && view.tone, status);
  }
  assert.equal(connectionView(healthyConnection()).action, null, 'nothing to do when all is well');
  assert.equal(connectionView(healthyConnection({ missingScopes: [INSIGHTS] })).action, 'Reconnect Instagram');
  assert.equal(connectionView(healthyConnection({ status: 'reconnect_needed' })).action, 'Reconnect Instagram');
  assert.equal(connectionView(healthyConnection({ status: 'deauthorized' })).action, 'Reconnect Instagram');
  assert.equal(connectionView(healthyConnection({ status: 'not_connected' })).action, 'Connect Instagram');
  assert.equal(connectionView(healthyConnection()).title, '@shop');
});

test('health shows on the badge', () => {
  assert.equal(connectionView(healthyConnection({ health: 'amber' })).tone, 'warn');
  assert.equal(connectionView(healthyConnection({ health: 'red' })).tone, 'bad');
});

test('the four permissions, and never content publishing', () => {
  assert.deepEqual(SCOPE_LABELS.map((s) => s.scope).sort(), [BASIC, COMMENTS, INSIGHTS, MESSAGES].sort());
  assert.doesNotMatch(JSON.stringify(SCOPE_LABELS), /publish/i);
});

test('the way back from Meta is a page of this site the server accepts', () => {
  assert.equal(ReturnTo.parse(RETURN_TO), RETURN_TO);
});

test('every word the server can come back with has a banner, and an unknown one is never a success', () => {
  const source = fs.readFileSync(new URL('../../../src/modules/ig-connect/connect.js', import.meta.url), 'utf8');
  const words = new Set([...source.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]));
  words.add('connected').add('missing_scopes');
  assert.ok(words.size >= 6, [...words].join());
  words.delete('failed'); // the banner an unknown word falls back to
  for (const word of words) assert.notEqual(returnBanner(word), returnBanner('made_up'), `${word} has no banner of its own`);
});

test('banners for the way back', () => {
  assert.equal(returnBanner(null), null);
  assert.equal(returnBanner('connected').tone, 'good');
  assert.equal(returnBanner('missing_scopes').tone, 'warn');
  assert.equal(returnBanner('made_up').tone, 'bad');
  assert.equal(returnBanner('constructor').tone, 'bad', 'not a property of the table');
});

test('the inbox\'s lists match the server\'s', () => {
  assert.deepEqual(Object.keys(THREAD_STATUS).sort(), [...THREAD_STATUSES].sort());
  assert.deepEqual(Object.keys(NEEDS_HUMAN_KIND).sort(), [...NEEDS_HUMAN_KINDS].sort());
  assert.deepEqual(THREAD_FILTERS.map((f) => f.value).filter(Boolean).sort(), [...THREAD_STATUSES].sort());
  assert.deepEqual(Object.keys(MESSAGE_KIND).sort(), ['attachment', 'postback', 'story_mention', 'story_reply']);
});

test('A-40: the line above the composer says why automation stopped, and until when', () => {
  const when = () => '3 pm';
  assert.equal(pauseLine({ automationPausedUntil: null }, when), '');
  assert.equal(pauseLine({ automationPausedUntil: 'x', pauseReason: 'thread.owner_replied' }, when), 'You replied, so automation is paused here until 3 pm.');
  assert.equal(pauseLine({ automationPausedUntil: 'x', pauseReason: 'thread.handoff' }, when), 'They asked for a person, so automation is paused here until 3 pm.');
  assert.equal(pauseLine({ automationPausedUntil: 'x', pauseReason: '' }, when), 'Automation is paused here until 3 pm.');
});

test('someone with no display name still has a row', () => {
  assert.equal(handle('asha'), '@asha');
  assert.equal(handle(''), 'Instagram user');
});
