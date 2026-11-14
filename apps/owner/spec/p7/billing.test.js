/**
 * PRD 3 and 5.12 on the rendered owner app (Bhava for Business): the Plan and billing screen shows the month's DM meter as
 * the server counts it, the 80% and 100% states, held DMs and the upgrade offer on Free, buys a pack and changes plan without
 * ever sending a price, and is the owner's alone. Written from the PRD and src/contracts/api/billing.js; the fake API answers
 * the contract's shapes. Screens are found by what a person reads, or by the shell's own test ids. F-81, F-86, F-112,
 * F-115, F-48.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { OWNER, SHOP_A, fakeApi, openApp, screenText, settle } from '../support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View testID={props.testID ?? 'image'} {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const NOW = '2026-11-14T06:00:00.000Z';
const FREE_SHOP = Object.freeze({ ...SHOP_A, plan: 'free', accountType: 'creator' });
const T1_SHOP = Object.freeze({ ...SHOP_A, plan: 't1' });
const MANAGER = Object.freeze({ id: 9, name: 'Mina', phone: '+91 ••••• •0003', role: 'manager', permissions: [] });

const plans = [
  { code: 'free', name: 'Free', rank: 0, monthlyPaise: 0, yearlyPaise: 0, includedDms: 500 },
  { code: 't1', name: 'Starter', rank: 1, monthlyPaise: 49_900, yearlyPaise: 499_000, includedDms: 5000 },
  { code: 't2', name: 'Growth', rank: 2, monthlyPaise: 99_900, yearlyPaise: 999_000, includedDms: 15_000 },
  { code: 't3', name: 'Store', rank: 3, monthlyPaise: 199_900, yearlyPaise: 1_999_000, includedDms: 30_000 },
];
const catalog = (current) => ({
  plans: plans.map((p) => ({ ...p, current: p.code === current })),
  addons: [{ code: 'dm_pack', name: '10,000 DMs', kind: 'pack', pricePaise: 29_900, cycle: 'once', feature: null, minPlan: 't1', includedFrom: null, meter: 'dms', units: 10_000, many: true, available: current !== 'free', unavailable: current === 'free' ? 'needs_plan' : null }],
  taxRateBp: 1800,
  offer: null,
});
const billingPlan = (plan) => ({
  plan, planName: plans.find((p) => p.code === plan).name, cycle: 'monthly', status: 'active', nextChargePaise: plans.find((p) => p.code === plan).monthlyPaise,
  periodEnd: plan === 'free' ? null : '2026-12-01T00:00:00.000Z', graceUntil: null, nextPlan: null, nextCycle: null, offer: null, hasPaymentMethod: plan !== 'free', items: [],
});
const usage = ({ used, included, packUnits = 0, heldDms = 0, canBuyPacks = true }) => {
  const allowance = included + packUnits;
  return {
    month: '2026-11-01', resetsAt: '2026-11-30T18:30:00.000Z', heldDms, canBuyPacks,
    meters: [{ meter: 'dms', used, included, packUnits, allowance, left: Math.max(0, allowance - used), percent: Math.floor((used * 100) / allowance), over: used >= allowance }],
  };
};
const features = (plan) => ({ plan, features: { automations: { on: true, limit: plan === 'free' ? 3 : null }, 'links.one_tap': { on: plan !== 'free', limit: null }, 'links.two_tap': { on: true, limit: null }, 'store.checkout': { on: ['t3', 't4', 't5'].includes(plan), limit: null } } });

/** A fake seller API with the billing routes of the contract for a business on `plan`. Records what the app sends. */
function billingApi({ plan = 't1', user = OWNER, meter = { used: 1200, included: 5000 }, onChange, onItem } = {}) {
  const shop = plan === 'free' ? FREE_SHOP : { ...T1_SHOP, plan };
  const sent = [];
  const api = fakeApi({
    user,
    businesses: [shop],
    extra: {
      'GET /billing': () => [200, billingPlan(plan)],
      'GET /billing/catalog': () => [200, catalog(plan)],
      'GET /billing/usage': () => [200, usage({ ...meter, canBuyPacks: plan !== 'free' })],
      'GET /billing/features': () => [200, features(plan)],
      'GET /billing/invoices': () => [200, { items: [], nextCursor: null }],
      'GET /billing/statements': () => [200, { items: [], nextCursor: null }],
      'GET /referrals': () => [200, { code: 'asha2026', link: 'https://app.example/signup?ref=asha2026', rewardPaise: 0, counts: { pending: 0, credited: 0, blocked: 0 }, creditedPaise: 0 }],
      'POST /billing/change': (call) => {
        sent.push(call);
        return onChange ? onChange(call) : [200, { plan: billingPlan(call.body.plan), effective: 'now', checkoutUrl: 'https://checkout.example/hosted/sub_1' }];
      },
      'POST /billing/items': (call) => {
        sent.push(call);
        return onItem ? onItem(call) : [201, { item: { id: 1, code: call.body.code, name: '10,000 DMs', kind: 'pack', cycle: 'once', quantity: call.body.quantity ?? 1, unitPricePaise: 29_900, startsAt: NOW, endsAt: null }, checkoutUrl: null }];
      },
    },
  });
  return { api, sent };
}

async function openBilling(api) {
  await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('tab-more'));
  await settle();
  await fireEvent.press(await screen.findByTestId('more-billing'));
  await settle(200);
}

/** Presses the first thing on screen whose text matches, then any confirmation the screen asks for. */
async function pressAndConfirm(pattern) {
  const target = (await screen.findAllByText(pattern))[0];
  await fireEvent.press(target);
  await settle(100);
  const confirm = screen.queryAllByText(/^(confirm|continue|pay|buy|yes)/i);
  if (confirm.length) await fireEvent.press(confirm[confirm.length - 1]);
  await settle(100);
}

const MONEY_FIELDS = /price|amount|paise|total|rupee/i;

test('F-86: the owner sees this month\'s DMs as the server counts them, with the share used and when it resets', async () => {
  const { api } = billingApi({ plan: 't1', meter: { used: 4000, included: 5000 } });
  await openBilling(api);
  await waitFor(() => expect(screenText(screen)).toMatch(/4,000/));
  const text = screenText(screen);
  expect(text).toMatch(/5,000/);
  expect(text).toMatch(/80\s?%/);
  expect(text).toMatch(/Starter/);
  expect(api.paths('GET').some((p) => p.startsWith('/billing/usage'))).toBe(true);
});

test('F-86: at 100% the meter says the DMs are used up and offers a pack on a paid plan', async () => {
  const { api } = billingApi({ plan: 't1', meter: { used: 5000, included: 5000 } });
  await openBilling(api);
  await waitFor(() => expect(screenText(screen)).toMatch(/100\s?%/));
  expect(screenText(screen)).toMatch(/pack/i);
});

test('F-112: a Free account at 500 DMs sees its held DMs and an upgrade, and is not offered a pack', async () => {
  const api = fakeApi({
    businesses: [FREE_SHOP],
    extra: {
      'GET /billing': () => [200, billingPlan('free')],
      'GET /billing/catalog': () => [200, catalog('free')],
      'GET /billing/usage': () => [200, usage({ used: 500, included: 500, heldDms: 3, canBuyPacks: false })],
      'GET /billing/features': () => [200, features('free')],
      'GET /billing/invoices': () => [200, { items: [], nextCursor: null }],
    },
  });
  await openBilling(api);
  await waitFor(() => expect(screenText(screen)).toMatch(/500/));
  const text = screenText(screen);
  expect(text).toMatch(/upgrade/i);
  expect(text).toMatch(/\b3\b[^"]*held|held[^"]*\b3\b|waiting/i);
  expect(screen.queryAllByText(/buy (a )?pack|add (a )?pack/i)).toHaveLength(0);
});

test('F-81: buying a pack sends the add-on code and a request key, never a price', async () => {
  const { api, sent } = billingApi({ plan: 't1', meter: { used: 5000, included: 5000 } });
  await openBilling(api);
  await pressAndConfirm(/pack/i);
  await waitFor(() => expect(sent.some((c) => c.path === '/billing/items')).toBe(true));
  const call = sent.find((c) => c.path === '/billing/items');
  expect(call.body.code).toBe('dm_pack');
  expect(call.body.requestKey).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  expect(Object.keys(call.body).filter((k) => MONEY_FIELDS.test(k))).toEqual([]);
});

test('F-115: the yearly price shown is ten months for twelve, and choosing it sends the plan and cycle only', async () => {
  const { api, sent } = billingApi({ plan: 't1' });
  await openBilling(api);
  const yearly = screen.queryAllByText(/year/i);
  if (yearly.length) await fireEvent.press(yearly[0]);
  await settle(100);
  // Growth: 999 rupees a month, 9,990 a year.
  await waitFor(() => expect(screenText(screen)).toMatch(/9,990/));
  await pressAndConfirm(/Growth/);
  const choose = screen.queryAllByText(/^(choose|upgrade|switch|select)/i);
  if (!sent.length && choose.length) {
    await fireEvent.press(choose[0]);
    await settle(100);
    const confirm = screen.queryAllByText(/^(confirm|continue|pay|yes)/i);
    if (confirm.length) await fireEvent.press(confirm[confirm.length - 1]);
  }
  await waitFor(() => expect(sent.some((c) => c.path === '/billing/change')).toBe(true));
  const call = sent.find((c) => c.path === '/billing/change');
  expect(call.body.plan).toBe('t2');
  expect(call.body.cycle).toBe('yearly');
  expect(Object.keys(call.body).filter((k) => MONEY_FIELDS.test(k))).toEqual([]);
});

test('F-48: a manager has no Plan and billing entry, and the billing routes are never called for them', async () => {
  const { api } = billingApi({ plan: 't1', user: MANAGER });
  await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('tab-more'));
  await settle();
  expect(screen.queryByTestId('more-billing')).toBeNull();
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(api.paths().filter((p) => p.startsWith('/billing') && p !== '/billing/features')).toEqual([]);
});
