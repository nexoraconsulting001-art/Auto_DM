import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { onlineManager } from '@tanstack/react-query';
import setup from './index.js';
import { PICKUP_FIELDS, TERMS_VERSION, checkPickup, progressOf } from './rules.js';
import { AT, MANAGER, forgetApps, fresh, openAt, screenText, settle, writes } from '../billing/testing.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.setTimeout(40_000);
afterEach(forgetApps);
beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
  WebBrowser.openBrowserAsync.mockClear();
});

const step = (name, status, over = {}) => ({ step: name, label: name, required: true, status, checkedAt: AT, code: '', reason: '', fix: '', ...over });
const checklist = (over = {}) => ({
  plan: 't3', done: false, checkoutOpen: false, kyc: { status: 'needs_clarification', reason: 'PAN does not match' },
  steps: [
    step('instagram', 'done'),
    step('terms', 'pending', { fix: 'terms' }),
    step('domain', 'waiting', { fix: 'dns', reason: 'DNS has not reached us yet' }),
    step('payments', 'failed', { fix: 'kyc', reason: 'PAN does not match' }),
    step('shipping', 'pending', { fix: 'pickup' }),
    step('own_keys', 'pending', { required: false, fix: 'keys' }),
  ],
  ...over,
});
const routes = (extra = {}) => ({
  'GET /setup': () => checklist(),
  'POST /setup/check': () => checklist(),
  'POST /setup/terms': () => checklist(),
  'POST /setup/kyc-link': () => ({ url: 'https://razorpay.example/kyc/abc', status: 'needs_clarification', reason: '' }),
  'PUT /setup/pickup-address': () => checklist(),
  'PUT /setup/own-keys': (call) => ({ provider: call.body.provider, keyId: call.body.keyId, masked: 'sk_••••', checklist: checklist() }),
  ...extra,
});
const open = (extra, opts = {}) => openAt('/setup', { list: [setup], routes: routes(extra), freshUntil: fresh(), ...opts });

test('the checklist shows how far along, each step’s live state, the reason, and the partner’s KYC words', async () => {
  await open();
  await screen.findByTestId('setup-step-payments');
  const text = screenText();
  expect(text).toMatch(/1 of 5 steps done/);
  expect(text).toMatch(/PAN does not match/);
  expect(text).toMatch(/Checkout opens once payments are approved/);
  expect(text).toMatch(/needs a little more from you/);
  expect(screen.getByTestId('setup-step-own_keys-status')).toBeTruthy();
  expect(text).toMatch(/Optional/);
});

test('check everything now asks the server to run the live checks, for all steps', async () => {
  const { server } = await open();
  await fireEvent.press(await screen.findByTestId('setup-check-all'));
  await waitFor(() => expect(writes(server).find((c) => c.path === '/setup/check')?.body).toEqual({}));
  await fireEvent.press(screen.getByTestId('setup-step-domain-check'));
  await waitFor(() => expect(writes(server).filter((c) => c.path === '/setup/check').pop().body).toEqual({ step: 'domain' }));
});

test('KYC opens the payment partner’s own page in the browser; no KYC detail is typed here', async () => {
  const { server } = await open();
  await fireEvent.press(await screen.findByTestId('setup-step-payments-fix'));
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://razorpay.example/kyc/abc'));
  expect(writes(server).find((c) => c.path === '/setup/kyc-link').body).toBeUndefined();
});

test('the terms are accepted by the owner after a confirmation, and the version is sent', async () => {
  const { server } = await open();
  await fireEvent.press(await screen.findByTestId('setup-step-terms-fix'));
  expect(screenText()).toMatch(/current terms of service/);
  await fireEvent.press(await screen.findByTestId('setup-terms-confirm'));
  await waitFor(() => expect(writes(server).find((c) => c.path === '/setup/terms')?.body).toEqual({ version: TERMS_VERSION }));
});

test('the pickup address is checked on the screen first, then sent as the server wants it', async () => {
  const { server } = await open();
  await fireEvent.press(await screen.findByTestId('setup-step-shipping-fix'));
  await fireEvent.press(await screen.findByTestId('pickup-save'));
  expect(screenText()).toMatch(/Enter a 10-digit mobile number/);
  expect(writes(server).some((c) => c.path === '/setup/pickup-address')).toBe(false);
  const values = { name: 'Asha', phone: '9812345678', email: '', line1: '12 MG Road', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
  for (const [name, value] of Object.entries(values)) await fireEvent.changeText(screen.getByTestId(`pickup-${name}`), value);
  await fireEvent.press(screen.getByTestId('pickup-save'));
  await waitFor(() => expect(writes(server).find((c) => c.path === '/setup/pickup-address')?.body).toEqual(values));
});

test('your own keys are tested by the server, never shown back, and the fields are emptied', async () => {
  const { server } = await open();
  await fireEvent.press(await screen.findByTestId('setup-step-own_keys-fix'));
  await fireEvent.changeText(await screen.findByTestId('keys-form-keyId'), 'rzp_live_abc');
  await fireEvent.changeText(screen.getByTestId('keys-form-keySecret'), 'topsecretvalue');
  await fireEvent.press(screen.getByTestId('keys-form-save'));
  await waitFor(() => expect(writes(server).find((c) => c.path === '/setup/own-keys')?.body).toEqual({ provider: 'razorpay', keyId: 'rzp_live_abc', keySecret: 'topsecretvalue' }));
  await settle(100);
  expect(screenText()).not.toContain('topsecretvalue');
});

test('keys that fail the test call are refused with the server’s words and nothing stays typed', async () => {
  await open({ 'PUT /setup/own-keys': () => [400, { error: 'Razorpay did not accept these keys', code: 'validation' }] });
  await fireEvent.press(await screen.findByTestId('setup-step-own_keys-fix'));
  await fireEvent.changeText(await screen.findByTestId('keys-form-keyId'), 'bad');
  await fireEvent.changeText(screen.getByTestId('keys-form-keySecret'), 'worse');
  await fireEvent.press(screen.getByTestId('keys-form-save'));
  await screen.findByTestId('keys-form-problem');
  expect(screenText()).toMatch(/did not accept these keys/);
  expect(screen.getByTestId('keys-form-keySecret').props.value).toBe('');
});

test('a manager sees where things stand but is sent to the owner for the steps', async () => {
  await open({}, { user: MANAGER });
  await screen.findByTestId('setup-step-payments');
  expect(screen.queryByTestId('setup-step-payments-fix')).toBeNull();
  expect(screenText()).toMatch(/The owner does this step/);
});

test('all done shows the finished state', async () => {
  await open({ 'GET /setup': () => checklist({ done: true, checkoutOpen: true, steps: [step('instagram', 'done')] }) });
  expect(await screen.findByText('Everything is set up')).toBeTruthy();
});

test('a failed read says so and offers a retry', async () => {
  await open({ 'GET /setup': () => [500, { error: 'x', code: 'internal' }] });
  await screen.findByTestId('setup-error', {}, { timeout: 15000 });
});

test('rules: progress counts only required steps, and the address rules match the server', () => {
  expect(progressOf(checklist().steps)).toEqual({ done: 1, total: 5 });
  expect(checkPickup(Object.fromEntries(PICKUP_FIELDS.map((f) => [f.name, '']))).problems).toMatchObject({ name: expect.any(String), phone: expect.any(String), pincode: expect.any(String) });
  expect(checkPickup({ name: 'A', phone: '1234567890', line1: 'x', city: 'c', state: 's', pincode: '123456' }).problems.phone).toBeTruthy();
  expect(checkPickup({ name: 'A', phone: '9876543210', email: 'bad', line1: 'x', city: 'c', state: 's', pincode: '12345' }).problems).toMatchObject({ email: expect.any(String), pincode: expect.any(String) });
});
