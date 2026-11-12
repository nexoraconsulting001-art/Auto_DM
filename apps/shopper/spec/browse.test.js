/**
 * The shopper app as a shopper first meets it (PRD 10.7, 10.11), run for both fixture brands: browsing with no login, no platform
 * name on any screen or host, guest checkout, and no notification prompt for someone who only browses. P-27, P-28, P-31, P-45.
 */
import { Linking } from 'react-native';
import { BRANDS, PRODUCTS, PLATFORM_NAME, REELS, act, brandOf, fireEvent, press, renderApp, screen, tab, visibleText, waitFor, waitText } from './support.js';

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

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

const SIGN_IN_PROMPT = /sign in to continue|please sign in|log in to continue|login required|you need to sign in/i;

describe.each(BRANDS)('%s', (name) => {
  const brand = brandOf(name);

  test('P-27: Browse shows the catalog and Reels with no login prompt, and the brand is the seller\'s', async () => {
    const store = await renderApp(name);
    for (const t of ['home', 'catalog', 'reels']) {
      await tab(t);
      expect(screen.getByTestId(`screen-${t}`)).toBeTruthy();
      expect(visibleText()).not.toMatch(SIGN_IN_PROMPT);
      expect(screen.queryByTestId('screen-sign-in')).toBeNull();
    }
    await tab('home');
    for (const p of PRODUCTS) expect(await waitText(p.name)).toBeTruthy();
    await tab('reels');
    for (const reel of REELS) expect(await waitText(reel.title)).toBeTruthy();
    await tab('catalog');
    expect(await waitText(PRODUCTS[0].name)).toBeTruthy();
    // Prices are shown in rupees from whole paise.
    expect(visibleText()).toMatch(/1,?299/);
    // Nothing needed a signed-in call, and nothing was asked of the account.
    expect(store.calls.filter((c) => /\/app\/(orders|rewards|account)|\/addresses/.test(c.path))).toEqual([]);
    for (const c of store.calls) expect(c.headers.authorization === undefined || /^Shopper /.test(c.headers.authorization)).toBe(true);
    // The brand's own name is somewhere the shopper reads, the seller's colour is the theme.
    expect(store.services.config.brand.name).toBe(brand.name);
    expect(store.services.theme.color.primary.toLowerCase()).toBe(brand.colors.primary.toLowerCase());
  });

  test('P-27: the reels tab keeps working when the store is slow or fails: an error state with a retry, never a login wall', async () => {
    const store = await renderApp(name, { routes: { 'GET /api/store/app/reels': () => ({ status: 500, body: { error: 'Something went wrong. Please try again.', code: 'internal' } }) } });
    await tab('reels');
    await waitFor(() => expect(visibleText()).toMatch(/something went wrong|try again|retry/i));
    expect(visibleText()).not.toMatch(SIGN_IN_PROMPT);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    expect(store.calls.length).toBeGreaterThan(0);
  });

  test('P-27: an app below the minimum version is sent to the store, in the seller\'s words', async () => {
    const storeUrl = 'https://play.google.com/store/apps/details?id=com.example.shop';
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderApp(name, { routes: { 'GET /api/store/app/home': () => ({ status: 426, body: { error: 'Please update the app to continue.', code: 'update_required', storeUrl } }) } });
    await waitFor(() => expect(visibleText()).toMatch(/update/i));
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    const button = await screen.findByText(/update|open (the )?store|get the update/i);
    await act(async () => { fireEvent.press(button); });
    expect(openURL).toHaveBeenCalledWith(storeUrl);
  });

  test('P-31: no screen, label, string or network host names the platform', async () => {
    const store = await renderApp(name);
    const seen = [];
    for (const t of ['home', 'catalog', 'reels', 'cart', 'account']) {
      await tab(t);
      await waitFor(() => expect(screen.getByTestId(`screen-${t}`)).toBeTruthy());
      seen.push(visibleText());
    }
    expect(seen.join('\n')).not.toMatch(PLATFORM_NAME);
    for (const lang of ['en', 'hi']) {
      const strings = JSON.stringify(store.services.strings.catalogue ?? store.services.features.map((f) => f.strings?.[lang] ?? {}));
      expect(strings).not.toMatch(PLATFORM_NAME);
    }
    expect(JSON.stringify(store.services.features.map((f) => f.strings))).not.toMatch(PLATFORM_NAME);
    const hosts = new Set(store.calls.map((c) => new URL(c.url).host));
    expect([...hosts]).toEqual(['localhost:4010']);
    for (const c of store.calls) expect(JSON.stringify(c.headers)).not.toMatch(PLATFORM_NAME);
    expect(JSON.stringify(store.services.config)).not.toMatch(PLATFORM_NAME);
  });

  test('P-45: a fresh install that only browses never asks for notifications', async () => {
    const store = await renderApp(name, { platform: 'android' });
    for (const t of ['home', 'catalog', 'reels', 'cart', 'account']) {
      await tab(t);
      await waitFor(() => expect(screen.getByTestId(`screen-${t}`)).toBeTruthy());
    }
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(visibleText()).not.toMatch(/allow notifications|turn on notifications|enable notifications/i);
    // No push device was registered with a granted permission, and no token was sent.
    for (const c of store.callsTo('PUT', '/api/store/app/push/device')) expect(c.body.permission).not.toBe('granted');
    expect(store.callsTo('PUT', '/api/store/app/push/prefs')).toEqual([]);
  });

  test('P-28: Checkout opens for a guest with the cart kept; cash on delivery asks for a WhatsApp code', async () => {
    const lines = [{ productId: 1, variantId: null, qty: 2, name: 'Copper Kettle', option: '', image: '', unitPaise: 129900, linePaise: 259800, state: 'ok' }];
    const store = await renderApp(name, {
      routes: {
        'GET /api/store/cart': () => ({ lines }),
        'POST /api/store/checkout/quote': () => ({ lines, subtotalPaise: 259800, discountPaise: 0, loyaltyPaise: 0, shippingPaise: 0, codFeePaise: 0, taxPaise: 0, totalPaise: 259800, advancePaise: 0, balancePaise: 0, paymentModes: [{ mode: 'prepaid', available: true, reason: '' }, { mode: 'cod', available: true, reason: '' }], serviceable: true, coupon: null, pointsUsed: 0, notices: [] }),
        'POST /api/store/checkout': (r) => (r.body.paymentMode === 'cod' ? { orderNumber: '', token: '', next: 'verify_phone' } : { orderNumber: 'ORD-9', token: 'tok-9', next: 'pay', gateway: { provider: 'razorpay', keyId: 'k', gatewayOrderId: 'o1', amountPaise: 259800, display: { name: brand.name, image: '' } } }),
      },
    });
    await tab('cart');
    expect(await waitText('Copper Kettle')).toBeTruthy();
    await press(/checkout|proceed|place order/i);
    await waitFor(() => expect(screen.getByTestId('screen-checkout')).toBeTruthy());
    expect(screen.queryByTestId('screen-sign-in')).toBeNull();
    expect(visibleText()).not.toMatch(SIGN_IN_PROMPT);
    // Prepaid needs no code.
    expect(visibleText()).toMatch(/online|upi|card|pay now/i);
    expect(store.callsTo('POST', '/api/store/otp/send')).toEqual([]);
    // Choosing cash on delivery and placing the order asks for the code, and the cart is not emptied.
    await press(/cash on delivery|cod/i);
    await press(/place order|confirm order|pay|continue/i);
    await waitFor(() => expect(visibleText()).toMatch(/whatsapp/i));
    await screen.findByPlaceholderText(/code|otp|6/i, undefined, { timeout: 4000 });
    expect(store.callsTo('PUT', '/api/store/cart').every((c) => c.body.lines.length > 0)).toBe(true);
    expect(visibleText()).not.toMatch(PLATFORM_NAME);
    // The order call carried no price, total, discount or channel.
    for (const c of store.callsTo('POST', '/api/store/checkout')) {
      expect(JSON.stringify(c.body)).not.toMatch(/pricePaise|totalPaise|subtotalPaise|discountPaise|channel|isApp|appOnly/i);
    }
  });
});
