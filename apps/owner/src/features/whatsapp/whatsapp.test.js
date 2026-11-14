import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { onlineManager } from '@tanstack/react-query';
import whatsapp from './index.js';
import { blankDraft, fromDraft, parseReturn, signupUrl, toDraft } from './rules.js';
import { AT, MANAGER, forgetApps, fresh, openAt, press, screenText, writes } from '../billing/testing.js';

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
  WebBrowser.openAuthSessionAsync.mockClear();
});

const status = (over = {}) => ({ connected: false, status: null, displayName: '', displayNumber: '', connectedAt: null, signupReady: true, ...over });
const connected = status({ connected: true, status: 'active', displayName: 'Alpha Works', displayNumber: '+91 ••••• •4321', connectedAt: AT });

function routes(state = {}) {
  state.status ??= status();
  state.keywords ??= [];
  return {
    'GET /whatsapp': () => state.status,
    'GET /whatsapp/keywords': () => ({ items: state.keywords }),
    'PUT /whatsapp/keywords': (call) => { state.keywords = call.body.items.map((s, i) => ({ id: i + 1, message: '', active: true, ...s })); return { items: state.keywords }; },
    'GET /whatsapp/optins': () => ({ items: [{ id: 1, purpose: 'marketing', source: 'keyword', optedInAt: AT, withdrawnAt: null }, { id: 2, purpose: 'order_updates', source: 'checkout', optedInAt: AT, withdrawnAt: AT }], nextCursor: null }),
    'POST /whatsapp/connect': () => ({ appId: '1234567890', configId: '9876543210', state: 'st_abc' }),
    'POST /whatsapp/connect/finish': (call) => { state.finish = call.body; state.status = connected; return connected; },
    'DELETE /whatsapp': () => { state.status = status(); return null; },
    ...state.extra,
  };
}
const open = (state, opts = {}) => openAt('/whatsapp', { list: [whatsapp], routes: routes(state), freshUntil: fresh(), ...opts });

test('not connected: says so and offers to connect; the owner starts Meta’s sign-up in the browser, and the finish carries what came back', async () => {
  const state = {};
  WebBrowser.openAuthSessionAsync.mockResolvedValueOnce({ type: 'success', url: 'bhavabusiness://done?code=AQB123&state=st_abc&waba_id=111111111&phone_number_id=222222222' });
  const { server } = await open(state);
  await screen.findByTestId('whatsapp-connect');
  expect(screenText()).toMatch(/WhatsApp is not connected/);
  await fireEvent.press(screen.getByTestId('whatsapp-connect'));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled());
  const url = WebBrowser.openAuthSessionAsync.mock.calls[0][0];
  expect(url).toMatch(/^https:\/\/business\.facebook\.com\//);
  expect(url).toContain('config_id=9876543210');
  await waitFor(() => expect(state.finish).toEqual({ code: 'AQB123', state: 'st_abc', wabaId: '111111111', phoneNumberId: '222222222' }));
  expect(writes(server).some((c) => c.path === '/whatsapp/connect/finish')).toBe(true);
});

test('connected: the display name and a masked number show, never a token or a raw number', async () => {
  await open({ status: connected });
  await screen.findByTestId('whatsapp-badge');
  const text = screenText();
  expect(text).toContain('Alpha Works');
  expect(text).toContain('+91 ••••• •4321');
  expect(text).not.toMatch(/token|access_token/i);
  expect(screen.queryByTestId('whatsapp-connect')).toBeNull();
});

test('disconnecting asks first, then calls the server', async () => {
  const state = { status: connected };
  const { server } = await open(state);
  await fireEvent.press(await screen.findByTestId('whatsapp-disconnect'));
  expect(screenText()).toMatch(/Keyword replies stop/);
  await fireEvent.press(await screen.findByTestId('whatsapp-disconnect-sheet-confirm'));
  await waitFor(() => expect(writes(server).some((c) => c.method === 'DELETE' && c.path === '/whatsapp')).toBe(true));
});

test('a plan without the add-on gets the upgrade prompt when it tries to connect', async () => {
  const extra = { 'POST /whatsapp/connect': () => [403, { error: 'Not on your plan', code: 'plan.feature_off', plan: 't1', feature: 'whatsapp' }] };
  await open({ extra });
  await fireEvent.press(await screen.findByTestId('whatsapp-connect'));
  await screen.findByTestId('upgrade-prompt');
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
});

test('sign-up that is not set up says so and cannot be started', async () => {
  await open({ status: status({ signupReady: false }) });
  await screen.findByTestId('whatsapp-not-ready');
  expect(screen.getByTestId('whatsapp-connect').props.accessibilityState?.disabled).toBe(true);
});

test('a keyword set is added with a link and saved as the whole list; a bad link is stopped on the screen', async () => {
  const state = { status: connected };
  const { server } = await open(state);
  await fireEvent.press(await screen.findByTestId('keyword-add'));
  await fireEvent.changeText(await screen.findByTestId('keyword-set-0-keywords'), 'link, LINK , price');
  await fireEvent.changeText(screen.getByTestId('keyword-set-0-link'), 'http://insecure.example/x');
  await fireEvent.press(screen.getByTestId('keyword-save'));
  expect(screenText()).toMatch(/starts with https/i);
  expect(writes(server).some((c) => c.path === '/whatsapp/keywords')).toBe(false);
  await fireEvent.changeText(screen.getByTestId('keyword-set-0-link'), 'https://shop.example/pot');
  await fireEvent.press(screen.getByTestId('keyword-save'));
  await waitFor(() => expect(writes(server).find((c) => c.path === '/whatsapp/keywords')?.body).toEqual({ items: [{ keywords: ['link', 'LINK', 'price'], reelId: null, linkUrl: 'https://shop.example/pot', message: '', active: true }] }));
});

test('a set answers with a reel or a link, never both', () => {
  const draft = { ...blankDraft(), keywords: 'a', target: 'reel', reelId: '12', linkUrl: 'https://ignored.example' };
  expect(fromDraft(draft).body).toMatchObject({ reelId: 12, linkUrl: '' });
  expect(fromDraft({ ...draft, reelId: '' }).problems.reelId).toBeTruthy();
  expect(fromDraft({ ...blankDraft(), keywords: '' }).problems.keywords).toBeTruthy();
  expect(fromDraft({ ...blankDraft(), keywords: 'x'.repeat(41), linkUrl: 'https://a.example' }).problems.keywords).toBe('whatsapp.keywords.tooLong');
  expect(toDraft({ id: 3, keywords: ['a', 'b'], reelId: 9, linkUrl: '', message: 'hi', active: false })).toMatchObject({ id: 3, keywords: 'a, b', target: 'reel', reelId: '9', active: false });
});

test('opt-ins show the purpose, the way, and who stopped, with no number', async () => {
  await open({ status: connected });
  await screen.findByTestId('optin-1');
  const text = screenText();
  expect(text).toMatch(/Through a keyword/);
  expect(text).toMatch(/Stopped/);
  expect(text).not.toMatch(/\+91\d|phone/i);
});

test('a manager sees the keywords but not the connection, and cannot connect', async () => {
  const { server } = await open({ status: connected }, { user: MANAGER });
  await screen.findByTestId('keyword-add');
  expect(screen.queryByTestId('whatsapp-connect')).toBeNull();
  expect(screen.queryByTestId('whatsapp-disconnect')).toBeNull();
  expect(server.calls.some((c) => c.path === '/whatsapp/connect')).toBe(false);
});

test('the Meta address and what comes back are checked', () => {
  expect(signupUrl({ appId: '1234567890', configId: '9876543210', state: 's' })).toMatch(/^https:\/\/business\.facebook\.com\/messaging\/whatsapp\/onboard\/\?/);
  expect(signupUrl({ appId: 'x', configId: '9876543210', state: 's' })).toBeNull();
  expect(parseReturn('bhavabusiness://x?code=C&state=S&waba_id=123456&phone_number_id=654321')).toEqual({ code: 'C', state: 'S', wabaId: '123456', phoneNumberId: '654321' });
  expect(parseReturn('bhavabusiness://x?code=C&state=S&waba_id=abc&phone_number_id=654321')).toBeNull();
  expect(parseReturn('nonsense')).toBeNull();
});
