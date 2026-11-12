import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { SHOP_A } from '../../shell/testing.js';
import { MANAGER, callsTo, daysFromNow, minutesAgo, openAt, page, reset, screenText, staff, writes } from '../compliance/testing.js';
import home from './index.js';
import { checklistView, needsYou, renewalDays } from './views.js';

jest.setTimeout(30000);
beforeEach(reset);

const STATS = { dms: 1284, dmsToday: 42, visits: 912, visitsToday: 30, orders: 214, ordersToday: 7, revenuePaise: 18642000, toConfirm: 2, toShip: 3, products: 40 };
const HEALTH = { score: 72, band: 'watch', deductions: [{ code: 'token_14d', points: -10, message: 'Your Instagram connection ends in 12 days.', fix: 'Reconnect Instagram to renew it.' }], computedAt: minutesAgo(30) };
const STATUS = { paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 0, gates: [] };
const CONNECTION = { status: 'active', igUserId: '1784', username: 'kesarhome', loginKind: 'instagram', scopes: [], missingScopes: [], insightsGranted: true, tokenExpiresAt: daysFromNow(41), health: 'ok', webhooksSubscribed: true };
const SETUP = { storeUrl: 'https://kesar.example.com', testMode: false, instagram: { connected: true, username: 'kesarhome' }, checklist: { dismissed: false, steps: [{ key: 'instagram', done: true }, { key: 'products', done: false }, { key: 'reel', done: false }] } };
const REEL = { id: '17890001', slug: 'spice-box', headline: 'Spice Box Diwali', keywords: ['SPICE'], dmMessage: '', buttonText: 'Shop now', publicReply: '', active: true, permalink: '', thumbnailUrl: '', videoUrl: '', caption: '', storeUrl: '', createdAt: minutesAgo(900), updatedAt: minutesAgo(60), productCount: 5, dmCount: 120, visitCount: 80, orderCount: 9 };
const COMMENT = { id: 5, commentId: 'c1', reelId: REEL.id, reelHeadline: REEL.headline, reelSlug: REEL.slug, username: 'priya.k', text: 'SPICE please', result: 'sent', error: '', createdAt: minutesAgo(3) };

function routes(overrides = {}) {
  return {
    'GET /stats/dashboard': () => STATS,
    'GET /account-health': () => HEALTH,
    'GET /compliance/status': () => STATUS,
    'GET /instagram/connection': () => CONNECTION,
    'GET /facebook/connection': () => ({ enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null }),
    'GET /settings/setup': () => SETUP,
    'PATCH /settings': () => ({}),
    'GET /reels': () => page([REEL]),
    'GET /activity': () => page([COMMENT]),
    'GET /inbox/needs-human': () => page([{ id: 1 }, { id: 2 }, { id: 3 }]),
    ...overrides,
  };
}

const openHome = ({ routes: extra, ...options } = {}) => openAt('/', { list: [home], routes: routes(extra), ...options });

test('the owner sees the safety score, today’s numbers with revenue, what needs them, and the latest reels and comments', async () => {
  await openHome();
  expect(await screen.findByTestId('home-score')).toBeTruthy();
  expect(screen.getByTestId('home-band').props.children).toBe('Worth a look');
  expect(screen.getByText('Your Instagram connection ends in 12 days.')).toBeTruthy();
  expect(screen.getByText('Instagram connection renews in 41 days')).toBeTruthy();
  expect(screen.getByTestId('home-dms')).toBeTruthy();
  expect(screen.getByText('1,284 all time')).toBeTruthy();
  expect(screen.getByText('₹1,86,420')).toBeTruthy(); // paise, shown, never worked out on the phone
  expect(screen.getByText('Orders waiting for payment: 2')).toBeTruthy();
  expect(screen.getByText('Paid orders to ship: 3')).toBeTruthy();
  expect(screen.getByText('Chats that need a human: 3')).toBeTruthy();
  expect(await screen.findByText('Spice Box Diwali')).toBeTruthy();
  expect(screen.getByText('@priya.k')).toBeTruthy();
  expect(screen.getByTestId('home-checklist')).toBeTruthy();
  expect(screen.getByText('1 of 3 done')).toBeTruthy();
});

test('hiding the setup steps is a change: it needs a connection, and goes once with one', async () => {
  const { server, network } = await openHome();
  await screen.findByTestId('home-checklist');
  network.set(false);
  await waitFor(() => expect(screen.getByTestId('offline-banner')).toBeTruthy());
  expect(screen.getByTestId('home-checklist-hide').props.accessibilityState.disabled).toBe(true);
  expect(writes(server)).toEqual([]);
  network.set(true);
  await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull());
  await fireEvent.press(screen.getByTestId('home-checklist-hide'));
  await waitFor(() => expect(callsTo(server, 'PATCH', '/settings').map((c) => c.body)).toEqual([{ checklistDismissed: true }]));
});

test('staff see only the panels their permissions answer: no revenue without orders, no setup, no reels without automations', async () => {
  const { server } = await openHome({ user: staff(['analytics']) });
  expect(await screen.findByTestId('home-numbers')).toBeTruthy();
  expect(screen.queryByTestId('home-revenue')).toBeNull();
  expect(screenText(screen)).not.toContain('₹1,86,420');
  expect(screen.queryByTestId('home-checklist')).toBeNull();
  expect(screen.queryByTestId('home-reels-loading')).toBeNull();
  expect(screen.queryByText('Spice Box Diwali')).toBeNull();
  expect(screen.queryByText('Orders waiting for payment: 2')).toBeNull(); // orders are not theirs
  const asked = new Set(server.calls.map((c) => c.path));
  for (const path of ['/settings/setup', '/reels', '/activity', '/inbox/needs-human', '/compliance/status']) expect(asked.has(path)).toBe(false);
});

test('someone with none of these permissions gets a plain screen, not an error', async () => {
  await openHome({ user: staff(['orders']) });
  expect(await screen.findByTestId('home-empty')).toBeTruthy();
  expect(screen.queryByTestId('home-numbers')).toBeNull();
});

test('a refused or failing panel stays in its panel; a connection that can’t be read hides only its line (P-25)', async () => {
  await openHome({
    user: MANAGER,
    routes: {
      'GET /account-health': () => [500, { error: 'boom', code: 'internal' }],
      'GET /instagram/connection': () => [502, { error: 'Instagram is unavailable', code: 'unavailable' }],
      'GET /reels': () => [403, { error: 'Not yours', code: 'forbidden' }],
    },
  });
  expect(await screen.findByTestId('home-health-error', {}, { timeout: 8000 })).toBeTruthy(); // a fault on the server is retried twice first
  expect(screen.getByTestId('home-numbers')).toBeTruthy();
  expect(screen.queryByTestId('home-renews')).toBeNull();
  expect(await screen.findByTestId('home-reels-error')).toBeTruthy();
  expect(screen.getByText('You don’t have access to this. Ask the owner of this business.')).toBeTruthy();
  expect(screen.getByText('@priya.k')).toBeTruthy();
  expect(screenText(screen)).not.toContain('boom');
});

test('the compliance status is said on Home: a pause by the owner with the way to review it', async () => {
  await openHome({ routes: { 'GET /compliance/status': () => ({ ...STATUS, paused: true, pausedBy: 'owner' }) } });
  expect(await screen.findByTestId('notice-paused')).toBeTruthy();
});

test('a commenter’s name and words are drawn on the screen and written nowhere else', async () => {
  const said = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(console, level).mockImplementation((...args) => said.push(args.map(String).join(' '))));
  await openHome();
  expect(await screen.findByText('SPICE please')).toBeTruthy();
  for (const spy of spies) spy.mockRestore();
  expect(said.filter((line) => /priya|SPICE please|9800000/.test(line))).toEqual([]);
});

// ---- the pure rules ----

test('the checklist hides when done or dismissed, and marks the next step', () => {
  expect(checklistView({ dismissed: true, steps: [{ key: 'reel', done: false }] }).visible).toBe(false);
  expect(checklistView({ dismissed: false, steps: [{ key: 'reel', done: true }] }).visible).toBe(false);
  const view = checklistView({ dismissed: false, steps: [{ key: 'instagram', done: true }, { key: 'reel', done: false }, { key: 'unknown', done: false }] });
  expect(view).toMatchObject({ visible: true, done: 1, total: 2 });
  expect(view.steps.find((s) => s.key === 'reel')).toMatchObject({ next: true, path: '/reels' });
});

test('needs-you cards follow the person’s permissions, and renewal days count from the token', () => {
  expect(needsYou({ stats: STATS, waiting: null, user: staff(['analytics']) })).toEqual([]);
  expect(needsYou({ stats: STATS, waiting: page([{ id: 1 }], 'next'), user: { role: 'owner', permissions: [] } }).map((i) => [i.key, i.values.count])).toEqual([['confirm', 2], ['ship', 3], ['human', '1+']]);
  expect(renewalDays({ status: 'active', tokenExpiresAt: new Date(Date.now() + 2.5 * 86_400_000).toISOString() })).toBe(3);
  expect(renewalDays({ status: 'reconnect_needed', tokenExpiresAt: daysFromNow(3) })).toBeNull();
});

test('Home is open to anyone signed in, and its panels are each an API route it lists', () => {
  expect(home.access.signedIn).toBe(true);
  for (const id of ['stats.dashboard', 'accountHealth.get', 'settings.setup', 'reels.list', 'activity.list', 'inbox.needsHuman', 'console:/']) expect(home.routeIds).toContain(id);
  expect(SHOP_A.plan).toBe('growth');
});
