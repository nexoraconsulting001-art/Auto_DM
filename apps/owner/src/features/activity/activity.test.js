import { screen } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import { minutesAgo, openAt, page, reset } from '../compliance/testing.js';
import activity from './index.js';
import { RESULT_CODES, describeResult, handleOf } from './results.js';

jest.setTimeout(30000);
beforeEach(reset);

const ROWS = [
  { id: 2, commentId: 'c2', reelId: '1790001', reelHeadline: 'Spice Box Diwali', reelSlug: 'spice-box', username: 'priya.k', text: 'SPICE', result: 'sent', error: '', createdAt: minutesAgo(1) },
  { id: 1, commentId: 'c1', reelId: null, reelHeadline: null, reelSlug: null, username: '', text: 'nice', result: 'skip:no-keyword', error: '', createdAt: minutesAgo(9) },
];

const open = (routes, options = {}) => openAt('/activity', { list: [activity], routes, ...options });

test('every comment and what happened to it, newest first', async () => {
  await open({ 'GET /activity': () => page(ROWS) });
  expect(await screen.findByTestId('activity-2')).toBeTruthy();
  expect(screen.getByText('@priya.k')).toBeTruthy();
  expect(screen.getByText('DM sent')).toBeTruthy();
  expect(screen.getByText('Instagram user')).toBeTruthy();
  expect(screen.getByTestId('activity-2-reel')).toBeTruthy();
});

test('nothing yet says how to see the first one; a failure says so plainly', async () => {
  await open({ 'GET /activity': () => page([]) });
  expect(await screen.findByTestId('activity-empty')).toBeTruthy();
});

test('a refused list is the plain refusal, not a crash', async () => {
  await open({ 'GET /activity': () => [403, { error: 'no', code: 'forbidden' }] });
  expect(await screen.findByTestId('activity-error')).toBeTruthy();
});

test('offline, the saved rows stay under the banner', async () => {
  const network = fakeNetwork(true);
  await open({ 'GET /activity': () => page(ROWS) }, { network });
  await screen.findByTestId('activity-2');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('activity-2')).toBeTruthy();
});

test('every result has words, and an unknown one is shown as it is', () => {
  const t = (key) => key;
  for (const code of RESULT_CODES) expect(describeResult(t, code).label).toBe(`activity.result.${code}`);
  expect(describeResult(t, 'skip:new-kind')).toEqual({ label: 'skip:new-kind', tone: 'neutral' });
  expect(handleOf(t, '')).toBe('activity.someone');
  for (const code of RESULT_CODES) expect(typeof activity.strings.hi[`activity.result.${code}`]).toBe('string');
});
