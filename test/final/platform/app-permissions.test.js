// D-10 (owner release APK): every permission a built APK holds is explained in the store listing or blocked (P-15). The
// notification library's badge helper (ShortcutBadger, pulled in with expo-notifications) adds the launcher badge
// permissions of a dozen phone makers at build time; neither app sets a badge count, so both apps block them, from one list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apkPermissionProblems, readAppConfig } from '../../../apps/owner/store/check.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** What the owner release APK held on CI (the Android release APK job), less what the app asks for itself. */
const ADDED_BY_LIBRARIES = [
  'com.sec.android.provider.badge.permission.READ', 'com.sec.android.provider.badge.permission.WRITE',
  'com.htc.launcher.permission.READ_SETTINGS', 'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.sonyericsson.home.permission.BROADCAST_BADGE', 'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT', 'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.huawei.android.launcher.permission.CHANGE_BADGE', 'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS', 'android.permission.READ_APP_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS', 'com.oppo.launcher.permission.WRITE_SETTINGS',
  'me.everything.badger.permission.BADGE_COUNT_READ', 'me.everything.badger.permission.BADGE_COUNT_WRITE',
  // expo-application's Install Referrer library (the owner release APK on CI, final loop 1).
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
];

/** The APK as the build makes it: a blocked permission is removed from the merged manifest (tools:node="remove"). */
function badgingOf(config, held) {
  const blocked = new Set(config.android.blockedPermissions ?? []);
  const kept = [...new Set([...(config.android.permissions ?? []), ...held])].filter((p) => !blocked.has(p));
  return [`package: name='${config.android.package}' versionCode='1'`, ...kept.map((p) => `uses-permission: name='${p}'`)].join('\n');
}

test('D-10: the owner APK holds no launcher badge permission the listing does not explain', async () => {
  const config = readAppConfig(ROOT);
  const listing = require('../../../apps/owner/store/listing.json');
  assert.deepEqual(apkPermissionProblems(badgingOf(config, ADDED_BY_LIBRARIES), listing, { appId: config.android.package }), []);
  for (const asked of config.android.permissions) assert.ok(!config.android.blockedPermissions.includes(asked), `${asked} is asked for and blocked`);
});

test('D-10: every shopper brand blocks the same launcher badge permissions', () => {
  const SETTINGS = ['BRAND_FILE', 'APP_ENV', 'API_BASE_URL', 'PAY_DRIVER', 'GOOGLE_SERVICES_JSON', 'APNS_ENV', 'UPDATES_URL'];
  const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  try {
    for (const name of SETTINGS) delete process.env[name];
    for (const brand of ['zarvelo', 'quindle']) {
      process.env.BRAND_FILE = path.join(ROOT, 'tools/build-brand/fixtures', brand, 'brand.json');
      const config = require('../../../apps/shopper/app.config.js')();
      const blocked = new Set(config.android.blockedPermissions);
      assert.deepEqual(ADDED_BY_LIBRARIES.filter((p) => !blocked.has(p)), [], brand);
      for (const asked of config.android.permissions) assert.ok(!blocked.has(asked), `${brand}: ${asked} is asked for and blocked`);
    }
  } finally {
    for (const name of SETTINGS) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

test('the install referrer permission is blocked because no app reads the install referrer', () => {
  // Blocking the permission breaks Application.getInstallReferrerAsync: if an app ever calls it, this test says so first.
  const calls = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'android', 'ios', 'dist', '.expo'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(c|m)?jsx?$/.test(entry.name) && /getInstallReferrer(Async)?\s*\(/.test(fs.readFileSync(file, 'utf8'))) calls.push(path.relative(ROOT, file));
    }
  };
  for (const dir of ['apps/owner/src', 'apps/shopper/src', 'packages']) walk(path.join(ROOT, dir));
  assert.deepEqual(calls, []);
  const { BLOCKED_LIBRARY_PERMISSIONS, INSTALL_REFERRER_PERMISSIONS } = require('../../../packages/app-core/android-permissions.cjs');
  for (const name of INSTALL_REFERRER_PERMISSIONS) assert.ok(BLOCKED_LIBRARY_PERMISSIONS.includes(name), name);
  assert.ok(readAppConfig(ROOT).android.blockedPermissions.includes('com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE'));
});
