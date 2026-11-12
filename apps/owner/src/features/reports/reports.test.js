import { fireEvent, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { OWNER, STAFF, fakeApi, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import reports from './index.js';
import leads from '../leads/index.js';

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const at = '2026-11-10T10:00:00.000Z';
const MANAGER = { ...OWNER, id: 20, role: 'manager' };
const LEAD = { id: 3, firstName: 'Meera', phone: '+919811111111', email: '', source: 'landing', sourceRef: 'diwali-box', utmCampaign: '', pageId: 4, consentVersion: 2, consentedAt: at, consents: [{ channel: 'whatsapp', grantedAt: at, withdrawnAt: null }, { channel: 'sms', grantedAt: at, withdrawnAt: at }], createdAt: at };

function api(extra = {}, user) {
  return fakeApi({
    ...(user ? { user } : {}),
    routes: {
      'GET /reports/preferences': () => ({ weekly: true, monthly: false, monthlyAvailable: false }),
      'PATCH /reports/preferences': (call) => ({ weekly: call.body.weekly ?? true, monthly: false, monthlyAvailable: false }),
      'GET /reports': () => ({ items: [{ id: 9, kind: 'weekly', periodStart: '2026-11-02', periodEnd: '2026-11-08', status: 'sent', fileUrl: '/report-files/m9', sentAt: at }], nextCursor: null }),
      'GET /reports/:id': () => ({ id: 9, kind: 'weekly', periodStart: '2026-11-02', periodEnd: '2026-11-08', status: 'sent', fileUrl: '/report-files/m9', sentAt: at }),
      'GET /downloads': () => ({ items: [], nextCursor: null }),
      'POST /downloads': (call) => [201, { id: 1, source: call.body.source, format: call.body.format, status: 'queued', background: true, rowCount: null, fileUrl: null, createdAt: at, expiresAt: null }],
      'GET /api-keys': () => ({ items: [], nextCursor: null }),
      'GET /leads': () => ({ items: [LEAD], nextCursor: null }),
      'GET /leads/:id': () => LEAD,
      'POST /leads/:id/revoke-consent': () => ({ ...LEAD, consents: LEAD.consents.map((c) => ({ ...c, withdrawnAt: c.withdrawnAt ?? at })) }),
      'GET /lead-downloads': () => ({ items: [], nextCursor: null }),
      ...extra,
    },
  });
}

async function open(server, path, user) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs(user));
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [reports, leads], linking });
  return made;
}

test('the report a weekly notice links to opens with its period and its file', async () => {
  await open(api(), '/reports/9');
  expect(await screen.findByTestId('report-period')).toBeTruthy();
  expect(screen.getByText('2 Nov to 8 Nov')).toBeTruthy();
  expect(screen.getByTestId('report-open')).toBeTruthy();
});

test('report emails can be switched off; a monthly report the plan lacks says so instead of a dead switch', async () => {
  const server = api();
  await open(server, '/reports');
  await fireEvent.press(await screen.findByTestId('reports-weekly'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PATCH').body).toEqual({ weekly: false });
  expect(screen.getByTestId('reports-monthly-unavailable')).toBeTruthy();
});

test('a summary file is asked for and shows as being made', async () => {
  const server = api();
  await open(server, '/reports');
  await fireEvent.press(await screen.findByTestId('reports-download-create'));
  await settle();
  expect(server.calls.find((c) => c.method === 'POST' && c.path === '/downloads').body).toEqual({ source: 'account_daily', format: 'csv' });
});

test('API keys are for the owner only; a manager sees no way in', async () => {
  await open(api({}, MANAGER), '/reports', MANAGER);
  expect(await screen.findByTestId('reports-open-scheduled')).toBeTruthy();
  expect(screen.queryByTestId('reports-open-keys')).toBeNull();
});

test('a lead shows each consent, its number masked as the app holds every number, and records a withdrawal', async () => {
  const server = api();
  await open(server, '/leads/3');
  expect(await screen.findByTestId('lead-consent-whatsapp')).toBeTruthy();
  // app-core masks every phone number in what the app holds, so the number shows masked here too
  expect(screen.getByTestId('lead-phone').props.children).toBe('+91 ••••• •1111');
  await fireEvent.press(screen.getByTestId('lead-consent-whatsapp-revoke'));
  await settle();
  expect(server.calls.find((c) => c.path === '/leads/3/revoke-consent').body).toEqual({ channels: ['whatsapp'] });
  expect(await screen.findByTestId('lead-all-withdrawn')).toBeTruthy();
});

test('a lead list that fails to load says so and offers a retry', async () => {
  await open(api({ 'GET /leads': () => [403, { error: 'Not allowed', code: 'forbidden' }] }), '/leads');
  expect(await screen.findByTestId('leads-list-error')).toBeTruthy();
  expect(screen.getByText('You don’t have access to this. Ask the owner of this business.')).toBeTruthy();
});

test('lead files are for managers: staff with customers see leads but no files', async () => {
  const desk = { ...STAFF, id: 30, permissions: ['customers'] };
  await open(api({}, desk), '/leads', desk);
  expect(await screen.findByTestId('lead-3')).toBeTruthy();
  expect(screen.queryByTestId('leads-download-create')).toBeNull();
  expect(screen.queryByTestId('leads-open-form')).toBeNull();
});
