// Over-the-air updates (PRD 10.10) under attack: an update that adds a native module, a permission or an SDK change is blocked
// (its native fingerprint is not the runtime's); rollout goes 10, 50, 100 and can neither skip a stage, even when two advances
// race, nor move while a roll back runs; crash reports are counted per release with no personal data, and a flood of fake
// reports from one device can neither trigger nor hide a roll back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { thresholdOf, wilsonLower } from '../../../src/modules/ota/index.js';
import { accepted, addAppShop, operatorOf, refusedStatus, sleep, together, useP6World } from '../spec-p6/kit.js';

const CONFIG = { otaMinLaunches: 20, otaCrashMultiplier: 2, otaCrashFloor: 0.01, otaBaselineCrashRate: 0.005, otaWindowMinutes: 60 };
const world = useP6World({ overrides: CONFIG });
const hash = () => crypto.randomBytes(32).toString('hex');
const key = () => `ota-${crypto.randomUUID().slice(0, 18)}`;
/** A stand-in for the native fingerprint (@expo/fingerprint): a hash of everything native the build links. */
const fingerprintOf = (native) => `fp${crypto.createHash('sha256').update(JSON.stringify(native)).digest('hex').slice(0, 30)}`;
const NATIVE = Object.freeze({ modules: ['expo-camera', 'expo-notifications'], permissions: ['android.permission.CAMERA'], sdk: 58 });
let serial = 0;

async function runtime(native = NATIVE) {
  const name = `7.${++serial}.${crypto.randomInt(1000)}`;
  const fingerprint = fingerprintOf(native);
  await world.sql(`INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, $2, '1.0.0') ON CONFLICT DO NOTHING`, [name, fingerprint]);
  return { name, fingerprint };
}
const publish = (operator, rt, fields = {}) => operator.send('POST', '/ota-releases', { runtimeVersion: rt.name, bundleFingerprint: rt.fingerprint, bundleId: `bundle-${crypto.randomUUID().slice(0, 8)}`, bundleHash: hash(), message: 'Fix', requestKey: key(), ...fields });
const releaseOf = async (operator, id) => (await operator.must('GET', '/ota-releases?limit=100')).items.find((r) => r.id === id);
const liveRelease = async (operator, rt) => {
  const release = accepted(await publish(operator, rt), 'Publishing').json();
  assert.ok(await world.waitFor(async () => ((await releaseOf(operator, release.id))?.status === 'live' ? true : null), 20_000, 100), 'The release never went live');
  return release;
};
const updates = async () => (await world.eas.get('/updates')).updates;

test('an update that adds a native module, a permission or an SDK change is blocked and asks for a store build; nothing reaches the apps', async () => {
  const operator = await operatorOf(world);
  await addAppShop(world, { platforms: ['android'] });
  const rt = await runtime();
  const before = (await updates()).length;
  for (const [what, native] of [
    ['a native module', { ...NATIVE, modules: [...NATIVE.modules, 'react-native-iap'] }],
    ['a permission', { ...NATIVE, permissions: [...NATIVE.permissions, 'android.permission.RECORD_AUDIO'] }],
    ['an SDK change', { ...NATIVE, sdk: 59 }],
  ]) {
    const res = await publish(operator, rt, { bundleFingerprint: fingerprintOf(native) });
    assert.equal(res.status, 409, `${what}: ${res.status}`);
    assert.equal(res.json().error, 'This update changes native code. Start a store build instead.');
  }
  const blocked = (await operator.must('GET', '/ota-releases?limit=100')).items.filter((r) => r.runtimeVersion === rt.name);
  assert.equal(blocked.length, 3);
  assert.ok(blocked.every((r) => r.status === 'blocked' && r.blockReason === 'native_change' && r.channelsTotal === 0));
  assert.equal((await updates()).length, before, 'A blocked update reached the update service');
  const alerts = (await operator.must('GET', '/alerts?limit=100')).items.filter((a) => a.kind === 'ota.native_change');
  assert.ok(alerts.length >= 3 && alerts.every((a) => /store build/.test(a.message)));
  // A blocked request key asked again is still blocked; a changed bundle under a used key is refused.
  const again = await publish(operator, rt, { bundleFingerprint: fingerprintOf({ ...NATIVE, sdk: 59 }), requestKey: 'kept-key-123' });
  assert.equal(again.status, 409);
  assert.equal((await publish(operator, rt, { bundleFingerprint: fingerprintOf({ ...NATIVE, sdk: 59 }), requestKey: 'kept-key-123' })).status, 409);
  // What the console does not take: a rollout or channels of the caller's choosing.
  for (const extra of [{ rollout: 100 }, { channels: ['t1'] }, { status: 'live' }]) refusedStatus(await publish(operator, rt, extra), JSON.stringify(extra), [400]);
  // The same JavaScript on the runtime's own fingerprint publishes.
  assert.equal((await publish(operator, rt)).status, 201);
  // A used request key answers its first release, even with another bundle: that bundle is never published.
  const first = await publish(operator, rt, { requestKey: 'same-key-for-two' });
  assert.equal(first.status, 201);
  const changed = await publish(operator, rt, { requestKey: 'same-key-for-two' });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.json().id, changed.json().bundleId], [first.json().id, first.json().bundleId]);
  assert.equal((await operator.must('GET', '/ota-releases?limit=100')).items.filter((r) => r.runtimeVersion === rt.name && r.status !== 'blocked').length, 2);
});

test('rollout goes 10, 50, 100 only: two advances at once move one stage, and nothing moves during a roll back', async () => {
  const operator = await operatorOf(world);
  await addAppShop(world, { platforms: ['android'] });
  const rt = await runtime();
  const release = await liveRelease(operator, rt);
  const raced = await together(2, () => operator.send('POST', `/ota-releases/${release.id}/advance`));
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409], `Two advances answered ${raced.map((r) => r.status)}`);
  assert.equal((await releaseOf(operator, release.id)).rollout, 50, 'Two advances skipped a stage');
  const channels = (await updates()).filter((u) => u.runtimeVersion === rt.name);
  assert.ok(channels.length >= 1 && channels.every((u) => u.rollout === 50), 'The update service is not at 50%');
  // A roll back in progress: no advance, no new release on the runtime.
  await world.sql(`UPDATE ota_releases SET status = 'rolling_back', rollback_reason = 'manual' WHERE id = $1`, [release.id]);
  const during = await operator.send('POST', `/ota-releases/${release.id}/advance`);
  assert.equal(during.status, 409);
  assert.match(during.json().error, /roll back/);
  assert.equal((await publish(operator, rt)).status, 409, 'A release was published during a roll back');
  // The database itself refuses a skip or a move while not live.
  await assert.rejects(() => world.sql('UPDATE ota_releases SET rollout = 100 WHERE id = $1', [release.id]), /Rollout goes 10, 50, 100/);
  // The worker finishes the roll back; repeating it changes nothing; a rolled back release never advances.
  await world.tick();
  const finished = await world.waitFor(async () => ((await releaseOf(operator, release.id)).status === 'rolled_back' ? true : null), 20_000, 100);
  assert.ok(finished, JSON.stringify(await world.sql(`SELECT queue, status, attempts, last_error FROM jobs WHERE queue LIKE 'ota%' ORDER BY id DESC LIMIT 6`)));
  const first = await releaseOf(operator, release.id);
  const repeat = accepted(await operator.send('POST', `/ota-releases/${release.id}/roll-back`, { reason: 'Again' })).json();
  assert.deepEqual(repeat, first);
  refusedStatus(await operator.send('POST', `/ota-releases/${release.id}/advance`), 'Advancing a rolled back release', [409]);
  assert.ok((await updates()).filter((u) => u.runtimeVersion === rt.name).every((u) => u.rolledBack), 'A channel still offers the rolled back update');
  // A newer release on a runtime replaces the live one.
  const rt2 = await runtime();
  const older = await liveRelease(operator, rt2);
  const newer = await liveRelease(operator, rt2);
  assert.equal((await releaseOf(operator, older.id)).status, 'superseded');
  assert.equal((await releaseOf(operator, newer.id)).status, 'live');
});

test('an advance racing a roll back never reaches the update service after the roll back began', async () => {
  const operator = await operatorOf(world);
  await addAppShop(world, { platforms: ['android'] });
  const rt = await runtime();
  const release = await liveRelease(operator, rt);
  const [advanced, rolled] = await Promise.all([
    operator.send('POST', `/ota-releases/${release.id}/advance`),
    operator.send('POST', `/ota-releases/${release.id}/roll-back`, { reason: 'Raced' }),
  ]);
  assert.ok([200, 409].includes(advanced.status), `The advance answered ${advanced.status}`);
  accepted(rolled, 'The roll back');
  await world.tick();
  const finished = await world.waitFor(async () => ((await releaseOf(operator, release.id)).status === 'rolled_back' ? true : null), 20_000, 100);
  assert.ok(finished, 'The roll back never finished');
  const channels = (await updates()).filter((u) => u.runtimeVersion === rt.name);
  assert.ok(channels.length >= 1 && channels.every((u) => u.rolledBack), 'A channel still offers the rolled back update');
  // Refused: the update service still holds the first stage. Taken: it was taken before the roll back, and the release says so.
  const stage = advanced.status === 200 ? 50 : 10;
  assert.ok(channels.every((u) => u.rollout === stage), `Advance ${advanced.status}, but the update service is at ${channels.map((u) => u.rollout)}`);
  assert.equal((await releaseOf(operator, release.id)).rollout, stage);
});

test('a flood of reports from one device counts once: it neither rolls an update back nor hides a real crash rate; no device data is kept', async () => {
  const operator = await operatorOf(world);
  const shop = await addAppShop(world, { platforms: ['android'] });
  const rt = await runtime();
  const release = await liveRelease(operator, rt);
  const updateId = (await updates()).find((u) => u.runtimeVersion === rt.name && u.channel === `t${shop.tenantId}`).id;
  let ip = 0;
  const device = async () => {
    const app = shop.app({ ip: `198.51.100.${(++ip % 250) + 1}` });
    assert.equal((await app.start('guest')).status, 201);
    return (event, id = updateId) => app.post('/api/store/app/health', { updateId: id, runtimeVersion: rt.name, event });
  };
  const flooder = await device();
  for (let i = 0; i < 60; i++) assert.equal((await flooder('crash')).status, 204);
  for (let i = 0; i < 60; i++) await flooder('launch');
  let health = await operator.must('GET', `/ota-releases/${release.id}/health`);
  assert.deepEqual([health.launches, health.crashes], [1, 1], 'One device counted more than once');
  // Real devices: 25 launches and one crashing device. One crash in the minimum launches is not a verdict.
  const launchers = await together(25, () => device());
  await Promise.all(launchers.map((send) => send('launch')));
  await world.tick();
  await sleep(300);
  await world.tick();
  assert.equal((await releaseOf(operator, release.id)).status, 'live', 'One crash among the launches rolled the update back');
  // The flood cannot hide a real rate: more launches from the flooder change nothing, and eight crashing devices roll it back.
  for (let i = 0; i < 60; i++) await flooder('launch');
  const crashers = await together(8, () => device());
  await Promise.all(crashers.map((send) => send('crash')));
  health = await operator.must('GET', `/ota-releases/${release.id}/health`);
  assert.deepEqual([health.launches, health.crashes], [26, 9]);
  const rolled = await world.waitFor(async () => ((await releaseOf(operator, release.id)).status === 'rolled_back' ? releaseOf(operator, release.id) : null), 25_000, 150);
  assert.ok(rolled, 'A real crash rate was not rolled back');
  assert.equal(rolled.rollbackReason, 'crash_rate');
  const alert = (await operator.must('GET', '/alerts?limit=100')).items.find((a) => a.kind === 'ota.rolled_back' && a.message.includes(`Update ${release.id} `));
  assert.ok(alert, 'Ops were not alerted');
  assert.match(alert.message, /9 crashes in 26 launches/);
  // What is kept: counts per release and hour only; the rate limit's key holds no device id.
  const columns = (await world.sql(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ota_health' ORDER BY ordinal_position`)).map((c) => c.column_name);
  assert.deepEqual(columns, ['release_id', 'hour', 'launches', 'crashes']);
  const sessions = await shop.appSessions();
  const keys = (await world.sql('SELECT key FROM rate_limit_hits')).map((r) => r.key);
  assert.ok(keys.length > 30 && keys.every((k) => /^[0-9a-f]{64}$/.test(k)), 'A rate limit key is not a hash');
  assert.ok(sessions.length > 30 && sessions.every((s) => s.device_id && !keys.some((k) => k.includes(s.device_id))), 'A device id is in the rate limit keys');
  // A report about an update that is not a live release of the runtime counts nothing; junk is refused; no session is a 401.
  const stranger = await device();
  assert.equal((await stranger('crash', 'update-999999')).status, 204);
  assert.equal((await stranger('crash', null)).status, 204);
  const junk = shop.app({ ip: '198.51.100.252' });
  await junk.start('guest');
  assert.equal((await junk.post('/api/store/app/health', { updateId, runtimeVersion: rt.name, event: 'crash', extra: 1 })).status, 400);
  assert.equal((await junk.post('/api/store/app/health', { updateId, runtimeVersion: rt.name, event: 'explode' })).status, 400);
  assert.equal((await shop.app().post('/api/store/app/health', { updateId, runtimeVersion: rt.name, event: 'crash' })).status, 401);
  const after = await operator.must('GET', `/ota-releases/${release.id}/health`);
  assert.deepEqual([after.launches, after.crashes], [26, 9], 'A report that is not one was counted');
});

test('the verdict rule: the 95% lower bound of the crash rate against max(multiplier x baseline, floor)', () => {
  assert.equal(thresholdOf(CONFIG, 0.005), 0.01);
  assert.equal(thresholdOf(CONFIG, 0.02), 0.04);
  assert.equal(thresholdOf(CONFIG, null), 0.01);
  assert.ok(wilsonLower(1, 24) < 0.01, 'One crash in 24 launches would roll back');
  assert.ok(wilsonLower(7, 24) > 0.1);
  assert.ok(wilsonLower(30, 1000) > 0.02 && wilsonLower(30, 1000) < 0.03);
  assert.equal(wilsonLower(0, 0), 0);
  assert.equal(wilsonLower(0, 100), 0);
});
