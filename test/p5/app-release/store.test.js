// apps/owner/store (PRD 10.6, "iOS ready from day one"): the Play and App Store listings for Bhava for Business, the
// Data safety and App Privacy answers worked out from what the app collects, the privacy manifest reasons, and the
// check that fails when the config asks for a permission the listing does not explain.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_REASONS, askedPermissions, collectionProblems, listingProblems, manifestProblems, readAppConfig } from '../../../apps/owner/store/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const answers = require('../../../apps/owner/store/answers.cjs');
const listing = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/owner/store/listing.json'), 'utf8'));
const config = readAppConfig(ROOT);
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the store check passes on the repository, and is run by app-tests', () => {
  const run = spawnSync(process.execPath, ['apps/owner/store/check.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 1200));
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/apps.yml'), 'utf8'), /node apps\/owner\/store\/check\.mjs/);
});

test('the listings are Bhava for Business in both stores, within each store\'s limits, and name no business', () => {
  assert.equal(listing.play.title, 'Bhava for Business');
  assert.equal(listing.appStore.name, 'Bhava for Business');
  assert.equal(config.name, 'Bhava for Business');
  assert.deepEqual(listingProblems(listing, config), []);
  const text = JSON.stringify(listing);
  assert.doesNotMatch(text, /mehta|plant\s*store/i);
  assert.match(listing.play.fullDescription, /There are no passwords/);
  assert.match(listing.appStore.description, /Sign in with Apple/, 'Apple 4.8: offered beside Google');
  assert.match(listing.appStore.description, /delete your account/i, 'Apple 5.1.1(v)');
});

test('a permission the app config asks for and the listing does not explain fails the check, and names it', () => {
  const asked = askedPermissions(config);
  for (const key of ['android.permission.CAMERA', 'android.permission.USE_BIOMETRIC', 'android.permission.POST_NOTIFICATIONS', 'NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSFaceIDUsageDescription']) assert.ok(asked.has(key), key);

  const more = clone(config);
  more.android.permissions.push('android.permission.ACCESS_FINE_LOCATION');
  more.plugins.push(['expo-image-picker', { microphonePermission: 'Record a video of your product.' }]);
  const problems = listingProblems(listing, more);
  assert.ok(problems.some((p) => p.includes('android.permission.ACCESS_FINE_LOCATION') && p.includes('does not explain')));
  assert.ok(problems.some((p) => p.includes('NSMicrophoneUsageDescription') && p.includes('does not explain')), 'a permission a plugin adds counts');

  const silent = clone(listing);
  silent.appStore.description = silent.appStore.description.replace(listing.permissions.NSFaceIDUsageDescription, '');
  assert.ok(listingProblems(silent, config).some((p) => p.includes('NSFaceIDUsageDescription') && p.includes('App Store description does not say')));

  const fewer = clone(config);
  fewer.android.permissions = fewer.android.permissions.filter((p) => p !== 'android.permission.CAMERA');
  assert.ok(listingProblems(listing, fewer).some((p) => p.includes('explains android.permission.CAMERA, which the app does not ask for')));
});

test('the store limits and each store\'s own words are enforced', () => {
  const long = clone(listing);
  long.play.shortDescription = 'x'.repeat(81);
  long.appStore.keywords = 'k,'.repeat(51);
  long.appStore.description += '\nAlso on Android.';
  long.play.fullDescription += '\nAlso on the App Store.';
  const problems = listingProblems(long, config);
  assert.ok(problems.some((p) => p.includes('play.shortDescription is longer than 80')));
  assert.ok(problems.some((p) => p.includes('appStore.keywords is longer than 100')));
  assert.ok(problems.some((p) => p.includes('App Store listing mentions "Android"')));
  assert.ok(problems.some((p) => p.includes('Play listing mentions "App Store"')));
});

test('the privacy manifest is the one the answers give: no tracking, every collected type, and Apple\'s own reason codes', () => {
  const manifest = config.ios.privacyManifests;
  assert.deepEqual(manifest, answers.privacyManifest());
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
  assert.deepEqual(new Set(manifest.NSPrivacyCollectedDataTypes.map((t) => t.NSPrivacyCollectedDataType)), new Set(answers.collection.items.map((i) => i.apple)));
  for (const type of manifest.NSPrivacyCollectedDataTypes) {
    assert.equal(type.NSPrivacyCollectedDataTypeTracking, false);
    assert.deepEqual(type.NSPrivacyCollectedDataTypePurposes, ['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
  }
  for (const api of manifest.NSPrivacyAccessedAPITypes) for (const reason of api.NSPrivacyAccessedAPITypeReasons) assert.ok(API_REASONS[api.NSPrivacyAccessedAPIType].includes(reason), reason);
  assert.deepEqual(manifestProblems(ROOT, config), []);

  const wrong = clone(answers.manifest);
  wrong.accessedApis[0].reasons = ['35F9.1'];
  wrong.accessedApis[1].usedBy = ['react-native-not-a-dependency'];
  const problems = manifestProblems(ROOT, config, wrong);
  assert.ok(problems.some((p) => p.includes('35F9.1 is not a reason Apple allows for NSPrivacyAccessedAPICategoryUserDefaults')));
  assert.ok(problems.some((p) => p.includes('react-native-not-a-dependency')));
  const drifted = clone(config);
  drifted.ios.privacyManifests.NSPrivacyCollectedDataTypes.pop();
  assert.ok(manifestProblems(ROOT, drifted).some((p) => p.includes('is not the one apps/owner/store/answers.cjs gives')));
});

test('the Data safety and App Privacy answers come from collection.json: nothing shared, nothing for tracking or ads, encrypted, deletable', () => {
  const play = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/owner/store/play/data-safety.json'), 'utf8'));
  const apple = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/owner/store/app-store/app-privacy.json'), 'utf8'));
  assert.deepEqual(play, answers.dataSafety());
  assert.deepEqual(apple, answers.appPrivacy());
  assert.equal(play.encryptedInTransit, true);
  assert.equal(play.deletionRequest.available, true);
  assert.equal(apple.tracking, false);
  for (const row of play.dataTypes) {
    assert.equal(row.shared, false, row.type);
    assert.ok(!row.purposes.some((p) => /Advertising|Analytics|Personalization/.test(p)), row.type);
  }
  for (const row of apple.dataTypes) assert.equal(row.usedForTracking, false, row.type);
  const types = play.dataTypes.map((row) => `${row.category} / ${row.type}`);
  for (const type of ['Personal info / Phone number', 'Personal info / Email address', 'Photos and videos / Photos', 'Messages / Other in-app messages', 'Device or other IDs / Device or other IDs', 'Financial info / Other financial info']) assert.ok(types.includes(type), type);
  assert.ok(!types.some((type) => /^App info and performance/.test(type)), 'no crash or diagnostics SDK, so none declared');
  assert.deepEqual(answers.shapeProblems(), []);
});

test('the answers are derived from the app: a new field, picker or tracking SDK it does not list fails the check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-store-'));
  try {
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('apps/owner/package.json', JSON.stringify({ dependencies: { expo: '1', '@sentry/react-native': '1' } }));
    write('packages/ui/package.json', JSON.stringify({ dependencies: { 'expo-location': '1' } }));
    write('apps/owner/src/features/x/XScreen.js', '<Field testID="x-phone" keyboardType="phone-pad" />\nconst picker = require(\'expo-image-picker\');\n');
    write('apps/owner/src/features/x/x.test.js', '<Field testID="x-email" autoComplete="email" />\n');
    const collection = { items: [{ id: 'phone', what: 'Phone number', why: 'Sign-in.', apple: 'NSPrivacyCollectedDataTypePhoneNumber', play: { category: 'Personal info', type: 'Phone number' }, purposes: ['appFunctionality'], tracking: false, sources: ['apps/owner/src/gone.js'] }] };
    const problems = collectionProblems(root, collection);
    assert.ok(problems.some((p) => p.includes('apps/owner/src/gone.js, which does not exist')));
    assert.ok(problems.some((p) => p.startsWith('apps/owner/src/features/x/XScreen.js:1 collects "phone"')));
    assert.ok(problems.some((p) => p.startsWith('apps/owner/src/features/x/XScreen.js:2 collects "photos"')));
    assert.ok(!problems.some((p) => p.includes('x.test.js')), 'tests are not the app');
    assert.ok(problems.some((p) => p.startsWith('@sentry/react-native is a dependency')));
    assert.ok(problems.some((p) => p.startsWith('expo-location is a dependency')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // On the repository every finding is accounted for.
  assert.deepEqual(collectionProblems(ROOT), []);
});

test('every permission the built APK holds, whichever library added it, is normal or explained in the listing', async () => {
  const { apkPermissionProblems } = await import('../../../apps/owner/store/check.mjs');
  // What prebuild writes into the manifest today (seen in apps/owner/android after expo prebuild), as aapt2 prints it.
  const held = ['INTERNET', 'CAMERA', 'POST_NOTIFICATIONS', 'USE_BIOMETRIC', 'USE_FINGERPRINT', 'VIBRATE'].map((p) => `uses-permission: name='android.permission.${p}'`);
  const badging = ["package: name='com.bhava.business' versionCode='1'", ...held, "uses-permission: name='com.bhava.business.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'"].join('\n');
  assert.deepEqual(apkPermissionProblems(badging, listing), []);
  const more = `${badging}\nuses-permission: name='android.permission.READ_MEDIA_IMAGES'\nuses-permission: name='com.google.android.gms.permission.AD_ID'\n`;
  const problems = apkPermissionProblems(more, listing);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /The APK holds android\.permission\.READ_MEDIA_IMAGES, and the store listing does not explain it/);
  assert.match(problems[1], /com\.google\.android\.gms\.permission\.AD_ID/);
  assert.deepEqual(apkPermissionProblems('not badging', listing), ['This is not the output of aapt2 dump badging']);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/apps.yml'), 'utf8'), /check\.mjs --apk-badging "\$RUNNER_TEMP\/badging\.txt"/);
});
