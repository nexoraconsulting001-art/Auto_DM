import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { MANAGER, everythingHeld, forgetApps, openApp, settle, writes } from '../orders/kit/testing.js';
import appPublishing from './index.js';
import { normalisePem } from './rules.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

afterEach(forgetApps);
beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const AT = '2026-11-12T10:00:00.000Z';
const PLATFORM = { entitled: true, minVersion: '', storeUrl: '', locked: false };
const CONFIG = {
  appName: 'Kesar Kitchen', shortName: 'Kesar', androidPackage: 'in.kesar.shop', iosBundleId: null, urlScheme: 'kesar', iconMediaId: null, iconUrl: '', splashMediaId: null, splashUrl: '',
  splashBackground: '', colors: {}, colorOverrides: {}, headingFont: '', bodyFont: '', fontOverrides: { heading: '', body: '' }, shopDomain: 'shop.kesar.in', supportEmail: 'hello@kesar.in',
  privacyUrl: 'https://kesar.in/privacy', appleTeamId: '', playAccountId: '', playSigningSha256: [], android: PLATFORM, ios: { ...PLATFORM, entitled: false }, validation: null,
};
const BOTH = { ...CONFIG, ios: PLATFORM };
const PEM = `-----BEGIN PRIVATE KEY-----\n${'MIGTAgEAMBMGByqGSM49AgEG'.repeat(6)}\n-----END PRIVATE KEY-----`;
const SECRET = 'MIGTAgEAMBMGByqGSM49AgEG';

const access = (platform, over = {}) => ({
  platform, accountType: 'unknown', legalName: '', dunsStatus: 'unknown', dunsLookupUrl: 'https://www.dnb.com/duns-number.html',
  closedTest: { status: 'not_needed', startedAt: null, testers: null, testersNeeded: 12, daysNeeded: 14, daysDone: 0 },
  credential: { kind: 'none', keyId: '', issuerId: '', keyLast4: '', set: false },
  serviceAccountEmail: platform === 'android' ? 'push@bhava-play.example.com' : '',
  access: { status: 'not_checked', roleFound: '', roleNeeded: 'Release manager', checkedAt: null },
  steps: [{ code: 'account', done: false, title: 'Make your developer account', warning: 'It can take a few days to be approved.' }],
  ...over,
});
const LISTING = { platform: 'android', title: 'Kesar', shortDescription: 'Spices', fullDescription: 'Fresh spices', keywords: '', category: '', whatsNew: '', limits: { title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500 }, dataSafety: {}, privacyLabels: {}, validation: null };
const SUMMARY = { weeklyCap: 2, optedIn: { orderUpdates: 40, offers: 31, newReels: 12 }, reachableNow: 25, credentials: { android: true, ios: false } };
const CAMPAIGN = { id: 4, title: 'Diwali sale', body: 'Flat 20% off', couponCode: null, linkPath: '/c/sale', status: 'sent', blockReason: '', audienceCount: 25, sentCount: 24, cappedCount: 1, failedCount: 0, createdAt: AT, sentAt: AT };

function routes(extra = {}) {
  const state = { android: access('android') };
  return {
    'GET /app-publishing': () => CONFIG,
    'PUT /app-publishing': (call) => ({ ...CONFIG, ...call.body }),
    'POST /app-publishing/validate': () => ({ ok: false, checkedAt: AT, problems: [{ field: 'privacyUrl', code: 'not_https', message: 'The privacy policy link must start with https://.', platform: null }] }),
    'GET /app-publishing/builds': () => ({ items: [{ id: 'b1', platform: 'android', appVersion: '1.0.0', buildNumber: 3, runtimeVersion: '1', status: 'failed', reason: 'brand', failedStep: 'validate', failedField: 'appName', failedMessage: 'Give your app a name.', submitError: '', createdAt: AT, finishedAt: AT, submittedAt: null }], nextCursor: null }),
    'POST /app-publishing/builds': (call) => [202, { builds: call.body.platforms.map((platform, i) => ({ id: `n${i}`, platform })) }],
    'GET /app-publishing/submissions': () => ({
      items: [{
        platform: 'android', state: 'rejected', appVersion: '1.0.0', buildNumber: 3, liveVersion: '', storeUrl: '', submittedAt: AT, decidedAt: AT,
        rejections: [{ guideline: '4.2.6', message: 'Your app looks like a template.', rejectedAt: AT, playbook: { code: '4.2.6', title: 'Apps made from a template', doc: 'docs/playbooks/4.2.6.md' } }],
        reviewTask: { guideline: '4.2.6' },
        presubmit: { passed: false, ranAt: AT, checks: [{ code: 'native_screens', guideline: '4.2', passed: false, detail: 'A WebView library is in the build' }] },
      }],
    }),
    'GET /app-listing/android': () => LISTING,
    'PUT /app-listing/android': (call) => ({ ...LISTING, ...call.body }),
    'GET /app-listing/android/assets': () => ({ items: [{ kind: 'screenshot_phone', device: 'phone', position: 1, url: 'https://cdn.example.com/s1.png', width: 1080, height: 1920, source: 'generated', specOk: true, problems: [] }] }),
    'GET /store-access': () => ({ items: [state.android, access('ios')] }),
    'PUT /store-access/ios': (call) => access('ios', call.body.ascKey ? { credential: { kind: 'asc_api_key', keyId: call.body.ascKey.keyId, issuerId: call.body.ascKey.issuerId, keyLast4: '3F2A', set: true } } : {}),
    'PUT /store-access/android': (call) => access('android', { accountType: call.body.accountType ?? 'unknown' }),
    'POST /store-access/android/check': () => (state.android = access('android', { access: { status: 'role_too_low', roleFound: 'Viewer', roleNeeded: 'Release manager', checkedAt: AT } })),
    'GET /push-campaigns/summary': () => SUMMARY,
    'GET /push-campaigns': () => ({ items: [CAMPAIGN], nextCursor: null }),
    'POST /push-campaigns': (call) => [202, { ...CAMPAIGN, id: 5, title: call.body.title, body: call.body.body, status: 'queued' }],
    'GET /coupons': () => ({ items: [], nextCursor: null }),
    'GET /push-credentials': () => ({ fcm: { set: true, projectId: 'kesar-app', clientEmailMasked: 'p***@kesar-app.iam', status: 'ok' }, apns: { set: false, keyId: '', teamId: '', topic: '', env: 'production', status: 'not_set' } }),
    'PUT /push-credentials': () => ({ fcm: { set: true, projectId: 'kesar-app', clientEmailMasked: 'p***@kesar-app.iam', status: 'ok' }, apns: { set: false, keyId: '', teamId: '', topic: '', env: 'production', status: 'not_set' } }),
    ...extra,
  };
}

async function confirmWithCode() {
  await fireEvent.press(await screen.findByTestId('reauth-send'));
  await fireEvent.changeText(await screen.findByTestId('reauth-code'), '654321');
  await fireEvent.press(screen.getByTestId('reauth-verify'));
  await settle();
}

const open = (path, extra = {}, options = {}) => openApp({ list: [appPublishing], path, routes: routes(extra), ...options });

test('P-33 the app fields name themselves in their messages as you type, and a save sends only what changed', async () => {
  const { server } = await open('/app-publishing');
  const name = await screen.findByTestId('app-field-appName');
  expect(name.props.value).toBe('Kesar Kitchen');
  await fireEvent.changeText(name, 'K'.repeat(34));
  expect(await screen.findByText('App name is 34 characters. The most is 30.')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('app-field-supportEmail'), 'not-an-email');
  expect(await screen.findByText('Support email: enter a valid email address.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('app-publishing-save'));
  await settle();
  expect(writes(server).some((c) => c.method === 'PUT' && c.path === '/app-publishing')).toBe(false); // nothing is sent while a field is wrong

  await fireEvent.changeText(name, 'Kesar Kitchen Foods');
  await fireEvent.changeText(screen.getByTestId('app-field-supportEmail'), 'hello@kesar.in');
  await fireEvent.press(screen.getByTestId('app-publishing-save'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/app-publishing')).toBe(true));
  expect(writes(server).find((c) => c.path === '/app-publishing').body).toEqual({ appName: 'Kesar Kitchen Foods' });
  expect(await screen.findByText('Your app details are saved.')).toBeTruthy();
});

test('the build list shows a failure’s step and field, and check my app lists what is missing', async () => {
  await open('/app-publishing');
  expect(await screen.findByText(/Checking your app details\. Give your app a name\. \(App name\)/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('app-publishing-check'));
  expect(await screen.findByTestId('app-publishing-problems')).toBeTruthy();
  expect(screen.getByText(/The privacy policy link must start with https/)).toBeTruthy();
});

test('P-27 a platform the plan lacks shows an upgrade prompt, offers no build, and sends no platform the plan lacks', async () => {
  const { server } = await open('/app-publishing');
  expect(await screen.findByTestId('upgrade-ios')).toBeTruthy();
  expect(screen.getByTestId('build-upgrade-ios')).toBeTruthy();
  expect(screen.queryByTestId('app-field-iosBundleId')).toBeNull();
  await fireEvent.press(screen.getByTestId('app-publishing-build'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/app-publishing/builds')).toBe(true));
  expect(writes(server).find((c) => c.path === '/app-publishing/builds').body.platforms).toEqual(['android']);
});

test('P-27 the server’s refusal of a platform the plan lacks reads as an upgrade note, not as a failure', async () => {
  await open('/app-publishing/stores', { 'GET /store-access': () => [403, { error: 'Your plan does not include the iOS app.', code: 'forbidden', reason: 'plan.not_included' }] });
  expect(await screen.findByTestId('app-publishing-stores-plan')).toBeTruthy();
  expect(screen.getByText('Your plan does not include the iOS app.')).toBeTruthy();
});

test('a manager cannot start a build', async () => {
  await open('/app-publishing', {}, { user: MANAGER });
  expect(await screen.findByText('Only the owner can start a build.')).toBeTruthy();
  expect(screen.getByTestId('app-publishing-build').props.accessibilityState?.disabled ?? screen.getByTestId('app-publishing-build').props.disabled).toBeTruthy();
});

test('P-37 P-38 the store account steps show their warnings; a personal Play account adds the closed-test numbers', async () => {
  const { server } = await open('/app-publishing/stores', { 'GET /app-publishing': () => BOTH });
  expect(await screen.findAllByText('It can take a few days to be approved.')).toHaveLength(2);
  expect(screen.getByTestId('service-account-email').props.children).toBe('push@bhava-play.example.com');
  await fireEvent.press(screen.getByTestId('account-android-type-personal'));
  expect(await screen.findByText('Google asks a personal account for 12 testers who stay for 14 days in a row before it can publish.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('account-android-save'));
  expect(await screen.findByTestId('reauth')).toBeTruthy(); // changing a store account asks for a fresh check first
  expect(writes(server).some((c) => c.path === '/store-access/android')).toBe(false);
  await confirmWithCode();
  await waitFor(() => expect(writes(server).some((c) => c.path === '/store-access/android')).toBe(true));
  expect(writes(server).find((c) => c.path === '/store-access/android').body).toEqual({ accountType: 'personal' });
});

test('P-39 our access check names the role it found and the role it needs', async () => {
  await open('/app-publishing/stores', { 'GET /app-publishing': () => BOTH });
  await fireEvent.press(await screen.findByTestId('access-android-check'));
  expect(await screen.findByText('The role we found (Viewer) is too low. We need Release manager.')).toBeTruthy();
});

test('P-40 the App Store Connect key is masked, written once after a fresh check, never read back, and no password is asked for', async () => {
  const { server, made } = await open('/app-publishing/stores', { 'GET /app-publishing': () => BOTH });
  const key = await screen.findByTestId('asc-key-privateKey');
  expect(key.props.secureTextEntry).toBe(true);
  expect(key.props.value).toBe('');
  expect(key.props.contextMenuHidden).toBe(true);
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/"testID":"[^"]*(password|passcode|apple-?id)/i);
  expect(screen.queryByLabelText(/password|passcode|apple id/i)).toBeNull();

  await fireEvent.changeText(screen.getByTestId('asc-key-keyId'), 'ABCDE12345');
  await fireEvent.changeText(screen.getByTestId('asc-key-issuerId'), '57246542-96fe-1a63-e053-0824d011072a');
  await fireEvent.changeText(key, 'password: hunter2');
  await fireEvent.press(screen.getByTestId('asc-key-save'));
  expect(await screen.findByText(/never ask for your Apple password/)).toBeTruthy();
  expect(writes(server).some((c) => c.path === '/store-access/ios')).toBe(false);

  await fireEvent.changeText(screen.getByTestId('asc-key-privateKey'), PEM);
  await fireEvent.press(screen.getByTestId('asc-key-save'));
  expect(await screen.findByTestId('reauth')).toBeTruthy();
  expect(writes(server).some((c) => c.path === '/store-access/ios')).toBe(false); // nothing goes before the check
  await confirmWithCode();
  await waitFor(() => expect(writes(server).some((c) => c.path === '/store-access/ios')).toBe(true));
  expect(writes(server).find((c) => c.path === '/store-access/ios').body.ascKey).toEqual({ keyId: 'ABCDE12345', issuerId: '57246542-96fe-1a63-e053-0824d011072a', privateKey: normalisePem(PEM) });
  expect(await screen.findByText('Your App Store Connect key is saved. It cannot be read back.')).toBeTruthy();
  expect(screen.getByTestId('asc-key-privateKey').props.value).toBe('');
  expect(screen.getByTestId('asc-key-keyId').props.value).toBe('');
  await made.cache.flush();
  expect(everythingHeld(made)).not.toContain(SECRET);
  expect(JSON.stringify(SecureStore.__dump())).not.toContain(SECRET);
});

test('P-48 the listing editor shows the store’s limit as you type and blocks what the store would refuse', async () => {
  const { server } = await open('/app-publishing/listing/android');
  const short = await screen.findByTestId('listing-shortDescription');
  expect(await screen.findByText('6 of 80 characters')).toBeTruthy();
  await fireEvent.changeText(short, 'x'.repeat(92));
  expect(await screen.findByText('Short description is 92 characters. Google Play allows 80.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('listing-save'));
  await settle();
  expect(writes(server).some((c) => c.path === '/app-listing/android')).toBe(false);
  await fireEvent.changeText(short, 'Fresh spices, delivered');
  await fireEvent.press(screen.getByTestId('listing-save'));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/app-listing/android')).toBe(true));
  expect(Object.keys(writes(server).find((c) => c.path === '/app-listing/android').body).sort()).toEqual(['fullDescription', 'shortDescription', 'title', 'whatsNew']);
});

test('the listing for a platform the plan lacks is the upgrade prompt, and the server is not asked for it', async () => {
  const { server } = await open('/app-publishing/listing/ios');
  expect(await screen.findByTestId('upgrade-ios')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/app-listing/ios')).toBe(false);
});

test('P-56 a rejection shows its guideline, the store’s words and what happens next', async () => {
  await open('/app-publishing/review');
  expect(await screen.findByTestId('submission-android-state')).toBeTruthy();
  expect(screen.getByText('Apps made from a template')).toBeTruthy();
  expect(screen.getByText('Guideline 4.2.6')).toBeTruthy();
  expect(screen.getByText('Your app looks like a template.')).toBeTruthy();
  expect(screen.getByText(/We show what is yours/)).toBeTruthy();
  expect(screen.getByTestId('submission-android-task')).toBeTruthy();
  expect(screen.getByText(/native screens \(4\.2\): A WebView library is in the build/)).toBeTruthy();
});

test('P-59 the offer composer shows the weekly cap, checks as you type, asks before sending and sends one request key', async () => {
  const { server } = await open('/app-publishing/offers');
  expect(await screen.findByText('Each shopper gets at most 2 offers a week (Monday to Sunday). Shoppers over the limit are skipped.')).toBeTruthy();
  expect(screen.getByTestId('offers-nokey-ios')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('offer-title'), 'Call 9876543210');
  await fireEvent.changeText(screen.getByTestId('offer-body'), 'x'.repeat(190));
  expect(await screen.findByText('Message is 190 characters. The most is 178.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('offer-send'));
  await settle();
  expect(writes(server).some((c) => c.path === '/push-campaigns')).toBe(false);

  await fireEvent.changeText(screen.getByTestId('offer-title'), 'Diwali sale');
  await fireEvent.changeText(screen.getByTestId('offer-body'), 'Flat 20% off sweets');
  await fireEvent.changeText(screen.getByTestId('offer-link'), '/c/sale');
  await fireEvent.press(screen.getByTestId('offer-send'));
  expect(await screen.findByText('It goes to about 25 shoppers who turned Offers on. You cannot take it back.')).toBeTruthy();
  expect(writes(server).some((c) => c.path === '/push-campaigns')).toBe(false); // not before the answer
  await fireEvent.press(screen.getAllByText('Send offer').at(-1));
  await waitFor(() => expect(writes(server).some((c) => c.path === '/push-campaigns')).toBe(true));
  const sent = writes(server).find((c) => c.path === '/push-campaigns').body;
  expect(sent).toMatchObject({ title: 'Diwali sale', body: 'Flat 20% off sweets', linkPath: '/c/sale' });
  expect(sent.requestKey).toMatch(/^[\w-]{8,80}$/);
});

test('P-59 a send that meets the weekly cap shows the server’s reason', async () => {
  await open('/app-publishing/offers', { 'POST /push-campaigns': () => [409, { error: 'Weekly offer limit reached', code: 'conflict' }] });
  await fireEvent.changeText(await screen.findByTestId('offer-title'), 'Diwali sale');
  await fireEvent.changeText(screen.getByTestId('offer-body'), 'Flat 20% off sweets');
  await fireEvent.press(screen.getByTestId('offer-send'));
  await fireEvent.press((await screen.findAllByText('Send offer')).at(-1));
  expect(await screen.findByTestId('offer-capped')).toBeTruthy();
  expect(screen.getAllByText(/Weekly offer limit reached/).length).toBeGreaterThan(0);
});

test('P-60 the Firebase key is masked, needs a fresh check, is checked without echoing it, and is emptied after saving', async () => {
  const { server, made } = await open('/app-publishing/keys', { 'GET /app-publishing': () => BOTH });
  const box = await screen.findByTestId('fcm-serviceAccount');
  expect(box.props.secureTextEntry).toBe(true);
  expect(box.props.value).toBe('');
  expect(screen.getByText(/A key is saved for project kesar-app/)).toBeTruthy();
  await fireEvent.changeText(box, '{"type":"user","private_key":"LEAK-ME"}');
  await fireEvent.press(screen.getByTestId('fcm-save'));
  expect(await screen.findByText(/must be the service account key file/)).toBeTruthy();
  expect(screen.queryByText(/LEAK-ME/)).toBeNull(); // a problem never echoes what was pasted

  const account = JSON.stringify({ type: 'service_account', project_id: 'kesar-app', client_email: 'push@kesar-app.iam.example.com', private_key: PEM });
  await fireEvent.changeText(screen.getByTestId('fcm-serviceAccount'), account);
  await fireEvent.press(screen.getByTestId('fcm-save'));
  expect(await screen.findByTestId('reauth')).toBeTruthy();
  expect(writes(server).some((c) => c.path === '/push-credentials')).toBe(false);
  await confirmWithCode();
  await waitFor(() => expect(writes(server).some((c) => c.path === '/push-credentials')).toBe(true));
  expect(writes(server).find((c) => c.path === '/push-credentials').body).toEqual({ fcm: { serviceAccount: account } });
  expect(await screen.findByText('Your key is saved. It cannot be read back.')).toBeTruthy();
  expect(screen.getByTestId('fcm-serviceAccount').props.value).toBe('');
  await made.cache.flush();
  expect(everythingHeld(made)).not.toContain(SECRET);
  expect(JSON.stringify(SecureStore.__dump())).not.toContain(SECRET);
});

test('push keys are the owner’s: a manager sees who to ask and the server is not asked', async () => {
  const { server } = await open('/app-publishing/keys', {}, { user: MANAGER });
  expect(await screen.findByTestId('keys-owner-only')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/push-credentials')).toBe(false);
});

test('empty and failed states: no builds, no offers yet, and a failed load with a retry', async () => {
  await open('/app-publishing', { 'GET /app-publishing/builds': () => ({ items: [], nextCursor: null }) });
  expect(await screen.findByText('No builds yet. Fill in your details, then build your app.')).toBeTruthy();
  await forgetApps();
  await open('/app-publishing/offers', { 'GET /push-campaigns': () => ({ items: [], nextCursor: null }) });
  expect(await screen.findByText('You have not sent an offer yet.')).toBeTruthy();
  await forgetApps();
  await open('/app-publishing/review', { 'GET /app-publishing/submissions': () => [500, { error: 'Something went wrong on our side. Please try again.', code: 'internal' }] });
  expect(await screen.findByText('That didn’t load', {}, { timeout: 8000 })).toBeTruthy();
});
