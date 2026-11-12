import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { MANAGER, ORDERS_STAFF, everythingHeld, fresh, openApp, settle, writes, forgetApps } from '../orders/kit/testing.js';
import payments from './index.js';
import shipping from '../shipping/index.js';
import shopify from '../shopify/index.js';
import settings from '../settings/index.js';
import orders from '../orders/index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

afterEach(forgetApps);

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const SECRET = 'typed-key-secret';
const ACCOUNT = { mode: 'own', provider: 'razorpay', kycStatus: 'not_started', linkedAccount: '', ownConnection: 'keys', ownAccount: 'acc_9', webhookUrl: 'https://alpha.example.com/webhooks/razorpay' };
const OPTIONS = { upi: true, card: true, netbanking: true, wallet: false, cod: true, partAdvance: false, codFeePaise: 0, codMaxOrderPaise: null, codPincodes: [], codBlockRtoCount: null, advanceKind: 'fixed', advanceValue: 0, holdMinutes: 30, onlineReady: true };
const SETTINGS = { storeName: 'Alpha Traders', tagline: '', instagramHandle: 'alpha', shippingFeePaise: 0, freeShippingAbovePaise: 0, upiId: 'alpha@okbank', upiPayee: 'Alpha', supportWhatsapp: '', supportEmail: '', heroKicker: '', heroTitle: '', heroSubtitle: '', trustPoints: '', bulkTitle: '', bulkText: '', aboutText: '', gstin: '', checklistDismissed: false };

function routes(extra = {}) {
  const state = { shop: null };
  return {
    'GET /payment-account': () => ACCOUNT,
    'GET /payment-settings': () => OPTIONS,
    'GET /settings': () => SETTINGS,
    'PATCH /settings/payment': () => SETTINGS,
    'GET /shipping-settings': () => ({ mode: 'own', pickupName: '', pickupPhone: '', pickupLine1: '', pickupLine2: '', pickupCity: '', pickupStateCode: '', pickupPincode: '', pickupRegistered: false, ownEmail: 'ops@alpha.in', ownPasswordSet: true, chargeBilling: 'payout' }),
    'PATCH /shipping-settings': (call) => ({ mode: 'own', pickupName: '', pickupPhone: '', pickupLine1: '', pickupLine2: '', pickupCity: '', pickupStateCode: '', pickupPincode: '', pickupRegistered: false, ownEmail: call.body.ownEmail ?? '', ownPasswordSet: true, chargeBilling: 'payout' }),
    'GET /shopify': () => state.shop ?? { connected: false, shopDomain: '', mode: 'source', status: 'none', lastReconciledAt: null, pendingOrders: 0, failedOrders: 0, webhookUrl: null },
    'PUT /shopify': (call) => (state.shop = { connected: true, shopDomain: call.body.shopDomain, mode: call.body.mode, status: 'active', lastReconciledAt: null, pendingOrders: 0, failedOrders: 0, webhookUrl: 'https://alpha.example.com/webhooks/shopify' }),
    ...extra,
  };
}

async function confirmWithCode() {
  await fireEvent.press(await screen.findByTestId('reauth-send'));
  await fireEvent.changeText(await screen.findByTestId('reauth-code'), '654321');
  await fireEvent.press(screen.getByTestId('reauth-verify'));
  await settle();
}

test('P-17 replacing the Razorpay key asks for a fresh code first; the field is masked, write-only, and the key is kept nowhere', async () => {
  const { server, made } = await openApp({ list: [payments], path: '/payments', routes: routes() });
  await fireEvent.press(await screen.findByTestId('payments-use-keys'));
  const secret = screen.getByTestId('payments-keys-razorpayKeySecret');
  expect(secret.props.secureTextEntry).toBe(true);
  expect(secret.props.value).toBe(''); // never filled from anything the server sent
  expect(secret.props.contextMenuHidden).toBe(true);
  expect(secret.props.autoComplete).toBe('off');
  expect(screen.getByText('One is saved. It is never shown. Type a new one to replace it.')).toBeTruthy();

  await fireEvent.changeText(screen.getByTestId('payments-keys-razorpayKeyId'), 'rzp_live_ABC123def');
  await fireEvent.changeText(secret, SECRET);
  await fireEvent.press(screen.getByTestId('payments-keys-save'));
  expect(await screen.findByTestId('reauth')).toBeTruthy();
  expect(writes(server).some((c) => c.path === '/settings/payment')).toBe(false); // nothing goes before the check
  await confirmWithCode();

  await waitFor(() => expect(writes(server).some((c) => c.path === '/settings/payment')).toBe(true));
  const paths = writes(server).map((c) => c.path);
  expect(paths.indexOf('/auth/reauth/verify')).toBeLessThan(paths.indexOf('/settings/payment'));
  expect(writes(server).find((c) => c.path === '/settings/payment').body).toEqual({ razorpayKeyId: 'rzp_live_ABC123def', razorpayKeySecret: SECRET });
  expect(await screen.findByText('Keys saved. The secret can’t be read back.')).toBeTruthy();
  expect(screen.getByTestId('payments-keys-razorpayKeySecret').props.value).toBe('');

  await made.cache.flush();
  expect(everythingHeld(made)).not.toContain(SECRET);
  expect(JSON.stringify(SecureStore.__dump())).not.toContain(SECRET);
});

test('P-17 closing the fresh check sends nothing and keeps nothing typed', async () => {
  const { server } = await openApp({ list: [payments], path: '/payments', routes: routes() });
  await fireEvent.press(await screen.findByTestId('payments-use-keys'));
  await fireEvent.changeText(screen.getByTestId('payments-keys-razorpayKeyId'), 'rzp_live_ABC123def');
  await fireEvent.changeText(screen.getByTestId('payments-keys-razorpayKeySecret'), SECRET);
  await fireEvent.press(screen.getByTestId('payments-keys-save'));
  await fireEvent.press(await screen.findByTestId('reauth-close'));
  await settle();
  expect(writes(server).some((c) => c.path === '/settings/payment')).toBe(false);
});

test('P-17 a key the server refuses still leaves the field empty, and its reason is shown', async () => {
  const refuse = { 'PATCH /settings/payment': () => [400, { error: 'Razorpay did not accept these keys.', code: 'validation_failed' }] };
  await openApp({ list: [payments], path: '/payments', routes: routes(refuse), freshUntil: fresh() });
  await fireEvent.press(await screen.findByTestId('payments-use-keys'));
  await fireEvent.changeText(screen.getByTestId('payments-keys-razorpayKeyId'), 'rzp_live_ABC123def');
  await fireEvent.changeText(screen.getByTestId('payments-keys-razorpayKeySecret'), SECRET);
  await fireEvent.press(screen.getByTestId('payments-keys-save'));
  expect(await screen.findByText('Razorpay did not accept these keys.')).toBeTruthy();
  expect(screen.getByTestId('payments-keys-razorpayKeySecret').props.value).toBe('');
});

test('P-17 the Shiprocket password and the Shopify token go the same way: fresh first, masked, sent once', async () => {
  const shippingRun = await openApp({ list: [shipping], path: '/shipping', routes: routes(), freshUntil: fresh() });
  const password = await screen.findByTestId('shipping-own-password');
  expect(password.props.secureTextEntry).toBe(true);
  expect(password.props.value).toBe('');
  await fireEvent.changeText(password, 'ship-pass-77');
  await fireEvent.press(screen.getByTestId('shipping-save'));
  await waitFor(() => expect(writes(shippingRun.server).some((c) => c.path === '/shipping-settings')).toBe(true));
  expect(writes(shippingRun.server).find((c) => c.path === '/shipping-settings').body.ownPassword).toBe('ship-pass-77');
  expect(await screen.findByText('Shipping settings saved. The password can’t be read back.')).toBeTruthy();
  expect(screen.getByTestId('shipping-own-password').props.value).toBe('');
  await shippingRun.made.cache.flush();
  expect(everythingHeld(shippingRun.made)).not.toContain('ship-pass-77');
  shippingRun.view.unmount();

  const shop = await openApp({ list: [shopify], path: '/shopify', routes: routes() });
  await fireEvent.changeText(await screen.findByTestId('shopify-connect-shopDomain'), 'alpha.myshopify.com');
  expect(screen.getByTestId('shopify-connect-accessToken').props.secureTextEntry).toBe(true);
  expect(screen.getByTestId('shopify-connect-webhookSecret').props.secureTextEntry).toBe(true);
  await fireEvent.changeText(screen.getByTestId('shopify-connect-accessToken'), 'shpat_secret_1');
  await fireEvent.changeText(screen.getByTestId('shopify-connect-webhookSecret'), 'whsec_2');
  await fireEvent.press(screen.getByTestId('shopify-connect-save'));
  await confirmWithCode();
  await waitFor(() => expect(writes(shop.server).some((c) => c.method === 'PUT' && c.path === '/shopify')).toBe(true));
  expect(writes(shop.server).find((c) => c.path === '/shopify').body).toEqual({ shopDomain: 'alpha.myshopify.com', accessToken: 'shpat_secret_1', webhookSecret: 'whsec_2', mode: 'source' });
  expect(await screen.findByTestId('shopify-connected')).toBeTruthy();
  await shop.made.cache.flush();
  const held = everythingHeld(shop.made);
  expect(held).not.toContain('shpat_secret_1');
  expect(held).not.toContain('whsec_2');
});

test('P-12 staff never see Payments, and a link to it opens nothing; a manager sees it without the owner’s controls', async () => {
  const staffRun = await openApp({ list: [payments, settings, orders], path: '/payments', routes: { ...routes(), 'GET /orders': () => ({ items: [], nextCursor: null }) }, user: ORDERS_STAFF });
  expect(await screen.findByTestId('tab-orders')).toBeTruthy();
  expect(screen.queryByTestId('screen-payments')).toBeNull();
  expect(staffRun.server.calls.some((c) => c.path.startsWith('/payment'))).toBe(false);
  staffRun.view.unmount();

  await openApp({ list: [payments], path: '/payments', routes: routes(), user: MANAGER });
  expect(await screen.findByTestId('screen-payments')).toBeTruthy();
  expect(await screen.findByTestId('payments-owner-only')).toBeTruthy();
  expect(screen.queryByTestId('payments-use-keys')).toBeNull();
  expect(screen.queryByTestId('payments-switch')).toBeNull();
  expect(screen.queryByTestId('payments-upi')).toBeNull();
  expect(screen.getByTestId('payments-save')).toBeTruthy(); // the ways to pay are a manager's to change
});
