import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '../../../src/tenancy.js';
import { brand, key, plainBusiness, startWorld } from './support.js';

// A native change rebuilds every brand (PRD 10.8, P-35): one batch, a build for every platform each brand's plan allows, on the
// new runtime and app version, each brand reported on its own; a brand that fails, at its details or on the build service,
// never stops the others. Our team only.

let w;
before(async () => {
  w = await startWorld();
});
after(async () => {
  await w?.close();
});

const runtime = () => `2.${crypto.randomInt(1, 99_999)}.0`;

/** Builds the brand's Android app once, to submitted, on the current runtime. */
async function shipped(b, service) {
  const [x] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  await b.run(() => service.run(x.id));
  const done = await w.drive(service, async () => ((await b.builds()).every((r) => r.status === 'submitted') ? true : null));
  assert.ok(done, 'The first build did not ship');
}
const fingerprint = () => `fp${crypto.randomBytes(15).toString('hex')}`;

test('P-35: every brand is rebuilt in one batch and the report lists each result; a failed brand does not stop the others', async () => {
  const both = await brand(w, { platforms: ['android', 'ios'], name: 'Both Stores' });
  const androidOnly = await brand(w, { platforms: ['android'], name: 'Android Only' });
  await w.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, 'app.ios', false) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = false`, [androidOnly.tenant.id]);
  // Broken Kit shipped an app once, then lost its privacy link; Half Done never finished its details and never built.
  const broken = await brand(w, { platforms: ['android'], name: 'Broken Kit' });
  const service = w.builds();
  await shipped(broken, service);
  await broken.set({ privacy_url: '' });
  const halfDone = await brand(w, { platforms: ['android'], name: 'Half Done', icon: false });
  const plain = await plainBusiness(w);
  await w.eas.post('/builds/behaviour', { kind: 'fail', platform: 'ios', message: 'Pod install failed.', times: 1 });
  const rt = runtime();
  const body = { reason: 'native_change', note: 'Updated the video library', appVersion: '1.1.0', runtimeVersion: rt, fingerprint: fingerprint(), platforms: ['android', 'ios'], requestKey: key() };

  const created = await w.console('POST', '/app-build-batches', body);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.reason, 'native_change');
  assert.equal(created.body.runtimeVersion, rt);
  const twin = await w.console('POST', '/app-build-batches', body);
  assert.equal(twin.body.id, created.body.id, 'One request key made two batches');

  // The queue's handlers, as the worker would run them, then the poll until every build has settled.
  const queued = await w.sql(`SELECT id, tenant_id FROM app_builds WHERE batch_id = $1 AND status = 'queued'`, [created.body.id]);
  assert.ok(queued.length >= 4, 'Both Stores twice, Android Only and Broken Kit once each are queued');
  for (const q of await w.sql(`SELECT id, tenant_id FROM app_builds WHERE batch_id = $1 AND status = 'queued'`, [created.body.id])) {
    await withTenant(Number(q.tenant_id), () => service.run(q.id));
  }
  const detail = await w.drive(service, async () => {
    const d = (await w.console('GET', `/app-build-batches/${created.body.id}`)).body;
    return d.builds.length && d.builds.every((b) => ['built', 'submitted', 'failed'].includes(b.status)) ? d : null;
  });
  assert.ok(detail, 'The batch never settled');
  const mine = (b) => detail.builds.filter((x) => x.tenantId === b.tenant.id);
  assert.deepEqual(mine(both).map((x) => x.platform).sort(), ['android', 'ios']);
  assert.deepEqual(mine(androidOnly).map((x) => x.platform), ['android'], 'An Android-only plan was rebuilt for iOS');
  assert.equal(mine(plain).length, 0, 'A business without the app was rebuilt');
  assert.equal(mine(halfDone).length, 0, 'A brand still being set up was rebuilt');
  assert.ok(detail.builds.every((x) => x.reason === 'native_change' && x.runtimeVersion === rt && x.appVersion === '1.1.0'));
  assert.ok(detail.builds.every((x) => x.tenantName), 'The report does not name each brand');
  const [brokenBuild] = mine(broken);
  assert.equal(brokenBuild.status, 'failed');
  assert.equal(brokenBuild.failedStep, 'validate');
  assert.equal(brokenBuild.failedField, 'privacyUrl');
  const easFailed = detail.builds.filter((x) => x.status === 'failed' && x.failedStep === 'build');
  assert.equal(easFailed.length, 1, 'Exactly one build failed on the build service');
  assert.equal(easFailed[0].platform, 'ios');
  assert.match(easFailed[0].failedMessage, /Pod install/);
  assert.ok(mine(androidOnly).every((x) => x.status === 'submitted'), 'The others did not carry on');
  // The list shows the batch finished, with its counts.
  await service.poll();
  const listed = (await w.console('GET', '/app-build-batches?limit=100')).body.items.find((b) => b.id === created.body.id);
  assert.equal(listed.status, 'finished');
  assert.equal(listed.counts.total, detail.builds.length);
  assert.equal(listed.counts.failed, detail.builds.filter((x) => x.status === 'failed').length);
  // Sellers see their own builds with the reason, and every brand's next build is on the new version.
  const [next] = await both.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  assert.equal(next.appVersion, '1.1.0');
  assert.equal(next.runtimeVersion, rt);
});

test('a batch is our team\'s only, never goes back a version, never reuses a runtime for other native code, and checks its input', async () => {
  const rt = runtime();
  const fp = fingerprint();
  const body = { reason: 'native_change', note: 'A native fix', appVersion: '1.2.0', runtimeVersion: rt, fingerprint: fp, platforms: ['android'], requestKey: key() };
  assert.equal((await w.console('POST', '/app-build-batches', body)).status, 201);
  assert.equal((await w.console('POST', '/app-build-batches', { ...body, requestKey: key(), appVersion: '1.0.5', runtimeVersion: runtime() })).status, 409, 'A lower app version');
  assert.equal((await w.console('POST', '/app-build-batches', { ...body, requestKey: key(), fingerprint: fingerprint() })).status, 409, 'The same runtime with other native code');
  for (const bad of [{ reason: 'brand' }, { appVersion: '1.2' }, { platforms: ['windows'] }, { requestKey: 'x' }, { fingerprint: 'short' }]) {
    assert.equal((await w.console('POST', '/app-build-batches', { ...body, requestKey: key(), ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await w.api('POST', '/app-build-batches', { ...body, requestKey: key() })).status, 404, 'A seller reached the batch route');
  assert.equal((await w.console('GET', '/app-build-batches/999999')).status, 404);
  // A brand with a build still running is reported in the batch, not skipped.
  const busy = await brand(w, { platforms: ['android'] });
  const service = w.builds();
  await busy.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  const made = await w.console('POST', '/app-build-batches', { ...body, requestKey: key(), appVersion: '1.2.1', runtimeVersion: runtime(), fingerprint: fingerprint() });
  assert.equal(made.status, 201, made.text);
  const detail = (await w.console('GET', `/app-build-batches/${made.body.id}`)).body;
  const reported = detail.builds.find((x) => x.tenantId === busy.tenant.id);
  assert.equal(reported.status, 'failed');
  assert.match(reported.failedMessage, /still running/);
});
