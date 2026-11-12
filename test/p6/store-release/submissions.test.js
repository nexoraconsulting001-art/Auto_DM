// Store review (PRD 10.14) under attack: submit() runs the gate before anything leaves, records the run, and sends a build only
// with this business's own key; a store answer that arrives late or twice changes nothing (the same rejection read again, an old
// rejection still shown after a resubmit, a step back to review, an answer about another version); the owner is told once; moves
// go only along the rules; two rejections on one guideline open a task the business cannot close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAppStores } from '../../../src/adapters/appstores/index.js';
import { createEas } from '../../../src/adapters/eas/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { appSubmissionsFor } from '../../../src/modules/app-submissions/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { accepted, addAppShop, operatorOf, refusedStatus, seedSubmission, sleep, useP6World } from '../spec-p6/kit.js';

const world = useP6World();
const unique = () => `${Date.now() % 1e8}${crypto.randomInt(1e4)}`;
let ctx;
const ctxOf = () => {
  if (!ctx) {
    const platform = createPlatform(world.config, { db: world.db });
    ctx = { db: world.db, config: world.config, platform, repos: createRepos(world.db, { secrets: platform.secrets, storage: platform.storage }), modules: MODULES, eas: createEas(world.config), appStores: createAppStores(world.config) };
  }
  return ctx;
};
const service = () => appSubmissionsFor(ctxOf());
const inShop = (shop, fn) => withTenant(shop.tenantId, fn);

async function iosShop({ key = true } = {}) {
  const bundleId = `in.example.r${unique()}`;
  const shop = await addAppShop(world, { platforms: ['ios'], config: { ios_bundle_id: bundleId } });
  await world.appstore.post('/apps', { bundleId, sellerName: `${shop.name} Traders`, name: shop.name });
  if (key) {
    const made = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
    accepted(await shop.send('PUT', '/store-access/ios', { accountType: 'organisation', legalName: `${shop.name} Traders`, dunsStatus: 'have', ascKey: { keyId: made.keyId, issuerId: made.issuerId, privateKey: made.privateKey } }));
  }
  return { shop, bundleId };
}

/** A build that finished on the build service: the seeded row, given the build service's id. */
async function builtOnEas(shop, platform = 'ios') {
  const { buildId } = await seedSubmission(shop, platform);
  const [build] = await shop.sql('SELECT * FROM app_builds WHERE tenant_id = $1 AND id = $2', [shop.tenantId, buildId]);
  const started = await ctxOf().eas.startBuild({ platform, channel: `t${shop.tenantId}`, appVersion: build.app_version, buildNumber: build.build_number, runtimeVersion: build.runtime_version, brandFile: { name: shop.name }, idempotencyKey: `build-${crypto.randomUUID()}` });
  await world.eas.post('/clock', { advanceMs: 70_000 });
  await shop.sql('UPDATE app_builds SET provider_build_id = $3 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, buildId, started.buildId]);
  return buildId;
}
const reviewOn = (shop) => shop.sql(`UPDATE app_configs SET review_enabled = true, review_phone = '+919999988877', review_code_hash = 'h' WHERE tenant_id = $1`, [shop.tenantId]);
const easSubmissions = async () => (await world.eas.get('/submissions')).submissions;

test('submit() runs the gate first and records it; a failed gate, no key or another business\'s key sends nothing', async () => {
  const { shop } = await iosShop();
  const buildId = await builtOnEas(shop);
  const before = (await easSubmissions()).length;
  const answer = await inShop(shop, () => service().submit(buildId, { actor: 'system' }));
  assert.equal(answer.presubmit.passed, false, 'Review access is off, and the gate passed');
  const demo = answer.presubmit.checks.find((c) => c.code === 'demo_access');
  assert.equal(demo.passed, false);
  assert.equal(demo.guideline, '2.1(a)');
  const [build] = await shop.sql('SELECT status, submit_error FROM app_builds WHERE tenant_id = $1 AND id = $2', [shop.tenantId, buildId]);
  assert.equal(build.status, 'built');
  assert.match(build.submit_error, /2\.1\(a\)/, 'The build does not say which guideline stopped it');
  assert.equal((await easSubmissions()).length, before, 'A build that failed the gate was sent');
  // The run is the server's, with every check of the platform, and the app's own checks pass from the release facts.
  const [run] = await shop.sql('SELECT * FROM presubmit_runs WHERE tenant_id = $1 AND build_id = $2 ORDER BY id DESC LIMIT 1', [shop.tenantId, buildId]);
  assert.equal(run.passed, false);
  assert.deepEqual(run.checks.filter((c) => !c.passed).map((c) => c.code), ['demo_access']);
  assert.match(run.tool_version, /presubmit/);

  // Review access on: the gate passes and the build goes to the build service with this business's own key.
  await reviewOn(shop);
  const sent = await inShop(shop, () => service().submit(buildId, { actor: 'system' }));
  assert.equal(sent.presubmit.passed, true, JSON.stringify(sent.presubmit.checks.filter((c) => !c.passed)));
  assert.equal((await easSubmissions()).length, before + 1);
  const [after] = await shop.sql('SELECT status, submit_error, provider_submission_id FROM app_builds WHERE tenant_id = $1 AND id = $2', [shop.tenantId, buildId]);
  assert.equal(after.status, 'submitted');
  assert.equal(after.submit_error, '');
  assert.ok(after.provider_submission_id);
  const call = (await world.eas.calls({ method: 'POST', path: '/v1/submissions' })).map((c) => c.body).at(-1);
  assert.equal(call.credentials.kind, 'asc_api_key');
  assert.ok(!JSON.stringify(await easSubmissions()).includes('PRIVATE KEY'));
  // Submitting the same build again is the same submission; the upload finishing moves it into review.
  await inShop(shop, () => service().submit(buildId, { actor: 'system' }));
  assert.equal((await easSubmissions()).length, before + 1, 'One build was sent twice');
  assert.equal((await shop.submissions())[0].state, 'draft');
  await world.eas.post('/clock', { advanceMs: 20_000 });
  await service().poll();
  assert.equal((await shop.submissions())[0].state, 'in_review');
  // While it is in review no other build is sent.
  const next = await builtOnEas(shop);
  await assert.rejects(() => inShop(shop, () => service().submit(next, { actor: 'system' })), /in review/);

  // A business with no key of its own: the gate runs, nothing is sent, the build says what to add.
  const { shop: bare } = await iosShop({ key: false });
  await reviewOn(bare);
  const bareBuild = await builtOnEas(bare);
  const count = (await easSubmissions()).length;
  const bareAnswer = await inShop(bare, () => service().submit(bareBuild, { actor: 'system' }));
  assert.equal(bareAnswer.presubmit.passed, true);
  assert.equal((await easSubmissions()).length, count);
  assert.match((await bare.sql('SELECT submit_error FROM app_builds WHERE tenant_id = $1 AND id = $2', [bare.tenantId, bareBuild]))[0].submit_error, /App Store Connect key/);
  // A build of another business is not found from here.
  await assert.rejects(() => inShop(bare, () => service().submit(buildId, { actor: 'system' })), /no such build/i);
});

const submissionOf = async (shop) => (await shop.must('GET', '/app-publishing/submissions')).items.find((s) => s.platform === 'ios');
const historyOf = async (shop) => (await shop.sql('SELECT from_state, to_state, actor FROM app_submission_history WHERE tenant_id = $1 ORDER BY id', [shop.tenantId])).map((h) => `${h.from_state}>${h.to_state}`);
const told = async (shop, kind) => Number((await shop.sql('SELECT count(*)::int AS n FROM notification_events WHERE tenant_id = $1 AND kind = $2', [shop.tenantId, kind]))[0].n);
const reads = async (n = 3) => {
  for (let i = 0; i < n; i++) {
    await world.tick();
    await sleep(150);
  }
};

test('a store answer that arrives late or twice changes nothing, and the owner is told once', async () => {
  const { shop, bundleId } = await iosShop();
  await seedSubmission(shop, 'ios', { state: 'in_review' });
  await world.appstore.post('/review', { bundleId, state: 'rejected', guideline: '2.1', message: 'We could not sign in.', version: '1.0.0', buildNumber: 1 });
  assert.ok(await world.waitFor(async () => ((await submissionOf(shop)).state === 'rejected' ? true : null), 20_000, 100), 'The rejection was not read');
  await reads();
  assert.equal((await shop.rejections()).length, 1, 'One rejection read three times was stored more than once');
  assert.equal(await told(shop, 'app.rejected'), 1);
  // Our team resubmits; the store still shows the old rejection. It is the old one: the app stays in review.
  const operator = await operatorOf(world);
  const id = (await shop.submissions())[0].id;
  accepted(await operator.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason: 'Turned review access on' }));
  await reads();
  assert.equal((await submissionOf(shop)).state, 'in_review', 'A rejection from before the resubmit moved the app again');
  assert.equal((await shop.rejections()).length, 1);
  // Approved; then a stale "in review" and an answer about another version change nothing.
  await world.appstore.post('/review', { bundleId, state: 'approved', version: '1.0.0', buildNumber: 1 });
  assert.ok(await world.waitFor(async () => ((await submissionOf(shop)).state === 'approved' ? true : null), 20_000, 100));
  await world.appstore.post('/review', { bundleId, state: 'in_review', version: '1.0.0', buildNumber: 1 });
  await reads();
  assert.equal((await submissionOf(shop)).state, 'approved', 'A late "in review" moved an approved app back');
  await world.appstore.post('/review', { bundleId, state: 'live', version: '0.9.0', buildNumber: 1 });
  await reads();
  assert.equal((await submissionOf(shop)).state, 'approved', 'An answer about another version made the app live');
  // Live, read again and again: one live push.
  await world.appstore.post('/review', { bundleId, state: 'live', version: '1.0.0', buildNumber: 1 });
  const live = await world.waitFor(async () => ((await submissionOf(shop)).state === 'live' ? submissionOf(shop) : null), 20_000, 100);
  assert.ok(live, 'Live was not read');
  assert.equal(live.liveVersion, '1.0.0');
  assert.match(live.storeUrl, /^https:\/\/apps\.apple\.com\//);
  await reads();
  assert.equal(await told(shop, 'app.live'), 1, 'The owner was told more than once');
  assert.deepEqual(await historyOf(shop), ['draft>in_review', 'in_review>rejected', 'rejected>in_review', 'in_review>approved', 'approved>live']);
});

test('moves go only along the rules, in code and in the database; a guideline that is not one is stored as unknown', async () => {
  const shop = await addAppShop(world, { platforms: ['android'] });
  await seedSubmission(shop, 'android');
  const move = (to, options) => inShop(shop, () => world.db.tx((t) => service().change(t, 'android', to, { actor: 'test', ...options })));
  for (const to of ['live', 'approved', 'rejected']) await assert.rejects(() => move(to), /can’t be moved/);
  assert.deepEqual((await move('live', { ifAllowed: true })).moved, false);
  assert.equal((await move('in_review')).moved, true);
  await assert.rejects(() => move('in_review'), /already/);
  // A store's odd guideline text and a long message: stored, cut to fit, mapped to "something else".
  const { rejection } = await inShop(shop, () => world.db.tx((t) => service().recordRejection(t, 'android', { guideline: '<script>', message: 'm'.repeat(5000), providerKey: 'k1' })));
  assert.equal(rejection.guideline, 'script');
  assert.equal(rejection.playbook_code, 'unknown');
  assert.equal(rejection.message.length, 4000);
  const twice = await inShop(shop, () => world.db.tx((t) => service().recordRejection(t, 'android', { guideline: '4.3', providerKey: 'k1' })));
  assert.equal(twice.duplicate, true);
  // A setting nobody may write through change().
  await assert.rejects(() => move('rejected', { set: { tenant_id: 1 } }), /cannot set/);
});

test('two rejections on one guideline open a review task: the resubmit is refused naming it, and the business cannot close it', async () => {
  const shop = await addAppShop(world, { platforms: ['android'] });
  await seedSubmission(shop, 'android', { state: 'in_review' });
  const operator = await operatorOf(world);
  const id = (await shop.submissions())[0].id;
  const reject = (guideline) => operator.send('POST', `/app-submissions/${id}/state`, { to: 'rejected', reason: 'The store said no', rejection: { guideline, message: 'Duplicate' } });
  const resubmit = () => operator.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason: 'Fixed' });
  accepted(await reject('4.3'));
  accepted(await resubmit());
  const second = accepted(await reject('4.3(a)')).json();
  assert.deepEqual(second.reviewTask, { guideline: '4.3' });
  assert.equal(second.rejections[0].playbook.code, '4.3');
  const blocked = await resubmit();
  assert.equal(blocked.status, 409);
  assert.match(blocked.json().error, /review task is open for this app \(guideline 4\.3\)/);
  // The business's own login cannot close the task or write a pass for its own build.
  await assert.rejects(() => inShop(shop, () => world.db.query(`UPDATE app_review_tasks SET status = 'resolved', resolved_at = now() WHERE tenant_id = $1`, [shop.tenantId])));
  await assert.rejects(() => inShop(shop, () => world.db.query(`DELETE FROM app_review_tasks WHERE tenant_id = $1`, [shop.tenantId])));
  assert.equal((await shop.reviewTasks())[0].status, 'open');
  // The seller's own API shows the task; our team resolves it once, and the way back opens.
  assert.deepEqual((await shop.must('GET', '/app-publishing/submissions')).items[0].reviewTask, { guideline: '4.3' });
  const task = (await shop.reviewTasks())[0];
  const resolved = accepted(await operator.send('POST', `/app-review-tasks/${task.id}/resolve`, { resolution: 'Rewrote the listing in the brand\'s own words' })).json();
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.resolvedBy, /^platform:/);
  refusedStatus(await operator.send('POST', `/app-review-tasks/${task.id}/resolve`, { resolution: 'again' }), 'Resolving twice', [409]);
  accepted(await resubmit());
  // The pass/fail of a run is the server's own reading of its checks: a run claiming to pass with a check failed is a fail.
  const { buildId } = await seedSubmission(shop, 'android', { presubmit: false });
  const lie = await inShop(shop, () => service().recordPresubmit(buildId, { platform: 'android', checks: [{ code: 'native_screens', passed: true }], toolVersion: 'x' }));
  assert.equal(lie.passed, false);
  // Another business's submission is not reachable from a business: the seller API shows its own only.
  const other = await addAppShop(world, { platforms: ['android'] });
  assert.deepEqual((await other.must('GET', '/app-publishing/submissions')).items.map((s) => [s.state, s.rejections.length]), [['draft', 0]]);
});
