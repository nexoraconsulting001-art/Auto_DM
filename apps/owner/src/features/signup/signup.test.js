import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { onlineManager } from '@tanstack/react-query';
import signup from './index.js';
import home from '../home/index.js';
import { formatElapsed, readyToStart, stageOf } from './rules.js';
import { AT, forgetApps, openAt, press, screenText, writes } from '../billing/testing.js';

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

const at = (...steps) => steps.map((step) => ({ step, at: AT }));
const base = { mode: 'public', signedIn: true, open: true, runToken: 'run_token_1', tenantId: null, accountType: null, steps: at('opened', 'signed_in'), next: 'account_type' };

/** A little server of its own: the record of steps moves as the person goes on. */
function signupRoutes(state, extra = {}) {
  state.status ??= { ...base };
  state.connection ??= { status: 'not_connected', username: '', scopes: [], missingScopes: [], webhooksSubscribed: false, tokenExpiresAt: null, health: 'green' };
  return {
    'GET /signup': () => state.status,
    'POST /signup': (call) => {
      state.started = call.body;
      state.status = { ...state.status, tenantId: 55, accountType: call.body.accountType, steps: at('opened', 'signed_in', 'account_type'), next: 'instagram_connected' };
      return [201, { tenantId: 55, slug: 'asha', host: 'asha.example', runToken: 'run_token_1', next: 'instagram_connected' }];
    },
    'GET /instagram/connection': () => state.connection,
    'POST /instagram/connect': () => ({ authorizeUrl: 'https://www.instagram.com/oauth/authorize?client_id=1' }),
    'GET /instagram/media': () => ({ items: [{ id: '17900', type: 'reel', caption: 'Monsoon pots', permalink: 'https://instagram.example/r/1', thumbnailUrl: '', postedAt: AT, automationId: null }], nextCursor: null }),
    'POST /signup/first-automation': (call) => {
      state.first = call.body;
      return state.firstAnswer ?? { automationId: 7, live: true, problems: [] };
    },
    'POST /signup/finish': (call) => {
      state.finished = call.body;
      return { tenantId: 55, host: 'asha.example', elapsedMs: 161_000, withinTarget: true };
    },
    ...extra,
  };
}
const open = (state, extra) => openAt('/signup', { list: [home, signup], routes: signupRoutes(state, extra) });

test('step one: the person picks Creator or Seller and a name, and the call carries exactly that', async () => {
  const state = {};
  const { server } = await open(state);
  await screen.findByTestId('signup-type');
  await fireEvent.press(await screen.findByTestId('signup-start'));
  expect(screenText()).toMatch(/Enter a name/);
  expect(writes(server).some((c) => c.path === '/signup')).toBe(false);
  await press(/^Seller$/);
  expect(screenText()).toMatch(/Sell products from your Instagram/);
  await fireEvent.changeText(screen.getByTestId('signup-name'), '  Alpha Works ');
  await fireEvent.changeText(screen.getByTestId('signup-referral'), 'asha2026');
  await fireEvent.press(screen.getByTestId('signup-start'));
  await waitFor(() => expect(state.started).toEqual({ accountType: 'seller', name: 'Alpha Works', inviteCode: '', referralCode: 'asha2026', runToken: 'run_token_1' }));
  await screen.findByTestId('signup-instagram');
});

test('Instagram is connected in the system browser, never inside the app, and the screen moves on once the server sees it', async () => {
  const state = { status: { ...base, tenantId: 55, accountType: 'creator', steps: at('opened', 'signed_in', 'account_type'), next: 'instagram_connected' } };
  const extra = {
    'POST /instagram/connect': () => {
      state.connection = { ...state.connection, status: 'active', username: 'asha' };
      state.status = { ...state.status, steps: at('opened', 'signed_in', 'account_type', 'instagram_connected') };
      return { authorizeUrl: 'https://www.instagram.com/oauth/authorize?client_id=1' };
    },
  };
  await open(state, extra);
  await fireEvent.press(await screen.findByTestId('signup-instagram-connect'));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://www.instagram.com/oauth/authorize?client_id=1', expect.any(String)));
  await screen.findByTestId('signup-auto', {}, { timeout: 8000 });
});

test('the first automation goes live with a reel, a keyword and a link, then finishes and shows how long it took', async () => {
  const state = { status: { ...base, tenantId: 55, accountType: 'creator', steps: at('opened', 'signed_in', 'account_type', 'instagram_connected'), next: 'automation_drafted' }, connection: { status: 'active', username: 'asha', scopes: [], missingScopes: [], webhooksSubscribed: true, tokenExpiresAt: null, health: 'green' } };
  const { server } = await open(state);
  await fireEvent.press(await screen.findByTestId('signup-reel-17900'));
  await fireEvent.changeText(screen.getByTestId('signup-keyword'), ' LINK ');
  await fireEvent.changeText(screen.getByTestId('signup-link'), 'https://shop.example/pot');
  await fireEvent.press(screen.getByTestId('signup-go-live'));
  await waitFor(() => expect(state.first).toEqual({ runToken: 'run_token_1', mediaId: '17900', keyword: 'LINK', link: 'https://shop.example/pot' }));
  await waitFor(() => expect(state.finished).toEqual({ runToken: 'run_token_1' }));
  await screen.findByTestId('signup-done');
  expect(screenText()).toMatch(/Live in 2 min 41 s/);
  expect(writes(server).filter((c) => c.path === '/signup/finish')).toHaveLength(1);
});

test('a link the rules refuse is not live: the server’s reason shows on its field and nothing is finished', async () => {
  const state = {
    status: { ...base, tenantId: 55, accountType: 'creator', steps: at('opened', 'signed_in', 'account_type', 'instagram_connected'), next: 'automation_drafted' },
    connection: { status: 'active', username: 'asha', scopes: [], missingScopes: [], webhooksSubscribed: true, tokenExpiresAt: null, health: 'green' },
    firstAnswer: { automationId: null, live: false, problems: [{ field: 'link', reason: 'link.shortener', message: 'Use your own link, not a shortened one' }] },
  };
  await open(state);
  await fireEvent.press(await screen.findByTestId('signup-reel-17900'));
  await fireEvent.changeText(screen.getByTestId('signup-keyword'), 'LINK');
  await fireEvent.changeText(screen.getByTestId('signup-link'), 'https://bit.ly/x');
  await fireEvent.press(screen.getByTestId('signup-go-live'));
  await screen.findByTestId('signup-reason-link');
  expect(screenText()).toMatch(/not a shortened one/);
  expect(state.finished).toBeUndefined();
});

test('the link, keyword and reel are checked on the screen before anything is sent', async () => {
  const state = { status: { ...base, tenantId: 55, accountType: 'creator', steps: at('opened', 'signed_in', 'account_type', 'instagram_connected'), next: 'automation_drafted' }, connection: { status: 'active', username: 'asha', scopes: [], missingScopes: [], webhooksSubscribed: true, tokenExpiresAt: null, health: 'green' } };
  await open(state);
  await fireEvent.press(await screen.findByTestId('signup-go-live'));
  expect(screenText()).toMatch(/Pick a reel/);
  expect(screenText()).toMatch(/Enter a keyword/);
  expect(screenText()).toMatch(/starts with https/i);
  expect(state.first).toBeUndefined();
});

test('closed sign-up says so and cannot be started', async () => {
  await open({ status: { ...base, mode: 'closed', open: false } });
  await screen.findByTestId('signup-closed');
  expect(screen.getByTestId('signup-start').props.accessibilityState?.disabled).toBe(true);
});

test('by invitation asks for the code first', async () => {
  const state = {};
  await open({ status: { ...base, mode: 'invite', open: false } });
  await fireEvent.press(await screen.findByTestId('signup-start'));
  expect(screenText()).toMatch(/Enter your invite code/);
  expect(state.started).toBeUndefined();
});

test('nothing on the sign-up screens mentions a plan, a price or paying', async () => {
  await open({});
  await screen.findByTestId('signup-type');
  expect(screenText()).not.toMatch(/₹|upgrade|checkout|pay\b|card details/i);
  expect(screenText()).toMatch(/no card and no password/i);
});

test('the owner’s invitation link is spent once, with the token only, and says whose business it is', async () => {
  let sent = null;
  await openAt('/invite/abcdefghijklmnopqrstuvwxyz', { list: [home, signup], routes: { 'POST /setup/invite': (call) => { sent = call.body; return { tenantId: 9, businessName: 'Alpha Works', expiresAt: AT }; } } });
  await fireEvent.press(await screen.findByTestId('invite-accept'));
  await screen.findByTestId('invite-done');
  expect(sent).toEqual({ token: 'abcdefghijklmnopqrstuvwxyz' });
  expect(screenText()).toMatch(/Alpha Works is yours/);
});

test('an old or used invitation shows the server’s words', async () => {
  await openAt('/invite/abcdefghijklmnopqrstuvwxyz', { list: [home, signup], routes: { 'POST /setup/invite': () => [409, { error: 'This link has already been used', code: 'conflict' }] } });
  await fireEvent.press(await screen.findByTestId('invite-accept'));
  await screen.findByTestId('invite-action-problem');
  expect(screenText()).toMatch(/already been used/);
});

test('rules: the stage follows the server’s record, and the first call is checked', () => {
  expect(stageOf({ tenantId: null, steps: [] }, null)).toBe('type');
  expect(stageOf({ tenantId: 5, steps: at('account_type') }, { status: 'not_connected' })).toBe('instagram');
  expect(stageOf({ tenantId: 5, steps: at('account_type') }, { status: 'active' })).toBe('automation');
  expect(stageOf({ tenantId: 5, steps: at('account_type', 'instagram_connected', 'automation_live') }, null)).toBe('finish');
  expect(stageOf({ tenantId: 5, steps: at('finished') }, null)).toBe('done');
  expect(readyToStart({ name: ' ', mode: 'invite', invite: '' })).toEqual({ name: 'signup.needName', invite: 'signup.needInvite' });
  expect(formatElapsed(161_000)).toBe('2 min 41 s');
  expect(formatElapsed(45_000)).toBe('45 s');
});

test('it lists every route', () => {
  expect(signup.routeIds).toEqual(['signup.status', 'signup.start', 'signup.firstAutomation', 'signup.finish', 'setup.openInvite']);
});
