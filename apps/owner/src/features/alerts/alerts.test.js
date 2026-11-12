import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import { callsTo, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import home from '../home/index.js';
import inbox from '../inbox/index.js';
import alerts from './index.js';
import { alertLink } from './links.js';

jest.setTimeout(30000);
beforeEach(reset);

const ALERTS = [
  { id: 3, kind: 'thread.handoff', severity: 'info', message: 'Someone asked to talk to a person. Their conversation is in “Needs a human”.', target: '31', createdAt: minutesAgo(2), readAt: null },
  { id: 2, kind: 'token.expiring', severity: 'warning', message: 'Your Instagram connection ends in 5 days.', target: '', createdAt: minutesAgo(600), readAt: minutesAgo(500) },
];

function routes(extra = {}) {
  return {
    'GET /alerts': () => page(ALERTS),
    'POST /alerts/:id/read': () => null,
    'GET /inbox/threads/:id': () => ({ id: 31, channel: 'instagram', username: 'priya.k', lastMessage: '', lastMessageAt: null, lastUserMessageAt: null, status: 'needs_human', automationPausedUntil: null, pauseReason: '', canReply: false, messages: [] }),
    ...extra,
  };
}

const open = (path = '/alerts', { extra, ...options } = {}) => openAt(path, { list: [alerts, inbox], routes: routes(extra), ...options });

test('alerts show newest first, unread marked, and “Mark as read” is sent once and sticks', async () => {
  const { server } = await open();
  expect(await screen.findByTestId('alert-3-unread')).toBeTruthy();
  expect(screen.queryByTestId('alert-2-unread')).toBeNull();
  await fireEvent.press(screen.getByTestId('alert-3-read'));
  await waitFor(() => expect(screen.queryByTestId('alert-3-unread')).toBeNull());
  expect(callsTo(server, 'POST', '/alerts/3/read')).toHaveLength(1);
});

test('an alert opens the record it is about', async () => {
  await open();
  await fireEvent.press(await screen.findByTestId('alert-3-open'));
  expect(await screen.findByTestId('screen-inbox-thread')).toBeTruthy();
});

test('no alerts says what would show here; a failed list says so with a retry', async () => {
  await open('/alerts', { extra: { 'GET /alerts': () => page([]) } });
  expect(await screen.findByTestId('alerts-empty')).toBeTruthy();
});

test('a list that fails shows the plain words and a retry', async () => {
  await open('/alerts', { extra: { 'GET /alerts': () => [404, { error: 'gone', code: 'not_found' }] } });
  expect(await screen.findByTestId('alerts-error')).toBeTruthy();
  expect(screen.getByTestId('alerts-error-retry')).toBeTruthy();
});

test('offline, saved alerts stay and marking read is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/alerts', { network });
  await screen.findByTestId('alert-3-read');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('alert-3-read').props.accessibilityState.disabled).toBe(true);
  expect(writes(server)).toEqual([]);
});

test('alerts are for those the API answers: staff with only orders have no alerts screen', async () => {
  const { server } = await open('/alerts', { user: staff(['orders']), list: [home, alerts] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-alerts')).toBeNull();
  expect(server.calls.some((c) => c.path === '/alerts')).toBe(false);
});

test('what each kind of alert opens, and nothing for a target that is not an id', () => {
  expect(alertLink({ kind: 'thread.handoff', target: '31' })).toBe('/inbox/threads/31');
  expect(alertLink({ kind: 'thread.handoff', target: '../x' })).toBeNull();
  expect(alertLink({ kind: 'token.expiring', target: '' })).toBe('/connect');
  expect(alertLink({ kind: 'domain.stopped', target: 'shop.example.com' })).toBe('/domains');
  expect(alertLink({ kind: 'paused.breaker', target: '' })).toBe('/compliance');
  expect(alertLink({ kind: 'something.else', target: '1' })).toBeNull();
});
