/**
 * The buying screens on the rendered app, once for each fixture brand, against a store that answers like the server does: cart,
 * guest checkout (prepaid asks for no code, cash on delivery asks for one), a double tap making one order, a cancelled payment
 * leaving the cart, Paid only from the server, the notification explainer after the first order only, sign-in, sign-out and
 * account deletion wiping the phone, and the account's other screens.
 */
import React from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App.js';
import { features } from './index.js';
import { PLATFORM_WORD, FIXTURES, ORIGIN, PRICE, TOKEN, brandOf, brands, flatText, makeStore, secure, setup, shopper, type } from './store.fixture.js';
import { clearUpdateRequired } from '../shell/gate.js';
import { linkingOf } from '../shell/menu.js';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true, status: 'undetermined' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getDevicePushTokenAsync: jest.fn(async () => ({ data: 'fcm-token-0123456789abcdef' })),
}));

jest.setTimeout(60000);
configure({ asyncUtilTimeout: 8000 });

async function fillAddress() {
  await type('addr-name', 'Asha Rao');
  await type('addr-phone', '9876543210');
  await type('addr-line1', '12 Lake Road');
  await type('addr-pincode', '411001');
  await type('addr-city', 'Pune');
  await fireEvent.press(screen.getByTestId('addr-state'));
  await fireEvent.press(await screen.findByTestId('state-27'));
}

/** Cart to checkout, the address filled and the terms agreed: ready to place. */
async function readyToPlace(services) {
  await services.cart.add({ productId: 5, qty: 1 });
  await render(<App services={services} linking={false} />);
  await fireEvent.press(screen.getByTestId('tab-cart'));
  await screen.findByTestId('totals-total');
  await fireEvent.press(screen.getByTestId('go-checkout'));
  await screen.findByTestId('screen-checkout');
  await fillAddress();
  await fireEvent.press(screen.getByTestId('agree-terms'));
  await waitFor(() => expect(screen.getByTestId('place-order')).toBeTruthy());
}

beforeEach(() => {
  clearUpdateRequired();
  require('expo-secure-store').__reset?.();
  jest.clearAllMocks();
});

describe.each(brands)('%s', (name) => {
  const brand = brandOf(name);

  test('the cart shows the server’s quote in paise, changes a quantity through the server, and names no platform', async () => {
    const { services, store } = setup(name);
    await services.cart.add({ productId: 5, qty: 1 });
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-cart'));
    expect(await screen.findByTestId('line-5-0')).toBeTruthy();
    expect(screen.getByTestId('totals-total')).toHaveTextContent('₹1,299');
    await fireEvent.press(screen.getByTestId('qty-more'));
    await waitFor(() => expect(screen.getByTestId('totals-total')).toHaveTextContent('₹2,598'));
    const quotes = store.log.filter((c) => c.path === '/api/store/checkout/quote');
    expect(quotes.at(-1).body).toEqual({ lines: [{ productId: 5, variantId: null, qty: 2 }] });
    expect(JSON.stringify(quotes.map((q) => q.body))).not.toMatch(/paise|total|price|discount/i);
    expect(flatText()).not.toMatch(PLATFORM_WORD);
  });

  test('an empty cart says so and leads back to the shop', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-cart'));
    expect(await screen.findByTestId('cart-empty')).toBeTruthy();
    expect(screen.getByTestId('go-shop')).toBeTruthy();
  });

  test('guest checkout, prepaid: no code asked, a double tap makes one order, a cancelled payment leaves the cart and is not Paid', async () => {
    const { services, store, opened } = setup(name);
    await readyToPlace(services);
    expect(screen.queryByTestId('cod-code')).toBeNull();
    const place = screen.getByTestId('place-order');
    // Two taps before the store answers: the first is in flight when the second lands.
    let release;
    store.state.hold = new Promise((resolve) => { release = resolve; });
    const first = fireEvent.press(place);
    await waitFor(() => expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(1));
    fireEvent.press(screen.getByTestId('place-order'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(1);
    release();
    await first;
    expect(await screen.findByTestId('payment-cancelled')).toBeTruthy();
    expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(1);
    expect(store.log.filter((c) => c.path === '/api/store/otp/send')).toHaveLength(0);
    const sent = store.log.find((c) => c.path === '/api/store/checkout').body;
    expect(JSON.stringify(sent)).not.toMatch(/paise|total|price|discount|fee/i);
    expect(sent.acceptTerms).toBe(true);
    expect(sent.consent.marketing).toEqual({ whatsapp: false, email: false });
    expect(sent.idempotencyKey).toMatch(/^key-/);
    expect(opened[0]).toBe(`${ORIGIN}/order/${TOKEN}`);
    expect(services.cart.count).toBe(1);
    expect(flatText()).not.toMatch(/Paid/);
    // The shopper can go round again on the same order.
    await fireEvent.press(screen.getByTestId('pay-again'));
    await waitFor(() => expect(store.log.some((c) => c.path === `/api/store/orders/${TOKEN}/retry`)).toBe(true));
    expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(1);
  });

  test('guest checkout, cash on delivery: a WhatsApp code is asked first and the order is placed only after it', async () => {
    const { services, store } = setup(name);
    await readyToPlace(services);
    await fireEvent.press(screen.getByTestId('mode-cod'));
    expect(await screen.findByTestId('cod-code')).toBeTruthy();
    expect(await screen.findByTestId('totals-cod-fee')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('place-order'));
    expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('cod-send'));
    await waitFor(() => expect(store.log.some((c) => c.path === '/api/store/otp/send')).toBe(true));
    const sentCode = store.log.find((c) => c.path === '/api/store/otp/send').body;
    expect(sentCode.purpose).toBe('cod');
    await type('cod-code-input', '123456');
    await fireEvent.press(screen.getByTestId('cod-verify'));
    expect(await screen.findByTestId('cod-verified')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('place-order'));
    expect(await screen.findByTestId('order-status')).toBeTruthy();
    expect(screen.getByTestId('order-status-title')).toHaveTextContent('Order placed. Pay on delivery.');
    expect(flatText()).not.toMatch(/Paid/);
    const placed = store.log.find((c) => c.path === '/api/store/checkout').body;
    expect(placed.idempotencyKey).toBe(sentCode.checkoutKey);
    await waitFor(() => expect(services.cart.count).toBe(0));
  });

  test.each([
    ['unpaid', 'pay', 'Waiting for your payment'],
    ['paid', 'done', 'Paid. Thank you!'],
    ['cod_due', 'done', 'Order placed. Pay on delivery.'],
  ])('an order shows Paid only when the server says paid (server says %s)', async (paymentStatus, next, words) => {
    const { services } = setup(name, makeStore(name, { orderState: { paymentStatus, next } }));
    const linking = { ...linkingOf(features, brand), getInitialURL: async () => `https://${brand.linkHosts[0]}/order/${TOKEN}`, subscribe: () => () => {} };
    await render(<App services={services} linking={linking} />);
    expect(await screen.findByTestId('order-status-title')).toHaveTextContent(words);
    if (paymentStatus !== 'paid') expect(screen.queryByText(/^Paid/)).toBeNull();
    // An old order opened from a link never empties the cart or offers notifications.
    expect(screen.queryByTestId('notification-explainer')).toBeNull();
  });

  test('the notification explainer comes after the first order only, turns on Order updates only, and “not now” asks the phone for nothing', async () => {
    const notifications = require('expo-notifications');
    // Browsing never asks.
    const browsing = setup(name);
    await render(<App services={browsing.services} linking={false} />);
    await waitFor(() => expect(browsing.store.log.some((c) => c.path === '/api/store/app/home')).toBe(true));
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('notification-explainer')).toBeNull();

    // After an order: the explainer, then the phone's prompt.
    const paid = makeStore(name, { orderState: { paymentStatus: 'paid', next: 'done' } });
    const { services, store } = setup(name, paid);
    await readyToPlace(services);
    paid.state.state = { next: 'done', paymentStatus: 'paid', fulfilmentStatus: 'new' };
    await fireEvent.press(screen.getByTestId('place-order'));
    expect(await screen.findByTestId('notification-explainer')).toBeTruthy();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('order-status-title')).toHaveTextContent('Paid. Thank you!');
    await fireEvent.press(screen.getByTestId('explainer-yes'));
    await waitFor(() => expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.log.some((c) => c.method === 'PUT' && c.path === '/api/store/app/push/prefs')).toBe(true));
    const saved = store.log.filter((c) => c.method === 'PUT' && c.path === '/api/store/app/push/prefs');
    expect(saved).toHaveLength(1);
    expect(saved[0].body).toEqual({ orderUpdates: true, source: 'first_order_prompt' });
    expect(store.state.prefs).toMatchObject({ orderUpdates: true, offers: false, newReels: false });
  });

  test('“Not now” on the explainer never asks the phone, and the order page works the same', async () => {
    const notifications = require('expo-notifications');
    const paid = makeStore(name, { orderState: { paymentStatus: 'cod_due', next: 'done' } });
    const { services } = setup(name, paid);
    await readyToPlace(services);
    await fireEvent.press(screen.getByTestId('mode-cod'));
    await fireEvent.press(screen.getByTestId('cod-send'));
    await type('cod-code-input', '123456');
    await fireEvent.press(screen.getByTestId('cod-verify'));
    await fireEvent.press(await screen.findByTestId('place-order'));
    expect(await screen.findByTestId('notification-explainer')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('explainer-no'));
    await waitFor(() => expect(screen.queryByTestId('notification-explainer')).toBeNull());
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('status-track')).toBeTruthy();
    expect(paid.log.some((c) => c.path === '/api/store/app/push/prefs' && c.method === 'PUT')).toBe(false);
  });

  test('notification settings: Offers and New reels are off until turned on, each with its own explicit choice', async () => {
    const { services, store } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    await fireEvent.press(await screen.findByTestId('row-notifications'));
    const offers = await screen.findByTestId('toggle-offers');
    expect(screen.getByTestId('toggle-order')).toBeTruthy();
    await fireEvent.press(offers);
    await waitFor(() => expect(store.state.prefs.offers).toBe(true));
    const saves = store.log.filter((c) => c.method === 'PUT' && c.path === '/api/store/app/push/prefs');
    expect(saves.at(-1).body).toEqual({ offers: true, source: 'settings' });
    expect(store.state.prefs.newReels).toBe(false);
  });

  test('sign in with a WhatsApp code, then sign out: tokens are wiped from secure storage, the cart and the cache', async () => {
    const { services, store, queryClient } = setup(name);
    await services.cart.add({ productId: 5, qty: 2 });
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    expect(await screen.findByTestId('account-sign-in')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('account-sign-in'));
    await type('sign-in-phone', '9876543210');
    await fireEvent.press(screen.getByTestId('sign-in-send'));
    await type('sign-in-code', '123456');
    await fireEvent.press(await screen.findByTestId('sign-in-verify'));
    expect(await screen.findByTestId('account-name')).toHaveTextContent('Asha Rao');
    expect(screen.getByTestId('account-phone')).toHaveTextContent(/•••••/);
    // The refresh token is in secure storage and nowhere else; the access token is in memory only.
    expect(Object.values(secure())).toContain('shopr_signed');
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toMatch(/shopr_|shopa_/);
    expect(store.log.some((c) => c.method === 'PUT' && c.path === '/api/store/cart')).toBe(true);

    await fireEvent.press(screen.getByTestId('account-sign-out'));
    const confirms = await screen.findAllByText('Sign out');
    await fireEvent.press(confirms.at(-1));
    await waitFor(() => expect(services.session.getState().status).toBe('guest'));
    expect(Object.values(secure())).not.toContain('shopr_signed');
    expect(store.log.some((c) => c.path === '/api/store/app/session/end')).toBe(true);
    expect(services.cart.count).toBe(0);
    await waitFor(() => expect(screen.queryByTestId('account-name')).toBeNull());
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toMatch(/Asha|shopr_|shopa_/);
    expect(flatText()).not.toContain('Asha');
  });

  test('Delete my account: the server is asked once, the phone forgets the shopper, and the shopper is a guest again', async () => {
    const { services, store, queryClient } = setup(name);
    await services.cart.add({ productId: 5, qty: 1 });
    await render(<App services={services} linking={false} />);
    await services.session.sendCode('9876543210');
    await services.session.signInWithCode('9876543210', '123456');
    expect(Object.values(secure())).toContain('shopr_signed');
    await fireEvent.press(screen.getByTestId('tab-account'));
    await fireEvent.press(await screen.findByTestId('account-delete'));
    await fireEvent.press(await screen.findByTestId('delete-start'));
    await fireEvent.press(await screen.findByText('Yes, delete it'));
    expect(await screen.findByTestId('deleted-message')).toHaveTextContent('Your account is deleted.');
    expect(store.log.filter((c) => c.path === '/api/store/app/account/delete')).toHaveLength(1);
    expect(store.log.find((c) => c.path === '/api/store/app/account/delete').body).toEqual({ confirm: true });
    expect(Object.values(secure())).not.toContain('shopr_signed');
    expect(services.cart.count).toBe(0);
    expect(services.session.getState()).toMatchObject({ status: 'guest', shopper: null });
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toMatch(/Asha|shopr_|shopa_/);
    expect(flatText()).not.toMatch(PLATFORM_WORD);
  });

  test('the account page offers sign-in to a guest, links the shopper’s screens, and shows no platform name', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    expect(await screen.findByTestId('account-sign-in')).toBeTruthy();
    for (const id of ['row-orders', 'row-wishlist', 'row-addresses', 'row-rewards', 'row-notifications']) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.queryByTestId('account-delete')).toBeNull();
    expect(flatText()).not.toMatch(PLATFORM_WORD);
    expect(flatText()).toContain(brand.name);
  });

  test('screens that need a signed-in shopper ask for sign-in and nothing more', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    await fireEvent.press(await screen.findByTestId('row-orders'));
    expect(await screen.findByTestId('need-sign-in')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('go-sign-in'));
    expect(await screen.findByTestId('screen-sign-in')).toBeTruthy();
    expect(screen.getByTestId('sign-in-google')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-apple')).toBeNull();
  });

  test('the registered screens are the ones this feature set promises', () => {
    const names = features.flatMap((f) => f.screens.map((s) => `${f.name}.${s.name}`));
    for (const id of ['cart.index', 'checkout.index', 'payment.index', 'orders.index', 'orders.order', 'orders.byToken', 'tracking.index', 'account.index', 'account.delete', 'sign-in.index', 'notifications.index', 'rewards.index', 'rewards.referral', 'wishlist.index', 'reviews.index', 'returns.index', 'addresses.index']) expect(names).toContain(id);
  });
});
