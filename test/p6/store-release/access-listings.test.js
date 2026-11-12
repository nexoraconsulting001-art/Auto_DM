// Store access (PRD 10.9) and listings (10.13) under attack: store keys are stored encrypted, answered masked and usable only by
// their own business, even when the sealed key is copied into another business's row; nothing that is not a .p8 key, and no
// password, is ever taken. The listing starts from a template naming the business, is refused in the store's own words when a
// field is over its limit or names the platform, and its images are checked against the spec and served only on the business's
// own address with a link that cannot be guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_COLLECTED, namesPlatform } from '../../../src/contracts/apps.js';
import { createAppStores } from '../../../src/adapters/appstores/index.js';
import { createEas } from '../../../src/adapters/eas/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { storeAccessFor, keyLast4 } from '../../../src/modules/store-access/index.js';
import { storeListingsFor } from '../../../src/modules/store-listings/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { accepted, addAppShop, hit, refusedStatus, useP6World } from '../spec-p6/kit.js';

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'store-release-files-'));
const world = useP6World({ overrides: { storageDriver: 'local', storageDir: STORAGE } });
const unique = () => `${Date.now() % 1e8}${crypto.randomInt(1e4)}`;
let ctx;
/** The server's own context, for what has no route: the submit path's credentials and the pipeline's putAsset. */
const ctxOf = () => {
  if (!ctx) {
    const platform = createPlatform(world.config, { db: world.db });
    ctx = { db: world.db, config: world.config, platform, repos: createRepos(world.db, { secrets: platform.secrets, storage: platform.storage }), modules: MODULES, eas: createEas(world.config), appStores: createAppStores(world.config) };
  }
  return ctx;
};

async function iosShop(name) {
  const bundleId = `in.example.k${unique()}`;
  const shop = await addAppShop(world, { platforms: ['ios'], name, config: { ios_bundle_id: bundleId } });
  await world.appstore.post('/apps', { bundleId, sellerName: `${shop.name} Traders`, name: shop.name });
  return { shop, bundleId };
}

test('a store key is stored sealed, answered as its last four characters, and opens only for its own business', async () => {
  const { shop: a } = await iosShop('Kesar Kitchen');
  const { shop: b } = await iosShop('Mehta Mart');
  const key = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  const saved = accepted(await a.send('PUT', '/store-access/ios', { accountType: 'organisation', legalName: `${a.name} Traders`, ascKey: { keyId: key.keyId, issuerId: key.issuerId, privateKey: key.privateKey } }), 'Saving the key').json();
  assert.equal(saved.credential.keyLast4, keyLast4(key.privateKey));
  assert.equal(saved.credential.keyLast4.length, 4);
  const body = key.privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  for (const answer of [saved, (await a.must('GET', '/store-access')).items.find((i) => i.platform === 'ios')]) {
    const text = JSON.stringify(answer);
    assert.ok(!text.includes('PRIVATE KEY') && !text.includes(body.slice(10, 50)), 'The key came back');
  }
  const [row] = await a.sql('SELECT * FROM store_access WHERE tenant_id = $1 AND platform = $2', [a.tenantId, 'ios']);
  assert.match(row.key_enc, /^v1\./);
  assert.ok(!row.key_enc.includes(body.slice(10, 50)) && !JSON.stringify(row).includes('PRIVATE KEY'), 'The key is stored in the clear');
  const audit = JSON.stringify(await a.sql('SELECT details FROM audit_log WHERE tenant_id = $1', [a.tenantId]));
  assert.ok(!audit.includes(body.slice(10, 50)), 'The key is in the audit log');
  assert.match(audit, /ascKey:set/);

  // The submit path opens it inside its own business only.
  const service = storeAccessFor(ctxOf());
  const opened = await withTenant(a.tenantId, () => service.credentials('ios'));
  assert.equal(opened.kind, 'asc_api_key');
  assert.equal(opened.privateKey, key.privateKey);
  assert.equal(await withTenant(b.tenantId, () => service.credentials('ios')), null, 'Another business opened a key');
  assert.equal(accepted(await a.send('POST', '/store-access/ios/check')).json().access.status, 'ok');

  // The sealed key copied into another business's row (a write that went round the code) is useless there.
  await b.sql(
    `INSERT INTO store_access (tenant_id, platform, credential_kind, key_id, issuer_id, key_enc, key_last4) VALUES ($1, 'ios', 'asc_api_key', $2, $3, $4, $5)
     ON CONFLICT (tenant_id, platform) DO UPDATE SET credential_kind = EXCLUDED.credential_kind, key_id = EXCLUDED.key_id, issuer_id = EXCLUDED.issuer_id, key_enc = EXCLUDED.key_enc, key_last4 = EXCLUDED.key_last4`,
    [b.tenantId, row.key_id, row.issuer_id, row.key_enc, row.key_last4],
  );
  assert.equal(await withTenant(b.tenantId, () => service.credentials('ios')), null, 'A copied key opened for another business');
  const stolen = accepted(await b.send('POST', '/store-access/ios/check')).json();
  assert.equal(stolen.access.status, 'invalid', 'A copied key passed the access check');
  assert.equal((await b.must('GET', '/store-access')).items.find((i) => i.platform === 'ios').credential.set, true);
  // A sealed value that is not ours at all is refused too.
  await b.sql(`UPDATE store_access SET key_enc = 'v1.AAAAAAAA.AAAA.AAAA.AAAA' WHERE tenant_id = $1 AND platform = 'ios'`, [b.tenantId]);
  assert.equal(await withTenant(b.tenantId, () => service.credentials('ios')), null);

  // Removing the key forgets it.
  const removed = accepted(await a.send('PUT', '/store-access/ios', { ascKey: null })).json();
  assert.deepEqual(removed.credential, { kind: 'none', keyId: '', issuerId: '', keyLast4: '', set: false });
  assert.equal(removed.access.status, 'not_checked');
  assert.equal(await withTenant(a.tenantId, () => service.credentials('ios')), null);
  assert.equal((await a.sql('SELECT key_enc FROM store_access WHERE tenant_id = $1 AND platform = $2', [a.tenantId, 'ios']))[0].key_enc, null);
});

test('only a real .p8 key is taken: not text, not an RSA key, not on Android, and never a password or a sign-in name', async () => {
  const { shop } = await iosShop();
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const privateKey of ['not a key', rsa, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----']) { // secret-scan:allow
    const res = await shop.send('PUT', '/store-access/ios', { ascKey: { keyId: 'ABCDE12345', issuerId: crypto.randomUUID(), privateKey } });
    refusedStatus(res, 'A key that is not a .p8 key', [400]);
    assert.match(res.text, /App Store Connect key/);
  }
  assert.equal((await shop.must('GET', '/store-access')).items.find((i) => i.platform === 'ios').credential.set, false);
  const android = await addAppShop(world);
  const key = await world.appstore.post('/keys', { role: 'APP_MANAGER' });
  refusedStatus(await android.send('PUT', '/store-access/android', { ascKey: { keyId: key.keyId, issuerId: key.issuerId, privateKey: key.privateKey } }), 'An Apple key on Android', [400]);
  refusedStatus(await android.send('PUT', '/store-access/ios', { accountType: 'organisation' }), 'A platform the plan lacks', [403]);
  for (const extra of [{ password: 'x'.repeat(12) }, { ascKey: { keyId: key.keyId, issuerId: key.issuerId, privateKey: key.privateKey, password: 'x' } }, { closedTest: { startedAt: null, appleId: 'a@b.example' } }]) {
    refusedStatus(await shop.send('PUT', '/store-access/ios', extra), `A body with ${JSON.stringify(Object.keys(extra))}`, [400]);
  }
  // A closed test cannot have started before personal accounts needed one.
  refusedStatus(await android.send('PUT', '/store-access/android', { accountType: 'personal', playAccountAfterCutoff: true, closedTest: { startedAt: '2023-01-01T00:00:00Z', testers: 12 } }), 'A closed test before the cutoff', [400]);
  // A legal name with markup or the platform's name.
  for (const legalName of ['<b>Mehta</b> Mart', 'Bhava Retail']) refusedStatus(await shop.send('PUT', '/store-access/ios', { legalName }), legalName, [400]);
  // The answers name no platform.
  assert.ok(!namesPlatform(JSON.stringify(await shop.must('GET', '/store-access'))));
});

test('the listing starts from a template that names the business; its privacy answers are what the app collects', async () => {
  const shop = await addAppShop(world, { platforms: ['android', 'ios'], config: { app_name: 'Mehta Mart' } });
  const android = await shop.must('GET', '/app-listing/android');
  assert.equal(android.title, 'Mehta Mart');
  assert.match(android.shortDescription, /Mehta Mart/);
  assert.match(android.fullDescription, /Mehta Mart/);
  assert.equal(android.validation.ok, true, JSON.stringify(android.validation));
  assert.ok([...android.shortDescription].length <= 80);
  const ios = await shop.must('GET', '/app-listing/ios');
  assert.ok([...ios.shortDescription].length <= 30, 'The subtitle template is over the App Store\'s limit');
  assert.match(ios.keywords, /mehta mart/);
  assert.equal(ios.validation.ok, true, JSON.stringify(ios.validation));
  for (const doc of [android.dataSafety.dataTypes, ios.privacyLabels.dataLinkedToYou]) assert.deepEqual(doc.map((d) => d.type), DATA_COLLECTED.map((d) => d.type));
  assert.equal(ios.privacyLabels.tracking, false);
  assert.deepEqual(ios.privacyLabels.dataUsedToTrackYou, []);
  assert.equal(android.dataSafety.sharesData, false);
  assert.ok(!namesPlatform(JSON.stringify([android, ios])));
  // Another business's template names that business, not this one.
  const other = await addAppShop(world, { config: { app_name: 'Kesar Kitchen' } });
  assert.equal((await other.must('GET', '/app-listing/android')).title, 'Kesar Kitchen');
  // Saving keeps the owner's text and the prefilled privacy answers.
  const saved = accepted(await shop.send('PUT', '/app-listing/android', { shortDescription: 'Fresh groceries from Mehta Mart, delivered.' })).json();
  assert.equal(saved.shortDescription, 'Fresh groceries from Mehta Mart, delivered.');
  assert.equal(saved.title, 'Mehta Mart');
  const [row] = await shop.sql('SELECT data_safety, validation FROM store_listings WHERE tenant_id = $1 AND platform = $2', [shop.tenantId, 'android']);
  assert.deepEqual(row.data_safety.dataTypes.map((d) => d.type), DATA_COLLECTED.map((d) => d.type));
  assert.equal(row.validation.ok, true);
});

test('a listing over a store\'s limit is refused in the store\'s words, naming the field, the limit and the length; the platform\'s name never gets in', async () => {
  const shop = await addAppShop(world, { platforms: ['android', 'ios'], config: { app_name: 'Mehta Mart' } });
  const over = await shop.send('PUT', '/app-listing/android', { shortDescription: 'x'.repeat(92) });
  assert.equal(over.status, 400);
  assert.equal(over.json().error, 'Short description is 92 characters. Google Play allows 80.');
  assert.equal(over.json().fields.shortDescription, over.json().error);
  const subtitle = await shop.send('PUT', '/app-listing/ios', { shortDescription: 'y'.repeat(31) });
  assert.equal(subtitle.status, 400);
  assert.match(subtitle.json().error, /Subtitle is 31 characters\. The App Store allows 30\./);
  const both = await shop.send('PUT', '/app-listing/android', { title: 't'.repeat(31), shortDescription: 's'.repeat(81) });
  assert.equal(both.status, 400);
  assert.deepEqual(Object.keys(both.json().fields).sort(), ['shortDescription', 'title']);
  for (const field of ['title', 'shortDescription', 'fullDescription', 'whatsNew']) {
    const res = await shop.send('PUT', '/app-listing/android', { [field]: 'Made with Bhava' });
    assert.equal(res.status, 400, field);
    assert.match(res.text, /name your business only/);
  }
  assert.equal((await shop.must('GET', '/app-listing/android')).shortDescription.includes('x'.repeat(10)), false, 'A refused text was kept');
  // The database refuses it too, whoever writes.
  await assert.rejects(() => shop.sql(`INSERT INTO store_listings (tenant_id, platform, title) VALUES ($1, 'android', 'BHAVA store') ON CONFLICT (tenant_id, platform, locale) DO UPDATE SET title = EXCLUDED.title`, [shop.tenantId]));
  // The early refusal is only for a signed-in manager of this business: anyone else gets the API's own answer.
  const anonymous = await hit(world, '/api/v1/app-listing/android', { host: shop.host, method: 'PUT', body: { shortDescription: 'x'.repeat(92) } });
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(anonymous.text, /Short description/);
});

test('listing images: checked against the store spec, screenshots only from the build, served only by an unguessable link on the business\'s own address', async () => {
  const shop = await addAppShop(world, { platforms: ['android', 'ios'] });
  const other = await addAppShop(world, { platforms: ['android'] });
  const listings = storeListingsFor(ctxOf());
  const png = (width, height, alpha = false) => sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#2E7D5B' } }).png().toBuffer();
  const icon = await withTenant(shop.tenantId, async () => listings.putAsset('android', 'icon', await png(512, 512), { source: 'generated' }));
  assert.equal(icon.specOk, true, JSON.stringify(icon.problems));
  assert.deepEqual([icon.width, icon.height], [512, 512]);
  const clear = await withTenant(shop.tenantId, async () => listings.putAsset('ios', 'icon', await png(1024, 1024, true), { source: 'generated' }));
  assert.equal(clear.specOk, false);
  assert.ok(clear.problems.some((p) => p.code === 'has_alpha'), 'A transparent App Store icon passed');
  const small = await withTenant(shop.tenantId, async () => listings.putAsset('android', 'feature_graphic', await png(1000, 500), { source: 'generated' }));
  assert.ok(small.problems.some((p) => p.code === 'wrong_size'));
  await assert.rejects(() => withTenant(shop.tenantId, async () => listings.putAsset('android', 'screenshot', await png(1080, 1920), { device: 'phone', source: 'upload' })), /real build/);
  const shot = await withTenant(shop.tenantId, async () => listings.putAsset('android', 'screenshot', await png(1080, 1920), { device: 'phone', source: 'build_capture' }));
  assert.equal(shot.specOk, true, JSON.stringify(shot.problems));
  await assert.rejects(() => withTenant(shop.tenantId, () => listings.putAsset('android', 'icon', Buffer.from('<svg/>'), { source: 'upload' })), /PNG or JPEG/);

  const items = (await shop.must('GET', '/app-listing/android/assets')).items;
  assert.deepEqual(items.map((a) => a.kind).sort(), ['feature_graphic', 'icon', 'screenshot']);
  assert.ok(items.every((a) => !a.url.startsWith('/media')), 'A listing image is under /media');
  const served = await hit(world, icon.url, { host: shop.host });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal((await sharp(served.raw).metadata()).width, 512);
  // A changed signature, another business's address, or the right link of another asset id: nothing.
  const sig = icon.url.split('/').pop();
  const flipped = icon.url.replace(sig, `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`);
  assert.equal((await hit(world, flipped, { host: shop.host })).status, 404);
  assert.equal((await hit(world, icon.url, { host: other.host })).status, 404, 'Another business\'s address served the image');
  const [id] = icon.url.split('/').slice(-2);
  assert.equal((await hit(world, `/app-listing-assets/${Number(id) + 1}/${sig}`, { host: shop.host })).status, 404);
  assert.deepEqual((await other.must('GET', '/app-listing/android/assets')).items, []);
  // The files are under the business's own private folder.
  const keys = (await shop.sql('SELECT storage_key FROM listing_assets WHERE tenant_id = $1', [shop.tenantId])).map((r) => r.storage_key);
  assert.ok(keys.every((k) => k.startsWith(`t/${shop.tenantId}/listing/`)));
});
