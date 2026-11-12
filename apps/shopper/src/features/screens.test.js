/**
 * The signed-in buying screens on the rendered app, once for each fixture brand: an order and one-tap reorder (P-64), tracking,
 * returns with photo proof, rewards and the referral link (P-66), saved addresses, and a review with photos.
 */
import React from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App.js';
import { features } from './index.js';
import { PLATFORM_WORD, PRICE, TOKEN, brandOf, brands, flatText, makeStore, setup, type } from './store.fixture.js';
import { clearUpdateRequired } from '../shell/gate.js';
import { linkingOf } from '../shell/menu.js';

jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn(async () => ({ granted: false })), requestPermissionsAsync: jest.fn(), getDevicePushTokenAsync: jest.fn() }));
jest.setTimeout(60000);
configure({ asyncUtilTimeout: 8000 });

const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const AT = '2026-10-01T10:00:00Z';
const ORDER = {
  orderNumber: 'A-1000', token: TOKEN, placedAt: AT, fulfilmentStatus: 'shipped', paymentStatus: 'paid', totalPaise: PRICE, itemCount: 1, image: '', paymentMode: 'prepaid',
  lines: [{ name: 'Brass lamp', option: '', qty: 2, unitPaise: PRICE, linePaise: PRICE * 2, image: '', productSlug: 'brass-lamp', orderItemId: 11 }],
  totals: { subtotalPaise: PRICE, discountPaise: 0, loyaltyPaise: 0, shippingPaise: 0, codFeePaise: 0, taxPaise: 0, totalPaise: PRICE, advancePaise: 0, balancePaise: 0 },
  address: { name: 'Asha Rao', line1: '12 Lake Road', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  timeline: [{ status: 'new', at: AT }, { status: 'shipped', at: AT }],
  shipments: [{ courier: 'Delhivery', awb: 'AWB123', status: 'shipped', expectedAt: null, trackingPath: '/track/x', scans: [{ at: AT, text: 'Left the hub', location: 'Pune' }] }],
  invoices: [{ number: 'INV-1', path: '/invoice/1' }], canCancel: false, canReturn: true, canReorder: true,
};
const REORDER = {
  lines: [{ productId: 7, variantId: null, name: 'Brass lamp', option: '', image: '', qty: 2, unitPaise: PRICE + 5000, linePaise: (PRICE + 5000) * 2, state: 'ok' }],
  added: 1, missing: [{ name: 'Clay vase', option: '', reason: 'sold_out' }], capped: [], addressId: 31, notices: [],
};
const PRODUCT = { id: 7, slug: 'brass-lamp', name: 'Brass lamp', pricePaise: PRICE, comparePaise: null, image: '', inStock: true, rating: 4.5, ratingCount: 2, description: '', images: [], options: [], variants: [], maxQty: 5, reels: [] };

async function signedIn(name, over = {}, orderState = {}) {
  const made = setup(name, makeStore(name, { orderState: { fulfilmentStatus: 'shipped', next: 'done', paymentStatus: 'paid', ...orderState }, over: {
    'GET /api/store/app/orders/A-1000': reply(ORDER),
    'GET /api/store/app/orders': reply({ items: [{ ...ORDER }], nextCursor: null }),
    ...over,
  } }));
  await made.services.session.signInWithCode('9876543210', '123456');
  return made;
}
async function openAt(services, brand, route) {
  const linking = { ...linkingOf(features, brand), getInitialURL: async () => `https://${brand.linkHosts[0]}${route}`, subscribe: () => () => {} };
  await render(<App services={services} linking={linking} />);
}

beforeEach(() => {
  clearUpdateRequired();
  require('expo-secure-store').__reset?.();
});

describe.each(brands)('%s', (name) => {
  const brand = brandOf(name);

  test('an order shows the server’s totals, and Order again brings today’s items back, names what is gone and preselects the saved address', async () => {
    const { services, store } = await signedIn(name, { 'POST /api/store/app/orders/A-1000/reorder': reply(REORDER) });
    await openAt(services, brand, '/account/orders/A-1000');
    expect(await screen.findByTestId('order-totals-total')).toHaveTextContent('₹1,299');
    expect(screen.getByTestId('order-fulfilment')).toHaveTextContent('Shipped');
    expect(screen.getByTestId('order-payment')).toHaveTextContent('Paid');
    await fireEvent.press(screen.getByTestId('order-reorder'));
    expect(await screen.findByTestId('reorder-result')).toBeTruthy();
    expect(flatText()).toContain('Clay vase is not available now.');
    expect(services.cart.lines.map((l) => [l.productId, l.qty])).toEqual([[7, 2]]);
    expect(services.checkout.preferred.addressId).toBe(31);
    expect(store.log.filter((c) => c.path === '/api/store/checkout')).toHaveLength(0);
    expect(flatText()).not.toMatch(PLATFORM_WORD);
  });

  test('the orders list shows past orders for a signed-in shopper and a guest is asked to sign in', async () => {
    const made = await signedIn(name);
    await openAt(made.services, brand, '/account/orders/A-1000');
    await fireEvent.press(await screen.findByTestId('order-track'));
    expect(await screen.findByTestId('screen-tracking')).toBeTruthy();
  });

  test('tracking shows the steps reached, the courier and every scan', async () => {
    const { services } = await signedIn(name);
    await openAt(services, brand, `/track/${TOKEN}`);
    expect(await screen.findByTestId('step-shipped-done')).toHaveTextContent('Now');
    expect(screen.getByTestId('step-packed-done')).toBeTruthy();
    expect(screen.queryByTestId('step-delivered-done')).toBeNull();
    expect(await screen.findByTestId('awb-AWB123')).toBeTruthy();
    expect(screen.getByTestId('scan-0')).toBeTruthy();
  });

  test('a guest tracking an order sees the steps and is told to sign in for the courier’s scans', async () => {
    const { services } = setup(name, makeStore(name, { orderState: { fulfilmentStatus: 'out_for_delivery', next: 'done', paymentStatus: 'paid' } }));
    await openAt(services, brand, `/track/${TOKEN}`);
    expect(await screen.findByTestId('step-out_for_delivery-done')).toBeTruthy();
    expect(screen.getByTestId('tracking-signin-hint')).toBeTruthy();
  });

  test('a return needs a photo or video, and goes as a form with the files', async () => {
    const picked = [{ uri: 'file:///tmp/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }];
    const made = setup(name, makeStore(name, { over: { 'GET /api/store/app/orders/A-1000': reply(ORDER), 'POST /api/store/orders/A-1000/returns': reply({ id: 1 }, 201) } }), { imagePicker: { launchImageLibraryAsync: async () => ({ canceled: false, assets: picked }) } });
    await made.services.session.signInWithCode('9876543210', '123456');
    await openAt(made.services, brand, '/account/orders/A-1000');
    await fireEvent.press(await screen.findByTestId('order-return'));
    await fireEvent.press(await screen.findByTestId('return-more-11'));
    await fireEvent.press(screen.getByTestId('return-send'));
    expect(made.store.log.some((c) => c.path.endsWith('/returns'))).toBe(false);
    expect(await screen.findByText('Add a photo or video of the item.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('proof-add'));
    expect(await screen.findByTestId('proof-0')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('return-send'));
    expect(await screen.findByTestId('return-sent')).toBeTruthy();
    const sent = made.store.log.find((c) => c.path === '/api/store/orders/A-1000/returns');
    const parts = Object.fromEntries([...sent.body.entries()]);
    expect(JSON.parse(parts.items)).toEqual([{ orderItemId: 11, qty: 1 }]);
    expect('proof' in parts).toBe(true);
    expect(parts.resolution).toBe('refund');
  });

  test('rewards show the points and the seller’s own referral link; a friend’s link keeps the code for checkout', async () => {
    const rewards = { enabled: true, pointsBalance: 120, pendingPoints: 10, valuePaise: 12000, expiring: null, history: [{ at: AT, points: 120, reason: 'Order A-1000', orderNumber: 'A-1000' }], referral: { code: 'ASHA10', url: `https://${brand.linkHosts[0]}/refer/ASHA10`, text: 'Shop with my link' } };
    const { services } = await signedIn(name, { 'GET /api/store/app/rewards': reply(rewards) });
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    await fireEvent.press(await screen.findByTestId('row-rewards'));
    expect(await screen.findByTestId('points-balance')).toHaveTextContent(/120/);
    expect(screen.getByTestId('points-value')).toHaveTextContent(/₹120/);
    expect(screen.getByTestId('referral-url')).toHaveTextContent(`https://${brand.linkHosts[0]}/refer/ASHA10`);
    expect(flatText()).not.toMatch(PLATFORM_WORD);
  });

  test('a friend’s referral link keeps its code for checkout', async () => {
    const { services } = await signedIn(name, { 'GET /api/store/app/rewards': reply({ enabled: false, pointsBalance: 0, pendingPoints: 0, valuePaise: 0, expiring: null, history: [], referral: null }) });
    await openAt(services, brand, '/refer/FRIEND7');
    expect(await screen.findByTestId('referral-kept')).toBeTruthy();
    expect(services.checkout.preferred.referralCode).toBe('FRIEND7');
  });

  test('saved addresses: add one with a state from the list, and it goes to the store as typed', async () => {
    const saved = { id: 31, name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', state: 'Maharashtra', pincode: '411001', kind: 'home', isDefault: true };
    const { services, store } = await signedIn(name, { 'GET /api/store/addresses': reply({ items: [saved] }), 'POST /api/store/addresses': reply({ address: saved }, 201) });
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-account'));
    await fireEvent.press(await screen.findByTestId('row-addresses'));
    expect(await screen.findByTestId('address-31')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('address-add'));
    await fireEvent.press(await screen.findByTestId('address-save'));
    expect(await screen.findByText('Enter your full name')).toBeTruthy();
    await type('addr-name', 'Ravi Rao');
    await type('addr-phone', '9811111111');
    await type('addr-line1', '4 Hill Street');
    await type('addr-pincode', '560001');
    await type('addr-city', 'Bengaluru');
    await fireEvent.press(screen.getByTestId('addr-state'));
    await fireEvent.press(await screen.findByTestId('state-29'));
    await fireEvent.press(screen.getByTestId('address-save'));
    await waitFor(() => expect(store.log.some((c) => c.method === 'POST' && c.path === '/api/store/addresses')).toBe(true));
    expect(store.log.find((c) => c.method === 'POST' && c.path === '/api/store/addresses').body).toMatchObject({ name: 'Ravi Rao', stateCode: '29', pincode: '560001', kind: 'home', isDefault: false });
  });

  test('a review goes with its photos as a form, and the store’s reply tells the shopper it will show once checked', async () => {
    const picked = [{ uri: 'file:///tmp/r.jpg', fileName: 'r.jpg', mimeType: 'image/jpeg' }];
    const made = setup(name, makeStore(name, { over: {
      'GET /api/store/app/products/brass-lamp': reply(PRODUCT),
      'GET /api/store/products/7/reviews': reply({ count: 1, average: 4.5, items: [{ id: 1, rating: 5, body: 'Lovely', displayName: 'Meera', reply: null, createdAt: AT }], nextCursor: null }),
      'POST /api/store/reviews': reply({ review: { id: 2 }, message: 'Thank you. It will appear once checked.' }, 201),
    } }), { imagePicker: { launchImageLibraryAsync: async () => ({ canceled: false, assets: picked }) } });
    await made.services.session.signInWithCode('9876543210', '123456');
    const linking = { ...linkingOf(features, brand), getInitialURL: async () => null, subscribe: () => () => {} };
    await render(<App services={made.services} linking={{ ...linking, config: { screens: { 'reviews.index': 'reviews/:slug' } }, getInitialURL: async () => `https://${brand.linkHosts[0]}/reviews/brass-lamp?orderNumber=A-1000` }} />);
    expect(await screen.findByTestId('reviews-summary')).toHaveTextContent(/4.5 out of 5/);
    expect(screen.getByTestId('review-1')).toBeTruthy();
    await type('review-body', 'Very nice');
    await fireEvent.press(screen.getByTestId('review-add-photo'));
    await fireEvent.press(await screen.findByTestId('review-send'));
    expect(await screen.findByTestId('review-thanks')).toHaveTextContent('Thank you. It will appear once checked.');
    const parts = Object.fromEntries([...made.store.log.find((c) => c.path === '/api/store/reviews').body.entries()]);
    expect(parts).toMatchObject({ orderNumber: 'A-1000', productId: '7', rating: '5', body: 'Very nice' });
    expect('photos' in parts).toBe(true);
  });
});
