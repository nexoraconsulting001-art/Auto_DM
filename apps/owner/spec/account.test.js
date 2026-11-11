/**
 * PRD 10.4 and 10.6, on the rendered app: replacing a payment key in the app needs a fresh re-auth and the key is
 * masked and never readable back; Settings offers "Delete my account", which asks for DELETE and then shows when the
 * account will be gone. P-17, P-26.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { fakeApi, openApp, screenText, settle } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const SECRET = 'spec-rzp-secret-never-shown';

test('P-17: replacing the Razorpay key asks for a fresh check first, and the key is masked and never shown again', async () => {
  let fresh = false;
  const saved = [];
  const api = fakeApi({
    extra: {
      'PATCH /settings/payment': (call) => {
        if (!fresh) return [403, { error: 'Confirm it is you first.', code: 'reauth_required' }];
        saved.push(call.body);
        return [200, { storeName: 'Alpha Works', tagline: '', instagramHandle: '', shippingFeePaise: 0, freeShippingAbovePaise: 0, upiId: '', upiPayee: '', supportWhatsapp: '', supportEmail: '', heroKicker: '', heroTitle: '', heroSubtitle: '', trustPoints: '', bulkTitle: '', bulkText: '', aboutText: '', gstin: '', checklistDismissed: false }];
      },
      'POST /auth/reauth/start': () => [202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30 }],
      'POST /auth/reauth/verify': () => { fresh = true; return [200, { freshUntil: new Date(Date.now() + 300_000).toISOString() }]; },
      'GET /payment-settings': () => [200, { upi: true, card: true, netbanking: true, wallet: false, cod: true, partAdvance: false, codFeePaise: 0, codMaxOrderPaise: null, codPincodes: [], codBlockRtoCount: null, advanceKind: 'fixed', advanceValue: 0, holdMinutes: 30, onlineReady: true }],
      'GET /payment-account': () => [200, { mode: 'own', provider: 'razorpay', kycStatus: 'verified', linkedAccount: '', ownConnection: 'keys', ownAccount: 'rzp_test_••••3456', webhookUrl: null }],
      'GET /settings': () => [200, { storeName: 'Alpha Works', tagline: '', instagramHandle: '', shippingFeePaise: 0, freeShippingAbovePaise: 0, upiId: '', upiPayee: '', supportWhatsapp: '', supportEmail: '', heroKicker: '', heroTitle: '', heroSubtitle: '', trustPoints: '', bulkTitle: '', bulkText: '', aboutText: '', gstin: '', checklistDismissed: false }],
    },
  });
  await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('tab-more'));
  await fireEvent.press(await screen.findByTestId('more-payments'));
  const secretField = await screen.findByLabelText(/key secret/i);
  expect(secretField.props.secureTextEntry).toBe(true);
  await fireEvent.changeText(await screen.findByLabelText(/key id/i), 'rzp_test_SpecKey123456'); // secret-scan:allow (made up)
  await fireEvent.changeText(secretField, SECRET);
  await fireEvent.press(screen.getByRole('button', { name: /save|replace|update/i }));
  // The app asks to confirm it is the owner: fingerprint, face or a WhatsApp code.
  await waitFor(() => expect(screenText(screen)).toMatch(/confirm|verify|fingerprint|face|code/i));
  await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/reauth/start' || c.path === '/auth/reauth/verify')).toBe(true), { timeout: 3000 });
  const code = screen.queryByLabelText(/code/i);
  if (code) {
    await fireEvent.changeText(code, '123456');
    await fireEvent.press(screen.getByRole('button', { name: /verify|confirm|continue/i }));
  }
  await waitFor(() => expect(saved).toHaveLength(1), { timeout: 3000 });
  expect(saved[0].razorpayKeySecret).toBe(SECRET);
  await settle(100);
  expect(screenText(screen)).not.toContain(SECRET);
});

test('P-26: Settings > Delete my account asks for DELETE, then shows the timeline', async () => {
  const requested = [];
  const api = fakeApi({
    extra: {
      'POST /auth/delete-account': (call) => {
        requested.push(call.body);
        if (call.body?.confirm !== 'DELETE') return [400, { error: 'Type DELETE to confirm', code: 'invalid', fields: { confirm: 'Type DELETE to confirm' } }];
        return [202, { status: 'requested', requestedAt: '2026-11-12T10:00:00.000Z', dueAt: '2026-12-12T10:00:00.000Z' }];
      },
    },
  });
  await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('tab-more'));
  await fireEvent.press(await screen.findByTestId('more-account'));
  await fireEvent.press(await screen.findByText(/delete my account/i));
  const confirm = await screen.findByLabelText(/delete/i);
  await fireEvent.changeText(confirm, 'DELETE');
  await fireEvent.press(screen.getByRole('button', { name: /delete/i }));
  await waitFor(() => expect(requested.some((b) => b.confirm === 'DELETE')).toBe(true), { timeout: 3000 });
  // The timeline: when it was asked and when the account will be gone, and that signing in again cancels it.
  await waitFor(() => expect(screenText(screen)).toMatch(/12 Dec|December 12|12\/12\/2026|2026-12-12|30 days/i), { timeout: 3000 });
  expect(screenText(screen)).toMatch(/sign in|cancel/i);
});
