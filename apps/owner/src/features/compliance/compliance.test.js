import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import compliance from './index.js';
import inbox from '../inbox/index.js';
import { MANAGER, callsTo, minutesAgo, openAt, page, reset, staff, writes } from './testing.js';
import { refusalOf } from './kit.js';
import { capsToOverrides, overallStatus, overrideTyped, statusNotices } from './notices.js';
import { REASON_STRINGS, describeOutcome, describeReason } from './reasons.js';

jest.setTimeout(30000);
beforeEach(reset);

const STATUS = { paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 2, gates: [{ code: 'gate.access_level', passed: true }, { code: 'gate.privacy_url', passed: false }] };
const CONNECTION = { status: 'active', igUserId: '1', username: 'kesar', loginKind: 'instagram', scopes: [], missingScopes: [], insightsGranted: true, tokenExpiresAt: null, health: 'ok', webhooksSubscribed: true };
const SETTINGS = { dryRun: false, disclosureEnabled: true, utmEnabled: true, capOverrides: {} };

function routes(state, extra = {}) {
  return {
    'GET /compliance/status': () => state.status,
    'POST /compliance/pause': (call) => {
      state.status = { ...state.status, paused: true, pausedBy: 'owner', pauseStore: call.body.pauseStore };
      return state.status;
    },
    'POST /compliance/resume': () => {
      state.status = { ...state.status, paused: false, pausedBy: null };
      return state.status;
    },
    'POST /compliance/slow-mode/override': () => ({ ...state.status, slowMode: { active: false, until: null, canOverride: false } }),
    'GET /compliance/held-jobs': () => page([{ id: 1, kind: 'private_reply', automationId: 12, reason: 'held', heldAt: minutesAgo(30), expiresAt: minutesAgo(-600) }]),
    'POST /compliance/held-jobs/discard': () => ({ discarded: 1 }),
    'GET /compliance/activity': () => page([
      { id: 9, at: minutesAgo(2), channel: 'instagram', kind: 'private_reply', outcome: 'skipped', reason: 'cap.per_media', automationId: 12, mediaId: '1790001', commentId: '1789550' },
      { id: 8, at: minutesAgo(9), channel: 'instagram', kind: 'private_reply', outcome: 'sent', reason: '', automationId: 12, mediaId: '1790001', commentId: '1789549' },
    ]),
    'GET /compliance/settings': () => SETTINGS,
    'PATCH /compliance/settings': (call) => ({ ...SETTINGS, ...call.body }),
    'GET /compliance/words': () => ({ base: ['stop', 'unsubscribe'], added: [{ id: 3, list: 'optout', word: 'bas' }] }),
    'POST /compliance/words': (call) => [201, { id: 4, ...call.body }],
    'DELETE /compliance/words/:id': () => null,
    'GET /instagram/connection': () => CONNECTION,
    'GET /facebook/connection': () => ({ enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null }),
    ...extra,
  };
}

async function open(path, { status = STATUS, extra, ...options } = {}) {
  const state = { status };
  return { ...(await openAt(path, { list: [compliance, inbox], routes: routes(state, extra), ...options })), state };
}

test('the status says whether messages are going, what is held, and Meta’s checks', async () => {
  await open('/compliance');
  expect(await screen.findByTestId('compliance-hero')).toBeTruthy();
  expect(screen.getByTestId('compliance-badge')).toBeTruthy();
  expect(await screen.findByTestId('held-1')).toBeTruthy();
  expect(screen.getByTestId('gate-gate.privacy_url')).toBeTruthy();
});

test('pausing every message asks first, then the owner can resume', async () => {
  const { server } = await open('/compliance');
  await fireEvent.press(await screen.findByTestId('compliance-pause'));
  expect(writes(server)).toEqual([]);
  await fireEvent.press(screen.getByTestId('compliance-pause-confirm-confirm'));
  await waitFor(() => expect(callsTo(server, 'POST', '/compliance/pause').map((c) => c.body)).toEqual([{ pauseStore: false }]));
  await fireEvent.press(await screen.findByTestId('compliance-resume'));
  await waitFor(() => expect(callsTo(server, 'POST', '/compliance/resume')).toHaveLength(1));
});

test('a pause by support shows, and nobody here can lift it', async () => {
  await open('/compliance', { status: { ...STATUS, paused: true, pausedBy: 'ops', canResume: false } });
  expect(await screen.findByTestId('compliance-support-pause')).toBeTruthy();
  expect(screen.queryByTestId('compliance-resume')).toBeNull();
});

test('staff read the status but pausing is the owner’s and managers’', async () => {
  await open('/compliance', { user: staff(['automations']) });
  expect(await screen.findByTestId('compliance-managers-only')).toBeTruthy();
  expect(screen.queryByTestId('compliance-pause')).toBeNull();
  expect(screen.queryByTestId('compliance-discard')).toBeNull();
});

test('slow mode from a reach drop: only the owner may override it, and only with the word typed', async () => {
  const slow = { ...STATUS, slowMode: { active: true, until: minutesAgo(-300), canOverride: true } };
  const { server } = await open('/compliance', { status: slow });
  expect(await screen.findByTestId('compliance-slow-override')).toBeTruthy();
  expect(screen.getByTestId('compliance-slow-override').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('compliance-slow-typed'), ' Override ');
  await fireEvent.press(screen.getByTestId('compliance-slow-override'));
  await waitFor(() => expect(callsTo(server, 'POST', '/compliance/slow-mode/override').map((c) => c.body)).toEqual([{ confirmation: 'Override' }]));
});

test('a manager sees slow mode but not the override', async () => {
  await open('/compliance', { user: MANAGER, status: { ...STATUS, slowMode: { active: true, until: null, canOverride: true } } });
  expect(await screen.findByTestId('compliance-slow')).toBeTruthy();
  expect(screen.queryByTestId('compliance-slow-override')).toBeNull();
});

test('a refusal from the server keeps the screen and says why in the engine’s words', async () => {
  await open('/compliance', { extra: { 'POST /compliance/pause': () => [409, { error: 'Already paused', code: 'conflict', reason: 'paused.owner' }] } });
  await fireEvent.press(await screen.findByTestId('compliance-pause'));
  await fireEvent.press(screen.getByTestId('compliance-pause-confirm-confirm'));
  expect(await screen.findByTestId('compliance-pause-refusal')).toBeTruthy();
  expect(screen.getByTestId('compliance-pause-refusal-code')).toBeTruthy();
});

test('the log gives each decision with its reason, and opens “Why no DM?” for a comment', async () => {
  await open('/compliance/log');
  expect(await screen.findByTestId('log-9')).toBeTruthy();
  expect(screen.getByText('This person was already sent a DM for this post.')).toBeTruthy();
  expect(screen.getByTestId('log-9-code').props.children).toBe('cap.per_media');
  await fireEvent.press(screen.getByTestId('log-9-why'));
  expect(await screen.findByTestId('screen-why-no-dm')).toBeTruthy();
});

test('the rules: caps can only be lowered, and the rest saves in one change', async () => {
  const { server } = await open('/compliance/settings');
  await fireEvent.changeText(await screen.findByTestId('rules-cap.per_person_24h'), '9');
  await fireEvent.press(screen.getByTestId('rules-save'));
  expect(callsTo(server, 'PATCH', '/compliance/settings')).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('rules-cap.per_person_24h'), '2');
  await fireEvent.press(screen.getByTestId('rules-dry-run'));
  await fireEvent.press(screen.getByTestId('rules-save'));
  await waitFor(() => expect(callsTo(server, 'PATCH', '/compliance/settings').map((c) => c.body)).toEqual([{ dryRun: true, disclosureEnabled: true, utmEnabled: true, capOverrides: { 'cap.per_person_24h': 2 } }]));
  expect(await screen.findByTestId('rules-saved')).toBeTruthy();
});

test('offline, the status shows what was saved and pausing is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/compliance', { network });
  await screen.findByTestId('compliance-pause');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('compliance-pause').props.accessibilityState.disabled).toBe(true);
  expect(writes(server)).toEqual([]);
});

// ---- the rules every screen uses to say a refusal ----

const t = (key, values) => `${key}${values ? JSON.stringify(values) : ''}`;

test('a refusal reads as the engine’s reason when it gave one, never as a stack or another business’s words', () => {
  expect(refusalOf(t, { status: 422, reason: 'link.shortener', message: 'x' })).toEqual({ text: 'compliance.reason.link.shortener', code: 'link.shortener' });
  expect(refusalOf(t, { status: 0, code: 'network' }).text).toBe('error.network');
  expect(refusalOf(t, { code: 'offline' }).text).toBe('offline.writeDisabled');
  expect(refusalOf(t, { status: 403, message: 'Order MM-9 belongs to someone else' }).text).toBe('error.forbidden');
  expect(refusalOf(t, { status: 500, message: 'TypeError at line 3' }).text).toBe('error.saveFailed');
  expect(refusalOf(t, { status: 409, message: 'Already done.' }).text).toBe('Already done.');
  expect(refusalOf(t, null)).toBeNull();
});

test('every reason and outcome has words in English and Hindi, and an unknown code is shown, not hidden', () => {
  expect(Object.keys(REASON_STRINGS.hi).sort()).toEqual(Object.keys(REASON_STRINGS.en).sort());
  expect(describeReason(t, 'something.new')).toBe('something.new');
  expect(describeOutcome(t, 'sent')).toEqual({ label: 'compliance.outcome.sent', tone: 'good' });
  expect(describeReason(t, '')).toBe('');
});

test('the notices: most serious first, one reconnect, and caps only lower', () => {
  const notices = statusNotices({ status: { ...STATUS, globalPause: true, paused: true, reconnectNeeded: true, breaker: 'open' }, connection: { ...CONNECTION, status: 'reconnect_needed' } });
  expect(notices.map((n) => n.key)).toEqual(['global', 'paused', 'reconnect', 'breaker']);
  expect(overallStatus(STATUS).badge).toBe('compliance.badge.running');
  expect(capsToOverrides({ 'cap.per_person_24h': '4' }).errors['cap.per_person_24h'].key).toBe('compliance.rules.onlyLower');
  expect(capsToOverrides({ 'cap.per_person_24h': '1', 'cap.dm_replies_24h': '' }).overrides).toEqual({ 'cap.per_person_24h': 1 });
  expect(overrideTyped(' OVERRIDE ')).toBe(true);
  expect(overrideTyped('overrid')).toBe(false);
});
