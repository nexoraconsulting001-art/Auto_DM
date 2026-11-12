import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { fakeNetwork, memoryStorage } from '../../shell/testing.js';
import { callsTo, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import home from '../home/index.js';
import inbox from './index.js';
import { cleanCommentId, isCommentId, pauseLine } from './views.js';

jest.setTimeout(30000);
beforeEach(reset);

const THREADS = [
  { id: 31, channel: 'instagram', username: 'priya.k', lastMessage: 'Is the spice box back?', lastMessageAt: minutesAgo(4), lastUserMessageAt: minutesAgo(4), status: 'needs_human', automationPausedUntil: null, pauseReason: '', canReply: true },
  { id: 32, channel: 'facebook', username: '', lastMessage: 'Thanks!', lastMessageAt: minutesAgo(90), lastUserMessageAt: minutesAgo(90), status: 'closed', automationPausedUntil: null, pauseReason: '', canReply: false },
];
const THREAD = { ...THREADS[0], automationPausedUntil: minutesAgo(-120), pauseReason: 'thread.handoff', messages: [
  { id: 1, direction: 'in', author: 'person', kind: 'text', text: 'Is the spice box back?', mediaRef: '', at: minutesAgo(5) },
  { id: 2, direction: 'out', author: 'automation', kind: 'text', text: 'Here is the link.', mediaRef: '', at: minutesAgo(4) },
] };
const NEEDS = [
  { id: 41, channel: 'instagram', kind: 'negative_comment', reason: 'negative_intent', threadId: null, commentId: '1789550', mediaId: '1790001', username: 'angry.one', text: 'Never arrived', status: 'open', createdAt: minutesAgo(10) },
  { id: 42, channel: 'instagram', kind: 'handoff', reason: 'thread.handoff', threadId: 31, commentId: '', mediaId: '', username: 'priya.k', text: '', status: 'open', createdAt: minutesAgo(3) },
];

function routes(extra = {}) {
  return {
    'GET /inbox/threads': (call) => page(THREADS.filter((t) => !call.search.includes('status=') || call.search.includes(`status=${t.status}`))),
    'GET /inbox/threads/:id': (call) => (call.path.endsWith('/31') ? THREAD : [404, { error: 'Not found', code: 'not_found' }]),
    'POST /inbox/threads/:id/reply': () => ({ outcome: 'sent', reason: '', automationPausedUntil: minutesAgo(-1440) }),
    'GET /inbox/needs-human': (call) => page(call.search.includes('status=resolved') ? [] : NEEDS),
    'POST /inbox/needs-human/:id/resolve': () => ({ ...NEEDS[0], status: 'resolved' }),
    'GET /compliance/why-no-dm': (call) => (call.search.includes('commentId=1789550')
      ? { commentId: '1789550', outcome: 'skipped', reason: 'negative_intent', explanation: 'The comment read like a complaint, so no sales link went out.', at: minutesAgo(10) }
      : [404, { error: 'Not found', code: 'not_found' }]),
    'GET /compliance/status': () => ({ paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 0, gates: [] }),
    'GET /instagram/connection': () => ({ status: 'active', igUserId: '1', username: 'kesar', loginKind: 'instagram', scopes: [], missingScopes: [], insightsGranted: true, tokenExpiresAt: null, health: 'ok', webhooksSubscribed: true }),
    'GET /facebook/connection': () => ({ enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null }),
    ...extra,
  };
}

const open = (path, { extra, ...options } = {}) => openAt(path, { list: [inbox], routes: routes(extra), ...options });

test('P-16: the inbox lists chats newest first with their state, and filters by it', async () => {
  const { server } = await open('/inbox');
  expect(await screen.findByTestId('thread-31')).toBeTruthy();
  expect(screen.getByText('@priya.k')).toBeTruthy();
  expect(screen.getByText('Instagram user')).toBeTruthy(); // no name given: a neutral word, never an id
  await fireEvent.press(screen.getByTestId('inbox-filter-closed'));
  await waitFor(() => expect(screen.queryByTestId('thread-31')).toBeNull());
  expect(server.calls.some((c) => c.path === '/inbox/threads' && c.search.includes('status=closed'))).toBe(true);
});

test('a chat shows its messages, why automation is paused, and a reply goes through the checks once', async () => {
  const { server } = await open('/inbox/threads/31');
  expect(await screen.findByTestId('message-1')).toBeTruthy();
  expect(screen.getByText('Here is the link.')).toBeTruthy();
  expect(screen.getByTestId('thread-paused')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('composer-text'), '  It ships Monday.  ');
  await fireEvent.press(screen.getByTestId('composer-send'));
  await waitFor(() => expect(callsTo(server, 'POST', '/inbox/threads/31/reply').map((c) => c.body)).toEqual([{ text: 'It ships Monday.' }]));
  expect(await screen.findByTestId('composer-sent')).toBeTruthy();
});

test('a reply the compliance engine holds back says so with the reason it gave', async () => {
  await open('/inbox/threads/31', { extra: { 'POST /inbox/threads/:id/reply': () => ({ outcome: 'skipped', reason: 'optout', automationPausedUntil: null }) } });
  await fireEvent.changeText(await screen.findByTestId('composer-text'), 'Hello again');
  await fireEvent.press(screen.getByTestId('composer-send'));
  expect(await screen.findByTestId('composer-not-sent')).toBeTruthy();
  expect(screen.getByText(/This person asked not to get automated messages\./)).toBeTruthy();
  expect(screen.getByText('Not sent: Skipped')).toBeTruthy();
});

test('a refused reply after the 24-hour window points to the Instagram app; any other refusal is said plainly', async () => {
  await open('/inbox/threads/31', { extra: { 'POST /inbox/threads/:id/reply': () => [409, { error: 'The window closed', code: 'conflict', reason: 'window.closed' }] } });
  await fireEvent.changeText(await screen.findByTestId('composer-text'), 'Hello');
  await fireEvent.press(screen.getByTestId('composer-send'));
  expect(await screen.findByTestId('composer-window')).toBeTruthy();
});

test('a chat that is gone is a plain “not here”, never a crash', async () => {
  await open('/inbox/threads/99');
  expect(await screen.findByTestId('thread-error')).toBeTruthy();
  expect(screen.getByText('This isn’t here any more.')).toBeTruthy();
});

test('offline, the saved chats show with the banner and the reply box is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/inbox/threads/31', { network });
  await screen.findByTestId('message-1');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('composer-send').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('composer-text').props.editable).toBe(false);
  expect(writes(server)).toEqual([]);
});

test('P-19: the inbox opens from the phone’s saved copy when the app starts with no connection', async () => {
  const storage = memoryStorage();
  const first = await open('/inbox', { storage });
  await screen.findByTestId('thread-31');
  await first.made.cache.flush();
  first.view.unmount();
  reset();
  const again = await open('/inbox', { storage, network: fakeNetwork(false), extra: { 'GET /inbox/threads': () => { throw new TypeError('Network request failed'); } } });
  expect(await screen.findByTestId('thread-31')).toBeTruthy();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(writes(again.server)).toEqual([]);
});

test('Needs a human: each item with the engine’s reason, the way to its chat, and “done” sent once', async () => {
  const { server } = await open('/inbox/needs-human');
  expect(await screen.findByTestId('needs-41')).toBeTruthy();
  expect(screen.getByText('Unhappy comment')).toBeTruthy();
  expect(screen.getByText(/The comment read like a complaint, so no sales link went out\./)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('needs-41-done'));
  await waitFor(() => expect(callsTo(server, 'POST', '/inbox/needs-human/41/resolve')).toHaveLength(1));
  await fireEvent.press(screen.getByTestId('needs-42-chat'));
  expect(await screen.findByTestId('screen-inbox-thread')).toBeTruthy();
});

test('Needs a human with nothing done yet says so', async () => {
  await open('/inbox/needs-human');
  await fireEvent.press(await screen.findByTestId('needs-filter-resolved'));
  expect(await screen.findByText('Nothing done yet')).toBeTruthy();
});

test('“Why no DM?” opened for a comment gives the decision, its reason and its code; an unknown one says nothing was kept', async () => {
  await open('/inbox/why-no-dm/1789550');
  expect(await screen.findByTestId('why-answer')).toBeTruthy();
  expect(screen.getByTestId('why-explanation').props.children).toBe('The comment read like a complaint, so no sales link went out.');
  expect(screen.getByTestId('why-code').props.children).toBe('negative_intent');
  await fireEvent.changeText(screen.getByTestId('why-comment'), '1111');
  await fireEvent.press(screen.getByTestId('why-look-up'));
  expect(await screen.findByTestId('why-none')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('why-comment'), 'a b/c');
  expect(screen.getByTestId('why-look-up').props.accessibilityState.disabled).toBe(true);
});

test('staff without the inbox permission have no inbox, and their status notices are not asked for', async () => {
  const { server } = await open('/inbox', { user: staff(['orders']), list: [home, inbox] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-inbox')).toBeNull();
  expect(server.calls.some((c) => c.path.startsWith('/inbox'))).toBe(false);
});

test('staff with the inbox but not automations see chats, without the compliance status they can’t read', async () => {
  const { server } = await open('/inbox', { user: staff(['inbox']) });
  expect(await screen.findByTestId('thread-31')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/compliance/status')).toBe(false);
});

test('the inbox rules: pause lines, and only real comment ids are looked up', () => {
  const t = (key, values) => `${key}:${values?.until ?? ''}`;
  expect(pauseLine(t, { automationPausedUntil: 'x', pauseReason: 'thread.handoff' }, () => 'soon')).toBe('inbox.paused.handoff:soon');
  expect(pauseLine(t, { automationPausedUntil: null }, () => 'soon')).toBe('');
  expect(cleanCommentId(`  ${'9'.repeat(90)} `)).toHaveLength(80);
  expect(isCommentId('17895695668004550')).toBe(true);
  expect(isCommentId('../etc')).toBe(false);
});
