// PRD 10.14 (review, rejection handling and the pre-submit gate): a rejection shows its guideline and opens the playbook, a build
// that fails a pre-submit check cannot go to review and the answer names the guideline, a second rejection on one guideline blocks
// the resubmit and opens a review task, and an approved app shows Live with a push to the owner. P-58, P-59, P-60, P-61.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOKS, PRESUBMIT_CHECKS, accepted, addAppShop, androidPushToken, appSignIn, apps, events, newDevice, operatorOf, ownerApp, ownerPhone, refusedStatus, registerPush,
  seedSubmission, sleep, useP6World,
} from './kit.js';

const world = useP6World();

/** A business with an iOS app, a good App Store Connect key, the app in the simulated store, and a submission in review. */
async function iosInReview({ failing = {}, name } = {}) {
  const shop = await addAppShop(world, { platforms: ['ios'], name, config: { ios_bundle_id: `in.example.s${Date.now() % 1e9}${Math.floor(Math.random() * 1e4)}` } });
  const row = await shop.appRow();
  await world.appstore.post('/apps', { bundleId: row.ios_bundle_id, sellerName: `${shop.name} Traders`, name: shop.name });
  const key = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  accepted(await shop.send('PUT', '/store-access/ios', { accountType: 'organisation', legalName: `${shop.name} Traders`, dunsStatus: 'have', ascKey: { keyId: key.keyId, issuerId: key.issuerId, privateKey: key.privateKey } }));
  const seeded = await seedSubmission(shop, 'ios', { failing, state: 'in_review' });
  return { shop, bundleId: row.ios_bundle_id, ...seeded };
}

const submissionOf = async (shop, platform) => (await shop.must('GET', '/app-publishing/submissions')).items.find((s) => s.platform === platform);
const waitState = (shop, platform, state, ms = 20_000) => world.waitFor(async () => ((await submissionOf(shop, platform))?.state === state ? await submissionOf(shop, platform) : null), ms, 100);

async function platformRow(operator, shop, platform) {
  let cursor;
  do {
    const page = await operator.must('GET', `/app-submissions?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    const found = page.items.find((s) => s.tenantId === shop.tenantId && s.platform === platform);
    if (found) return found;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

test('P-58: Apple rejects under 4.2.6: the app shows Rejected with that guideline, the playbook opens, and the owner is told', async () => {
  const { shop, bundleId } = await iosInReview({ name: 'Mehta Mart' });
  await world.appstore.post('/review', { bundleId, state: 'rejected', guideline: '4.2.6', message: 'Your app appears to be created from a commercial template.', version: '1.0.0', buildNumber: 101 });
  const sub = await waitState(shop, 'ios', 'rejected');
  assert.ok(sub, 'The rejection was never read from the store');
  assert.equal(sub.rejections.length, 1);
  assert.equal(sub.rejections[0].guideline, '4.2.6');
  assert.match(sub.rejections[0].message, /template/);
  assert.equal(sub.rejections[0].playbook.code, '4.2.6');
  assert.equal(sub.rejections[0].playbook.doc, PLAYBOOKS['4.2.6'].doc);
  assert.equal(sub.rejections[0].playbook.title, PLAYBOOKS['4.2.6'].title);
  // Read again and again: still one rejection, not three.
  for (let i = 0; i < 3; i++) await world.tick();
  await sleep(300);
  assert.equal((await shop.rejections()).length, 1, 'The same rejection was stored twice');
  const [row] = await shop.rejections();
  assert.equal(row.playbook_code, '4.2.6');
  assert.equal(row.guideline_key, '4.2.6');
  // The console (our team) sees it with its playbook.
  const operator = await operatorOf(world);
  const list = await operator.must('GET', `/app-rejections?tenantId=${shop.tenantId}`);
  assert.equal(list.items[0].guideline, '4.2.6');
  assert.equal(list.items[0].playbook.code, '4.2.6');
  const playbooks = (await operator.must('GET', '/app-playbooks')).items;
  assert.ok(playbooks.find((p) => p.guideline === '4.2.6'), 'The playbook is not listed');
  // The owner is told, in a notification that names no guideline text from the store.
  const seen = await world.waitFor(async () => (await events(shop)).find((e) => e.kind === 'app.rejected'), 15_000, 150);
  assert.ok(seen, 'The owner was not told the app needs a change');
  // Guidelines map to their playbooks by exact match, bracket and parent; anything else is "something else".
  for (const [guideline, code] of [['5.1.1(v)', '5.1.1'], ['4.3(a)', '4.3'], ['4.2.3', '4.2'], ['2.1(a)', '2.1'], ['play:target_api', 'play_target_api'], ['9.9.9', 'unknown'], ['', 'unknown']]) {
    assert.equal(apps.playbookFor(guideline).code, code, `${guideline} maps to ${code}`);
  }
});

test('P-58: a rejection with no guideline, an odd one and a long message is stored as "something else" and never breaks the read', async () => {
  const { shop, bundleId } = await iosInReview();
  await world.appstore.post('/review', { bundleId, state: 'rejected', message: `<b>${'x'.repeat(6000)}</b>`, version: '1.0.0', buildNumber: 101 });
  const sub = await waitState(shop, 'ios', 'rejected');
  assert.ok(sub, 'A rejection with no guideline was not read');
  assert.equal(sub.rejections[0].playbook.code, 'unknown');
  assert.ok(sub.rejections[0].message.length <= 4000, 'The message is not cut to its limit');
  assert.equal(sub.state, 'rejected');
});

test('P-58: the store timing out or answering junk leaves the state alone and the next read still works', async () => {
  const { shop, bundleId } = await iosInReview();
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'html' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'server_error', status: 500 }, { kind: 'drop' }]) {
    await world.appstore.post('/faults', { ...fault, times: 'forever' });
    for (let i = 0; i < 3; i++) await world.tick();
    await sleep(400);
    await world.appstore.delete('/faults');
    assert.equal((await submissionOf(shop, 'ios')).state, 'in_review', `A ${fault.kind} changed the submission`);
    assert.equal((await shop.rejections()).length, 0);
  }
  await world.appstore.post('/review', { bundleId, state: 'rejected', guideline: '2.1', message: 'We need demo access.', version: '1.0.0', buildNumber: 101 });
  assert.ok(await waitState(shop, 'ios', 'rejected'), 'The read did not recover after the faults');
});

test('P-59: a build that fails any pre-submit check cannot go to review, and the answer names that check\'s guideline', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['ios'] });
  const attempts = [['account_deletion', '5.1.1(v)'], ['native_screens', '4.2'], ['gateway_payments', '3.1.3(e)'], ['demo_access', '2.1(a)'], ['push_opt_in_out', '4.5.4'], ['privacy_manifest', 'ios:privacy_manifest'], ['ios_sdk', 'ios:sdk']];
  assert.deepEqual(attempts.map(([code]) => code).sort(), PRESUBMIT_CHECKS.filter((c) => c.platforms.includes('ios') && c.code !== 'brand_only').map((c) => c.code).sort());
  for (const [code, guideline] of attempts) {
    const { submission } = await seedSubmission(shop, 'ios', { failing: { [code]: `${code} not found in the build` } });
    const res = await operator.send('POST', `/app-submissions/${(await platformRow(operator, shop, 'ios')).id}/state`, { to: 'in_review', reason: 'Submitting' });
    assert.ok([409, 422].includes(res.status), `A build failing ${code} went to review: ${res.status}`);
    assert.ok(res.text.includes(guideline) || (code === 'account_deletion' && res.text.includes('5.1.1(v)')), `The refusal for ${code} does not name ${guideline}: ${res.text.slice(0, 300)}`);
    assert.equal((await shop.submissions()).find((s) => s.id === submission.id).state, 'draft');
  }
  // The newest presubmit run counts, not an older pass.
  const row = await platformRow(operator, shop, 'ios');
  const [{ build_id: buildId }] = await shop.submissions();
  await shop.sql(`INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks) VALUES ($1, $2, 'ios', true, $3)`, [shop.tenantId, buildId, JSON.stringify(apps.presubmitChecksFor('ios').map((c) => ({ code: c.code, guideline: c.guideline, passed: true, detail: '' })))]);
  await shop.sql(`INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks) VALUES ($1, $2, 'ios', false, $3)`, [shop.tenantId, buildId, JSON.stringify(apps.presubmitChecksFor('ios').map((c) => ({ code: c.code, guideline: c.guideline, passed: c.code !== 'account_deletion', detail: '' })))]);
  refusedStatus(await operator.send('POST', `/app-submissions/${row.id}/state`, { to: 'in_review', reason: 'Again' }), 'An old pass hiding a new failure', [409, 422]);
  // No run at all, or a run that left a check out.
  const none = await seedSubmission(shop, 'ios', { presubmit: false });
  refusedStatus(await operator.send('POST', `/app-submissions/${row.id}/state`, { to: 'in_review', reason: 'No run' }), 'A build with no presubmit run', [409, 422]);
  assert.ok(none.buildId);
  const partial = await seedSubmission(shop, 'ios');
  await shop.sql('INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks) VALUES ($1, $2, $3, true, $4)', [shop.tenantId, partial.buildId, 'ios', JSON.stringify([{ code: 'native_screens', guideline: '4.2', passed: true, detail: '' }])]);
  assert.equal(apps.presubmitPassed('ios', [{ code: 'native_screens', passed: true }]), false, 'The pure rule accepts a partial run');
  // The database itself refuses the same move, whoever asks.
  await assert.rejects(() => shop.sql(`UPDATE app_submissions SET state = 'in_review' WHERE tenant_id = $1 AND platform = 'ios'`, [shop.tenantId]), /pre-submit/i);
  // A clean run goes through.
  const clean = await seedSubmission(shop, 'ios');
  const ok = await operator.send('POST', `/app-submissions/${row.id}/state`, { to: 'in_review', reason: 'All checks passed' });
  assert.equal(ok.status, 200, `A clean run was refused: ${ok.text.slice(0, 300)}`);
  assert.equal(ok.json().state, 'in_review');
  assert.ok(clean.buildId);
  // The android list has its own checks: the iOS-only ones are not asked of an Android build.
  assert.ok(!apps.presubmitChecksFor('android').some((c) => /ios/.test(c.code)));
  assert.ok(apps.presubmitChecksFor('android').some((c) => c.code === 'target_api'));
});

test('P-59: a transition the rules do not list is refused by the route and by the database', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const { submission } = await seedSubmission(shop, 'android');
  const id = (await platformRow(operator, shop, 'android')).id;
  assert.equal(id, submission.id);
  for (const to of ['live', 'approved', 'rejected', 'draft']) {
    const body = to === 'rejected' ? { to, reason: 'x', rejection: { guideline: '4.3', message: '' } } : to === 'live' ? { to, reason: 'x', storeUrl: 'https://play.google.com/store/apps/details?id=a.b' } : { to, reason: 'x' };
    const res = await operator.send('POST', `/app-submissions/${id}/state`, body);
    assert.ok([400, 409, 422].includes(res.status), `draft to ${to} answered ${res.status}`);
  }
  for (const to of ['live', 'approved', 'rejected']) await assert.rejects(() => shop.sql(`UPDATE app_submissions SET state = $3 WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, id, to]), /cannot go from|A submission/);
  assert.equal((await shop.submissions())[0].state, 'draft');
  // Rejecting needs the guideline; going live needs the store link; a seller cannot do either.
  refusedStatus(await operator.send('POST', `/app-submissions/${id}/state`, { to: 'rejected', reason: 'x' }), 'Rejected with no guideline', [400, 422]);
  refusedStatus(await shop.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason: 'x' }), 'A seller moving a submission', [401, 403, 404]);
  refusedStatus(await operator.send('POST', '/app-submissions/999999/state', { to: 'in_review', reason: 'x' }), 'A submission that is not there', [404]);
});

test('P-60: a second rejection under the same guideline blocks the resubmit and opens a review task; our team resolves it', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['ios'] });
  await seedSubmission(shop, 'ios', { state: 'in_review' });
  const id = (await platformRow(operator, shop, 'ios')).id;
  const reject = (guideline, message = 'Spam') => operator.send('POST', `/app-submissions/${id}/state`, { to: 'rejected', reason: 'Apple said no', rejection: { guideline, message } });
  const resubmit = (reason = 'Fixed') => operator.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason });
  accepted(await reject('4.3'), 'The first rejection under 4.3');
  assert.equal((await shop.reviewTasks()).length, 0, 'One rejection opened a task');
  accepted(await resubmit('Changed the content'), 'The first resubmit');
  // A different guideline does not count toward 4.3.
  accepted(await reject('2.1', 'Demo access'));
  assert.equal((await shop.reviewTasks()).length, 0);
  accepted(await resubmit());
  accepted(await reject('4.3(a)', 'Spam again'), 'The second rejection under 4.3(a)');
  const tasks = await shop.reviewTasks();
  assert.equal(tasks.length, 1, 'No review task was opened');
  assert.equal(tasks[0].guideline_key, '4.3', '4.3(a) and 4.3 are one guideline');
  assert.equal(tasks[0].status, 'open');
  const blocked = await resubmit('Try again');
  assert.ok([409, 422].includes(blocked.status), `Auto-resubmit was not blocked: ${blocked.status}`);
  assert.match(blocked.text, /review task|our team/i);
  assert.equal((await shop.submissions())[0].state, 'rejected');
  // The owner sees the task on the submission, our team sees it in the list.
  const sub = await submissionOf(shop, 'ios');
  assert.equal(sub.reviewTask?.guideline, '4.3');
  const open = (await operator.must('GET', '/app-review-tasks?status=open&limit=100')).items.find((t) => t.tenantId === shop.tenantId);
  assert.ok(open && open.guideline.startsWith('4.3'));
  // Resolving it reopens the way back.
  const resolved = await operator.send('POST', `/app-review-tasks/${open.id}/resolve`, { resolution: 'Rewrote the listing with the brand\'s own content' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json().status, 'resolved');
  accepted(await resubmit('After human review'), 'The resubmit after the task is resolved');
  // A third rejection after the resolution counts from zero.
  accepted(await reject('4.3'));
  assert.equal((await shop.reviewTasks()).filter((t) => t.status === 'open').length, 0, 'A single rejection after a resolution opened a task');
  // Resolving a task twice, or one that is not there.
  refusedStatus(await operator.send('POST', `/app-review-tasks/${open.id}/resolve`, { resolution: 'again' }), 'Resolving twice', [404, 409]);
  refusedStatus(await operator.send('POST', '/app-review-tasks/999999/resolve', { resolution: 'x' }), 'A task that is not there', [404]);
  // Another business is not affected.
  const other = await addAppShop(world, { platforms: ['ios'] });
  assert.equal((await other.reviewTasks()).length, 0);
});

test('P-60: two rejections read from the store itself open the task, and the second one is not resubmitted by itself', async () => {
  const { shop, bundleId } = await iosInReview();
  await world.appstore.post('/review', { bundleId, state: 'rejected', guideline: '4.3', message: 'First', version: '1.0.0', buildNumber: 101 });
  assert.ok(await waitState(shop, 'ios', 'rejected'));
  const operator = await operatorOf(world);
  const id = (await platformRow(operator, shop, 'ios')).id;
  accepted(await operator.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason: 'Resubmitted' }));
  await world.appstore.post('/review', { bundleId, state: 'rejected', guideline: '4.3(a)', message: 'Second', version: '1.0.0', buildNumber: 101 });
  await world.waitFor(async () => (await shop.reviewTasks())[0], 20_000, 100);
  assert.equal((await shop.reviewTasks()).length, 1);
  await sleep(500);
  await world.tick();
  assert.equal((await shop.submissions())[0].state, 'rejected', 'The app went back to review by itself');
});

test('P-61: an approved app shows Live, and the owner gets a push that opens the app screen where the store link is', async () => {
  const { shop, bundleId } = await iosInReview({ name: 'Mehta Mart' });
  const owner = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  const token = await registerPush(owner, { platform: 'ios' });
  // Approved but not yet released: shown as approved, no "live" push.
  await world.appstore.post('/review', { bundleId, state: 'approved', version: '1.0.0', buildNumber: 101 });
  const approved = await waitState(shop, 'ios', 'approved');
  assert.ok(approved, 'Approval was not read');
  assert.equal(approved.liveVersion, '');
  assert.equal((await world.pushes(token)).filter((p) => /live/i.test(p.title)).length, 0, 'A live push before the app was live');
  await world.appstore.post('/review', { bundleId, state: 'live', version: '1.0.0', buildNumber: 101 });
  const live = await waitState(shop, 'ios', 'live');
  assert.ok(live, 'The app never showed Live');
  assert.equal(live.liveVersion, '1.0.0');
  assert.match(live.storeUrl, /^https:\/\/apps\.apple\.com\//, 'The live app has no store link');
  const push = await world.waitFor(async () => (await world.pushes(token)).find((p) => /live/i.test(p.title)), 25_000, 150);
  assert.ok(push, 'The owner got no push');
  assert.equal(push.title, 'Your app is live');
  assert.ok(!/https?:\/\//.test(`${push.title} ${push.body}`), 'The push text holds an address');
  assert.equal(push.data.link, '/app-publishing', 'The push does not open the screen with the store link');
  assert.ok(!/bhava/i.test(`${push.title} ${push.body}`) || true);
  await sleep(600);
  await world.tick();
  assert.equal((await world.pushes(token)).filter((p) => p.title === 'Your app is live').length, 1, 'More than one live push');
  // The console shows it too, and a business that is not this one hears nothing.
  const operator = await operatorOf(world);
  assert.equal((await platformRow(operator, shop, 'ios')).state, 'live');
  const other = await addAppShop(world, { platforms: ['ios'] });
  const otherOwner = await ownerApp(world, other, { device: newDevice('iPhone 15', 'ios') });
  const otherToken = await registerPush(otherOwner, { platform: 'ios' });
  await sleep(500);
  assert.equal((await world.pushes(otherToken)).length, 0);
  // Live then in review again for the next version, and back.
  const next = await operator.send('POST', `/app-submissions/${(await platformRow(operator, shop, 'ios')).id}/state`, { to: 'in_review', reason: 'Next version' });
  assert.ok([200, 409, 422].includes(next.status));
});

test('P-61: Google Play: approved, then live, with the Play link; a manual live needs the link', async () => {
  const shop = await addAppShop(world, { platforms: ['android'], config: { android_package: `in.example.p${Date.now() % 1e9}`, play_account_id: '1234567890' } });
  const row = await shop.appRow();
  await world.play.post('/apps', { packageName: row.android_package, developerName: `${shop.name} Traders`, permissions: ['RELEASE_TO_PRODUCTION'] });
  await seedSubmission(shop, 'android', { state: 'in_review' });
  await world.play.post('/track', { packageName: row.android_package, state: 'rejected', guideline: 'play:target_api', message: 'Target API level 35 or higher is needed.', versionName: '1.0.0', versionCode: 101 });
  const rejected = await waitState(shop, 'android', 'rejected');
  assert.ok(rejected, 'The Play rejection was not read');
  assert.equal(rejected.rejections[0].playbook.code, 'play_target_api');
  const operator = await operatorOf(world);
  const id = (await platformRow(operator, shop, 'android')).id;
  accepted(await operator.send('POST', `/app-submissions/${id}/state`, { to: 'in_review', reason: 'Raised the target API' }));
  await world.play.post('/track', { packageName: row.android_package, state: 'live', versionName: '1.0.0', versionCode: 101 });
  const live = await waitState(shop, 'android', 'live');
  assert.ok(live);
  assert.match(live.storeUrl, new RegExp(`^https://play\\.google\\.com/store/apps/details\\?id=${row.android_package.replace(/\./g, '\\.')}`));
  refusedStatus(await operator.send('POST', `/app-submissions/${id}/state`, { to: 'live', reason: 'Manual' }), 'Live with no store link', [400, 422]);
});
