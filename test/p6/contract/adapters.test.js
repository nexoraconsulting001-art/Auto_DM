// The Phase 6 adapters against their simulators: EAS (builds, submits, over-the-air updates), App Store Connect and Google Play
// (access checks and review state), and Sign in with Apple for a brand's own bundle id. Faults come from the simulators: slow
// and failed builds, a rejection with its guideline, a key with too low a role, timeouts, junk, and the controlled clock.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAppleSignIn } from '../../../src/adapters/apple/index.js';
import { createAppStores } from '../../../src/adapters/appstores/index.js';
import { createEas } from '../../../src/adapters/eas/index.js';
import { ProviderError, ProviderHostBlockedError } from '../../../src/adapters/http.js';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { createAppStore } from '../../../tools/sim/appstore/index.mjs';
import { createEas as createEasSim } from '../../../tools/sim/eas/index.mjs';
import { createPlay } from '../../../tools/sim/play/index.mjs';

const TOKEN = 'expo-sim-token';
const FAST = 400;
let eas;
let appstore;
let play;
before(async () => {
  eas = await createEasSim({ token: TOKEN }).start();
  appstore = await createAppStore().start();
  play = await createPlay().start();
});
after(async () => {
  await eas?.close();
  await appstore?.close();
  await play?.close();
});

const brandFile = { schema: 1, tenantId: 7, name: 'Kesar Home' };
const request = (overrides = {}) => ({ platform: 'android', profile: 'production', channel: 't7', appVersion: '1.0.0', buildNumber: 1, runtimeVersion: '1.0.0', brandFile, idempotencyKey: `build-${crypto.randomUUID()}`, ...overrides });
const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

test('a simulator address is refused in production and any foreign host always', () => {
  const production = { NODE_ENV: 'production' };
  assert.throws(() => createEas({ easBaseUrl: eas.url, expoToken: TOKEN }, { env: production }), /simulator|refused/i);
  assert.throws(() => createAppStores({ appStoreBaseUrl: appstore.url }, { env: production }), /simulator|refused/i);
  assert.throws(() => createAppStores({ playBaseUrl: play.url }, { env: production }), /simulator|refused/i);
  for (const config of [{ easBaseUrl: 'https://eas.example' }, { easBaseUrl: 'https://api.expo.dev.evil.example' }]) assert.throws(() => createEas(config), ProviderHostBlockedError);
  assert.throws(() => createAppStores({ appStoreBaseUrl: 'https://asc.example' }), ProviderHostBlockedError);
  assert.throws(() => createAppStores({ playBaseUrl: 'https://play.example' }), ProviderHostBlockedError);
  assert.doesNotThrow(() => createEas({}), 'empty is the provider itself');
  assert.throws(() => createAppStores({ playServiceAccount: 'not json at all' }), /PLAY_SERVICE_ACCOUNT/);
});

test('EAS: a build goes queued, building, built on the clock; the same key is one build; slow and failed builds say so', async () => {
  await eas.post('/reset');
  await eas.post('/clock', { freeze: true });
  const client = createEas({ easBaseUrl: eas.url, expoToken: TOKEN, providerTimeoutMs: FAST });
  assert.equal(client.configured, true);
  const unset = await failure(createEas({ easBaseUrl: eas.url }).getBuild('build-1'));
  assert.deepEqual([unset.kind, unset.delivery], ['not_configured', 'none']);

  const key = `build-${crypto.randomUUID()}`;
  const started = await client.startBuild(request({ idempotencyKey: key }));
  assert.deepEqual(started.status, 'queued');
  assert.equal((await client.startBuild(request({ idempotencyKey: key }))).buildId, started.buildId, 'the same request twice is one build');
  assert.equal((await eas.get('/builds')).builds.length, 1);
  assert.equal((await client.getBuild(started.buildId)).status, 'queued');
  await eas.post('/clock', { advanceMs: 5_000 });
  assert.equal((await client.getBuild(started.buildId)).status, 'building');
  await eas.post('/clock', { advanceMs: 60_000 });
  const built = await client.getBuild(started.buildId);
  assert.equal(built.status, 'built');
  assert.ok(built.fingerprint.length >= 8 && built.artifactUrl.startsWith(eas.url));
  const artifact = await client.fetchArtifact(started.buildId);
  const chunks = [];
  for await (const chunk of artifact.stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /SIM-ARTIFACT/);

  await eas.post('/builds/behaviour', { kind: 'slow', buildMs: 600_000 });
  const slow = await client.startBuild(request());
  await eas.post('/clock', { advanceMs: 70_000 });
  assert.equal((await client.getBuild(slow.buildId)).status, 'building', 'a slow build is still building');
  await eas.post('/builds/behaviour', { kind: 'fail', step: 'assets', message: 'The icon has a transparent background.' });
  const failed = await client.startBuild(request({ platform: 'ios' }));
  await eas.post('/clock', { advanceMs: 70_000 });
  assert.deepEqual((await client.getBuild(failed.buildId)).error, { step: 'assets', message: 'The icon has a transparent background.' });
  assert.equal((await client.getBuild(failed.buildId)).status, 'failed');

  const wrong = await failure(createEas({ easBaseUrl: eas.url, expoToken: 'not-it', providerTimeoutMs: FAST }).getBuild(started.buildId));
  assert.deepEqual([wrong.kind, wrong.status], ['auth', 401]);
  await assert.rejects(() => client.startBuild(request({ idempotencyKey: '' })), /idempotency key/, 'a write never goes without its key');
});

test('EAS: a timeout is reported with delivery unknown, junk as malformed, and a submit finishes or errors on the clock', async () => {
  await eas.post('/reset');
  await eas.post('/clock', { freeze: true });
  const client = createEas({ easBaseUrl: eas.url, expoToken: TOKEN, providerTimeoutMs: FAST });
  const { buildId } = await client.startBuild(request());
  await eas.fault({ kind: 'timeout', match: { path: '/v1/builds/*' }, times: 'forever' });
  const slow = await failure(client.getBuild(buildId));
  assert.ok(slow instanceof ProviderError);
  assert.deepEqual([slow.kind, slow.delivery, slow.retryable], ['timeout', 'unknown', true]);
  await eas.delete('/faults');
  await eas.fault({ kind: 'malformed', mode: 'garbage', match: { path: '/v1/builds/*' } });
  assert.equal((await failure(client.getBuild(buildId))).kind, 'malformed');
  await eas.delete('/faults');

  await eas.post('/clock', { advanceMs: 65_000 });
  const credentials = { ascApiKey: { keyId: 'ABCDE12345' } };
  const submitKey = `submit-${crypto.randomUUID()}`;
  const submitted = await client.submit({ buildId, platform: 'android', credentials, idempotencyKey: submitKey });
  assert.equal(submitted.status, 'queued');
  assert.equal((await client.submit({ buildId, platform: 'android', credentials, idempotencyKey: submitKey })).submissionId, submitted.submissionId);
  await eas.post('/clock', { advanceMs: 3_000 });
  assert.equal((await client.getSubmission(submitted.submissionId)).status, 'in_progress');
  await eas.post('/clock', { advanceMs: 10_000 });
  assert.deepEqual(await client.getSubmission(submitted.submissionId), { submissionId: submitted.submissionId, status: 'finished', error: null });
  await eas.post('/submissions/behaviour', { kind: 'fail', message: 'Missing compliance answer.' });
  const refused = await client.submit({ buildId, platform: 'android', credentials, idempotencyKey: `submit-${crypto.randomUUID()}` });
  await eas.post('/clock', { advanceMs: 11_000 });
  assert.deepEqual(await client.getSubmission(refused.submissionId), { submissionId: refused.submissionId, status: 'errored', error: 'Missing compliance answer.' });
  assert.equal(JSON.stringify(await eas.get('/submissions')).includes('ABCDE12345'), false, 'credentials are not echoed');
});

test('EAS updates: publish at 10%, then 50%, then roll back; runtime 1.2 is served and 1.1 is not (P-41)', async () => {
  await eas.post('/reset');
  const client = createEas({ easBaseUrl: eas.url, expoToken: TOKEN, providerTimeoutMs: FAST });
  const resolve = async (runtimeVersion, seed) => (await eas.get('/channels/t7/resolve', { runtimeVersion, seed: String(seed) })).updateId;
  const { updateId } = await client.publishUpdate({ channel: 't7', runtimeVersion: '1.2.0', bundleId: 'group-1', message: 'Fixes', idempotencyKey: `publish-${crypto.randomUUID()}` });
  assert.equal(await resolve('1.2.0', 5), updateId, 'inside the 10% rollout');
  assert.equal(await resolve('1.2.0', 30), null, 'outside it');
  assert.equal(await resolve('1.1.0', 5), null, 'another runtime never gets it');
  assert.deepEqual(await client.setRollout({ channel: 't7', updateId, percent: 50 }), { percent: 50 });
  assert.equal(await resolve('1.2.0', 30), updateId);
  await assert.rejects(() => client.setRollout({ channel: 't7', updateId, percent: 25 }), /10, 50 or 100/);
  assert.deepEqual(await client.rollBack({ channel: 't7', updateId, idempotencyKey: `rollback-${crypto.randomUUID()}` }), { rolledBack: true });
  assert.equal(await resolve('1.2.0', 5), null, 'a rolled-back update reaches nobody');
});

test('App Store Connect: ok, a role too low naming the role needed (P-39), an invalid key, unreachable, and a rejection after the clock moves', async () => {
  await appstore.post('/reset');
  await appstore.post('/apps', { bundleId: 'com.kesarhome.shop', sellerName: 'Kesar Home Private Limited' });
  const { appStoreConnect } = createAppStores({ appStoreBaseUrl: appstore.url, providerTimeoutMs: FAST, appStoreRoleNeeded: 'APP_MANAGER' });
  const manager = appStoreConnect.forKey(await appstore.post('/keys', { role: 'APP_MANAGER' }));
  assert.deepEqual(await manager.checkAccess({ bundleId: 'com.kesarhome.shop' }), { status: 'ok', roleFound: 'APP_MANAGER', roleNeeded: 'APP_MANAGER' });
  const developer = appStoreConnect.forKey(await appstore.post('/keys', { role: 'DEVELOPER' }));
  assert.deepEqual(await developer.checkAccess({ bundleId: 'com.kesarhome.shop' }), { status: 'role_too_low', roleFound: 'DEVELOPER', roleNeeded: 'APP_MANAGER' });
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const stranger = appStoreConnect.forKey({ keyId: 'ZZZZZ99999', issuerId: crypto.randomUUID(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.equal((await stranger.checkAccess({ bundleId: 'com.kesarhome.shop' })).status, 'invalid', 'a key the store did not issue');
  assert.equal((await appStoreConnect.forKey({ keyId: 'ABCDE12345', issuerId: crypto.randomUUID(), privateKey: 'not a key' }).checkAccess({ bundleId: 'x' })).status, 'invalid');
  await appstore.fault({ kind: 'timeout', match: { path: '/v1/apps' }, times: 'forever' });
  assert.equal((await manager.checkAccess({ bundleId: 'com.kesarhome.shop' })).status, 'unreachable', 'never thrown');
  await appstore.delete('/faults');
  await appstore.fault({ kind: 'malformed', mode: 'html', match: { path: '/v1/apps' }, times: 2 });
  assert.equal((await manager.checkAccess({ bundleId: 'com.kesarhome.shop' })).status, 'unreachable', 'junk');
  await appstore.delete('/faults');

  assert.equal((await manager.reviewState({ bundleId: 'com.kesarhome.shop' })).state, 'none');
  await appstore.post('/review', { bundleId: 'com.kesarhome.shop', state: 'rejected', guideline: '4.2.6', message: 'Apps made from a template.', afterMs: 60_000 });
  assert.equal((await manager.reviewState({ bundleId: 'com.kesarhome.shop' })).state, 'none', 'not yet');
  await appstore.post('/clock', { advanceMs: 61_000 });
  const rejected = await manager.reviewState({ bundleId: 'com.kesarhome.shop' });
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual([rejected.rejection.guideline, rejected.rejection.message], ['4.2.6', 'Apps made from a template.']);
  assert.ok(rejected.rejection.key);
  await appstore.post('/review', { bundleId: 'com.kesarhome.shop', state: 'live', version: '1.0.1', buildNumber: 4 });
  const live = await manager.reviewState({ bundleId: 'com.kesarhome.shop' });
  assert.deepEqual([live.state, live.version, live.buildNumber, live.sellerName], ['live', '1.0.1', 4, 'Kesar Home Private Limited'], 'P-40');
  assert.match(live.storeUrl, /^https:\/\/apps\.apple\.com\/app\/id\d+$/);
  await appstore.fault({ kind: 'server_error', match: { path: '/v1/apps' }, times: 2 });
  assert.equal((await failure(manager.reviewState({ bundleId: 'com.kesarhome.shop' }))).kind, 'server', 'review state throws for the poll to skip');
  await appstore.delete('/faults');
});

test('Google Play: our service account, its permission on the app, unreachable and invalid, and a rejection after the clock moves', async () => {
  await play.post('/reset');
  const account = await play.post('/service-account');
  await play.post('/apps', { packageName: 'com.kesarhome.shop', developerName: 'Kesar Home Private Limited', permissions: ['RELEASE_TO_PRODUCTION', 'VIEW_APP_INFORMATION'] });
  await play.post('/apps', { packageName: 'com.viewonly.shop', developerName: 'View Only', permissions: ['VIEW_APP_INFORMATION'] });
  await play.post('/apps', { packageName: 'com.nothing.shop', developerName: 'Nothing', permissions: [] });
  const { googlePlay } = createAppStores({ playBaseUrl: play.url, playServiceAccount: JSON.stringify(account), providerTimeoutMs: FAST });
  assert.equal(googlePlay.configured, true);
  assert.equal(googlePlay.serviceAccountEmail, account.client_email, 'the address the owner invites');
  assert.deepEqual(await googlePlay.checkAccess({ packageName: 'com.kesarhome.shop' }), { status: 'ok', roleFound: 'RELEASE_TO_PRODUCTION', roleNeeded: 'RELEASE_TO_PRODUCTION' });
  assert.deepEqual(await googlePlay.checkAccess({ packageName: 'com.viewonly.shop' }), { status: 'role_too_low', roleFound: 'VIEW_APP_INFORMATION', roleNeeded: 'RELEASE_TO_PRODUCTION' });
  assert.equal((await googlePlay.checkAccess({ packageName: 'com.nothing.shop' })).status, 'role_too_low', 'invited with nothing');
  assert.equal((await googlePlay.checkAccess({ packageName: 'com.unknown.shop' })).status, 'invalid', 'not invited at all');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const strangerAccount = { ...account, client_email: 'someone@elsewhere.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const stranger = createAppStores({ playBaseUrl: play.url, playServiceAccount: Buffer.from(JSON.stringify(strangerAccount)).toString('base64'), providerTimeoutMs: FAST }).googlePlay;
  assert.equal((await stranger.checkAccess({ packageName: 'com.kesarhome.shop' })).status, 'invalid', 'a service account the store refuses');
  assert.equal((await createAppStores({ playBaseUrl: play.url }).googlePlay.checkAccess({ packageName: 'com.kesarhome.shop' })).status, 'unreachable', 'not set up: nothing to check with');
  await play.fault({ kind: 'timeout', match: { path: '/androidpublisher/*' }, times: 'forever' });
  assert.equal((await googlePlay.checkAccess({ packageName: 'com.kesarhome.shop' })).status, 'unreachable');
  await play.delete('/faults');

  assert.equal((await googlePlay.trackState({ packageName: 'com.kesarhome.shop' })).state, 'none');
  await play.post('/track', { packageName: 'com.kesarhome.shop', state: 'rejected', guideline: 'play:target_api', message: 'Target API level too low.', versionCode: 3, afterMs: 60_000 });
  assert.equal((await googlePlay.trackState({ packageName: 'com.kesarhome.shop' })).state, 'none', 'not yet');
  await play.post('/clock', { advanceMs: 61_000 });
  const rejected = await googlePlay.trackState({ packageName: 'com.kesarhome.shop' });
  assert.deepEqual([rejected.state, rejected.rejection.guideline, rejected.versionCode], ['rejected', 'play:target_api', 3]);
  await play.post('/track', { packageName: 'com.kesarhome.shop', state: 'live', versionName: '1.0.1', versionCode: 4 });
  const live = await googlePlay.trackState({ packageName: 'com.kesarhome.shop' });
  assert.deepEqual([live.state, live.versionName, live.versionCode, live.sellerName, live.storeUrl], ['live', '1.0.1', 4, 'Kesar Home Private Limited', 'https://play.google.com/store/apps/details?id=com.kesarhome.shop']);
  const deleted = (await play.calls({ method: 'DELETE' })).length;
  assert.ok(deleted >= 3, 'every edit opened to read is deleted again');
});

test('Sign in with Apple takes a per-call audience, so a shopper token for the brand\'s bundle id verifies', async () => {
  const apple = await createApple().start();
  try {
    const signIn = createAppleSignIn({ appleKeysBaseUrl: apple.url, appleSigninAudiences: ['sim.apple.owner-app'] });
    const { identityToken, sub } = await apple.post('/identity-token', { aud: 'com.kesarhome.shop', nonce: 'raw-nonce-1' });
    assert.equal((await signIn.verify(identityToken, { nonce: 'raw-nonce-1', audiences: ['com.kesarhome.shop'] })).sub, sub);
    await assert.rejects(() => signIn.verify(identityToken, { nonce: 'raw-nonce-1' }), (err) => err.kind === 'wrong_audience', 'the configured audience is the owner app\'s');
    await assert.rejects(() => signIn.verify(identityToken, { nonce: 'raw-nonce-1', audiences: ['com.other.shop'] }), (err) => err.kind === 'wrong_audience');
    const unset = createAppleSignIn({ appleKeysBaseUrl: apple.url });
    assert.equal((await unset.verify(identityToken, { nonce: 'raw-nonce-1', audiences: ['com.kesarhome.shop'] })).sub, sub, 'a brand\'s app needs no seller audience set');
    await assert.rejects(() => unset.verify(identityToken, { nonce: 'raw-nonce-1', audiences: [] }), (err) => err.kind === 'wrong_audience');
  } finally {
    await apple.close();
  }
});
