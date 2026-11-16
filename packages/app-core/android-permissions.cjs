/**
 * Android permissions a library adds at build time that no app of ours uses, so every app blocks them (app.config.js
 * blockedPermissions; the build removes them from the merged manifest). One list for the owner app and every shopper brand.
 *
 * LAUNCHER_BADGE_PERMISSIONS: expo-notifications brings ShortcutBadger, which asks for the badge permissions of a dozen
 * launchers. Neither app sets an icon badge count, and an unexplained permission fails the store check (P-15).
 *
 * INSTALL_REFERRER_PERMISSIONS: expo-application brings Google's Install Referrer library, which asks to bind Play's
 * install referrer service. It is used only by Application.getInstallReferrerAsync, which no app calls: an app never
 * learns which campaign or link installed it (the store answers collect no such data).
 *
 * BLOCKED_LIBRARY_PERMISSIONS is every list above: what each app.config.js spreads into blockedPermissions.
 */
const LAUNCHER_BADGE_PERMISSIONS = Object.freeze([
  'com.sec.android.provider.badge.permission.READ', 'com.sec.android.provider.badge.permission.WRITE',
  'com.htc.launcher.permission.READ_SETTINGS', 'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.sonyericsson.home.permission.BROADCAST_BADGE', 'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT', 'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.huawei.android.launcher.permission.CHANGE_BADGE', 'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS', 'android.permission.READ_APP_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS', 'com.oppo.launcher.permission.WRITE_SETTINGS',
  'me.everything.badger.permission.BADGE_COUNT_READ', 'me.everything.badger.permission.BADGE_COUNT_WRITE',
]);

const INSTALL_REFERRER_PERMISSIONS = Object.freeze(['com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE']);

const BLOCKED_LIBRARY_PERMISSIONS = Object.freeze([...LAUNCHER_BADGE_PERMISSIONS, ...INSTALL_REFERRER_PERMISSIONS]);

module.exports = { BLOCKED_LIBRARY_PERMISSIONS, INSTALL_REFERRER_PERMISSIONS, LAUNCHER_BADGE_PERMISSIONS };
