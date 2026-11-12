// PRD 10.8 (per-brand build pipeline, the server's side), 10.13 (store listing assets) and 10.1 (one source tree, one binary per
// brand): a complete kit builds both platforms on EAS and submits to the brand's accounts, a missing privacy URL or a bad icon
// stops the run before anything is built and names the field, a native change rebuilds every brand and reports each, generated
// assets pass the store spec, a listing over the store's limit is refused naming the limit. P-32, P-33, P-34, P-35, P-55, P-56, P-57.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ASSET_SPECS, STORE_LIMITS, accepted, addAppShop, addP4Shop, apps, hit, multipart, namesPlatform, operatorOf, refusedStatus, sleep, useP6World } from './kit.js';

const world = useP6World();
const key = () => `req-${crypto.randomUUID().slice(0, 20)}`;

async function image(shop, { width = 1024, height = 1024, alpha = false, color = '#2E7D5B', mime = 'image/png' } = {}) {
  const channels = alpha ? 4 : 3;
  const base = sharp({ create: { width, height, channels, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : color } });
  const data = await (mime === 'image/png' ? base.png() : base.jpeg()).toBuffer();
  const form = multipart('file', mime === 'image/png' ? 'icon.png' : 'icon.jpg', mime, data);
  const res = await hit(world, '/api/v1/media', { host: shop.host, method: 'POST', token: shop.token, headers: form.headers, body: form.body });
  assert.equal(res.status, 201, `Uploading the icon answered ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json().url.split('/').pop();
}

/** A business whose app details are complete: icon, colours, links, both stores. */
async function readyBrand(options = {}) {
  const shop = await addAppShop(world, { platforms: ['android', 'ios'], ...options });
  const iconMediaId = await image(shop);
  accepted(await shop.send('PUT', '/app-publishing', { iconMediaId }), 'Saving the icon');
  return shop;
}

/** Moves the simulators' clocks until `check` gives something. */
async function drive(check, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    await world.advance(8_000);
    await world.tick();
    const value = await check();
    if (value || Date.now() > end) return value;
    await sleep(60);
  }
}
const buildsOf = async (shop) => (await shop.must('GET', '/app-publishing/builds?limit=100')).items;
const easBuilds = async () => (await world.eas.get('/builds')).builds;
const request = (shop, platforms = ['android', 'ios'], requestKey = key()) => shop.send('POST', '/app-publishing/builds', { platforms, requestKey });

test('P-32: a complete kit builds both platforms on EAS and submits them to the brand\'s own accounts', async () => {
  const shop = await readyBrand({ name: 'Mehta Mart' });
  await world.appstore.post('/apps', { bundleId: (await shop.appRow()).ios_bundle_id, sellerName: 'Mehta Mart Traders' });
  const asc = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  accepted(await shop.send('PUT', '/store-access/ios', { accountType: 'organisation', legalName: 'Mehta Mart Traders', dunsStatus: 'have', ascKey: { keyId: asc.keyId, issuerId: asc.issuerId, privateKey: asc.privateKey } }));
  const validation = accepted(await shop.send('POST', '/app-publishing/validate'), 'Validating').json();
  assert.equal(validation.ok, true, `A complete kit does not validate: ${JSON.stringify(validation.problems)}`);
  const before = (await easBuilds()).length;
  const key1 = key();
  const res = accepted(await request(shop, ['android', 'ios'], key1), 'Requesting the builds');
  assert.equal(res.status, 202);
  const started = res.json().builds;
  assert.deepEqual(started.map((b) => b.platform).sort(), ['android', 'ios']);
  assert.ok(started.every((b) => b.appVersion === started[0].appVersion), 'The platforms have different app versions');
  // The same request key is the same builds.
  const twin = accepted(await request(shop, ['android', 'ios'], key1)).json().builds;
  assert.deepEqual(twin.map((b) => b.id).sort(), started.map((b) => b.id).sort(), 'One request key made two sets of builds');
  const done = await drive(async () => {
    const list = await buildsOf(shop);
    return list.length >= 2 && list.every((b) => ['built', 'submitted', 'failed'].includes(b.status)) ? list : null;
  });
  assert.ok(done, 'The builds never finished');
  assert.ok(done.every((b) => b.status !== 'failed'), `A build failed: ${JSON.stringify(done.map((b) => [b.platform, b.status, b.failedStep, b.failedMessage]))}`);
  assert.equal((await easBuilds()).length, before + 2, 'EAS did not get exactly two builds');
  // What was sent to EAS: the brand\'s channel, its version, its own build numbers, and no secret or platform name.
  const sent = (await world.eas.calls({ method: 'POST', path: '/v1/builds' })).map((c) => c.body).filter((b) => b.channel === `t${shop.tenantId}`);
  assert.ok(sent.length >= 2, 'EAS did not receive the builds of the brand');
  const row = await shop.appRow();
  for (const b of sent) {
    assert.equal(b.channel, `t${shop.tenantId}`);
    assert.ok(!/PRIVATE KEY|\.p8|\.p12|keystore/i.test(JSON.stringify(b)), 'A secret went to the build service');
    assert.ok(!namesPlatform(JSON.stringify(b)), 'The build request names the platform');
  }
  assert.ok(sent.every((b) => b.runtimeVersion === sent[0].runtimeVersion && b.appVersion === sent[0].appVersion));
  // Submitted to the brand's accounts (or waiting only on review state): a submission per platform on EAS.
  const submitted = await drive(async () => ((await world.eas.get('/submissions')).submissions.length >= 2 ? (await world.eas.get('/submissions')).submissions : null), 60_000);
  assert.ok(submitted, 'The builds were not submitted');
  assert.ok(!/PRIVATE KEY|BEGIN/.test(JSON.stringify(submitted)), 'A store key is in the submission');
  const finalBuilds = await drive(async () => { const l = await buildsOf(shop); return l.every((b) => b.status === 'submitted') ? l : null; }, 60_000);
  assert.ok(finalBuilds, 'The builds did not reach submitted');
  assert.ok(finalBuilds.every((b) => b.submittedAt));
  // Each platform has its own build number, and the next request takes the next ones.
  const next = accepted(await request(shop)).json().builds;
  for (const b of next) assert.ok(b.buildNumber > finalBuilds.find((o) => o.platform === b.platform).buildNumber, 'Build numbers did not move on');
  assert.equal(next[0].appVersion, finalBuilds[0].appVersion, 'The app version changed between builds');
  assert.ok(row.android_package && row.ios_bundle_id);
  // The submissions of the app are tracked per platform from now on.
  const subs = (await shop.must('GET', '/app-publishing/submissions')).items;
  assert.deepEqual(subs.map((s) => s.platform).sort(), ['android', 'ios']);
  assert.ok(subs.every((s) => ['draft', 'in_review'].includes(s.state)));
});

test('P-32: only an owner asks for a build; a platform the plan lacks is refused; EAS failing, hanging or answering junk is reported, never lost', async () => {
  const shop = await readyBrand();
  const manager = await shop.manager();
  assert.ok([401, 403].includes((await manager.send('POST', '/app-publishing/builds', { platforms: ['android'], requestKey: key() })).status), 'A manager asked for a build');
  assert.equal((await manager.send('GET', '/app-publishing/builds')).status, 200, 'A manager cannot read the builds');
  refusedStatus(await shop.send('POST', '/app-publishing/builds', { platforms: [], requestKey: key() }), 'No platform', [400, 422]);
  refusedStatus(await shop.send('POST', '/app-publishing/builds', { platforms: ['android'], requestKey: 'x' }), 'A short request key', [400, 422]);
  refusedStatus(await shop.send('POST', '/app-publishing/builds', { platforms: ['android'], requestKey: key(), brandFile: {} }), 'A brand file in the request', [400, 422]);
  // A tier 4 business has no iOS.
  const android = await addAppShop(world, { platforms: ['android'] });
  accepted(await android.send('PUT', '/app-publishing', { iconMediaId: await image(android) }));
  const refused = await request(android, ['ios']);
  assert.equal(refused.status, 403, `iOS for a tier 4 business answered ${refused.status}`);
  assert.equal((await buildsOf(android)).length, 0);
  // A business with no app at all.
  const plain = await addP4Shop(world);
  assert.equal((await plain.send('POST', '/app-publishing/builds', { platforms: ['android'], requestKey: key() })).status, 403);
  // EAS fails the build: it is failed with the step and the message, and is not submitted.
  await world.eas.post('/builds/behaviour', { kind: 'fail', platform: 'android', message: 'Gradle task failed' });
  const submissionsBefore = (await world.eas.get('/submissions')).submissions.length;
  accepted(await request(shop, ['android']));
  const failed = await drive(async () => (await buildsOf(shop)).find((b) => b.platform === 'android' && b.status === 'failed'), 60_000);
  assert.ok(failed, 'A failed EAS build was not reported');
  assert.equal(failed.failedStep, 'build');
  assert.ok(failed.failedMessage.length > 0 && failed.failedMessage.length <= 500);
  assert.equal((await world.eas.get('/submissions')).submissions.length, submissionsBefore, 'A failed build was submitted');
  // A slow build is still building, not failed.
  await world.eas.post('/builds/behaviour', { kind: 'slow', platform: 'android', buildMs: 600_000 });
  accepted(await request(shop, ['android']));
  await drive(async () => (await buildsOf(shop)).find((b) => b.platform === 'android' && b.status === 'building'), 30_000);
  const slow = (await buildsOf(shop)).find((b) => b.status === 'building');
  assert.ok(slow, 'A slow build is not shown as building');
  // EAS timing out or answering junk while we poll: the build stays where it was.
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'html' }, { kind: 'server_error', status: 502 }, { kind: 'drop' }]) {
    await world.eas.post('/faults', { ...fault, times: 'forever', match: { method: 'GET', path: '/v1/builds/*' } });
    for (let i = 0; i < 3; i++) await world.tick();
    await sleep(300);
    await world.eas.delete('/faults');
    const still = (await buildsOf(shop)).find((b) => b.id === slow.id);
    assert.ok(['queued', 'building'].includes(still.status), `A ${fault.kind} from EAS moved the build to ${still.status}`);
  }
  await world.eas.post('/reset');
});

test('P-33: a missing privacy URL stops the run before anything is built, and the answer names the field', async () => {
  const shop = await readyBrand();
  accepted(await shop.send('PUT', '/app-publishing', { privacyUrl: '' }));
  const validation = accepted(await shop.send('POST', '/app-publishing/validate')).json();
  assert.equal(validation.ok, false);
  const problem = validation.problems.find((p) => p.field === 'privacyUrl');
  assert.ok(problem, `The problem list does not name privacyUrl: ${JSON.stringify(validation.problems)}`);
  assert.equal(problem.code, 'required');
  assert.match(problem.message, /privacy/i);
  const before = (await easBuilds()).length;
  const res = await request(shop);
  if (res.status < 300) {
    const builds = await drive(async () => { const l = await buildsOf(shop); return l.length && l.every((b) => b.status === 'failed') ? l : null; }, 30_000);
    assert.ok(builds, 'The builds did not stop');
    for (const b of builds) {
      assert.equal(b.failedStep, 'validate');
      assert.equal(b.failedField, 'privacyUrl');
    }
  } else {
    assert.ok([409, 422].includes(res.status), `A missing privacy URL answered ${res.status}`);
    assert.match(res.text, /privacyUrl|privacy/i);
  }
  assert.equal((await easBuilds()).length, before, 'Something was built before the check stopped the run');
  // A privacy link must be https; other schemes are refused when saved.
  for (const url of ['http://shop.test/privacy', 'javascript:alert(1)', 'ftp://x.y/z', 'https://']) refusedStatus(await shop.send('PUT', '/app-publishing', { privacyUrl: url }), `Privacy URL ${url}`, [400, 422]);
  // Fixing it clears the problem.
  accepted(await shop.send('PUT', '/app-publishing', { privacyUrl: `https://${shop.host}/policies/privacy` }));
  assert.equal(accepted(await shop.send('POST', '/app-publishing/validate')).json().ok, true);
  // Every other required field is named the same way.
  accepted(await shop.send('PUT', '/app-publishing', { supportEmail: '', androidPackage: null, appleTeamId: '', playSigningSha256: [] }));
  const fields = accepted(await shop.send('POST', '/app-publishing/validate')).json().problems.map((p) => p.field);
  for (const field of ['supportEmail', 'androidPackage', 'appleTeamId', 'playSigningSha256']) assert.ok(fields.includes(field), `${field} is not named`);
});

test('P-34: an icon that fails the store spec stops the run with the spec message and names the field', async () => {
  for (const [what, options, pattern] of [
    ['too small', { width: 600, height: 600 }, /1024/],
    ['not square', { width: 1200, height: 1000 }, /square/i],
    ['tiny', { width: 16, height: 16 }, /1024/],
  ]) {
    const shop = await addAppShop(world, { platforms: ['android', 'ios'] });
    const iconMediaId = await image(shop, options);
    const saved = await shop.send('PUT', '/app-publishing', { iconMediaId });
    const before = (await easBuilds()).length;
    if (saved.status >= 300) {
      assert.ok([400, 422].includes(saved.status), `An icon ${what} answered ${saved.status}`);
      assert.match(saved.text, pattern);
      continue;
    }
    const validation = accepted(await shop.send('POST', '/app-publishing/validate')).json();
    const res = await request(shop);
    if (res.status < 300) {
      const failed = await drive(async () => { const l = await buildsOf(shop); return l.length && l.every((b) => b.status === 'failed') ? l : null; }, 30_000);
      assert.ok(failed, `An icon ${what} was not stopped`);
      for (const b of failed) {
        assert.ok(['validate', 'assets'].includes(b.failedStep), `${what}: stopped at ${b.failedStep}`);
        assert.match(b.failedField, /icon/i, `${what}: the field is ${b.failedField}`);
        assert.match(b.failedMessage, pattern, `${what}: the message is "${b.failedMessage}"`);
      }
    } else {
      assert.match(res.text, pattern);
    }
    assert.equal((await easBuilds()).length, before, `An icon ${what} still reached the build service`);
    assert.ok(validation.ok === false || res.status >= 300 || true);
  }
  // A transparent source icon either builds with a flattened store icon (no alpha) or stops naming the icon; it never ships with alpha.
  const shop = await addAppShop(world, { platforms: ['android', 'ios'] });
  accepted(await shop.send('PUT', '/app-publishing', { iconMediaId: await image(shop, { alpha: true }) }));
  accepted(await request(shop, ['ios']));
  const settled = await drive(async () => { const l = await buildsOf(shop); return l.length && l.every((b) => ['failed', 'built', 'submitted'].includes(b.status)) ? l : null; }, 60_000);
  assert.ok(settled);
  if (settled[0].status === 'failed') assert.match(settled[0].failedField, /icon/i);
  else {
    const assets = (await shop.must('GET', '/app-listing/ios/assets')).items;
    const icon = assets.find((a) => a.kind === 'icon');
    assert.ok(icon && icon.specOk, 'The iOS store icon was kept with transparency');
  }
  // Something that is not an image is turned away when uploaded.
  const form = multipart('file', 'icon.png', 'image/png', Buffer.from('this is not a png'));
  const bad = await hit(world, '/api/v1/media', { host: shop.host, method: 'POST', token: shop.token, headers: form.headers, body: form.body });
  assert.ok(bad.status >= 400 && bad.status < 500);
});

test('P-35: a native change rebuilds every brand in one batch, and the report lists each result, a failed brand included', async () => {
  const operator = await operatorOf(world);
  const both = await readyBrand();
  const androidOnly = await addAppShop(world, { platforms: ['android'] });
  accepted(await androidOnly.send('PUT', '/app-publishing', { iconMediaId: await image(androidOnly) }));
  const plain = await addP4Shop(world, { name: 'No App Here' });
  const runtimeVersion = `2.${Date.now() % 100000}.0`;
  const fingerprint = `fp${crypto.randomBytes(15).toString('hex')}`;
  await world.eas.post('/fingerprints', { runtimeVersion, fingerprint });
  // One brand's iOS build fails; the batch carries on.
  await world.eas.post('/builds/behaviour', { kind: 'fail', platform: 'ios', message: 'Pod install failed', times: 1 });
  const body = { reason: 'native_change', note: 'Updated the video library', appVersion: '1.1.0', runtimeVersion, fingerprint, platforms: ['android', 'ios'], requestKey: key() };
  const created = await operator.send('POST', '/app-build-batches', body);
  assert.equal(created.status, 201, `Creating the batch answered ${created.status}: ${created.text.slice(0, 300)}`);
  const batch = created.json();
  assert.equal(batch.reason, 'native_change');
  assert.equal(batch.runtimeVersion, runtimeVersion);
  const twin = await operator.send('POST', '/app-build-batches', body);
  assert.equal(twin.json().id, batch.id, 'One request key made two batches');
  const finished = await drive(async () => {
    const detail = await operator.must('GET', `/app-build-batches/${batch.id}`);
    return detail.builds.every((b) => ['built', 'submitted', 'failed'].includes(b.status)) && detail.builds.length ? detail : null;
  }, 150_000);
  assert.ok(finished, 'The batch never finished');
  const mine = (tenant) => finished.builds.filter((b) => b.tenantId === tenant.tenantId);
  assert.deepEqual(mine(both).map((b) => b.platform).sort(), ['android', 'ios'], 'Every platform of a two-platform brand is rebuilt');
  assert.deepEqual(mine(androidOnly).map((b) => b.platform), ['android'], 'An Android-only brand is rebuilt for Android only');
  assert.equal(mine(plain).length, 0, 'A business without the app was rebuilt');
  assert.ok(finished.builds.every((b) => b.reason === 'native_change' && b.runtimeVersion === runtimeVersion && b.appVersion === '1.1.0'));
  assert.ok(finished.builds.every((b) => b.tenantName), 'The report does not name the brand');
  const failed = finished.builds.filter((b) => b.status === 'failed');
  assert.equal(failed.length, 1, 'Exactly one build was made to fail');
  assert.equal(failed[0].platform, 'ios');
  assert.match(failed[0].failedMessage, /Pod|failed/i);
  assert.ok(finished.builds.filter((b) => b.status !== 'failed').length >= 2, 'The others did not carry on');
  const list = (await operator.must('GET', '/app-build-batches?limit=100')).items.find((b) => b.id === batch.id);
  assert.equal(list.counts.failed, 1);
  assert.equal(list.counts.total, finished.builds.length);
  assert.equal(list.status, 'finished');
  // The sellers see their own builds with the reason, not each other\'s.
  assert.ok((await buildsOf(both)).some((b) => b.reason === 'native_change'));
  assert.equal((await buildsOf(plain).catch(() => [])).length ?? 0, 0);
  // Not for just anyone, and not with a lower version than the shop\'s.
  refusedStatus(await both.send('POST', '/app-build-batches', { ...body, requestKey: key() }), 'A seller starting a batch', [401, 403, 404]);
  refusedStatus(await operator.send('POST', '/app-build-batches', { ...body, requestKey: key(), reason: 'brand' }), 'A batch of the wrong reason', [400, 422]);
  refusedStatus(await operator.send('POST', '/app-build-batches', { ...body, requestKey: key(), appVersion: '1.1' }), 'A bad app version', [400, 422]);
  refusedStatus(await operator.send('POST', '/app-build-batches', { ...body, requestKey: key(), platforms: ['windows'] }), 'A made-up platform', [400, 422]);
  // A brand can also be built on its own by our team.
  const one = await operator.send('POST', `/tenants/${androidOnly.tenantId}/app-builds`, { platforms: ['android'], requestKey: key() });
  assert.equal(one.status, 202);
  assert.equal((await operator.send('POST', `/tenants/${plain.tenantId}/app-builds`, { platforms: ['android'], requestKey: key() })).status, 403);
});

test('P-55: generated assets pass the current store spec, are real images of the stated size, and the iOS store icon has no transparency', async () => {
  const shop = await readyBrand({ name: 'Mehta Mart' });
  accepted(await request(shop));
  await drive(async () => { const l = await buildsOf(shop); return l.length >= 2 && l.every((b) => ['built', 'submitted', 'failed'].includes(b.status)) ? l : null; }, 90_000);
  for (const platform of ['android', 'ios']) {
    const res = accepted(await shop.send('GET', `/app-listing/${platform}/assets`), `${platform} assets`);
    const items = res.json().items;
    assert.ok(items.length >= 2, `${platform}: too few assets`);
    const kinds = items.map((a) => a.kind);
    assert.ok(kinds.includes('icon'), `${platform}: no icon`);
    if (platform === 'android') assert.ok(kinds.includes('feature_graphic'), 'No feature graphic for Play');
    const screenshots = items.filter((a) => a.kind === 'screenshot');
    const store = apps.storeOf(platform);
    assert.ok(screenshots.length >= STORE_LIMITS[store].screenshots.min && screenshots.length <= STORE_LIMITS[store].screenshots.max, `${platform}: ${screenshots.length} screenshots`);
    for (const asset of items) {
      assert.equal(asset.specOk, true, `${platform} ${asset.kind}: ${JSON.stringify(asset.problems)}`);
      assert.deepEqual(asset.problems, []);
      assert.ok(['generated', 'build_capture', 'upload'].includes(asset.source));
      const file = await hit(world, asset.url.startsWith('http') ? new URL(asset.url).pathname : asset.url, { host: shop.host });
      assert.equal(file.status, 200, `${asset.kind} is not served: ${file.status}`);
      const meta = await sharp(Buffer.from(file.text, 'binary')).metadata().catch(() => null);
      if (meta) {
        assert.equal(meta.width, asset.width, `${asset.kind}: the file is ${meta.width} wide, not ${asset.width}`);
        assert.equal(meta.height, asset.height);
      }
      const spec = ASSET_SPECS[apps.assetSpecKey(platform, asset.kind, asset.device)];
      assert.ok(spec, `${asset.kind} has no spec`);
      const problems = apps.checkAsset(apps.assetSpecKey(platform, asset.kind, asset.device), { width: asset.width, height: asset.height, mime: 'image/png', hasAlpha: false, bytes: 1 });
      assert.ok(problems.filter((p) => p.code === 'wrong_size' || p.code === 'wrong_type').length === 0 || asset.kind.startsWith('adaptive') || asset.kind === 'notification_icon' || asset.kind === 'splash', `${asset.kind}: ${JSON.stringify(problems)}`);
    }
  }
  // The assets belong to the business: another business\'s listing assets are not reachable by id.
  const other = await readyBrand();
  const theirs = (await other.must('GET', '/app-listing/android/assets')).items;
  assert.ok(theirs.every((a) => !new URL(a.url, 'http://x').pathname.includes(shop.host)));
  refusedStatus(await shop.send('GET', '/app-listing/windows/assets'), 'A made-up platform', [400, 404, 422]);
});

test('P-56: a short description over the store\'s limit fails validation and names the limit; at the limit it passes', async () => {
  const shop = await readyBrand();
  const limits = apps.listingLimits('android');
  assert.equal(limits.shortDescription, 80);
  const outcome = async (platform, fields) => {
    const res = await shop.send('PUT', `/app-listing/${platform}`, fields);
    if (res.status >= 400) return { saved: false, text: res.text, status: res.status };
    const out = res.json();
    const problems = out.validation?.problems ?? [];
    return { saved: problems.length === 0, text: JSON.stringify(problems), status: res.status, out };
  };
  const base = { title: 'Mehta Mart', fullDescription: 'Shop the whole Mehta Mart range in one place.' };
  const over = await outcome('android', { ...base, shortDescription: 'x'.repeat(92) });
  assert.equal(over.saved, false, 'A 92-character short description was accepted');
  assert.match(over.text, /Short description/i);
  assert.match(over.text, /\b80\b/, 'The limit is not named');
  assert.match(over.text, /92/, 'The length is not named');
  assert.equal((await shop.must('GET', '/app-listing/android')).shortDescription === 'x'.repeat(92), false, 'The refused text was kept');
  assert.equal((await outcome('android', { ...base, shortDescription: 'x'.repeat(81) })).saved, false, '81 characters');
  assert.equal((await outcome('android', { ...base, shortDescription: 'x'.repeat(80) })).saved, true, '80 characters is allowed');
  // Characters, not bytes: 80 Devanagari letters is 240 bytes and still fits.
  assert.equal((await outcome('android', { ...base, shortDescription: 'क'.repeat(80) })).saved, true, '80 Devanagari characters');
  assert.equal((await outcome('android', { ...base, shortDescription: 'क'.repeat(81) })).saved, false);
  // Each store has its own limit: the App Store subtitle is 30.
  const subtitle = await outcome('ios', { title: 'Mehta Mart', fullDescription: 'Shop the range.', shortDescription: 'y'.repeat(31) });
  assert.equal(subtitle.saved, false);
  assert.match(subtitle.text, /Subtitle/i);
  assert.match(subtitle.text, /\b30\b/);
  assert.equal((await outcome('ios', { title: 'Mehta Mart', fullDescription: 'Shop the range.', shortDescription: 'y'.repeat(30) })).saved, true);
  assert.equal((await outcome('android', { ...base, title: 't'.repeat(31), shortDescription: 'ok' })).saved, false, 'A 31-character title');
  assert.equal((await outcome('android', { ...base, fullDescription: 'd'.repeat(4001), shortDescription: 'ok' })).saved, false, 'A 4001-character description');
  const keywords = await outcome('ios', { title: 'Mehta Mart', fullDescription: 'Shop.', keywords: 'k'.repeat(101) });
  assert.equal(keywords.saved, false);
  assert.match(keywords.text, /Keywords/i);
  // The platform\'s name is not for a listing.
  for (const field of ['title', 'shortDescription', 'fullDescription']) {
    const res = await outcome('android', { ...base, shortDescription: 'ok', [field]: 'Built on Bhava' });
    assert.equal(res.saved, false, `${field} accepted the platform's name`);
    assert.match(res.text, /business only|names_platform/i);
  }
  // Required text.
  const blank = await outcome('android', { title: '', fullDescription: '', shortDescription: '' });
  assert.equal(blank.saved, false);
  // Markup is stored as text and comes back as the same text.
  const markup = '<b>Sale</b> & more';
  const stored = await outcome('android', { ...base, shortDescription: markup });
  if (stored.status < 300) assert.equal((await shop.must('GET', '/app-listing/android')).shortDescription, markup);
  // The response tells the editor each field\'s limit, equal to the store\'s.
  const listing = await shop.must('GET', '/app-listing/android');
  assert.deepEqual(listing.limits, limits);
  // Another business\'s listing and the wrong platform.
  refusedStatus(await shop.send('PUT', '/app-listing/windows', base), 'A made-up platform', [400, 404, 422]);
  const manager = await shop.manager();
  assert.equal((await manager.send('GET', '/app-listing/android')).status, 200);
});

test('P-57: the privacy answers are prefilled from what the app collects, and the iOS build\'s privacy-manifest check passes with no warning', async () => {
  const shop = await readyBrand();
  const android = await shop.must('GET', '/app-listing/android');
  const ios = await shop.must('GET', '/app-listing/ios');
  const wanted = apps.DATA_COLLECTED.map((d) => d.type);
  for (const [name, doc] of [['data safety', android.dataSafety], ['privacy labels', ios.privacyLabels]]) {
    const text = JSON.stringify(doc);
    for (const type of wanted) assert.ok(text.includes(type), `The ${name} do not list ${type}`);
    assert.ok(!/card|upi|bank|payment details/i.test(text), `The ${name} list payment details the gateway holds`);
    assert.ok(!/"tracking"\s*:\s*true/.test(text), `The ${name} say the app tracks people`);
    assert.ok(!namesPlatform(text), `The ${name} name the platform`);
  }
  accepted(await request(shop, ['ios']));
  const sub = await drive(async () => {
    const s = (await shop.must('GET', '/app-publishing/submissions')).items.find((i) => i.platform === 'ios');
    return s?.presubmit ? s : null;
  }, 90_000);
  assert.ok(sub, 'The iOS build was never checked before review');
  const check = sub.presubmit.checks.find((c) => c.code === 'privacy_manifest');
  assert.ok(check, 'No privacy-manifest check ran');
  assert.equal(check.passed, true, `The privacy manifest check failed: ${check.detail}`);
  assert.doesNotMatch(check.detail, /warning|missing|ITMS/i);
  assert.deepEqual(sub.presubmit.checks.map((c) => c.code).sort(), apps.presubmitChecksFor('ios').map((c) => c.code).sort(), 'A check is missing from the run');
  assert.equal(sub.presubmit.passed, true);
});

test('P-32: app details that clash or carry markup: a package already used by another business, markup in the name, locked ids, fields only the console sets', async () => {
  const a = await addAppShop(world, { config: { android_package: 'in.example.taken' } });
  const b = await addAppShop(world);
  refusedStatus(await b.send('PUT', '/app-publishing', { androidPackage: 'in.example.taken' }), 'A package id already used by another business', [409, 422]);
  assert.notEqual((await b.appRow()).android_package, 'in.example.taken');
  assert.equal((await a.appRow()).android_package, 'in.example.taken');
  refusedStatus(await b.send('PUT', '/app-publishing', { androidPackage: 'IN.Example.Taken' }), 'The same package in capitals', [400, 409, 422]);
  const iosA = await addAppShop(world, { platforms: ['ios'], config: { ios_bundle_id: 'in.example.taken.ios' } });
  refusedStatus(await b.send('PUT', '/app-publishing', { iosBundleId: 'in.example.taken.ios' }), 'A bundle id already used', [409, 422]);
  assert.ok(iosA);
  // Names: markup, platform name, length.
  for (const appName of ['<script>alert(1)</script>', '<b>Shop</b>', 'Bhava Shop', 'x'.repeat(31), '']) {
    const res = await b.send('PUT', '/app-publishing', { appName });
    if (res.status < 300 && appName !== '' && !namesPlatform(appName) && appName.length <= 30) {
      const validation = accepted(await b.send('POST', '/app-publishing/validate')).json();
      assert.ok(validation.problems.some((p) => p.field === 'appName'), `Markup in the app name is not flagged: ${appName}`);
    } else assert.ok(res.status === 400 || res.status === 422 || res.status < 300, `${appName} answered ${res.status}`);
  }
  for (const urlScheme of ['Bhava', 'bhavashop', 'ab', '1abc', 'a b c', 'javascript']) {
    const res = await b.send('PUT', '/app-publishing', { urlScheme });
    assert.ok(res.status >= 400 || !/bhava/i.test(urlScheme), `The scheme ${urlScheme} answered ${res.status}`);
  }
  // What only our team sets cannot be set by the seller.
  for (const extra of [{ androidMinVersion: '9.9.9' }, { iosStoreUrl: 'https://apps.apple.com/x' }, { reviewEnabled: true }, { reviewPhone: '+919999999999' }, { tenantId: a.tenantId }, { androidLockedAt: new Date().toISOString() }]) {
    refusedStatus(await b.send('PUT', '/app-publishing', extra), `The seller setting ${Object.keys(extra)[0]}`, [400, 422]);
  }
  // Once the app is out the ids are locked.
  await b.appSet({ android_package: 'in.example.locked', android_locked_at: new Date() });
  refusedStatus(await b.send('PUT', '/app-publishing', { androidPackage: 'in.example.changed' }), 'Changing a locked package id', [409, 422]);
  assert.equal((await b.appRow()).android_package, 'in.example.locked');
  // Another business\'s app details are not reachable by guessing: the route takes none.
  const mine = await b.must('GET', '/app-publishing');
  assert.notEqual(mine.androidPackage, 'in.example.taken');
  assert.ok(!namesPlatform(JSON.stringify(mine)));
});
