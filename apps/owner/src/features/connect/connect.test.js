import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { fakeNetwork } from '../../shell/testing.js';
import { MANAGER, callsTo, daysFromNow, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import connect from './index.js';
import { connectionView, isMetaLogin, pageView } from './connection.js';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })), openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

jest.setTimeout(30000);
beforeEach(reset);

const ACTIVE = { status: 'active', igUserId: '1784', username: 'kesarhome', loginKind: 'instagram', scopes: ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights'], missingScopes: [], insightsGranted: true, tokenExpiresAt: daysFromNow(41), health: 'ok', webhooksSubscribed: true };
const NONE = { ...ACTIVE, status: 'not_connected', igUserId: null, username: '', scopes: [], tokenExpiresAt: null, health: 'none' };
const FB_OFF = { enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null };

function routes(state, extra = {}) {
  return {
    'GET /instagram/connection': () => state.ig,
    'POST /instagram/connect': () => ({ authorizeUrl: 'https://www.instagram.com/oauth/authorize?client_id=1&state=abc' }),
    'DELETE /instagram/connection': () => {
      state.ig = NONE;
      return null;
    },
    'GET /facebook/connection': () => state.fb,
    'POST /facebook/connect': () => ({ authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth?state=x' }),
    'GET /facebook/posts': () => page([{ id: '100_200', message: 'Diwali spice box', permalink: '', postedAt: minutesAgo(60), linkedIgMediaId: null }]),
    'GET /facebook/links': () => page([]),
    'GET /facebook/link-suggestions': () => ({ items: [{ fbPostId: '100_200', igMediaId: '1790001', score: 0.92 }] }),
    'PUT /facebook/links/:id': (call) => ({ fbPostId: call.path.split('/').pop(), igMediaId: call.body.igMediaId, status: 'confirmed', confirmedAt: minutesAgo(0) }),
    'GET /instagram/media': () => page([]),
    ...extra,
  };
}

async function open(path, { ig = ACTIVE, fb = FB_OFF, extra, ...options } = {}) {
  const state = { ig, fb };
  const opened = await openAt(path, { list: [connect], routes: routes(state, extra), ...options });
  return { ...opened, state };
}

test('connecting opens Meta’s own login in the system browser, never a web view, and reads the connection again after', async () => {
  const { server, state } = await open('/connect', { ig: NONE });
  expect(await screen.findByTestId('connect-ig-start')).toBeTruthy();
  state.ig = ACTIVE; // what the server will say once the person has finished on Meta's pages
  await fireEvent.press(screen.getByTestId('connect-ig-start'));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1));
  expect(WebBrowser.openAuthSessionAsync.mock.calls[0][0]).toBe('https://www.instagram.com/oauth/authorize?client_id=1&state=abc');
  expect(WebBrowser.openAuthSessionAsync.mock.calls[0][1]).toBe('bhavabusiness://auth/callback');
  expect(callsTo(server, 'POST', '/instagram/connect').map((c) => c.body)).toEqual([{ returnTo: '/admin/connect' }]);
  expect(await screen.findByText('@kesarhome')).toBeTruthy();
  expect(callsTo(server, 'GET', '/instagram/connection').length).toBeGreaterThanOrEqual(2);
});

test('an address that is not Meta’s login opens nothing, and the person is told it didn’t work', async () => {
  await open('/connect', { ig: NONE, extra: { 'POST /instagram/connect': () => ({ authorizeUrl: 'https://evil.example.com/login' }) } });
  await fireEvent.press(await screen.findByTestId('connect-ig-start'));
  expect(await screen.findByTestId('connect-ig-refusal')).toBeTruthy();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
});

test('a lost connection is said, and a manager is offered Reconnect', async () => {
  await open('/connect', { user: MANAGER, ig: { ...ACTIVE, status: 'reconnect_needed', health: 'red' } });
  expect(await screen.findByText('Reconnect Instagram')).toBeTruthy();
  expect(screen.getByTestId('connect-ig-badge')).toBeTruthy();
});

test('staff see the connection but connecting is the owner’s and managers’', async () => {
  await open('/connect', { user: staff(['automations']), ig: NONE });
  expect(await screen.findByTestId('connect-ask-manager')).toBeTruthy();
  expect(screen.queryByTestId('connect-ig-start')).toBeNull();
});

test('a server that can’t start a connection says so plainly', async () => {
  await open('/connect', { ig: NONE, extra: { 'POST /instagram/connect': () => [409, { error: 'Instagram connection isn’t set up on this server yet.', code: 'conflict' }] } });
  await fireEvent.press(await screen.findByTestId('connect-ig-start'));
  expect(await screen.findByText('Instagram connection isn’t set up on this server yet.')).toBeTruthy();
});

test('disconnecting asks first, then the screen shows it is gone', async () => {
  const { server } = await open('/connect');
  await fireEvent.press(await screen.findByTestId('connect-ig-disconnect'));
  expect(writes(server)).toEqual([]);
  await fireEvent.press(screen.getByTestId('connect-ig-disconnect-confirm-confirm'));
  await waitFor(() => expect(callsTo(server, 'DELETE', '/instagram/connection')).toHaveLength(1));
  expect(await screen.findByTestId('connect-ig-start')).toBeTruthy();
});

test('Facebook shows nothing until it is switched on; then the Page connects the same way', async () => {
  await open('/connect');
  await screen.findByTestId('connect-instagram');
  expect(screen.queryByTestId('connect-facebook')).toBeNull();
});

test('with Facebook on, the Page connects in the system browser too', async () => {
  await open('/connect', { fb: { ...FB_OFF, enabled: true } });
  await fireEvent.press(await screen.findByTestId('connect-fb-start'));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync.mock.calls.map((c) => c[0])).toEqual(['https://www.facebook.com/v23.0/dialog/oauth?state=x']));
});

test('Facebook copies of reels: a suggestion is confirmed once', async () => {
  const { server } = await open('/connect/facebook', { fb: { ...FB_OFF, enabled: true, status: 'active', pageName: 'Kesar Home' } });
  await fireEvent.press(await screen.findByTestId('fb-suggestion-100_200-confirm'));
  await waitFor(() => expect(callsTo(server, 'PUT', '/facebook/links/100_200').map((c) => c.body)).toEqual([{ igMediaId: '1790001' }]));
});

test('offline, every connect and disconnect button is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/connect', { network });
  await screen.findByTestId('connect-ig-disconnect');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('connect-ig-disconnect').props.accessibilityState.disabled).toBe(true);
  expect(writes(server)).toEqual([]);
});

test('the connect rules: Meta’s hosts only, and what each state offers', () => {
  expect(isMetaLogin('https://www.instagram.com/oauth/authorize')).toBe(true);
  expect(isMetaLogin('https://m.facebook.com/dialog/oauth')).toBe(true);
  expect(isMetaLogin('https://instagram.com.evil.example/oauth')).toBe(false);
  expect(isMetaLogin('http://www.instagram.com/oauth')).toBe(false);
  expect(isMetaLogin('javascript:alert(1)')).toBe(false);
  expect(connectionView(NONE).action).toBe('connect.ig.connect');
  expect(connectionView({ ...ACTIVE, missingScopes: ['instagram_business_manage_comments'] }).action).toBe('connect.ig.reconnect');
  expect(connectionView({ ...ACTIVE, status: 'deauthorized' })).toMatchObject({ tone: 'bad', connected: false });
  expect(pageView({ status: 'active' }).connected).toBe(true);
  expect(connect.routeIds).toEqual(expect.arrayContaining(['instagram.connect', 'facebook.connect', 'console:/connect']));
});

test('the connect screens never draw a web view', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    expect([file, /react-native-webview|<WebView/.test(fs.readFileSync(path.join(__dirname, file), 'utf8'))]).toEqual([file, false]);
  }
  expect(React).toBeTruthy();
});
