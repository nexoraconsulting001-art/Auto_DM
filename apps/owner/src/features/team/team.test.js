import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { AT, MANAGER, fresh, openApp, settle, writes, forgetApps } from '../orders/kit/testing.js';
import team from './index.js';
import auditLog from '../audit-log/index.js';
import settings from '../settings/index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

afterEach(forgetApps);

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const ME = { id: 7, name: 'Asha', phone: '+91 ••••• •0001', role: 'owner', permissions: [], you: true, verified: true, joinedAt: AT };
const RAVI = { id: 8, name: 'Ravi', phone: '+91 ••••• •0002', role: 'staff', permissions: ['orders'], you: false, verified: true, joinedAt: AT };

function routes(state) {
  return {
    'GET /team': () => ({ items: state.members, nextCursor: null, invites: state.invites }),
    'POST /team/invites': (call) => {
      const invite = { id: 50, contact: call.body.contact, role: call.body.role, permissions: call.body.permissions, expiresAt: AT, createdAt: AT };
      state.invites = [...state.invites, invite];
      return [201, invite];
    },
    'PATCH /team/:id': (call) => {
      const id = Number(call.path.split('/')[2]);
      state.members = state.members.map((m) => (m.id === id ? { ...m, ...call.body } : m));
      return state.members.find((m) => m.id === id);
    },
    'DELETE /team/:id': (call) => {
      const id = Number(call.path.split('/')[2]);
      state.members = state.members.filter((m) => m.id !== id);
      return null;
    },
    'GET /audit-log': () => ({ items: [{ id: 'a1', actor: 'user:7', action: 'team.update', target: 'user:8', details: { role: 'manager', userId: 8, nested: { no: 1 } }, createdAt: AT }], nextCursor: null }),
  };
}

test('F-49 the only owner cannot demote or remove themselves: both are blocked, and nothing is sent', async () => {
  const state = { members: [ME, RAVI], invites: [] };
  const { server } = await openApp({ list: [team], path: '/team', routes: routes(state), freshUntil: fresh() });
  await fireEvent.press(await screen.findByTestId('member-7'));
  expect(await screen.findByTestId('team-only-owner')).toBeTruthy();
  expect(screen.getByTestId('team-member-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('team-member-remove').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('team-member-role-manager').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByTestId('team-member-remove'));
  await settle();
  expect(writes(server)).toEqual([]);
});

test('an invitation and a role change each ask for a fresh check first, and staff get only the permissions chosen', async () => {
  const state = { members: [ME, RAVI], invites: [] };
  const { server } = await openApp({ list: [team], path: '/team', routes: routes(state) });
  await fireEvent.press(await screen.findByTestId('team-invite'));
  await fireEvent.changeText(screen.getByTestId('team-invite-contact'), '+91 98000 00009');
  await fireEvent.press(screen.getByTestId('team-invite-permissions-catalog'));
  await fireEvent.press(screen.getByTestId('team-invite-send'));
  await fireEvent.press(await screen.findByTestId('reauth-send'));
  await fireEvent.changeText(await screen.findByTestId('reauth-code'), '654321');
  await fireEvent.press(screen.getByTestId('reauth-verify'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/team/invites')).toBe(true));
  expect(writes(server).find((c) => c.path === '/team/invites').body).toEqual({ contact: '+919800000009', role: 'staff', permissions: ['catalog'] });
  expect(await screen.findByTestId('invite-50')).toBeTruthy();

  // The session is fresh now: the next change goes without asking again.
  await fireEvent.press(screen.getByTestId('member-8'));
  await fireEvent.press(await screen.findByTestId('team-member-role-manager'));
  await fireEvent.press(screen.getByTestId('team-member-save'));
  await waitFor(() => expect(writes(server).some((c) => c.method === 'PATCH')).toBe(true));
  expect(writes(server).find((c) => c.method === 'PATCH').body).toEqual({ role: 'manager', permissions: [] });
  expect(writes(server).filter((c) => c.path === '/auth/reauth/verify')).toHaveLength(1);
});

test('F-46 a manager never sees the team or the audit log', async () => {
  const state = { members: [ME, RAVI], invites: [] };
  const { server } = await openApp({ list: [team, auditLog, settings], path: '/team', routes: { ...routes(state), 'GET /settings': () => [404, { error: 'x', code: 'not_found' }] }, user: MANAGER });
  expect(screen.queryByTestId('screen-team')).toBeNull();
  await fireEvent.press(await screen.findByTestId('tab-more'));
  expect(await screen.findByTestId('more-settings')).toBeTruthy();
  expect(screen.queryByTestId('more-team')).toBeNull();
  expect(screen.queryByTestId('more-audit-log')).toBeNull();
  expect(server.calls.some((c) => c.path === '/team' || c.path === '/audit-log')).toBe(false);
});

test('the audit log lists who changed what, with plain details only', async () => {
  const state = { members: [ME], invites: [] };
  await openApp({ list: [auditLog], path: '/audit-log', routes: routes(state) });
  expect(await screen.findByText('Team update')).toBeTruthy();
  expect(screen.getByText('role: manager')).toBeTruthy();
  expect(screen.queryByText(/nested/)).toBeNull();
});
