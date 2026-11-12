import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { fakeNetwork, makeServices, memoryStorage, renderShell, signedInAs, OWNER, SHOP_A, MEMBERSHIPS, fakeApi } from '../../shell/testing.js';
import { AT, CATALOG_STAFF, ORDERS_STAFF, openApp, settle, writes, forgetApps } from './kit/testing.js';
import orders from './index.js';
import refunds from '../refunds/index.js';
import invoices from '../invoices/index.js';
import inventory from '../inventory/index.js';

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

/** A cash on delivery order waiting for the seller, as the server sends it. */
function codOrder(over = {}) {
  return {
    id: 1, orderNumber: 'AT-1001', status: 'awaiting_payment', customerName: 'Sunita', phone: '+919811112222', email: '', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001',
    subtotalPaise: 99900, shippingPaise: 0, totalPaise: 99900, reelId: null, source: 'dm', notes: '', createdAt: AT, updatedAt: AT,
    flow: 'checkout', fulfilmentStatus: 'new', paymentStatus: 'cod_due', paymentMode: 'cod', holdReason: null, cancelReason: null,
    discountPaise: 0, loyaltyPaise: 0, codFeePaise: 0, taxPaise: 0, advancePaise: 0, balancePaise: 99900, paidPaise: 0, refundedPaise: 0, couponCode: '',
    codRisk: 'none', gatewayMode: 'managed', nextFulfilment: ['packed', 'cancelled'], canCancel: true, refundDuePaise: 0,
    confirmedAt: null, shippedAt: null, deliveredAt: null, cancelledAt: null, itemCount: 1,
    items: [{ id: 11, productId: 5, name: 'Clay pot', image: '', pricePaise: 99900, option: 'Large', sku: 'POT-L', qty: 1 }],
    ...over,
  };
}

/** The order routes: a little state machine of its own, so a refusal and a reload can be told apart. */
function orderRoutes(state) {
  const list = () => ({ items: state.orders.map(({ items, ...row }) => row), nextCursor: null });
  const one = (call) => state.orders.find((o) => call.path === `/orders/${o.id}`) ?? [404, { error: 'Not found', code: 'not_found' }];
  return {
    'GET /orders': list,
    'GET /orders/:id': one,
    'POST /orders/:id/advance': (call) => {
      const id = Number(call.path.split('/')[2]);
      if (state.refuse) return [409, { error: state.refuse, code: 'conflict' }];
      state.orders = state.orders.map((o) => (o.id === id ? { ...o, fulfilmentStatus: call.body.to, nextFulfilment: ['shipped', 'cancelled'] } : o));
      return state.orders.find((o) => o.id === id);
    },
    'GET /orders/:id/timeline': () => ({ items: [{ id: 'e1', kind: 'created', at: AT, actor: 'shopper', to: null, reason: '', note: '' }] }),
    'GET /orders/:id/shipments': () => ({ items: [] }),
    'GET /orders/:id/payments': () => ({ items: [] }),
    'GET /orders/:id/refunds': () => ({ items: [] }),
    'GET /invoices': () => ({ items: [], nextCursor: null }),
    'GET /order-alerts': () => ({ items: [], nextCursor: null }),
  };
}

test('P-18 Confirm on a cash on delivery order sends the move and nothing else, then shows what the server now holds', async () => {
  const state = { orders: [codOrder()] };
  const { server } = await openApp({ list: [orders], path: '/orders', routes: orderRoutes(state) });
  const row = await screen.findByTestId('order-1');
  expect(within(row).getByText('New')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('order-1-confirm'));
  await waitFor(() => expect(writes(server)).toHaveLength(1));
  const [call] = writes(server);
  expect([call.method, call.path]).toEqual(['POST', '/orders/1/advance']);
  expect(call.body).toEqual({ to: 'packed' }); // never an amount: what is due is the server's
  expect(JSON.stringify(call.body)).not.toMatch(/paise|amount|total/i);
  expect(await screen.findByText('Confirmed. It’s marked as packed.')).toBeTruthy();
  await waitFor(() => expect(within(screen.getByTestId('order-1')).getByText('Packed')).toBeTruthy());
  expect(screen.queryByTestId('order-1-confirm')).toBeNull(); // the list was read again, not guessed
});

test('a move the state machine refuses shows the server’s reason, and the order is read again to show the truth', async () => {
  const state = { orders: [codOrder({ id: 2, orderNumber: 'AT-1002' })], refuse: null };
  const { server } = await openApp({ list: [orders], path: '/orders/2', routes: orderRoutes(state) });
  expect(await screen.findByTestId('order-action-confirm')).toBeTruthy();
  // Meanwhile the shopper cancelled: the server refuses the move and now holds a cancelled order.
  state.refuse = 'This order was cancelled, so it can’t be packed.';
  state.orders = state.orders.map((o) => ({ ...o, fulfilmentStatus: 'cancelled', cancelReason: 'shopper', nextFulfilment: [], canCancel: false }));
  const readsBefore = server.calls.filter((c) => c.method === 'GET' && c.path === '/orders/2').length;
  await fireEvent.press(screen.getByTestId('order-action-confirm'));
  expect(await screen.findByText('This order was cancelled, so it can’t be packed.')).toBeTruthy();
  await waitFor(() => expect(server.calls.filter((c) => c.method === 'GET' && c.path === '/orders/2').length).toBeGreaterThan(readsBefore));
  await waitFor(() => expect(screen.queryByTestId('order-action-confirm')).toBeNull());
  expect(within(screen.getByTestId('order-badges')).getByText('Cancelled')).toBeTruthy();
});

test('P-19 Orders opened with no connection shows the saved orders under the Offline banner, with Confirm disabled', async () => {
  // First, online: the list is read and saved on the phone.
  const storage = memoryStorage();
  const state = { orders: [codOrder()] };
  const first = fakeApi({ routes: orderRoutes(state) });
  const before = makeServices(first, { storage });
  await before.session.adopt(signedInAs(OWNER, SHOP_A, MEMBERSHIPS));
  const opened = await renderShell(before, { list: [orders], linking: { getInitialURL: async () => 'bhavabusiness://orders', addEventListener: () => ({ remove() {} }) } });
  expect(await screen.findByTestId('order-1')).toBeTruthy();
  await before.cache.flush();
  expect(storage.items.size).toBeGreaterThan(0);
  opened.view.unmount();
  before.queryClient.clear();

  // Then airplane mode: the server cannot be reached and the network says so.
  const network = fakeNetwork(false);
  const unreachable = () => {
    throw new TypeError('Network request failed');
  };
  const { server, made } = await openApp({ list: [orders], path: '/orders', routes: { ...orderRoutes(state), 'GET /orders': unreachable }, network, storage });
  await act(async () => network.set(false));
  await settle();
  expect(await screen.findByTestId('order-1')).toBeTruthy();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  const confirm = screen.getByTestId('order-1-confirm');
  expect(confirm.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(confirm);
  await settle();
  expect(writes(server)).toEqual([]); // nothing was sent, and nothing was kept to send later
  expect(made.queryClient.getMutationCache().getAll()).toEqual([]);
});

test('P-12 staff without the orders permission do not see Orders, and a link to it opens nothing', async () => {
  const state = { orders: [codOrder()] };
  const { server } = await openApp({ list: [orders, invoices, inventory], path: '/orders/1', routes: { ...orderRoutes(state), 'GET /inventory': () => ({ items: [], nextCursor: null }), 'GET /inventory/settings': () => ({ lowStockThreshold: 3 }) }, user: CATALOG_STAFF });
  await screen.findByTestId('tab-more');
  expect(screen.queryByTestId('tab-orders')).toBeNull();
  expect(screen.queryByTestId('screen-order')).toBeNull();
  expect(server.calls.some((c) => c.path.startsWith('/orders'))).toBe(false);
});

test('P-12 a call the server refuses shows the refusal in words, never the server’s own message', async () => {
  const routes = { 'GET /orders': () => [403, { error: 'Staff 8 lacks orders on tenant 1', code: 'forbidden' }] };
  await openApp({ list: [orders], path: '/orders', routes, user: ORDERS_STAFF });
  expect(await screen.findByText('You don’t have access to this. Ask the owner of this business.')).toBeTruthy();
  expect(screen.queryByText(/tenant 1/)).toBeNull();
});

test('S-29 a manager sees no Refund button on an order; the owner opens the refund screen from it', async () => {
  const state = { orders: [codOrder({ id: 3, paymentMode: 'prepaid', paymentStatus: 'paid', paidPaise: 99900, balancePaise: 0, fulfilmentStatus: 'packed', nextFulfilment: ['shipped'] })] };
  const { MANAGER } = require('./kit/testing.js');
  const asManager = await openApp({ list: [orders, refunds], path: '/orders/3', routes: orderRoutes(state), user: MANAGER });
  expect(await screen.findByTestId('order-refunds')).toBeTruthy();
  expect(screen.queryByTestId('order-refund')).toBeNull();
  expect(screen.getByText('Only the owner can refund it.')).toBeTruthy();
  asManager.view.unmount();

  await openApp({ list: [orders, refunds], path: '/orders/3', routes: orderRoutes(state) });
  await fireEvent.press(await screen.findByTestId('order-refund'));
  expect(await screen.findByTestId('screen-refund-create')).toBeTruthy();
});
