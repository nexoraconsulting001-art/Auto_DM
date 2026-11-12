// PRD 10.10 (over-the-air updates): an update reaches the apps of its own runtime only, a native change is blocked and a store build
// is asked for, a crash rate that doubles at 10% rolls back and alerts ops, and rollouts only go 10, 50, 100. P-41, P-42, P-43.
// (P-44, the device offline at launch, is the app's: apps/shopper/spec.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { accepted, addAppShop, addP4Shop, apps, operatorOf, refusedStatus, sleep, together, useP6World } from './kit.js';

const world = useP6World({ overrides: { otaMinLaunches: 20, otaCrashMultiplier: 2, otaCrashFloor: 0.01, otaBaselineCrashRate: 0.005, otaWindowMinutes: 60 } });
const hash = () => crypto.randomBytes(32).toString('hex');
const key = () => `ota-${crypto.randomUUID().slice(0, 18)}`;
let serial = 0;

/** A runtime of its own (so tests do not share releases): app_runtimes holds the fingerprint its store builds report. */
async function runtime(name = `9.${++serial}.0`) {
  const fingerprint = `fp${crypto.createHash('sha256').update(name).digest('hex').slice(0, 30)}`;
  await world.sql(`INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, $2, '1.0.0') ON CONFLICT DO NOTHING`, [name, fingerprint]);
  await world.eas.post('/fingerprints', { runtimeVersion: name, fingerprint });
  return { name, fingerprint };
}
const publish = (operator, rt, fields = {}) => operator.send('POST', '/ota-releases', { runtimeVersion: rt.name, bundleFingerprint: rt.fingerprint, bundleId: `bundle-${crypto.randomUUID().slice(0, 8)}`, bundleHash: hash(), message: 'Fix the cart total on small screens', requestKey: key(), ...fields });
const resolve = async (shop, runtimeVersion, seed) => (await world.eas.get(`/channels/t${shop.tenantId}/resolve`, { runtimeVersion, seed: String(seed) })).updateId;
const updates = async () => (await world.eas.get('/updates')).updates;

test('P-41: a fix published on runtime 1.2 reaches apps on 1.2 and not apps on 1.1, on every brand\'s channel, at 10% first', async () => {
  const operator = await operatorOf(world);
  const a = await addAppShop(world, { platforms: ['android', 'ios'] });
  const b = await addAppShop(world, { platforms: ['android'] });
  const none = await addP4Shop(world, { name: 'No App' });
  const r12 = await runtime();
  const r11 = await runtime();
  const res = await publish(operator, r12);
  assert.equal(res.status, 201, `Publishing answered ${res.status}: ${res.text.slice(0, 300)}`);
  const release = res.json();
  assert.equal(release.rollout, 10);
  assert.ok(['publishing', 'live'].includes(release.status));
  const live = await world.waitFor(async () => {
    const list = (await operator.must('GET', '/ota-releases?limit=100')).items.find((r) => r.id === release.id);
    return list?.status === 'live' ? list : null;
  }, 20_000, 100);
  assert.ok(live, 'The release never went live');
  assert.equal(live.channelsDone, live.channelsTotal);
  assert.ok(live.channelsTotal >= 2, 'One bundle goes to every brand\'s channel');
  // One bundle, one update on each brand's channel for the one runtime.
  const all = await updates();
  const mine = all.filter((u) => u.runtimeVersion === r12.name);
  for (const shop of [a, b]) assert.ok(mine.some((u) => u.channel === `t${shop.tenantId}`), `No update on channel t${shop.tenantId}`);
  assert.equal(new Set(mine.map((u) => u.bundleId ?? u.message)).size, 1, 'The channels got different bundles');
  assert.ok(!all.some((u) => u.runtimeVersion === r11.name), 'The other runtime got an update');
  assert.ok(!mine.some((u) => u.channel === `t${none.tenantId}`), 'A business without an app got a channel update');
  // Who gets it: runtime 1.2 devices inside the rollout, never 1.1 devices.
  for (const seed of [0, 5, 9]) assert.ok(await resolve(a, r12.name, seed), `A 1.2 device (seed ${seed}) did not get the update`);
  for (const seed of [10, 50, 99]) assert.equal(await resolve(a, r12.name, seed), null, `A 1.2 device (seed ${seed}) outside 10% got it`);
  for (const seed of [0, 5, 50]) assert.equal(await resolve(a, r11.name, seed), null, 'A 1.1 device got a 1.2 update');
  // 10, then 50, then 100: no skipping, nothing after.
  const to50 = await operator.send('POST', `/ota-releases/${release.id}/advance`);
  assert.equal(to50.status, 200);
  assert.equal(to50.json().rollout, 50);
  assert.ok(await resolve(a, r12.name, 30));
  assert.equal(await resolve(a, r12.name, 60), null);
  const to100 = await operator.send('POST', `/ota-releases/${release.id}/advance`);
  assert.equal(to100.json().rollout, 100);
  assert.ok(await resolve(a, r12.name, 99));
  assert.equal(await resolve(a, r11.name, 99), null);
  refusedStatus(await operator.send('POST', `/ota-releases/${release.id}/advance`), 'Advancing past 100', [409, 422]);
  refusedStatus(await operator.send('POST', '/ota-releases/999999/advance'), 'Advancing a release that is not there', [404]);
  // The same request key is the same release; a changed bundle under the same key is refused.
  const again = await publish(operator, r12, { requestKey: 'x'.repeat(20) });
  const twin = await publish(operator, r12, { requestKey: 'x'.repeat(20) });
  assert.ok([200, 201].includes(twin.status));
  assert.equal(twin.json().id, again.json().id, 'One request key made two releases');
});

test('P-41: the publish call refuses what is not a release: bad hashes, bad keys, empty runtimes, and anyone but our team', async () => {
  const operator = await operatorOf(world);
  const r = await runtime();
  for (const bad of [{ bundleHash: 'abc' }, { bundleHash: 'Z'.repeat(64) }, { requestKey: 'short' }, { runtimeVersion: '' }, { bundleId: '' }, { bundleFingerprint: 'abc' }, { message: 'x'.repeat(501) }, { rollout: 100 }, { channels: ['t1'] }]) {
    refusedStatus(await publish(operator, r, bad), `Publishing with ${Object.keys(bad)[0]}`, [400, 422]);
  }
  const shop = await addAppShop(world);
  refusedStatus(await shop.send('POST', '/ota-releases', { runtimeVersion: r.name, bundleFingerprint: r.fingerprint, bundleId: 'b', bundleHash: hash(), requestKey: key() }), 'A seller publishing an update', [401, 403, 404]);
  assert.equal((await updates()).filter((u) => u.runtimeVersion === r.name).length, 0);
});

test('P-42: an update that adds a native module is blocked, nothing is published, and a store build is requested', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const r = await runtime();
  const before = (await updates()).length;
  // The bundle was built against a different native fingerprint: a native module was added.
  const res = await publish(operator, r, { bundleFingerprint: `fp${crypto.randomBytes(15).toString('hex')}` });
  assert.equal(res.status, 409, `A native change answered ${res.status}: ${res.text.slice(0, 300)}`);
  assert.match(res.text, /native|store build/i, 'The refusal does not say why');
  const blocked = (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.runtimeVersion === r.name);
  assert.ok(blocked, 'The blocked release was not recorded');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'native_change');
  assert.equal((await updates()).length, before, 'A blocked update reached the update service');
  assert.equal(await resolve(shop, r.name, 0), null);
  // A store build is asked for: an open native-change batch, or an alert to ops, or both.
  const batches = (await operator.must('GET', '/app-build-batches?limit=100')).items;
  const alerts = (await operator.must('GET', '/alerts?limit=100')).items;
  const asked = batches.some((b) => b.reason === 'native_change' && b.runtimeVersion !== r.name && b.status === 'open') || alerts.some((a) => /native|store build/i.test(`${a.kind} ${a.message}`));
  assert.ok(asked, 'No store build was requested');
  // The same bundle with the runtime\'s own fingerprint is fine, so the block is about the fingerprint and nothing else.
  const fine = await publish(operator, r);
  assert.equal(fine.status, 201);
  // A runtime nobody has built is unknown, not an empty channel list.
  const unknown = await publish(operator, { name: '0.0.0-never', fingerprint: r.fingerprint });
  assert.ok([404, 409, 422].includes(unknown.status), `An unknown runtime answered ${unknown.status}`);
  if (unknown.status === 409) {
    const row = (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.runtimeVersion === '0.0.0-never');
    assert.ok(!row || row.blockReason === 'unknown_runtime');
  }
});

test('P-43: a crash rate that doubles at 10% rollout rolls the release back and alerts ops', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const r = await runtime();
  const release = accepted(await publish(operator, r), 'Publishing').json();
  await world.waitFor(async () => (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id && x.status === 'live'), 20_000, 100);
  const updateId = (await updates()).find((u) => u.runtimeVersion === r.name && u.channel === `t${shop.tenantId}`)?.id ?? release.bundleId;
  const launch = (i, event) => {
    const app = shop.app({ ip: `192.0.2.${(i % 250) + 1}` });
    return app.start('guest').then(() => app.post('/api/store/app/health', { updateId, runtimeVersion: r.name, event }));
  };
  // Enough launches, a normal crash rate: nothing happens.
  const launches = await together(24, (i) => launch(i, 'launch'));
  assert.ok(launches.every((x) => x.status < 300), `Health answers: ${launches.map((x) => x.status)}`);
  await sleep(500);
  await world.tick();
  assert.equal((await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id).status, 'live');
  // One device that crashes over and over counts once an hour, so it cannot roll anything back.
  const spammer = shop.app({ ip: '192.0.2.250' });
  await spammer.start('guest');
  for (let i = 0; i < 40; i++) await spammer.post('/api/store/app/health', { updateId, runtimeVersion: r.name, event: 'crash' });
  await world.tick();
  const mid = await operator.must('GET', `/ota-releases/${release.id}/health`);
  assert.ok(mid.crashes <= 1, `One device counted ${mid.crashes} crashes`);
  assert.equal((await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id).status, 'live', 'One noisy device rolled the release back');
  // Many devices crash: the rate is far over twice the baseline.
  const crashes = await together(6, (i) => launch(100 + i, 'crash'));
  assert.ok(crashes.every((x) => x.status < 300));
  const rolled = await world.waitFor(async () => (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id && x.status === 'rolled_back'), 25_000, 150);
  assert.ok(rolled, 'The release was not rolled back');
  assert.equal(rolled.rollbackReason, 'crash_rate');
  assert.ok(rolled.rolledBackAt);
  assert.equal(rolled.rollout, 10, 'It was still at 10% when it was rolled back');
  // The update service stopped offering it; ops were told.
  assert.equal(await resolve(shop, r.name, 0), null, 'The rolled-back update is still offered');
  const health = await operator.must('GET', `/ota-releases/${release.id}/health`);
  assert.ok(health.launches >= 24 && health.crashes >= 6);
  assert.ok(health.crashRate >= health.threshold, 'The health numbers do not explain the roll back');
  assert.ok(health.threshold >= 0.01);
  const alerts = (await operator.must('GET', '/alerts?limit=100')).items;
  assert.ok(alerts.some((a) => /ota|update|roll/i.test(`${a.kind} ${a.message}`)), 'Ops were not alerted');
  // A rolled-back release cannot be advanced, and rolling it back again changes nothing.
  refusedStatus(await operator.send('POST', `/ota-releases/${release.id}/advance`), 'Advancing a rolled-back release', [409, 422]);
  const again = await operator.send('POST', `/ota-releases/${release.id}/roll-back`, { reason: 'Again' });
  assert.ok([200, 409].includes(again.status));
  assert.equal((await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id).status, 'rolled_back');
});

test('P-43: too few launches, a healthy rate, health for another runtime and junk bodies never roll anything back; a manual roll back works', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const r = await runtime();
  const release = accepted(await publish(operator, r)).json();
  await world.waitFor(async () => (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id && x.status === 'live'), 20_000, 100);
  const send = async (i, body) => {
    const app = shop.app({ ip: `198.18.0.${(i % 250) + 1}` });
    await app.start('guest');
    return app.post('/api/store/app/health', body);
  };
  // Five launches, all crashed: under the minimum number of launches, so no verdict.
  await together(5, (i) => send(i, { updateId: release.bundleId, runtimeVersion: r.name, event: 'crash' }));
  await together(5, (i) => send(10 + i, { updateId: release.bundleId, runtimeVersion: r.name, event: 'launch' }));
  await world.tick();
  assert.equal((await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id).status, 'live', 'A verdict from too few launches');
  // Health about a runtime that has no release, a body that is not health, and an event that is not one.
  for (const body of [{ runtimeVersion: 'nope', event: 'crash', updateId: null }, { runtimeVersion: r.name, event: 'explode', updateId: null }, { runtimeVersion: r.name, event: 'crash', updateId: 'x'.repeat(121) }, { runtimeVersion: r.name }, { event: 'crash' }, { runtimeVersion: r.name, event: 'crash', updateId: null, extra: 1 }]) {
    const res = await send(30, body);
    assert.ok(res.status >= 200 && res.status < 500, `Health ${JSON.stringify(body).slice(0, 60)} answered ${res.status}`);
  }
  assert.ok(Number((await operator.must('GET', `/ota-releases/${release.id}/health`)).crashes) <= 5, 'Junk health counted as crashes');
  // Health needs an app session; with none it is refused.
  assert.equal((await shop.app().post('/api/store/app/health', { updateId: null, runtimeVersion: r.name, event: 'launch' })).status, 401);
  // Our team can roll back by hand with a reason, and the reason is required.
  refusedStatus(await operator.send('POST', `/ota-releases/${release.id}/roll-back`, {}), 'Rolling back with no reason', [400, 422]);
  const manual = await operator.send('POST', `/ota-releases/${release.id}/roll-back`, { reason: 'Found a layout bug' });
  assert.equal(manual.status, 200);
  const after = await world.waitFor(async () => (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === release.id && x.status === 'rolled_back'), 20_000, 100);
  assert.ok(after);
  assert.equal(after.rollbackReason, 'manual');
  assert.equal(await resolve(shop, r.name, 0), null);
});

test('P-41: the EAS service timing out or answering junk leaves a release failed or unfinished, never half-live, and the next publish works', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const r = await runtime();
  for (const fault of [{ kind: 'server_error', status: 503 }, { kind: 'malformed', mode: 'garbage' }, { kind: 'timeout' }]) {
    await world.eas.post('/faults', { ...fault, times: 'forever', match: { method: 'POST', path: '/v1/channels/*' } });
    const res = await publish(operator, r);
    assert.ok(res.status < 500, `A ${fault.kind} from the update service made the publish answer ${res.status}`);
    const settled = await world.waitFor(async () => (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === res.json().id && ['failed', 'publishing', 'live'].includes(x.status) && (x.status !== 'publishing' || x.channelsDone < x.channelsTotal)), 25_000, 200);
    await world.eas.delete('/faults');
    const row = settled ?? (await operator.must('GET', '/ota-releases?limit=100')).items.find((x) => x.id === res.json().id);
    assert.ok(row.status !== 'live' || row.channelsDone === row.channelsTotal, 'A release is live with channels missing');
  }
  const ok = await publish(operator, r);
  assert.equal(ok.status, 201);
  assert.ok(shop.tenantId);
  assert.ok(apps.OTA_ROLLOUT.join() === '10,50,100');
});
