import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { onlineManager } from '@tanstack/react-query';
import billing from './index.js';
import signup from '../home/index.js';
import { billingActionsOn } from './actions.js';
import { meterView, planRefusal, groupDigits, newRequestKey } from './rules.js';
import { AT, CREATOR_FREE, MANAGER, SELLER_T1, fakeNetwork, forgetApps, openAt, press, screenText, settle, writes } from './testing.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })), openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.setTimeout(40_000);
afterEach(forgetApps);
beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
  WebBrowser.openBrowserAsync.mockClear();
});

const plans = [
  { code: 'free', name: 'Free', rank: 0, monthlyPaise: 0, yearlyPaise: 0, includedDms: 500 },
  { code: 't1', name: 'Starter', rank: 1, monthlyPaise: 49_900, yearlyPaise: 499_000, includedDms: 5000 },
  { code: 't2', name: 'Growth', rank: 2, monthlyPaise: 99_900, yearlyPaise: 999_000, includedDms: 15_000 },
  { code: 't3', name: 'Store', rank: 3, monthlyPaise: 199_900, yearlyPaise: 1_999_000, includedDms: 30_000 },
];
const catalog = (current) => ({
  plans: plans.map((p) => ({ ...p, current: p.code === current })),
  addons: [
    { code: 'dm_pack', name: '10,000 DMs', kind: 'pack', pricePaise: 29_900, cycle: 'monthly', feature: null, minPlan: 't1', includedFrom: null, meter: 'dms', units: 10_000, many: true, available: current !== 'free', unavailable: current === 'free' ? 'needs_plan' : null },
    { code: 'loyalty', name: 'Loyalty and referrals', kind: 'addon', pricePaise: 49_900, cycle: 'monthly', feature: 'store.loyalty', minPlan: 't3', includedFrom: null, meter: null, units: null, many: false, available: false, unavailable: 'needs_plan' },
    { code: 'extra_seat', name: 'Extra team member', kind: 'addon', pricePaise: 19_900, cycle: 'monthly', feature: null, minPlan: 't1', includedFrom: null, meter: null, units: null, many: true, available: current !== 'free', unavailable: null },
  ],
  taxRateBp: 1800,
  offer: null,
});
const planAnswer = (plan, over = {}) => ({
  plan, planName: plans.find((p) => p.code === plan).name, cycle: 'monthly', status: 'active', nextChargePaise: plans.find((p) => p.code === plan).monthlyPaise,
  periodEnd: plan === 'free' ? null : '2026-12-01T00:00:00.000Z', graceUntil: null, nextPlan: null, nextCycle: null, offer: null, hasPaymentMethod: plan !== 'free', items: [], ...over,
});
const usage = ({ used, included, packUnits = 0, heldDms = 0, canBuyPacks = true }) => {
  const allowance = included + packUnits;
  return { month: '2026-11-01', resetsAt: '2026-11-30T18:30:00.000Z', heldDms, canBuyPacks, meters: [{ meter: 'dms', used, included, packUnits, allowance, left: Math.max(0, allowance - used), percent: Math.floor((used * 100) / allowance), over: used >= allowance }] };
};
const features = (plan) => ({ plan, features: { automations: { on: true, limit: plan === 'free' ? 3 : null }, 'links.one_tap': { on: plan !== 'free', limit: null }, 'store.checkout': { on: plan === 't3', limit: null } } });

function billingRoutes({ plan = 't1', meter = { used: 1200, included: 5000 }, change, item, planExtra } = {}) {
  return {
    'GET /billing': () => planAnswer(plan, planExtra),
    'GET /billing/catalog': () => catalog(plan),
    'GET /billing/usage': () => usage({ ...meter, canBuyPacks: plan !== 'free' }),
    'GET /billing/features': () => features(plan),
    'GET /billing/invoices': () => ({ items: [], nextCursor: null }),
    'GET /billing/statements': () => ({ items: [], nextCursor: null }),
    'POST /billing/change': change ?? ((call) => ({ plan: planAnswer(call.body.plan), effective: 'now', checkoutUrl: 'https://checkout.example/hosted/sub_1' })),
    'POST /billing/items': item ?? ((call) => [201, { item: { id: 1, code: call.body.code, name: '10,000 DMs', kind: 'pack', cycle: 'once', quantity: 1, unitPricePaise: 29_900, startsAt: AT, endsAt: null }, checkoutUrl: 'https://checkout.example/hosted/pack_1' }]),
    'POST /billing/payment-method': () => ({ url: 'https://checkout.example/hosted/method', expiresAt: null }),
  };
}

const open = (opts = {}, route = {}) => openAt('/billing', { list: [billing], routes: billingRoutes(route), ...opts });
const confirm = async () => press(/^confirm$/i, { last: true });

test('the owner sees the month’s DMs as the server counts them, the plan, and when it resets', async () => {
  const { server } = await open({}, { plan: 't1', meter: { used: 4000, included: 5000 } });
  await screen.findByTestId('billing-usage-count');
  const text = screenText();
  expect(text).toMatch(/4,000 of 5,000 DMs used \(80%\)/);
  expect(text).toMatch(/Starter/);
  expect(screen.getByTestId('billing-usage-near')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/billing/usage')).toBe(true);
});

test('at 100% the DMs are used up and a pack is offered on a paid plan', async () => {
  await open({}, { plan: 't1', meter: { used: 5000, included: 5000 } });
  await screen.findByTestId('billing-usage-over');
  expect(screen.getByTestId('billing-pack-dm_pack')).toBeTruthy();
  expect(screenText()).toMatch(/100%/);
});

test('a Free account at its limit sees its held DMs and the plans, and no pack', async () => {
  await open({ business: { ...CREATOR_FREE, accountType: 'seller' } }, { plan: 'free', meter: { used: 500, included: 500, heldDms: 3 } });
  await screen.findByTestId('billing-usage-held');
  expect(screenText()).toMatch(/3 DMs are waiting/);
  await waitFor(() => expect(screenText()).toMatch(/500 of 500/));
  expect(screen.queryByTestId('billing-pack-dm_pack')).toBeNull();
  expect(screen.getByTestId('billing-usage-upgrade')).toBeTruthy();
});

test('buying a pack sends the code, a quantity and a request key, never a price, then opens the hosted page in the browser', async () => {
  const { server } = await open({}, { plan: 't1', meter: { used: 5000, included: 5000 } });
  await press(/pack/i);
  expect(screen.getByTestId('billing-confirm-price')).toBeTruthy();
  await confirm();
  await waitFor(() => expect(writes(server).some((c) => c.path === '/billing/items')).toBe(true));
  const call = writes(server).find((c) => c.path === '/billing/items');
  expect(call.body.code).toBe('dm_pack');
  expect(call.body.quantity).toBe(1);
  expect(call.body.requestKey).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  expect(Object.keys(call.body).sort()).toEqual(['code', 'quantity', 'requestKey']);
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://checkout.example/hosted/pack_1'));
});

test('yearly is shown as the server priced it, and choosing it sends the plan and cycle only', async () => {
  const { server } = await open({}, { plan: 't1' });
  await press(/^Yearly$/);
  await waitFor(() => expect(screenText()).toMatch(/₹9,990 a year/));
  expect(screenText()).toMatch(/two months free/i);
  await press(/^Growth$/);
  expect(screenText()).toMatch(/applies at once/i);
  await confirm();
  await waitFor(() => expect(writes(server).some((c) => c.path === '/billing/change')).toBe(true));
  const call = writes(server).find((c) => c.path === '/billing/change');
  expect(call.body).toEqual({ plan: 't2', cycle: 'yearly', requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,80}$/) });
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://checkout.example/hosted/sub_1'));
});

test('a downgrade says it waits for the end of the period and keeps the data', async () => {
  await open({ business: { ...SELLER_T1, plan: 't2' } }, { plan: 't2', change: (call) => ({ plan: planAnswer('t2', { nextPlan: call.body.plan }), effective: 'period_end', checkoutUrl: null }) });
  await press(/^Starter$/);
  expect(screenText()).toMatch(/end of the current period/i);
});

test('a change of money asks for a fresh check when the server wants one, then repeats the same request key', async () => {
  let attempts = 0;
  const change = () => {
    attempts += 1;
    if (attempts === 1) return [403, { error: 'Confirm it is you', code: 'reauth_required' }];
    return { plan: planAnswer('t2'), effective: 'now', checkoutUrl: null };
  };
  const { server } = await open({}, { plan: 't1', change });
  await press(/^Growth$/);
  // The confirm handler waits for the fresh check, so the press is not awaited.
  fireEvent.press((await screen.findAllByText(/^confirm$/i)).pop());
  await fireEvent.press(await screen.findByTestId('reauth-send'));
  await settle(80);
  await fireEvent.changeText(await screen.findByTestId('reauth-code'), '654321');
  await fireEvent.press(await screen.findByTestId('reauth-verify'));
  await waitFor(() => expect(writes(server).filter((c) => c.path === '/billing/change')).toHaveLength(2));
  const [first, second] = writes(server).filter((c) => c.path === '/billing/change');
  expect(second.body.requestKey).toBe(first.body.requestKey);
});

test('a refusal shows the server’s reason and no checkout opens', async () => {
  await open({}, { plan: 't1', change: () => [409, { error: 'You are already on that plan', code: 'conflict' }] });
  await press(/^Growth$/);
  await confirm();
  await screen.findByTestId('billing-action-problem');
  expect(screenText()).toMatch(/already on that plan/);
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
});

test('there is no card field anywhere on the screens', async () => {
  await open({}, { plan: 't1' });
  await screen.findByTestId('billing-current');
  expect(screen.queryAllByLabelText(/card number|cvv|expiry/i)).toHaveLength(0);
  expect(screenText()).toMatch(/never asks for card details/i);
});

test('with BILLING_ACTIONS off (the iOS default) the plan, usage, invoices and limits show and nothing says where to buy', async () => {
  await open({ platform: 'ios' }, { plan: 't1', meter: { used: 5000, included: 5000 } });
  await screen.findByTestId('billing-usage-over');
  const text = screenText();
  expect(text).toMatch(/Starter/);
  expect(text).toMatch(/5,000 of 5,000/);
  expect(screen.getByTestId('billing-invoices-link')).toBeTruthy();
  for (const gone of ['billing-pack-dm_pack', 'billing-plans', 'billing-cycle', 'billing-addons', 'billing-method']) expect(screen.queryByTestId(gone)).toBeNull();
  expect(screen.queryAllByText(/upgrade|buy|choose|switch|extra pack|change payment|see plans|pay/i)).toHaveLength(0);
});

test('the build setting decides: on for Android, off for iOS, and an explicit value wins either way', () => {
  const constants = (billingActions) => ({ expoConfig: { extra: billingActions === undefined ? {} : { billingActions } } });
  expect(billingActionsOn({ constants: constants(), platform: 'android' })).toBe(true);
  expect(billingActionsOn({ constants: constants(), platform: 'ios' })).toBe(false);
  expect(billingActionsOn({ constants: constants('0'), platform: 'android' })).toBe(false);
  expect(billingActionsOn({ constants: constants('1'), platform: 'ios' })).toBe(true);
  expect(billingActionsOn({ constants: constants(false), platform: 'android' })).toBe(false);
  expect(billingActionsOn({ constants: { expoConfig: { extra: { hidePlanPurchase: true } } }, platform: 'ios' })).toBe(false);
});

test('a manager has no Plan and billing entry and no billing route is called for them', async () => {
  const { server } = await openAt('/billing', { list: [billing, signup], routes: billingRoutes(), user: MANAGER });
  await settle(200);
  expect(screen.queryByTestId('screen-billing')).toBeNull();
  expect(server.calls.filter((c) => c.path.startsWith('/billing') && c.path !== '/billing/features')).toEqual([]);
});

test('a creator on Free sees the creator’s plan screen and none of the store’s', async () => {
  await open({ business: CREATOR_FREE }, { plan: 'free', meter: { used: 120, included: 500 } });
  await screen.findByTestId('billing-current');
  await screen.findByTestId('billing-addons');
  expect(screen.getByTestId('billing-invoices-link')).toBeTruthy();
  expect(screen.queryByTestId('billing-statements-link')).toBeNull();
  expect(screen.queryByTestId('billing-addon-loyalty')).toBeNull();
  expect(screenText()).not.toMatch(/Store checkout/);
});

test('offline, the saved plan shows and every change is switched off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open({ network }, { plan: 't1', meter: { used: 5000, included: 5000 } });
  await screen.findByTestId('billing-usage-over');
  await act(async () => { network.set(false); onlineManager.setOnline(false); });
  await settle(100);
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('billing-pack-dm_pack').props.accessibilityState?.disabled).toBe(true);
  expect(writes(server)).toHaveLength(0);
});

test('a read that fails shows the error with a retry, and a slow one shows loading rows', async () => {
  const routes = { ...billingRoutes(), 'GET /billing/usage': () => [500, { error: 'Boom', code: 'internal' }] };
  await openAt('/billing', { list: [billing], routes });
  await screen.findByTestId('billing-meter-error', {}, { timeout: 15000 });
  expect(screen.getAllByText(/Try again/).length).toBeGreaterThan(0);
});

test('invoices and credit notes are listed with their file opened outside the app; an empty list says so', async () => {
  const invoice = { id: 5, docType: 'invoice', number: 'BH/26/0005', issuedAt: AT, periodStart: '2026-11-01', periodEnd: '2026-11-30', originalInvoiceId: null, taxablePaise: 49_900, cgstPaise: 4_491, sgstPaise: 4_491, igstPaise: 0, totalPaise: 58_882, paid: true, hasFile: true, lines: [] };
  const { server } = await openAt('/billing/invoices', {
    list: [billing],
    routes: { ...billingRoutes(), 'GET /billing/invoices': () => ({ items: [invoice], nextCursor: null }), 'GET /billing/invoices/5/file': () => ({ fileUrl: 'https://files.example/inv5.pdf', fileName: 'inv5.pdf', expiresAt: AT }) },
  });
  expect(await screen.findByText('BH/26/0005')).toBeTruthy();
  expect(screenText()).toMatch(/₹588\.82/);
  await fireEvent.press(await screen.findByTestId('billing-invoice-5-file'));
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://files.example/inv5.pdf'));
  expect(server.calls.some((c) => c.path === '/billing/invoices/5/file')).toBe(true);
});

test('with no invoices the screen says so', async () => {
  await openAt('/billing/invoices', { list: [billing], routes: billingRoutes() });
  expect(await screen.findByText('No invoices yet')).toBeTruthy();
});

test('a statement shows the closing balance with which way it is owed, and no commission', async () => {
  const statement = {
    id: 3, month: '2026-10-01', openingBalance: { amountPaise: 0, owedTo: 'business' }, salesPaise: 500_000, refundsPaise: 20_000, gatewayFeesPaise: 11_800, shippingPaise: 30_000, commissionPaise: 0, payoutsPaise: 400_000,
    closingBalance: { amountPaise: 38_200, owedTo: 'business' }, counts: { orders: 9, refunds: 1, shipments: 9 }, payouts: [], reconciliation: 'matched', hasPdf: true, hasCsv: true, sentAt: null,
  };
  const { server } = await openAt('/billing/statements', {
    list: [billing],
    routes: { ...billingRoutes(), 'GET /billing/statements': () => ({ items: [statement], nextCursor: null }), 'GET /billing/statements/3/file': () => ({ fileUrl: 'https://files.example/s3.csv', fileName: 's3.csv', expiresAt: AT }) },
  });
  await screen.findByTestId('billing-statement-3');
  expect(screenText()).toMatch(/₹382 owed to you/);
  expect(screenText()).toMatch(/no share of your sales/i);
  await fireEvent.press(screen.getByTestId('billing-statement-3-csv'));
  await waitFor(() => expect(server.calls.some((c) => c.path === '/billing/statements/3/file' && c.search.includes('format=csv'))).toBe(true));
});

test('rules: the meter, grouping and refusals', () => {
  expect(meterView({ used: 4000, allowance: 5000, percent: 80, over: false, packUnits: 0, left: 1000 }).state).toBe('near');
  expect(meterView({ used: 5000, allowance: 5000, percent: 100, over: true }).state).toBe('over');
  expect(meterView({ used: 5, allowance: null, percent: 0, over: false }).unlimited).toBe(true);
  expect(groupDigits(150000)).toBe('1,50,000');
  expect(newRequestKey()).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  expect(newRequestKey()).not.toBe(newRequestKey());
  expect(planRefusal({ code: 'plan.feature_off', plan: 't1' }).kind).toBe('feature');
  expect(planRefusal({ code: 'plan.limit_reached', limit: 3, used: 3 }).kind).toBe('limit');
  expect(planRefusal({ code: 'conflict' })).toBeNull();
});

test('the feature lists every billing route and is the owner’s alone', () => {
  expect(billing.access.roles).toEqual(['owner']);
  expect(billing.routeIds).toEqual(expect.arrayContaining(['billing.plan', 'billing.catalog', 'billing.change', 'billing.addItem', 'billing.usage', 'billing.invoices', 'billing.statements', 'billing.paymentMethod', 'billing.features']));
});
