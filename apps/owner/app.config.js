/**
 * Bhava for Business: one binary for every business (PRD 10.6). Everything that differs between builds is a
 * build setting read here, and the app builds with none of them set and with no account anywhere:
 *
 *   API_BASE_URL          where the API is, such as https://app.example.com. Required for a release build
 *   APP_ID                the Android package and iOS bundle id (default below)
 *   APP_ENV               development (default), preview or production
 *   GOOGLE_SERVICES_JSON  path to google-services.json; without it (or ./google-services.json) Android push is off
 *   APNS_ENV              development or production: adds the iOS push entitlement; without it iOS push is off
 *   UPDATES_URL           where over-the-air updates are served; without it updates are off
 *   HIDE_PLAN_PURCHASE    1 hides every buy button for a plan on iOS
 *
 * Nothing secret belongs in this file or in `extra`: both are readable inside the shipped app.
 */
const fs = require('node:fs');
const path = require('node:path');
const { withEntitlementsPlist } = require('expo/config-plugins');
const pkg = require('./package.json');

const DEFAULT_APP_ID = 'com.bhava.business';
/** The link scheme the server writes into pushes, emails and the browser sign-in (OWNER_APP_SCHEME). A test keeps them equal. */
const SCHEMES = ['bhavabusiness', 'bhava'];

const env = process.env;
const appEnv = ['development', 'preview', 'production'].includes(env.APP_ENV) ? env.APP_ENV : 'development';
const appId = env.APP_ID || DEFAULT_APP_ID;
if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(appId)) throw new Error(`APP_ID "${appId}" is not an application id such as com.example.app`);

const apiBaseUrl = String(env.API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
if (!/^https?:\/\/[^/\s]+$/.test(apiBaseUrl)) throw new Error('API_BASE_URL must be an origin such as https://app.example.com, with no path');
if (appEnv === 'production' && !/^https:\/\//.test(apiBaseUrl)) throw new Error('A production build needs API_BASE_URL set to an https address');
const plainHttp = apiBaseUrl.startsWith('http://');

const exists = (file) => Boolean(file) && fs.existsSync(path.resolve(__dirname, file));
const googleServices = [env.GOOGLE_SERVICES_JSON, './google-services.json'].find(exists);
const apnsEnv = ['development', 'production'].includes(env.APNS_ENV) ? env.APNS_ENV : null;

/** With no push setting, the iOS build asks for no push entitlement, so it signs and runs with any profile or none. */
const withoutPushEntitlement = (config) =>
  withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });

const CAMERA = 'Take photos of your products and upload them to your shop.';
const PHOTOS = 'Choose product photos and your logo from your library.';

module.exports = () => ({
  name: 'Bhava for Business',
  slug: 'bhava-for-business',
  owner: undefined,
  version: pkg.version,
  runtimeVersion: { policy: 'fingerprint' },
  orientation: 'portrait',
  scheme: SCHEMES,
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  platforms: ['android', 'ios'],
  android: {
    package: appId,
    adaptiveIcon: { foregroundImage: './assets/adaptive-foreground.png', monochromeImage: './assets/adaptive-monochrome.png', backgroundColor: '#F6F5F1' },
    ...(googleServices ? { googleServicesFile: googleServices } : {}),
    permissions: ['android.permission.CAMERA', 'android.permission.USE_BIOMETRIC', 'android.permission.POST_NOTIFICATIONS'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW'],
    allowBackup: false,
  },
  ios: {
    bundleIdentifier: appId,
    supportsTablet: false,
    usesAppleSignIn: true,
    infoPlist: {
      NSCameraUsageDescription: CAMERA,
      NSPhotoLibraryUsageDescription: PHOTOS,
      NSFaceIDUsageDescription: 'Unlock the app with Face ID instead of signing in again.',
      ITSAppUsesNonExemptEncryption: false,
      CFBundleAllowMixedLocalizations: true,
      ...(plainHttp ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
    },
    // The privacy manifest Apple requires (PRD: iOS ready from day one). No tracking; what is collected is what an
    // account needs. Keep in step with the App Privacy answers when a feature starts collecting something new.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePhoneNumber', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeEmailAddress', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePhotosorVideos', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
      ],
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
      ],
    },
  },
  updates: env.UPDATES_URL ? { url: env.UPDATES_URL, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 } : { enabled: false },
  plugins: [
    ['expo-build-properties', { android: { targetSdkVersion: 36, minSdkVersion: 24, usesCleartextTraffic: plainHttp }, ios: {} }],
    ['expo-splash-screen', { image: './assets/splash.png', imageWidth: 160, backgroundColor: '#F6F5F1' }],
    ['expo-secure-store', { faceIDPermission: 'Unlock the app with Face ID instead of signing in again.', configureAndroidBackup: true }],
    ['expo-local-authentication', { faceIDPermission: 'Unlock the app with Face ID instead of signing in again.' }],
    ['expo-image-picker', { photosPermission: PHOTOS, cameraPermission: CAMERA, microphonePermission: false }],
    'expo-apple-authentication',
    'expo-web-browser',
    'expo-sqlite',
    'expo-localization',
    'expo-font',
    'expo-asset',
    ...(googleServices || apnsEnv ? [['expo-notifications', { icon: './assets/notification.png', color: '#3B2FC9', mode: apnsEnv ?? 'development' }]] : []),
    ...(apnsEnv ? [] : [withoutPushEntitlement]),
  ],
  extra: {
    apiBaseUrl,
    appEnv,
    hidePlanPurchase: env.HIDE_PLAN_PURCHASE === '1',
    push: { android: Boolean(googleServices), ios: Boolean(apnsEnv) },
  },
});

module.exports.DEFAULT_APP_ID = DEFAULT_APP_ID;
module.exports.SCHEMES = SCHEMES;
