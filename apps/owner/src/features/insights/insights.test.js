import { act, fireEvent, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { OWNER, STAFF, fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import insights from './index.js';
import traffic from '../traffic/index.js';
import reachGuard from '../reach-guard/index.js';

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const at = '2026-11-10T10:00:00.000Z';
const day = (d, value, state = 'ok') => ({ day: `2026-11-0${d}`, value, state, mayChange: false });
const STATUS = { connected: true, permission: 'ok', collectingSince: '2026-10-01', lastUpdatedAt: at, nextRefreshAt: null, storyDiscovery: 'edge' };
const ACCOUNT = {
  from: '2026-11-01', to: '2026-11-07', source: 'platform', permission: 'ok', lastUpdatedAt: at, followers: [day(1, 900), day(2, 905)],
  metrics: [
    { metric: 'reach', label: 'Accounts reached', estimated: false, total: 4200, gapDays: 0, days: [day(1, 600), day(2, null, 'no_data'), day(3, 700)], breakdowns: [] },
    { metric: 'views', label: 'Views', estimated: true, total: null, gapDays: 3, days: [day(1, null, 'not_available'), day(2, null, 'not_available')], breakdowns: [] },
  ],
};
const ANALYST = { ...STAFF, id: 9, permissions: ['analytics'] }; // may read analytics, may not see revenue
const BUYER_DESK = { ...STAFF, id: 10, permissions: ['analytics', 'orders'] }; // staff with orders: revenue allowed

const delta = (value) => ({ value, previous: null, change: null, changePercent: null });
const SUMMARY = {
  source: 'bhava', sessions: delta(120), visitors: delta(80), newVisitors: delta(60), returningVisitors: delta(20), pageViews: delta(300), productTaps: delta(40), outboundTaps: delta(5),
  whatsappTaps: delta(7), addToCart: delta(9), checkoutStarted: delta(4), orders: delta(3), revenuePaise: delta(1234550), bounceRate: delta(0.42), medianEngagedMs: delta(80000),
  previews: 0, notIncluded: [], lastUpdatedAt: at,
};

function api(extra = {}, user = OWNER) {
  return fakeApi({
    user,
    routes: {
      'GET /insights/status': () => STATUS,
      'GET /insights/account': () => ACCOUNT,
      'GET /traffic/summary': () => SUMMARY,
      'GET /traffic/trend': () => ({ points: [{ day: '2026-11-01', sessions: 4, previous: null }, { day: '2026-11-02', sessions: 9, previous: null }], label: 'bhava' }),
      'GET /traffic/realtime': () => ({ active: 2, pages: [], sources: [], label: 'bhava' }),
      'GET /traffic/sources': () => ({ items: [{ source: 'instagram', referrerDomain: '', sessions: 70, visitors: 50, productTaps: 20, orders: 2, revenuePaise: 99900 }], label: 'bhava' }),
      'GET /traffic/heatmap': () => ({ timeZone: 'Asia/Kolkata', cells: [{ weekday: 2, hour: 20, sessions: 11 }], label: 'bhava' }),
      'GET /traffic/pages': () => ({ items: [], label: 'bhava' }),
      'GET /traffic/breakdown': () => ({ by: 'device', items: [], label: 'bhava' }),
      ...extra,
    },
  });
}

/** The words a Text element shows. */
const textIn = (id) => [].concat(screen.getByTestId(id).props.children).join('');
const textOf = async (id) => [].concat((await screen.findByTestId(id)).props.children).join('');

async function open(server, path, { user = OWNER, network } = {}) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs(user));
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [insights, traffic, reachGuard], linking, ...(network ? { network } : {}) });
  return made;
}

test('every chart names where its numbers come from; a missing figure says why and is never drawn as 0', async () => {
  await open(api(), '/insights');
  expect(await screen.findByTestId('insights-chart-reach')).toBeTruthy();
  expect(textIn('insights-chart-reach-source')).toBe('From Instagram/Facebook');
  expect(screen.getByTestId('insights-chart-reach-line')).toBeTruthy(); // the two days with a number, the gap left out
  expect(textIn('insights-chart-views-state')).toBe('Not available');
  expect(textIn('insights-total-views-value')).toBe('Not available');
  expect(textIn('insights-total-reach-value')).toBe('4,200');
});

test('when Instagram stops sharing insights, every chart says Permission needed instead of a flat line', async () => {
  const server = api({ 'GET /insights/status': () => ({ ...STATUS, permission: 'needed' }), 'GET /insights/account': () => ({ ...ACCOUNT, permission: 'needed' }) });
  await open(server, '/insights');
  expect(await screen.findByTestId('insights-permission')).toBeTruthy();
  expect(textIn('insights-chart-reach-state')).toBe('Permission needed');
  expect(screen.queryByTestId('insights-chart-reach-line')).toBeNull();
  expect(textIn('insights-total-reach-value')).toBe('Permission needed');
});

test('an account not yet connected says so, and offline the refresh waits', async () => {
  const network = fakeNetwork(true);
  const server = api({ 'GET /insights/status': () => ({ ...STATUS, connected: false }), 'GET /insights/account': () => ({ ...ACCOUNT, metrics: [], followers: [] }) });
  await open(server, '/insights', { network });
  expect(await screen.findByTestId('insights-not-connected')).toBeTruthy();
  expect(screen.getByTestId('insights-account-empty')).toBeTruthy();
  await act(async () => network.set(false));
  await settle();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('insights-refresh').props.accessibilityState.disabled).toBe(true);
});

test('traffic shows revenue in rupees from paise to the owner, labelled as measured by Bhava', async () => {
  await open(api(), '/traffic');
  expect(await screen.findByTestId('traffic-revenue')).toBeTruthy();
  expect(textIn('traffic-revenue-value')).toBe('₹12,345.50');
  expect(textIn('traffic-summary-source')).toBe('Measured by Bhava');
  expect(screen.getByText(/₹999/)).toBeTruthy(); // the source row's revenue
});

test('staff who may read analytics but not revenue never see an amount, even if one arrived', async () => {
  await open(api({}, ANALYST), '/traffic', { user: ANALYST });
  expect(await screen.findByTestId('traffic-sessions')).toBeTruthy();
  expect(screen.queryByTestId('traffic-revenue')).toBeNull();
  expect(screen.queryByText(/₹/)).toBeNull();
});

test('staff holding orders see revenue, as canSeeRevenue allows', async () => {
  await open(api({}, BUYER_DESK), '/traffic', { user: BUYER_DESK });
  expect(await screen.findByTestId('traffic-revenue')).toBeTruthy();
});

test('a figure the plan leaves out is Not available, not 0', async () => {
  await open(api({ 'GET /traffic/summary': () => ({ ...SUMMARY, orders: delta(null), notIncluded: ['orders'] }) }), '/traffic');
  expect(await textOf('traffic-orders-value')).toBe('Not available');
});

test('Reach Guard shows its state and the owner-only thresholds; Account Health with no score says Not available', async () => {
  const server = api({
    'GET /reach-guard': () => ({ state: 'normal', since: null, message: 'Reach is steady.', settledDays: 10, mediaCounted: 12, baselineReach: 500, thresholds: { reachDropPercent: 40, mediaDropPercent: 50, clearPercent: 20 }, trip: null, slowMode: { active: false, trigger: null, until: null, canOverride: false, restoring: false }, lastEvaluatedAt: at }),
    'GET /reach-guard/trips': () => ({ items: [], nextCursor: null }),
    'GET /account-health': () => ({ score: null, band: null, deductions: [], computedAt: null }),
    'GET /account-health/history': () => ({ days: [] }),
  });
  await open(server, '/reach-guard');
  expect(await screen.findByTestId('reach-state')).toBeTruthy();
  expect(screen.getByText('Reach is steady.')).toBeTruthy();
  expect(screen.getByTestId('reach-thresholds')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('reach-open-health'));
  expect(await screen.findByTestId('health-score-none')).toBeTruthy();
});
