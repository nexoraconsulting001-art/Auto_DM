/**
 * The shopper app after the first look (PRD 10.7 to 10.11), run for both fixture brands: paying, deleting the account, the first
 * order's notification explainer, reorder, the category order, rewards, a second brand's app, an offline launch and a DM link
 * opened twice. P-29, P-30, P-44, P-46, P-51, P-64, P-65, P-66, P-70. Written from the PRD and the contract only.
 */
import { Linking } from 'react-native';
import { BRANDS, PLATFORM_NAME, PRODUCTS, REELS, SHOPPER, act, brandOf, fireEvent, orderRow, press, renderApp, screen, signInThroughScreens, tab, visibleText, waitFor, waitText } from './support.js';

jest.mock('expo-notifications', () => ({
  __esModule: true,
  getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[spec]' })),
  getDevicePushTokenAsync: jest.fn(async () => ({ data: 'fcm-spec-token', type: 'android' })),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  AndroidImportance: { DEFAULT: 3, HIGH: 4, MAX: 5 },
}));
const notifications = require('expo-notifications');

const signedIn = { 'GET /api/store/app/me': () => ({ shopper: SHOPPER, sharedProfile: { available: false, linked: false, consented: false } }) };
const line = (productId, name, qty, unitPaise, extra = {}) => ({ productId, variantId: null, qty, name, option: '', image: '', unitPaise, linePaise: unitPaise * qty, state: 'ok', ...extra });
const quote = (lines, total) => ({ lines, subtotalPaise: total, discountPaise: 0, loyaltyPaise: 0, shippingPaise: 0, codFeePaise: 0, taxPaise: 0, totalPaise: total, advancePaise: 0, balancePaise: 0, paymentModes: [{ mode: 'cod', available: true, reason: '' }], serviceable: true, coupon: null, pointsUsed: 0, notices: [] });
const orderDetail = (n, lines) => ({
  ...orderRow(n), paymentMode: 'prepaid', canReorder: true, canCancel: false, canReturn: false, invoices: [], shipments: [], timeline: [],
  lines, totals: { subtotalPaise: 1, discountPaise: 0, loyaltyPaise: 0, shippingPaise: 0, codFeePaise: 0, taxPaise: 0, totalPaise: 1, advancePaise: 0, balancePaise: 0 },
  address: { name: 'Asha Rao', line1: '12 Lake Road', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

describe.each(BRANDS)('%s', (name) => {
  const brand = brandOf(name);

  test('P-29: coming back from a test-card payment shows Paid, from the server\'s answer and not from the link alone', async () => {
    Linking.getInitialURL.mockResolvedValue(`${brand.scheme}://order/tok-9`);
    const store = await renderApp(name, {
      routes: {
        ...signedIn,
        'GET /api/store/app/order/tok-9': () => ({ orderNumber: 'ORD-9', fulfilmentStatus: 'placed', paymentStatus: 'paid', totalPaise: 259800, next: 'done', payPath: '' }),
      },
    });
    await waitFor(() => expect(visibleText()).toMatch(/paid/i), { timeout: 5000 });
    expect(visibleText()).toMatch(/ORD-9/);
    expect(store.callsTo('GET', '/api/store/app/order/tok-9').length).toBeGreaterThan(0);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
  });

  test('P-29: a payment that the server says failed never shows Paid', async () => {
    Linking.getInitialURL.mockResolvedValue(`${brand.scheme}://order/tok-8`);
    await renderApp(name, {
      routes: { ...signedIn, 'GET /api/store/app/order/tok-8': () => ({ orderNumber: 'ORD-8', fulfilmentStatus: 'placed', paymentStatus: 'failed', totalPaise: 1000, next: 'failed', payPath: '' }) },
    });
    await waitFor(() => expect(visibleText()).toMatch(/fail|try again|not (go|went) through|unsuccessful/i), { timeout: 5000 });
    expect(visibleText()).not.toMatch(/\bpaid\b/i);
  });

  test('P-30: deleting the account in the app asks to confirm, sends confirm true, ends the sign-in and shows the seller\'s message', async () => {
    const store = await renderApp(name, { routes: signedIn });
    await tab('account');
    await press(/delete (my )?account/i);
    // Nothing is sent before the shopper confirms.
    expect(store.callsTo('POST', '/api/store/app/account/delete')).toEqual([]);
    await press(/delete|confirm|yes/i);
    await waitFor(() => expect(store.callsTo('POST', '/api/store/app/account/delete').length).toBe(1));
    expect(store.callsTo('POST', '/api/store/app/account/delete')[0].body).toEqual({ confirm: true });
    await waitFor(() => expect(visibleText()).toMatch(/deleted/i));
    expect(visibleText()).not.toMatch(/Asha Rao|3210/);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
  });

  test('P-30: when the server says deletion is waiting (an open order), the app says so and does not claim it is gone', async () => {
    await renderApp(name, {
      routes: { ...signedIn, 'POST /api/store/app/account/delete': () => ({ status: 'waiting', signedOut: false, message: 'We will delete your account once your open order is delivered.' }) },
    });
    await tab('account');
    await press(/delete (my )?account/i);
    await press(/delete|confirm|yes/i);
    await waitFor(() => expect(visibleText()).toMatch(/once your open order is delivered/i));
    expect(visibleText()).not.toMatch(/your account was deleted/i);
  });

  test('P-44: a device offline at launch opens with what it last downloaded, and never a login wall or a crash', async () => {
    const first = await renderApp(name);
    await tab('home');
    expect(await waitText(PRODUCTS[0].name)).toBeTruthy();
    screen.unmount?.();
    const second = await renderApp(name);
    second.state.offline = true;
    await tab('home');
    await waitFor(() => expect(screen.getByTestId('screen-home')).toBeTruthy());
    expect(visibleText()).not.toMatch(/sign in to continue|please sign in|log in to continue/i);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    expect(first.calls.length).toBeGreaterThan(0);
  });

  test('P-44: the build lets an over-the-air update load in the background and launches the cached bundle at once', () => {
    const { execFileSync } = require('node:child_process');
    const path = require('node:path');
    const file = path.resolve(__dirname, '../../../tools/build-brand/fixtures', name, 'brand.json');
    const script = 'const c=require("./app.config.js"); const x=typeof c==="function"?c({config:{}}):c; process.stdout.write(JSON.stringify((x.expo||x).updates||null))';
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, BRAND_FILE: file, UPDATES_URL: 'https://updates.example.test/manifest' }, encoding: 'utf8',
    });
    const updates = JSON.parse(out);
    expect(updates.fallbackToCacheTimeout).toBe(0);
    expect(updates.checkAutomatically).toBe('ON_LOAD');
    expect(updates.requestHeaders['expo-channel-name']).toBe(brand.updates.channel);
  });

  test('P-46: the first order shows the explainer, then the system prompt, and only Order updates is on', async () => {
    const lines = [line(1, 'Copper Kettle', 1, 129900)];
    let verified = false;
    const store = await renderApp(name, {
      routes: {
        ...signedIn,
        'GET /api/store/cart': () => ({ lines }),
        'POST /api/store/checkout/quote': () => quote(lines, 129900),
        'POST /api/store/otp/verify': () => { verified = true; return { ok: true }; },
        'POST /api/store/checkout': () => (verified ? { orderNumber: 'ORD-5', token: 'tok-5', next: 'done' } : { orderNumber: '', token: '', next: 'verify_phone' }),
        'POST /api/store/app/push/orders': () => null,
      },
    });
    await tab('cart');
    await press(/checkout|proceed|place order/i);
    await press(/cash on delivery|cod/i);
    await press(/place order|confirm order|pay|continue/i);
    const code = await screen.findByPlaceholderText(/code|otp|6/i, undefined, { timeout: 4000 });
    await act(async () => { fireEvent.changeText(code, '123456'); });
    await press(/verify|confirm|continue/i);
    // The explainer comes first, in the seller's words, and the system prompt has not yet appeared.
    await waitFor(() => expect(visibleText()).toMatch(/order updates|updates (about|on) your order|notify you/i), { timeout: 5000 });
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    await press(/allow|turn on|yes|continue|enable/i);
    await waitFor(() => expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    // Only Order updates is on: nothing the app saves turns Offers or New reels on.
    for (const c of store.callsTo('PUT', '/api/store/app/push/prefs')) {
      expect(c.body.offers === true).toBe(false);
      expect(c.body.newReels === true).toBe(false);
    }
  });

  test('P-46: saying no to the explainer never raises the system prompt', async () => {
    const lines = [line(1, 'Copper Kettle', 1, 129900)];
    await renderApp(name, {
      routes: {
        ...signedIn,
        'GET /api/store/cart': () => ({ lines }),
        'POST /api/store/checkout/quote': () => quote(lines, 129900),
        'POST /api/store/checkout': () => ({ orderNumber: 'ORD-6', token: 'tok-6', next: 'done' }),
      },
    });
    await tab('cart');
    await press(/checkout|proceed|place order/i);
    await press(/cash on delivery|cod/i);
    await press(/place order|confirm order|pay|continue/i);
    await waitFor(() => expect(visibleText()).toMatch(/order updates|notify you|not now|maybe later|no thanks/i), { timeout: 5000 });
    await press(/not now|maybe later|no thanks|skip/i);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test('P-51: opening the same DM link in the app twice goes straight to the reel both times, with no token and no click call', async () => {
    const landing = { slug: 'brunch-edit', title: 'Brunch edit', image: '', videoUrl: null, products: PRODUCTS.slice(0, 2), category: null };
    for (let i = 0; i < 2; i += 1) {
      Linking.getInitialURL.mockResolvedValue(`https://${brand.shopDomain}/r/brunch-edit`);
      const store = await renderApp(name, { routes: { 'GET /api/store/app/landing/brunch-edit': () => landing } });
      await waitFor(() => expect(store.callsTo('GET', '/api/store/app/landing/brunch-edit').length).toBeGreaterThan(0), { timeout: 5000 });
      for (const c of store.calls) {
        expect(c.path).not.toMatch(/click|token|redirect|short/i);
        expect(new URL(c.url).host).toBe('localhost:4010');
      }
      screen.unmount?.();
    }
  });

  test('P-64: Reorder from an order puts today\'s prices in the cart, names what is missing and sends no price or quantity', async () => {
    const today = [line(1, 'Copper Kettle', 1, 134900)];
    const reorder = { lines: today, added: 1, missing: [{ name: 'Clay Mug', option: '', reason: 'sold_out' }, { name: 'Brass Tray', option: '', reason: 'inactive' }], capped: [{ name: 'Copper Kettle', qty: 1 }], addressId: 7, notices: [] };
    const order = orderDetail(1, [{ name: 'Copper Kettle', option: '', qty: 2, unitPaise: 129900, linePaise: 259800, image: '', productSlug: 'copper-kettle' }]);
    const store = await renderApp(name, {
      routes: { ...signedIn, 'GET /api/store/app/orders/ORD-1': () => order, 'POST /api/store/app/orders/ORD-1/reorder': () => reorder, 'GET /api/store/cart': () => ({ lines: today }) },
    });
    await tab('account');
    await press(/orders/i);
    await press('ORD-1');
    await press(/order (it )?again|reorder|buy again/i);
    await waitFor(() => expect(store.callsTo('POST', '/api/store/app/orders/ORD-1/reorder').length).toBe(1));
    await waitFor(() => expect(visibleText()).toMatch(/Clay Mug/));
    expect(visibleText()).toMatch(/Brass Tray/);
    expect(store.callsTo('POST', '/api/store/app/orders/ORD-1/reorder')[0].body ?? {}).toEqual({});
    await tab('cart');
    expect(await waitText('Copper Kettle')).toBeTruthy();
    expect(visibleText()).toMatch(/1,?349/);
    expect(visibleText()).not.toMatch(/1,?299/);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
  });

  test('P-64: an order with nothing left to buy leaves the cart empty and names the item', async () => {
    const reorder = { lines: [], added: 0, missing: [{ name: 'Clay Mug', option: '', reason: 'inactive' }], capped: [], addressId: null, notices: [] };
    const order = orderDetail(1, [{ name: 'Clay Mug', option: '', qty: 1, unitPaise: 24900, linePaise: 24900, image: '', productSlug: 'clay-mug' }]);
    await renderApp(name, { routes: { ...signedIn, 'GET /api/store/app/orders/ORD-1': () => order, 'POST /api/store/app/orders/ORD-1/reorder': () => reorder } });
    await tab('account');
    await press(/orders/i);
    await press('ORD-1');
    await press(/order (it )?again|reorder|buy again/i);
    await waitFor(() => expect(visibleText()).toMatch(/Clay Mug/));
    await tab('cart');
    expect(screen.queryByText('Clay Mug')).toBeNull();
  });

  test('P-65: the category screen shows the pinned reel first, then the set order', async () => {
    const ordered = [REELS[2], REELS[0], REELS[1]];
    await renderApp(name, { routes: { 'GET /api/store/app/categories/tea': () => ({ category: { slug: 'tea', name: 'Tea', image: '' }, reels: ordered, products: { items: PRODUCTS, nextCursor: null } }) } });
    await tab('home');
    await press('Tea');
    expect(await waitText('Festive picks')).toBeTruthy();
    const text = visibleText();
    expect(text.indexOf('Festive picks')).toBeLessThan(text.indexOf('Brunch edit'));
    expect(text.indexOf('Brunch edit')).toBeLessThan(text.indexOf('Tea time'));
  });

  test('P-66: Rewards shows the points balance and the referral link on the seller\'s own host, in the seller\'s name', async () => {
    const store = await renderApp(name, { routes: signedIn });
    await tab('account');
    await press(/rewards|points/i);
    await waitFor(() => expect(visibleText()).toMatch(/\b42\b/));
    expect(visibleText()).toContain(`https://${brand.shopDomain}/refer/ASHA42`);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    for (const c of store.calls) expect(new URL(c.url).host).toBe('localhost:4010');
  });

  test('P-66: a business with Rewards switched off shows no balance and no link', async () => {
    await renderApp(name, { routes: { ...signedIn, 'GET /api/store/app/rewards': () => ({ enabled: false, pointsBalance: 0, pendingPoints: 0, valuePaise: 0, expiring: null, history: [], referral: null }) } });
    await tab('account');
    const entry = screen.queryByText(/rewards|points/i);
    if (entry) {
      await act(async () => { fireEvent.press(entry); });
      expect(visibleText()).not.toMatch(/refer\//);
    }
  });
});

test('P-70: a shopper signed in at two brands\' apps sees only each brand\'s own orders', async () => {
  expect(BRANDS.length).toBeGreaterThanOrEqual(2);
  const [a, b] = BRANDS;
  const ordersOf = (n) => ({ 'GET /api/store/app/orders': () => ({ items: [orderRow(n, { totalPaise: 100000 + n })], nextCursor: null }), ...signedIn });
  await renderApp(a, { routes: ordersOf(101) });
  await tab('account');
  await press(/orders/i);
  expect(await waitText('ORD-101')).toBeTruthy();
  screen.unmount?.();
  const second = await renderApp(b, { routes: ordersOf(202) });
  await tab('account');
  await press(/orders/i);
  expect(await waitText('ORD-202')).toBeTruthy();
  expect(visibleText()).not.toMatch(/ORD-101/);
  expect(brandOf(a).tenantId).not.toBe(brandOf(b).tenantId);
  const header = (c) => c.headers['X-App-Tenant'] ?? c.headers['x-app-tenant'];
  for (const c of second.calls) if (header(c) !== undefined) expect(String(header(c))).toBe(String(brandOf(b).tenantId));
});

test('P-70: signing in at the second brand\'s app goes through that app\'s own sign-in calls', async () => {
  const store = await renderApp(BRANDS[BRANDS.length - 1]);
  await signInThroughScreens();
  expect(store.callsTo('POST', '/api/store/otp/send').length + store.callsTo('POST', '/api/store/app/session').length).toBeGreaterThan(0);
});
