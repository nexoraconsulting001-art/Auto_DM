import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BrandFile, namesPlatform } from '../../../src/contracts/apps.js';
import { AppConfigProblem, appConfigFor } from '../../../src/modules/app-config/index.js';
import { TEST_SIGNING_SHA256 } from '../../helpers.js';
import { brand, plainBusiness, png, startWorld } from './support.js';

// The app details in the brand kit and their checks (PRD 10.7, 10.8): what a seller may save, what stops a build and names its
// field (P-33, P-34), the ids that are one business's alone and locked once submitted, and the brand file made from them.

let w;
before(async () => {
  w = await startWorld();
});
after(async () => {
  await w?.close();
});

const save = (body) => w.api('PUT', '/app-publishing', body);
const validate = () => w.api('POST', '/app-publishing/validate');
const upload = async (buffer, mime = 'image/png', b = w.main) => b.run(() => w.ctx.repos.media.save(buffer, mime));

test('the owner reads and saves the app details; the answer is the row over the brand kit and names no platform', async () => {
  const res = await save({ appName: 'Kesar Kitchen', shortName: 'Kesar', colors: { primary: '#7A1F3D' }, supportEmail: 'help@kesar.example' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.appName, 'Kesar Kitchen');
  assert.equal(res.body.colors.primary, '#7A1F3D');
  assert.deepEqual(res.body.colorOverrides, { primary: '#7A1F3D' });
  assert.equal(res.body.validation, null, 'A save clears the last check');
  assert.equal(res.body.android.entitled, true);
  assert.ok(!namesPlatform(JSON.stringify(res.body)));
  const got = await w.api('GET', '/app-publishing');
  assert.equal(got.status, 200);
  assert.equal(got.body.shortName, 'Kesar');
  const [audit] = await w.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'app.config_saved' ORDER BY id DESC LIMIT 1`, [w.main.tenant.id]);
  assert.deepEqual(audit.details.fields.sort(), ['appName', 'colors', 'shortName', 'supportEmail']);
  assert.ok(!JSON.stringify(audit.details).includes('help@kesar.example'), 'The audit row holds values');
});

test('P-33: validation names every missing field, privacy URL first among them, and fixing it clears the problem', async () => {
  assert.equal((await save({ privacyUrl: '' })).status, 200);
  const res = await validate();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  const privacy = res.body.problems.find((p) => p.field === 'privacyUrl');
  assert.equal(privacy.code, 'required');
  assert.match(privacy.message, /privacy/i);
  const [row] = await w.sql('SELECT validation FROM app_configs WHERE tenant_id = $1', [w.main.tenant.id]);
  assert.equal(row.validation.ok, false, 'The answer is stored');
  assert.equal((await save({ privacyUrl: `https://${w.main.host}/policies/privacy` })).status, 200);
  assert.equal((await validate()).body.ok, true, JSON.stringify((await validate()).body.problems));
  // Every other field is named the same way, with its platform.
  assert.equal((await save({ supportEmail: '', androidPackage: null, appleTeamId: '', playSigningSha256: [] })).status, 200);
  const fields = (await validate()).body.problems.map((p) => `${p.field}:${p.platform ?? ''}`);
  for (const f of ['supportEmail:', 'androidPackage:android', 'appleTeamId:ios', 'playSigningSha256:android']) assert.ok(fields.includes(f), `${f} is not named: ${fields}`);
  // A shop domain that is not the business's own.
  assert.equal((await save({ shopDomain: 'someone-else.example' })).status, 200);
  assert.ok((await validate()).body.problems.some((p) => p.field === 'shopDomain' && p.code === 'not_own_host'));
  await w.main.set({ support_email: 'help@seller.example', android_package: `com.example.main${w.main.tenant.id}`, apple_team_id: 'ABCDE12345', play_signing_sha256: [TEST_SIGNING_SHA256], shop_domain: w.main.host });
  assert.equal((await validate()).body.ok, true, JSON.stringify((await validate()).body.problems));
});

test('a save with markup, hidden characters, the platform name, a reserved link name or a field only our team sets is refused naming it', async () => {
  const before = await w.main.row();
  const cases = [
    [{ appName: '<script>alert(1)</script>' }, 'appName'],
    [{ appName: 'Kesar\u0000Kitchen' }, 'appName'],
    [{ shortName: 'Kes\ud800ar' }, 'shortName'],
    [{ appName: 'Bhava Shop' }, 'appName'],
    [{ supportEmail: 'help@bhava.example' }, 'supportEmail'],
    [{ urlScheme: 'javascript' }, 'urlScheme'],
    [{ urlScheme: 'bhavashop' }, 'urlScheme'],
    [{ privacyUrl: 'http://shop.example/privacy' }, 'privacyUrl'],
    [{ privacyUrl: 'javascript:alert(1)' }, 'privacyUrl'],
    [{ privacyUrl: 'https://' }, 'privacyUrl'],
    [{ appName: 'x'.repeat(31) }, 'appName'],
  ];
  for (const [body, field] of cases) {
    const res = await save(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} answered ${res.status}: ${res.text.slice(0, 200)}`);
    assert.ok(res.body.fields?.[field], `${field} is not named: ${res.text.slice(0, 200)}`);
  }
  for (const extra of [{ androidMinVersion: '9.9.9' }, { iosStoreUrl: 'https://apps.apple.com/x' }, { reviewEnabled: true }, { tenantId: 9 }, { androidLockedAt: new Date().toISOString() }, { androidNextBuild: 1 }]) {
    assert.equal((await save(extra)).status, 400, `The seller set ${Object.keys(extra)[0]}`);
  }
  const afterRow = await w.main.row();
  assert.equal(afterRow.app_name, before.app_name, 'A refused save changed the row');
  assert.equal(afterRow.android_next_build, before.android_next_build);
});

test('P-34: an icon that fails the store source spec is refused with the spec message; another business\'s image is not taken', async () => {
  for (const [what, image, pattern] of [['too small', await png(600, 600), /1024/], ['not square', await png(1200, 1000), /square/i], ['a GIF', await (await import('sharp')).default({ create: { width: 1024, height: 1024, channels: 3, background: '#112233' } }).gif().toBuffer(), /PNG or JPEG/]]) {
    const id = await upload(image, what === 'a GIF' ? 'image/gif' : 'image/png');
    const res = await save({ iconMediaId: id });
    assert.equal(res.status, 400, `${what}: ${res.status}`);
    assert.match(res.text, pattern, `${what}: ${res.text}`);
    assert.ok(res.body.fields.iconMediaId);
  }
  const notImage = await upload(Buffer.from('not a png at all'));
  assert.equal((await save({ iconMediaId: notImage })).status, 400);
  const other = await brand(w, { platforms: ['android'] });
  const theirs = await upload(await png(1024, 1024), 'image/png', other);
  const res = await save({ iconMediaId: theirs });
  assert.equal(res.status, 400, 'Another business\'s image was taken');
  assert.notEqual((await w.main.row()).icon_media_id, theirs);
  const good = await upload(await png(1024, 1024, { color: '#7A1F3D' }));
  assert.equal((await save({ iconMediaId: good })).status, 200);
  // An image set behind the check (straight into the row) is still caught by validation.
  const tiny = await upload(await png(16, 16));
  await w.main.set({ icon_media_id: tiny });
  const problems = (await validate()).body.problems;
  assert.ok(problems.some((p) => p.field === 'iconMediaId' && /1024/.test(p.message)), JSON.stringify(problems));
  await w.main.set({ icon_media_id: good });
});

test('two businesses never hold the same package, bundle id or link name, in any case, and the ids lock once submitted', async () => {
  const a = await brand(w, { platforms: ['android', 'ios'] });
  const taken = (await a.row()).android_package;
  let res = await save({ androidPackage: taken });
  assert.equal(res.status, 409, res.text);
  assert.ok(res.body.fields.androidPackage);
  assert.equal((await save({ iosBundleId: (await a.row()).ios_bundle_id.toUpperCase() })).status, 409, 'The same bundle id in capitals');
  assert.equal((await save({ urlScheme: (await a.row()).url_scheme })).status, 409);
  assert.equal((await a.row()).android_package, taken, 'The other business lost its id');
  // Locked after the first submitted build: the seller is told, and the database refuses it too.
  const mine = await w.main.row();
  await w.main.set({ android_locked_at: new Date() });
  res = await save({ androidPackage: 'in.example.changed' });
  assert.equal(res.status, 409);
  assert.ok(res.body.fields.androidPackage);
  assert.equal((await save({ urlScheme: 'otherlinkname' })).status, 409, 'The link name changed after a submit');
  await assert.rejects(w.sql('UPDATE app_configs SET android_package = $2 WHERE tenant_id = $1', [w.main.tenant.id, 'in.example.sneaky']), /cannot change/);
  await assert.rejects(w.sql('UPDATE app_configs SET android_locked_at = NULL WHERE tenant_id = $1', [w.main.tenant.id]), /never lifted/);
  assert.equal((await w.main.row()).android_package, mine.android_package);
  // The iOS id is still free to change until an iOS build is submitted.
  assert.equal((await save({ iosBundleId: `in.example.ios${w.main.tenant.id}` })).status, 200);
});

test('every call checks the plan first: a business with no app in its plan is refused, on the server', async () => {
  const plain = await plainBusiness(w);
  const service = appConfigFor(w.ctx);
  for (const call of [() => service.get(), () => service.save({ appName: 'Shop' }, 'user:1'), () => service.validate()]) {
    await assert.rejects(plain.run(call), (err) => err.status === 403);
  }
  assert.equal((await w.sql('SELECT count(*)::int AS n FROM app_configs WHERE tenant_id = $1', [plain.tenant.id]))[0].n, 0);
});

test('the brand file holds only this business, as data: its ids for the one platform, its channel, no key, and seller text as plain values', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'], name: 'Mehta "Mart" $(rm -rf ~)' });
  const other = await brand(w, { platforms: ['android'], name: 'Zarvelo Goods' });
  const service = appConfigFor(w.ctx);
  const file = await b.run(() => service.brandFile({ platform: 'android', buildNumber: 7, appVersion: '1.0.0', runtimeVersion: '1.0.0' }));
  assert.ok(BrandFile.safeParse(file).success);
  assert.equal(file.tenantId, b.tenant.id);
  assert.equal(file.name, 'Mehta "Mart" $(rm -rf ~)', 'The name is kept as it was typed, as a value');
  assert.equal(file.android.versionCode, 7);
  assert.equal(file.ios, null, 'An Android build carries no iOS ids');
  assert.deepEqual(file.associatedDomains, []);
  assert.equal(file.updates.channel, `t${b.tenant.id}`);
  assert.deepEqual(file.linkHosts, [b.host]);
  assert.equal(file.apiBaseUrl, `https://${b.host}`);
  const text = JSON.stringify(file);
  const theirs = await other.row();
  for (const value of [theirs.android_package, theirs.url_scheme, other.host, 'Zarvelo', `t${other.tenant.id}"`]) assert.ok(!text.includes(value), `The brand file names another business: ${value}`);
  assert.ok(!/key|secret|password|token|keystore|p12|p8/i.test(Object.keys(file).join(' ')));
  assert.deepEqual(JSON.parse(text), file, 'The file is plain JSON data');
  const ios = await b.run(() => service.brandFile({ platform: 'ios', buildNumber: 3, appVersion: '1.0.0', runtimeVersion: '1.0.0' }));
  assert.equal(ios.android, null);
  assert.deepEqual(ios.associatedDomains, [`applinks:${b.host}`]);
  // A missing field stops it and is named.
  await b.set({ privacy_url: '' });
  await assert.rejects(b.run(() => service.brandFile({ platform: 'android', buildNumber: 8, appVersion: '1.0.0', runtimeVersion: '1.0.0' })), (err) => err instanceof AppConfigProblem && err.field === 'privacyUrl');
});

test('our team sets the minimum version and the review access; the code is kept only as a hash and the mirror follows', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'] });
  let res = await w.console('PUT', `/tenants/${b.tenant.id}/app-minimum`, { platform: 'android', minVersion: '1.2.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.example.x' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.android, { minVersion: '1.2.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.example.x' });
  const [mirror] = await w.sql(`SELECT min_version FROM app_min_versions WHERE app = 'shopper' AND tenant_id = $1 AND platform = 'android'`, [b.tenant.id]);
  assert.equal(mirror.min_version, '1.2.0');
  assert.equal((await w.console('PUT', `/tenants/${b.tenant.id}/app-minimum`, { platform: 'ios', minVersion: '1.0.0', storeUrl: 'https://play.google.com/store/apps/details?id=x' })).status, 400, 'A Play link for iOS');
  assert.equal((await w.console('PUT', '/tenants/999999/app-minimum', { platform: 'ios', minVersion: '', storeUrl: '' })).status, 404);
  res = await w.console('PUT', `/tenants/${b.tenant.id}/app-review-access`, { phone: '+919876543210', code: '246810', enabled: true });
  assert.equal(res.status, 204, res.text);
  const row = await b.row();
  assert.equal(row.review_enabled, true);
  assert.ok(row.review_code_hash && !row.review_code_hash.includes('246810'));
  assert.equal((await w.console('PUT', `/tenants/${b.tenant.id}/app-review-access`, { phone: null, code: null, enabled: false })).status, 204);
  assert.equal((await b.row()).review_enabled, false);
  const audit = await w.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'app.review_access_set'`, [b.tenant.id]);
  assert.ok(audit.length && !JSON.stringify(audit).includes('9876543210') && !JSON.stringify(audit).includes('246810'));
  // A seller cannot reach either.
  assert.equal((await w.api('PUT', `/tenants/${b.tenant.id}/app-minimum`, { platform: 'android', minVersion: '9.9.9', storeUrl: '' })).status, 404);
});
