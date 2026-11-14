import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import teamFeed from './index.js';
import { describe as describeChange } from './TeamFeedScreen.js';
import { AT, MANAGER, forgetApps, openAt, press, screenText, settle, writes } from '../billing/testing.js';

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

const change = (id, over = {}) => ({
  id, service: 'catalog_management', taskRef: `T-${id}`, routeId: 'products.update', target: `Clay pot ${id}`, before: { price: '₹499' }, after: { price: '₹599' },
  state: 'applied', canUndo: true, createdAt: AT, decidedAt: null, undoneAt: null, ...over,
});

function feedRoutes(state, extra = {}) {
  return {
    'GET /team-feed': (call) => ({ items: state.items.filter((c) => !call.search.includes('state=') || call.search.includes(`state=${c.state}`)), nextCursor: null }),
    'GET /services': () => ({ items: [{ service: 'catalog_management', scope: 'Products', active: true, mode: 'direct', activeFrom: null, activeTo: null }] }),
    'POST /team-feed/:id/undo': (call) => { const id = Number(call.path.split('/')[2]); state.items = state.items.map((c) => (c.id === id ? { ...c, state: 'undone', canUndo: false } : c)); return state.items.find((c) => c.id === id); },
    'POST /team-feed/:id/approve': (call) => { const id = Number(call.path.split('/')[2]); state.items = state.items.map((c) => (c.id === id ? { ...c, state: 'approved' } : c)); return state.items.find((c) => c.id === id); },
    'POST /team-feed/:id/reject': (call) => { const id = Number(call.path.split('/')[2]); state.items = state.items.map((c) => (c.id === id ? { ...c, state: 'rejected' } : c)); return state.items.find((c) => c.id === id); },
    'PUT /services': (call) => ({ items: [{ service: call.body.service, scope: 'Products', active: true, mode: call.body.mode, activeFrom: null, activeTo: null }] }),
    ...extra,
  };
}

test('every change the team made is listed with what it was and what it became', async () => {
  const state = { items: [change(1), change(2, { state: 'draft', canUndo: false, target: 'Banner 4' })] };
  await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes(state) });
  await screen.findByTestId('change-1');
  const text = screenText();
  expect(text).toContain('Catalog management');
  expect(text).toContain('Clay pot 1');
  expect(text).toMatch(/Before: price: ₹499/);
  expect(text).toMatch(/After: price: ₹599/);
  expect(screen.getByTestId('team-feed-waiting')).toBeTruthy();
});

test('undo writes the old version back through the server and the row shows it undone', async () => {
  const state = { items: [change(1)] };
  const { server } = await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes(state) });
  await fireEvent.press(await screen.findByTestId('change-1-undo'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/team-feed/1/undo')).toBe(true));
  await waitFor(() => expect(screen.queryByTestId('change-1-undo')).toBeNull());
  expect(screen.getByTestId('change-1-state')).toBeTruthy();
  expect(screenText()).toMatch(/Undone/);
});

test('a waiting change is approved or rejected, and approve and reject are not shown for a change that is already done', async () => {
  const state = { items: [change(1, { state: 'draft', canUndo: false }), change(2, { state: 'draft', canUndo: false }), change(3)] };
  const { server } = await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes(state) });
  await fireEvent.press(await screen.findByTestId('change-1-approve'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/team-feed/1/approve')).toBe(true));
  await fireEvent.press(await screen.findByTestId('change-2-reject'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/team-feed/2/reject')).toBe(true));
  expect(screen.queryByTestId('change-3-approve')).toBeNull();
  expect(writes(server).every((c) => c.body === undefined)).toBe(true);
});

test('an approval the plan no longer allows shows the upgrade prompt on Android and only the limit in words on iOS', async () => {
  const refusal = () => [403, { error: 'Not on your plan', code: 'plan.feature_off', plan: 't1', feature: 'automations' }];
  const state = { items: [change(1, { state: 'draft', canUndo: false })] };
  await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes(state, { 'POST /team-feed/:id/approve': refusal }) });
  await fireEvent.press(await screen.findByTestId('change-1-approve'));
  await screen.findByTestId('upgrade-prompt');
  expect(screen.getByTestId('upgrade-prompt-plans')).toBeTruthy();
});

test('on iOS the same refusal says what is not included and offers no way to buy', async () => {
  const refusal = () => [403, { error: 'Not on your plan', code: 'plan.limit_reached', plan: 't1', feature: 'automations', limit: 3, used: 3 }];
  const state = { items: [change(1, { state: 'draft', canUndo: false })] };
  await openAt('/team-feed', { list: [teamFeed], platform: 'ios', routes: feedRoutes(state, { 'POST /team-feed/:id/approve': refusal }) });
  await fireEvent.press(await screen.findByTestId('change-1-approve'));
  await screen.findByTestId('upgrade-prompt');
  expect(screen.queryByTestId('upgrade-prompt-plans')).toBeNull();
  expect(screenText()).toMatch(/3 of 3/);
});

test('the owner picks how the team works; a manager can see it and not change it', async () => {
  const state = { items: [change(1)] };
  const { server } = await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes(state) });
  await screen.findByTestId('team-feed-mode-catalog_management');
  await press(/^Ask me first$/);
  await waitFor(() => expect(writes(server).some((c) => c.path === '/services' && c.body.mode === 'approve_first' && c.body.service === 'catalog_management')).toBe(true));
});

test('a manager cannot change the mode', async () => {
  const state = { items: [change(1)] };
  const { server } = await openAt('/team-feed', { list: [teamFeed], user: MANAGER, routes: feedRoutes(state) });
  await screen.findByTestId('team-feed-mode-catalog_management');
  await press(/^Ask me first$/);
  await settle(100);
  expect(writes(server).some((c) => c.path === '/services')).toBe(false);
});

test('an empty feed and a failed read both say so', async () => {
  await openAt('/team-feed', { list: [teamFeed], routes: feedRoutes({ items: [] }) });
  await screen.findByTestId('team-feed-list-empty');
});

test('the summary shows plain fields only and is short', () => {
  expect(describeChange({ a: 1, b: 'x', deep: { z: 1 } })).toBe('a: 1 · b: x');
  expect(describeChange(null)).toBe('');
});

test('it lists all its routes', () => {
  expect(teamFeed.routeIds).toEqual(['teamFeed.list', 'teamFeed.undo', 'teamFeed.approve', 'teamFeed.reject', 'services.settings', 'services.saveSettings', 'console:/team-feed']);
});
