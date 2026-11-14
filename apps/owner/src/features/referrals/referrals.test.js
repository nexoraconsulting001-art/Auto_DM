import React from 'react';
import { screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import referrals from './index.js';
import signup from '../home/index.js';
import { CREATOR_FREE, MANAGER, forgetApps, openAt, screenText, settle } from '../billing/testing.js';

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
});

const answer = (over = {}) => ({ code: 'asha2026', link: 'https://app.example/signup?ref=asha2026', rewardPaise: 0, counts: { pending: 2, credited: 1, blocked: 1 }, creditedPaise: 49_900, ...over });

test('the link is shown to share, with the counts and the credit the server worked out, and a note that it never goes in a DM', async () => {
  await openAt('/referrals', { list: [referrals], routes: { 'GET /referrals': () => answer() } });
  await screen.findByTestId('referrals-link');
  const text = screenText();
  expect(text).toContain('https://app.example/signup?ref=asha2026');
  expect(text).toMatch(/Never put it inside a DM/);
  expect(screen.getByTestId('referrals-credited')).toBeTruthy();
  expect(text).toContain('₹499');
  expect(text).toMatch(/same Instagram account, phone or payment method/);
});

test('a creator on Free has it too, and a new account sees an empty state', async () => {
  await openAt('/referrals', { list: [referrals], business: CREATOR_FREE, routes: { 'GET /referrals': () => answer({ counts: { pending: 0, credited: 0, blocked: 0 }, creditedPaise: 0 }) } });
  await screen.findByTestId('referrals-empty');
});

test('a read that fails shows the error and a way to retry', async () => {
  await openAt('/referrals', { list: [referrals], routes: { 'GET /referrals': () => [500, { error: 'x', code: 'internal' }] } });
  await screen.findByTestId('referrals-error', {}, { timeout: 15000 });
});

test('only the owner gets the screen', async () => {
  const { server } = await openAt('/referrals', { list: [referrals, signup], user: MANAGER, routes: { 'GET /referrals': () => answer() } });
  await settle(150);
  await waitFor(() => expect(screen.queryByTestId('screen-referrals')).toBeNull());
  expect(server.calls.some((c) => c.path === '/referrals')).toBe(false);
});

test('it lists its one route', () => {
  expect(referrals.routeIds).toEqual(['referrals.get']);
});
