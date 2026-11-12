// PRD 10.9 (the business's own developer accounts and our access to them): a personal Play account adds a closed-testing step, a
// missing D-U-N-S number shows the lookup link and a waiting status, an API key with too low a role names the role needed, and the
// listing's seller is the business's legal name. We never take a store password. P-37, P-38, P-39, P-40.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { accepted, addAppShop, assertNoPlatformName, refusedStatus, useP6World } from './kit.js';

const world = useP6World();

const access = async (shop, platform) => (await shop.must('GET', '/store-access')).items.find((i) => i.platform === platform);
const save = (shop, platform, body) => shop.send('PUT', `/store-access/${platform}`, body);
const check = (shop, platform) => shop.send('POST', `/store-access/${platform}/check`);
const text = (value) => JSON.stringify(value);

test('P-37: a personal Play account shows a warning and adds a closed-testing step with 12 testers for 14 days', async () => {
  const shop = await addAppShop(world, { name: 'Kesar Kitchen' });
  const before = await access(shop, 'android');
  assert.equal(before.accountType, 'unknown');
  assert.ok(!before.steps.some((s) => /closed/i.test(s.code)), 'A closed-testing step appears before the account type is known');
  const res = accepted(await save(shop, 'android', { accountType: 'personal', playAccountAfterCutoff: true }), 'Choosing a personal Play account');
  const out = res.json();
  assert.equal(out.accountType, 'personal');
  const step = out.steps.find((s) => /closed/i.test(s.code));
  assert.ok(step, 'No closed-testing step was added');
  assert.equal(step.done, false);
  assert.ok(step.warning.length > 10, 'The step has no warning');
  assert.match(text(out.steps), /12 testers|12 people|twelve/i, 'The warning does not say 12 testers');
  assert.match(text(out.steps), /14 (consecutive )?days|fourteen/i, 'The warning does not say 14 days');
  assert.equal(out.closedTest.status, 'required');
  assert.equal(out.closedTest.testersNeeded, 12);
  assert.equal(out.closedTest.daysNeeded, 14);
  assertNoPlatformName(res, 'The Play access answer');
  // Progress: started, then 12 testers, then done after 14 days.
  const started = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const running = accepted(await save(shop, 'android', { closedTest: { startedAt: started, testers: 12 } })).json();
  assert.equal(running.closedTest.status, 'running');
  assert.equal(running.closedTest.daysDone, 3);
  assert.equal(running.closedTest.testers, 12);
  const long = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const done = accepted(await save(shop, 'android', { closedTest: { startedAt: long, testers: 12 } })).json();
  assert.equal(done.closedTest.status, 'done');
  assert.equal(done.steps.find((s) => /closed/i.test(s.code)).done, true);
  // Fewer than 12 testers does not finish it, a start in the future is refused, a start 100 years ago is not "done".
  const few = accepted(await save(shop, 'android', { closedTest: { startedAt: long, testers: 11 } })).json();
  assert.notEqual(few.closedTest.status, 'done', 'Eleven testers finished the closed test');
  refusedStatus(await save(shop, 'android', { closedTest: { startedAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), testers: 12 } }), 'A closed test starting in the future', [400, 422]);
  refusedStatus(await save(shop, 'android', { closedTest: { startedAt: long, testers: -1 } }), 'Negative testers', [400, 422]);
  // An organisation account, or a personal one made before the cutoff, needs no closed test.
  const org = accepted(await save(shop, 'android', { accountType: 'organisation', closedTest: { startedAt: null, testers: null } })).json();
  assert.equal(org.closedTest.status, 'not_needed');
  assert.ok(!org.steps.some((s) => /closed/i.test(s.code) && !s.done), 'An organisation account still has the closed-testing step');
  const old = accepted(await save(shop, 'android', { accountType: 'personal', playAccountAfterCutoff: false })).json();
  assert.equal(old.closedTest.status, 'not_needed');
  // iOS has no closed test, whatever the account type.
  const ios = await addAppShop(world, { platforms: ['ios'] });
  const iosOut = accepted(await save(ios, 'ios', { accountType: 'personal' })).json();
  assert.equal(iosOut.closedTest.status, 'not_needed');
  // Only the owner can change it, and another business's store access is not reachable.
  const manager = await shop.manager();
  assert.ok([401, 403].includes((await manager.send('PUT', '/store-access/android', { accountType: 'organisation' })).status), 'A manager changed the store access');
  assert.equal((await access(ios, 'ios')).accountType, 'personal');
});

test('P-38: a business with no D-U-N-S number sees the lookup link and the status "Waiting for D-U-N-S"', async () => {
  const shop = await addAppShop(world, { platforms: ['android', 'ios'] });
  for (const platform of ['android', 'ios']) {
    const out = accepted(await save(shop, platform, { accountType: 'organisation', dunsStatus: 'waiting' }), `D-U-N-S waiting on ${platform}`).json();
    assert.equal(out.dunsStatus, 'waiting');
    assert.match(out.dunsLookupUrl, /^https:\/\//, 'No lookup link');
    assert.ok(!namesIn(out.dunsLookupUrl), 'The lookup link names the platform');
    assert.match(text(out.steps), /Waiting for D-U-N-S/i, 'The status is not "Waiting for D-U-N-S"');
    const step = out.steps.find((s) => /duns|d-u-n-s/i.test(s.code));
    assert.ok(step && step.done === false);
  }
  const have = accepted(await save(shop, 'ios', { dunsStatus: 'have' })).json();
  assert.equal(have.dunsStatus, 'have');
  assert.equal(have.steps.find((s) => /duns/i.test(s.code))?.done, true);
  assert.doesNotMatch(text(have.steps), /Waiting for D-U-N-S/i);
  // A personal Play account does not need one.
  const personal = accepted(await save(shop, 'android', { accountType: 'personal', dunsStatus: 'not_needed' })).json();
  assert.equal(personal.dunsStatus, 'not_needed');
  assert.doesNotMatch(text(personal.steps), /Waiting for D-U-N-S/i);
  // The status is one of the four words; anything else is refused.
  refusedStatus(await save(shop, 'ios', { dunsStatus: 'maybe' }), 'A made-up status', [400, 422]);
  // Time spent waiting is remembered from the first "waiting", not reset by saving it again.
  const first = (await shop.sql('SELECT duns_requested_at FROM store_access WHERE tenant_id = $1 AND platform = $2', [shop.tenantId, 'android']))[0];
  await save(shop, 'android', { accountType: 'organisation', dunsStatus: 'waiting' });
  const second = (await shop.sql('SELECT duns_requested_at FROM store_access WHERE tenant_id = $1 AND platform = $2', [shop.tenantId, 'android']))[0];
  assert.ok(second.duns_requested_at, 'The request date is not kept');
  await save(shop, 'android', { dunsStatus: 'waiting' });
  const third = (await shop.sql('SELECT duns_requested_at FROM store_access WHERE tenant_id = $1 AND platform = $2', [shop.tenantId, 'android']))[0];
  assert.equal(String(third.duns_requested_at), String(second.duns_requested_at));
  assert.ok(first);
});
const namesIn = (s) => /bhava/i.test(s);

test('P-39: an App Store Connect key with too low a role fails validation and names the role needed; a right key passes; junk is not a crash', async () => {
  const shop = await addAppShop(world, { platforms: ['ios'], config: { ios_bundle_id: 'in.example.kesar' } });
  await world.appstore.post('/apps', { bundleId: 'in.example.kesar', sellerName: 'Kesar Kitchen Traders', name: 'Kesar Kitchen' });
  const low = await world.appstore.post('/keys', { role: 'DEVELOPER' });
  const saved = accepted(await save(shop, 'ios', { accountType: 'organisation', legalName: 'Kesar Kitchen Traders', ascKey: { keyId: low.keyId, issuerId: low.issuerId, privateKey: low.privateKey } }), 'Saving the key').json();
  assert.equal(saved.credential.kind, 'asc_api_key');
  assert.equal(saved.credential.set, true);
  assert.equal(saved.credential.keyId, low.keyId);
  assert.ok(saved.credential.keyLast4.length === 4);
  // The private key is never answered, in this call or the next, and is stored encrypted.
  assert.ok(!text(saved).includes('PRIVATE KEY') && !text(saved).includes(low.privateKey.slice(40, 80)), 'The saved key came back');
  assert.ok(!text(await access(shop, 'ios')).includes('PRIVATE KEY'));
  const [row] = await shop.sql('SELECT key_enc FROM store_access WHERE tenant_id = $1 AND platform = $2', [shop.tenantId, 'ios']);
  assert.ok(row.key_enc && !row.key_enc.includes('PRIVATE KEY') && !row.key_enc.includes(low.privateKey.slice(40, 80)), 'The key is stored in the clear');
  const audit = await shop.sql('SELECT * FROM audit_log WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(!JSON.stringify(audit).includes(low.privateKey.slice(40, 80)), 'The key is in the audit log');
  // The check.
  const checked = accepted(await check(shop, 'ios'), 'Checking access').json();
  assert.equal(checked.access.status, 'role_too_low');
  assert.equal(checked.access.roleFound, 'DEVELOPER');
  assert.equal(checked.access.roleNeeded, 'APP_MANAGER', 'The role needed is named');
  assert.match(text(checked.steps), /APP_MANAGER|App Manager/i, 'The step does not tell the owner which role to give');
  // A key with the right role.
  const good = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  accepted(await save(shop, 'ios', { ascKey: { keyId: good.keyId, issuerId: good.issuerId, privateKey: good.privateKey } }));
  const ok = accepted(await check(shop, 'ios')).json();
  assert.equal(ok.access.status, 'ok');
  assert.equal(ok.access.roleFound, 'APP_MANAGER');
  assert.ok(ok.access.checkedAt);
  // A higher role also passes.
  const admin = await world.appstore.post('/keys', { role: 'ADMIN' });
  accepted(await save(shop, 'ios', { ascKey: { keyId: admin.keyId, issuerId: admin.issuerId, privateKey: admin.privateKey } }));
  assert.equal(accepted(await check(shop, 'ios')).json().access.status, 'ok');
  // A key the store does not know, the wrong issuer, and a key that is not a key.
  accepted(await save(shop, 'ios', { ascKey: { keyId: 'ZZZZZZZZZZ', issuerId: good.issuerId, privateKey: good.privateKey } }));
  assert.equal(accepted(await check(shop, 'ios')).json().access.status, 'invalid');
  accepted(await save(shop, 'ios', { ascKey: { keyId: good.keyId, issuerId: crypto.randomUUID(), privateKey: good.privateKey } }));
  assert.equal(accepted(await check(shop, 'ios')).json().access.status, 'invalid');
  const garbage = await save(shop, 'ios', { ascKey: { keyId: good.keyId, issuerId: good.issuerId, privateKey: 'not a key at all' } });
  if (garbage.status < 300) assert.equal(accepted(await check(shop, 'ios')).json().access.status, 'invalid');
  else assert.ok([400, 422].includes(garbage.status));
  // The store timing out, answering junk or a server error: unreachable, the key is kept, nothing crashes, the answer is prompt.
  accepted(await save(shop, 'ios', { ascKey: { keyId: good.keyId, issuerId: good.issuerId, privateKey: good.privateKey } }));
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'html' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'server_error', status: 503 }, { kind: 'drop' }, { kind: 'rate_limit', retryAfter: 1 }]) {
    await world.appstore.post('/faults', { ...fault, times: 'forever' });
    const started = Date.now();
    const res = await check(shop, 'ios');
    await world.appstore.delete('/faults');
    assert.ok(res.status < 500, `A ${fault.kind} (${fault.mode ?? ''}) from the store made the check answer ${res.status}`);
    assert.ok(Date.now() - started < 30_000, `A ${fault.kind} from the store held the check for ever`);
    const out = res.json();
    assert.ok(['unreachable', 'invalid'].includes(out.access.status), `${fault.kind}: access was ${out.access.status}`);
    assert.equal(out.credential.set, true, `${fault.kind} removed the key`);
    assertNoPlatformName(res, `A ${fault.kind} answer`);
  }
  await world.appstore.post('/reset');
});

test('P-39: Google Play: our service account needs the release permission; too little is named, the right grant passes; no password is ever taken', async () => {
  const shop = await addAppShop(world, { config: { android_package: 'in.example.kesar', play_account_id: '1234567890' } });
  const out = await access(shop, 'android');
  assert.match(out.serviceAccountEmail, /@.+\..+/, 'The owner is not told which account to invite');
  assert.ok(!text(out).includes('PRIVATE KEY'), 'Our Play key came back to a business');
  await world.play.post('/apps', { packageName: 'in.example.kesar', developerName: 'Kesar Kitchen Traders', permissions: [] });
  assert.ok(['role_too_low', 'invalid'].includes(accepted(await check(shop, 'android')).json().access.status), 'No permission passed');
  await world.play.post('/apps', { packageName: 'in.example.kesar', developerName: 'Kesar Kitchen Traders', permissions: ['VIEW_APP_INFORMATION'] });
  const low = accepted(await check(shop, 'android')).json();
  assert.equal(low.access.status, 'role_too_low');
  assert.equal(low.access.roleNeeded, 'RELEASE_TO_PRODUCTION');
  await world.play.post('/apps', { packageName: 'in.example.kesar', developerName: 'Kesar Kitchen Traders', permissions: ['RELEASE_TO_PRODUCTION'] });
  assert.equal(accepted(await check(shop, 'android')).json().access.status, 'ok');
  // The app is not in any Play Console yet.
  await shop.appSet({ android_package: 'in.example.unknown' });
  assert.ok(['invalid', 'role_too_low', 'unreachable'].includes(accepted(await check(shop, 'android')).json().access.status));
  // Store passwords, passcodes and sign-in names are refused outright and not stored.
  for (const extra of [{ password: 'hunter2hunter2' }, { appleId: 'owner@icloud.example' }, { passcode: '123456' }, { googlePassword: 'x'.repeat(12) }, { email: 'owner@gmail.example', password: 'x'.repeat(10) }]) {
    refusedStatus(await save(shop, 'android', extra), `Store access with ${Object.keys(extra).join(' and ')}`, [400, 422]);
  }
  const dump = JSON.stringify(await shop.sql('SELECT * FROM store_access WHERE tenant_id = $1', [shop.tenantId]));
  assert.ok(!/hunter2|123456|icloud\.example/.test(dump), 'A refused password was stored');
  // Another business never sees this one's access.
  const other = await addAppShop(world);
  assert.equal((await access(other, 'android')).credential.kind, 'none');
  assert.equal((await access(other, 'android')).access.status, 'not_checked');
});

test('P-40: the published listing\'s seller is the business\'s legal name; a different seller is flagged', async () => {
  const shop = await addAppShop(world, { platforms: ['ios'], config: { ios_bundle_id: 'in.example.mehta' } });
  await world.appstore.post('/apps', { bundleId: 'in.example.mehta', sellerName: 'Mehta Mart Traders', name: 'Mehta Mart' });
  const key = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  accepted(await save(shop, 'ios', { accountType: 'organisation', legalName: 'Mehta Mart Traders', dunsStatus: 'have', ascKey: { keyId: key.keyId, issuerId: key.issuerId, privateKey: key.privateKey } }));
  const matched = accepted(await check(shop, 'ios')).json();
  assert.equal(matched.legalName, 'Mehta Mart Traders');
  const step = matched.steps.find((s) => /legal|seller/i.test(s.code));
  assert.ok(step, 'No step about the seller name');
  assert.equal(step.done, true);
  // The store says the seller is someone else (an agency\'s account): the step is not done and says whose name it shows.
  await world.appstore.post('/apps', { bundleId: 'in.example.mehta', sellerName: 'A Marketing Agency Pvt Ltd', name: 'Mehta Mart' });
  const mismatch = accepted(await check(shop, 'ios')).json();
  const bad = mismatch.steps.find((s) => /legal|seller/i.test(s.code));
  assert.equal(bad.done, false);
  assert.ok(bad.warning.length > 5);
  // The legal name is required text, limited in length and markup-free.
  refusedStatus(await save(shop, 'ios', { legalName: 'x'.repeat(201) }), 'A 201-character legal name', [400, 422]);
  const html = await save(shop, 'ios', { legalName: '<script>alert(1)</script> Traders' });
  if (html.status < 300) assert.ok(!/<script>/.test(text(html.json())), 'Markup in the legal name came back live');
  // The name never names the platform.
  const platformName = await save(shop, 'ios', { legalName: 'Bhava Traders' });
  refusedStatus(platformName, 'A legal name that names the platform', [400, 422]);
});
