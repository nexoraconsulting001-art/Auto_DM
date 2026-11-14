import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { AT, everythingHeld, openApp, writes, forgetApps } from '../orders/kit/testing.js';
import orders from '../orders/index.js';
import refunds from './index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

afterEach(forgetApps);

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const ORDER = {
  id: 3, orderNumber: 'AT-1003', status: 'paid', customerName: 'Sunita', phone: '+919811112222', email: '', address: '', city: '', state: '', pincode: '',
  subtotalPaise: 99900, shippingPaise: 0, totalPaise: 99900, reelId: null, source: 'store', notes: '', createdAt: AT, updatedAt: AT,
  flow: 'checkout', fulfilmentStatus: 'packed', paymentStatus: 'paid', paymentMode: 'prepaid', holdReason: null, cancelReason: null, discountPaise: 0, loyaltyPaise: 0,
  codFeePaise: 0, taxPaise: 0, advancePaise: 0, balancePaise: 0, paidPaise: 99900, refundedPaise: 0, couponCode: '', codRisk: 'none', gatewayMode: 'managed',
  nextFulfilment: ['shipped'], canCancel: false, refundDuePaise: 0, confirmedAt: AT, shippedAt: null, deliveredAt: null, cancelledAt: null, itemCount: 1, items: [],
};
const PAYMENT = { id: 21, orderId: 3, purpose: 'full', provider: 'razorpay', method: 'upi', amountPaise: 99900, feePaise: 0, feeTaxPaise: 0, refundedPaise: 0, status: 'captured', needsReview: false, transferStatus: 'none', capturedAt: AT, createdAt: AT };

test('S-28 a refund sends only the amount the person typed, refuses more than can go back, and a retry is the same refund', async () => {
  let failNext = true;
  const routes = {
    'GET /orders/:id': () => ORDER,
    'GET /orders/:id/payments': () => ({ items: [PAYMENT] }),
    'POST /orders/:id/refunds': (call) => {
      if (failNext) {
        failNext = false;
        throw new TypeError('Network request failed'); // the answer was lost
      }
      return [201, { id: 40, orderId: 3, paymentId: 21, amountPaise: call.body.amountPaise, status: 'requested', method: 'gateway', reference: '', reason: call.body.reason, reversalStatus: 'none', reversalPaise: 0, createdAt: AT, processedAt: null }];
    },
  };
  const { server, made } = await openApp({ list: [orders, refunds], path: '/orders/3/refund', routes });
  expect(await screen.findByText('Up to ₹999 can go back to the customer, the way they paid.')).toBeTruthy();
  const password = screen.getByTestId('refund-password');
  expect(password.props.secureTextEntry).toBe(true);

  await fireEvent.changeText(screen.getByTestId('refund-amount'), '1000');
  await fireEvent.changeText(password, 'owner-pass');
  await fireEvent.press(screen.getByTestId('refund-submit'));
  expect(await screen.findByText('You can refund at most ₹999')).toBeTruthy();
  expect(writes(server)).toEqual([]);

  await fireEvent.changeText(screen.getByTestId('refund-amount'), '499.50');
  await fireEvent.press(screen.getByTestId('refund-submit'));
  expect(await screen.findByText('We couldn’t reach the server. Check your connection and try again.')).toBeTruthy();
  expect(screen.getByTestId('refund-password').props.value).toBe(''); // typed again, never kept
  await fireEvent.changeText(screen.getByTestId('refund-password'), 'owner-pass');
  await fireEvent.press(screen.getByTestId('refund-submit'));
  expect(await screen.findByTestId('refund-done')).toBeTruthy();

  const sent = writes(server).filter((c) => c.path === '/orders/3/refunds');
  expect(sent).toHaveLength(2);
  expect(sent[0].body.idempotencyKey).toBe(sent[1].body.idempotencyKey);
  expect(sent[1].body).toEqual({ amountPaise: 49950, reason: '', idempotencyKey: sent[0].body.idempotencyKey, password: 'owner-pass' });
  expect(everythingHeld(made)).not.toContain('owner-pass');
});

test('S-29 a manager opening the refund screen by a link cannot refund', async () => {
  const { MANAGER } = require('../orders/kit/testing.js');
  const routes = { 'GET /orders/:id': () => ORDER, 'GET /orders/:id/payments': () => ({ items: [PAYMENT] }) };
  const { server } = await openApp({ list: [orders, refunds], path: '/orders/3/refund', routes, user: MANAGER });
  expect(await screen.findByTestId('refund-owner-only')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('refund-submit').props.accessibilityState.disabled).toBe(true));
  expect(writes(server)).toEqual([]);
});
