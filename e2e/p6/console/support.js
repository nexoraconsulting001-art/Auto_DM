// Shared by the Phase 6 console browser tests ("My app", PRD 10.7 to 10.14): the Phase 5 console world (the real app, its
// sign-in by WhatsApp code on the simulators, the smallest phone), with the app-publishing part of the seller API answered from
// the browser's side by `mockApi`, so each screen's data, refusals and slow or failed answers are forced exactly. The server's
// own side is tested in test/p6/spec-p6. Needs a console build (npm run build:console). Nothing here leaves this machine.
export {
  PHONE, SERVER_FAULT, confirmItsYou, expectHealthy, json, openWorld, ownWorker, panel, seriousFindings, sideways, signInWithCode, toast, watch,
} from '../../p5/console/support.js';
import { json } from '../../p5/console/support.js';

export const AT = '2026-11-12T10:00:00.000Z';
const PLATFORM = { entitled: true, minVersion: '', storeUrl: '', locked: false };
export const PEM = `-----BEGIN PRIVATE KEY-----\n${'MIGTAgEAMBMGByqGSM49AgEG'.repeat(6)}\n-----END PRIVATE KEY-----`;
export const FINGERPRINT = Array.from({ length: 32 }, (_, i) => ((i * 7 + 16) % 256).toString(16).toUpperCase().padStart(2, '0')).join(':');

export const CONFIG = {
  appName: 'Kesar Kitchen', shortName: 'Kesar', androidPackage: 'in.kesar.shop', iosBundleId: null, urlScheme: 'kesar', iconMediaId: null, iconUrl: '', splashMediaId: null, splashUrl: '',
  splashBackground: '', colors: {}, colorOverrides: {}, headingFont: '', bodyFont: '', fontOverrides: { heading: '', body: '' }, shopDomain: 'shop.kesar.in', supportEmail: 'hello@kesar.in',
  privacyUrl: 'https://kesar.in/privacy', appleTeamId: '', playAccountId: '', playSigningSha256: [], android: PLATFORM, ios: { ...PLATFORM, entitled: false }, validation: null,
};
export const BOTH = { ...CONFIG, ios: PLATFORM };

export const access = (platform, over = {}) => ({
  platform, accountType: 'unknown', legalName: '', dunsStatus: 'unknown', dunsLookupUrl: 'https://www.dnb.com/duns-number.html',
  closedTest: { status: 'not_needed', startedAt: null, testers: null, testersNeeded: 12, daysNeeded: 14, daysDone: 0 },
  credential: { kind: 'none', keyId: '', issuerId: '', keyLast4: '', set: false },
  serviceAccountEmail: platform === 'android' ? 'push@bhava-play.example.com' : '',
  access: { status: 'not_checked', roleFound: '', roleNeeded: 'Release manager', checkedAt: null },
  steps: [{ code: 'account', done: false, title: 'Make your developer account', warning: 'It can take a few days to be approved.' }],
  ...over,
});
export const LISTING = {
  platform: 'android', title: 'Kesar', shortDescription: 'Spices', fullDescription: 'Fresh spices', keywords: '', category: '', whatsNew: '',
  limits: { title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500 }, dataSafety: {}, privacyLabels: {}, validation: null,
};
export const SUMMARY = { weeklyCap: 2, optedIn: { orderUpdates: 40, offers: 31, newReels: 12 }, reachableNow: 25, credentials: { android: true, ios: false } };
export const CAMPAIGN = { id: 4, title: 'Diwali sale', body: 'Flat 20% off', couponCode: null, linkPath: '/c/sale', status: 'sent', blockReason: '', audienceCount: 25, sentCount: 24, cappedCount: 1, failedCount: 0, createdAt: AT, sentAt: AT };
export const CREDENTIALS = {
  fcm: { set: true, projectId: 'kesar-app', clientEmailMasked: 'p***@kesar-app.iam', status: 'ok' },
  apns: { set: false, keyId: '', teamId: '', topic: '', env: 'production', status: 'not_set' },
};

/** The default answers. A test passes `overrides` ({ 'GET /store-access': (call) => ... }) to change one. */
export const defaults = (state) => ({
  'GET /app-publishing': () => state.config,
  'PUT /app-publishing': ({ body }) => (state.config = { ...state.config, ...body }),
  'POST /app-publishing/validate': () => ({ ok: false, checkedAt: AT, problems: [{ field: 'privacyUrl', code: 'not_https', message: 'The privacy policy link must start with https://.', platform: null }] }),
  'GET /app-publishing/builds': () => ({
    items: [{ id: 'b1', platform: 'android', appVersion: '1.0.0', buildNumber: 3, runtimeVersion: '1', status: 'failed', reason: 'brand', failedStep: 'validate', failedField: 'appName', failedMessage: 'Give your app a name.', submitError: '', createdAt: AT, finishedAt: AT, submittedAt: null }],
    nextCursor: null,
  }),
  'POST /app-publishing/builds': ({ body }) => json({ builds: body.platforms.map((platform, i) => ({ id: `n${i}`, platform })) }, 202),
  'GET /app-publishing/submissions': () => ({
    items: [{
      platform: 'android', state: 'rejected', appVersion: '1.0.0', buildNumber: 3, liveVersion: '', storeUrl: '', submittedAt: AT, decidedAt: AT,
      rejections: [{ guideline: '4.2.6', message: 'Your app looks like a template.', rejectedAt: AT, playbook: { code: '4.2.6', title: 'Apps made from a template', doc: 'docs/playbooks/4.2.6.md' } }],
      reviewTask: { guideline: '4.2.6' },
      presubmit: { passed: false, ranAt: AT, checks: [{ code: 'native_screens', guideline: '4.2', passed: false, detail: 'A WebView library is in the build' }] },
    }],
  }),
  'GET /app-listing/android': () => state.listing,
  'PUT /app-listing/android': ({ body }) => (state.listing = { ...state.listing, ...body }),
  'GET /app-listing/android/assets': () => ({ items: [{ kind: 'screenshot_phone', device: 'phone', position: 1, url: '', width: 1080, height: 1920, source: 'generated', specOk: false, problems: [{ code: 'too_few', message: 'Add at least 2 screenshots.' }] }] }),
  'GET /store-access': () => ({ items: [access('android'), access('ios')] }),
  'PUT /store-access/android': ({ body }) => access('android', { accountType: body.accountType ?? 'unknown' }),
  'PUT /store-access/ios': ({ body }) => access('ios', body.ascKey ? { credential: { kind: 'asc_api_key', keyId: body.ascKey.keyId, issuerId: body.ascKey.issuerId, keyLast4: '3F2A', set: true } } : {}),
  'POST /store-access/android/check': () => access('android', { access: { status: 'role_too_low', roleFound: 'Viewer', roleNeeded: 'Release manager', checkedAt: AT } }),
  'GET /push-campaigns/summary': () => SUMMARY,
  'GET /push-campaigns': () => ({ items: [CAMPAIGN], nextCursor: null }),
  'POST /push-campaigns': ({ body }) => json({ ...CAMPAIGN, id: 5, title: body.title, body: body.body, status: 'queued' }, 202),
  'GET /push-credentials': () => CREDENTIALS,
  'PUT /push-credentials': () => CREDENTIALS,
});

const AREA = /\/api\/v1\/(app-publishing|app-listing|store-access|push-campaigns|push-credentials)(\/|\?|$)/;

/**
 * Answers the app-publishing routes in `page` from `defaults` and `overrides`. Returns { calls, state }: `calls` is every request
 * as { key: 'PUT /store-access/ios', body }. An answer may be a plain object (200) or a json(...) / { status, body } reply.
 */
export async function mockApi(page, { overrides = {}, config = CONFIG } = {}) {
  const state = { config, listing: LISTING };
  const calls = [];
  const answers = { ...defaults(state), ...overrides };
  await page.route(AREA, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname.replace('/api/v1', '')}`;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ key, body });
    const answer = answers[key];
    if (!answer) return route.fulfill(json({ error: 'This isn’t available yet.', code: 'not_implemented' }, 501));
    const reply = await answer({ body, url, calls });
    return route.fulfill(typeof reply?.status === 'number' && typeof reply?.body === 'string' ? reply : json(reply ?? {}));
  });
  return { calls, state };
}

export const refusal = (status, message, extra = {}) => json({ error: message, code: extra.code ?? 'forbidden', ...extra }, status);
export const writesTo = (calls, key) => calls.filter((call) => call.key === key);
