/**
 * The shopper app: one source tree, one binary per brand (PRD 10.1, 10.7, 10.8). Everything a brand differs by comes from the
 * one file named by BRAND_FILE (see brand.cjs): name, short name, package, bundle id, link scheme, icon, adaptive icon,
 * splash, colours, fonts, shop domain, business id, support email, privacy URL, Apple team id, associated domains, the
 * verified-link intent filters, the runtime version and the build numbers. No brand is named in this file or anywhere beside it.
 *
 * The build settings that are not a brand's:
 *
 *   BRAND_FILE            the brand file. Required: there is no default brand
 *   APP_ENV               development (default), preview or production
 *   API_BASE_URL          for a development or preview build only: talk to this server instead of the brand's own address
 *   PAY_DRIVER            hosted or native: how the app takes payment (README.md). Default: what the brand file says
 *   GOOGLE_SERVICES_JSON  path to the brand's google-services.json, kept outside the repository; without it Android push is off
 *   APNS_ENV              development or production: adds the iOS push entitlement; without it iOS push is off
 *   UPDATES_URL           where over-the-air updates are served; without it updates are off
 *
 * Nothing secret belongs in this file, in a brand file or in `extra`: all three are readable inside the shipped app.
 */
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./package.json');
const { payDriverOf, readBrand } = require('./brand.cjs');
const { KEEP_RULES } = require('./plugins/with-native-pay.cjs');

const CAMERA = 'Take a photo of an item for a return request or a review.';
const PHOTOS = 'Choose a photo or a short video of an item for a return request or a review.';

/** `/r/*` opens anything under /r/; a plain path opens only itself. One data entry per host and path. */
const linkData = (hosts, paths) => hosts.flatMap((host) => paths.map((p) => (p.endsWith('/*') ? { scheme: 'https', host, pathPrefix: p.slice(0, -1) } : { scheme: 'https', host, path: p })));

/** With no push setting, the iOS build asks for no push entitlement, so it signs and runs with any profile or none. */
// expo/config-plugins is loaded when prebuild runs the plugin, so the config itself reads with no Expo installed.
const withoutPushEntitlement = (config) =>
  require('expo/config-plugins').withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });

module.exports = () => {
  const env = process.env;
  const { brand, asset, fonts, fontFamilies } = readBrand(env, __dirname);
  if (brand.appVersion !== pkg.version) throw new Error(`Every brand ships app version ${pkg.version}; this brand file says ${brand.appVersion}`);

  const appEnv = ['development', 'preview', 'production'].includes(env.APP_ENV) ? env.APP_ENV : 'development';
  const override = appEnv === 'production' ? '' : String(env.API_BASE_URL || '').replace(/\/+$/, '');
  if (appEnv === 'production' && env.API_BASE_URL) throw new Error('A production build talks to the brand’s own address: API_BASE_URL is for test builds only');
  if (override && !/^https?:\/\/[^/\s]+$/.test(override)) throw new Error('API_BASE_URL must be an origin such as https://shop.example.com, with no path');
  const apiBaseUrl = override || brand.apiBaseUrl;
  const plainHttp = apiBaseUrl.startsWith('http://');

  const payDriver = payDriverOf(brand, env);
  const exists = (file) => Boolean(file) && fs.existsSync(path.resolve(__dirname, file));
  const googleServices = brand.push.android && exists(env.GOOGLE_SERVICES_JSON) ? env.GOOGLE_SERVICES_JSON : null;
  const apnsEnv = brand.push.ios && ['development', 'production'].includes(env.APNS_ENV) ? env.APNS_ENV : null;

  return {
    name: brand.name,
    slug: brand.scheme,
    owner: undefined,
    version: pkg.version,
    runtimeVersion: brand.runtimeVersion,
    orientation: 'portrait',
    scheme: brand.scheme,
    icon: asset('icon'),
    userInterfaceStyle: 'light',
    platforms: ['android', 'ios'],
    ...(brand.android ? {
      android: {
        package: brand.android.package,
        versionCode: brand.android.versionCode,
        adaptiveIcon: { foregroundImage: asset('adaptiveForeground'), backgroundImage: asset('adaptiveBackground') },
        ...(googleServices ? { googleServicesFile: googleServices } : {}),
        // Verified links (10.12): the same direct https link a message carries opens the app, with no redirect in between.
        intentFilters: [{ action: 'VIEW', autoVerify: true, data: linkData(brand.linkHosts, brand.linkPaths.open), category: ['BROWSABLE', 'DEFAULT'] }],
        permissions: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'],
        blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT'],
        allowBackup: false,
      },
    } : {}),
    ...(brand.ios ? {
      ios: {
        bundleIdentifier: brand.ios.bundleId,
        buildNumber: String(brand.ios.buildNumber),
        appleTeamId: brand.ios.teamId,
        associatedDomains: brand.associatedDomains,
        supportsTablet: false,
        usesAppleSignIn: true,
        infoPlist: {
          CFBundleDisplayName: brand.shortName,
          NSCameraUsageDescription: CAMERA,
          NSPhotoLibraryUsageDescription: PHOTOS,
          ITSAppUsesNonExemptEncryption: false,
          CFBundleAllowMixedLocalizations: true,
          ...(plainHttp ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
        },
        // No tracking, ever. The collected data types are added by the store-listing work from DATA_COLLECTED
        // (src/contracts/apps.js); the required-reason APIs below are the ones React Native and Expo use.
        privacyManifests: {
          NSPrivacyTracking: false,
          NSPrivacyTrackingDomains: [],
          NSPrivacyCollectedDataTypes: [],
          NSPrivacyAccessedAPITypes: [
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
            { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
          ],
        },
      },
    } : {}),
    updates: env.UPDATES_URL
      ? { url: env.UPDATES_URL, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0, requestHeaders: { 'expo-channel-name': brand.updates.channel } }
      : { enabled: false },
    plugins: [
      ['expo-build-properties', { android: { targetSdkVersion: 36, minSdkVersion: 24, usesCleartextTraffic: plainHttp, ...(payDriver === 'native' ? { extraProguardRules: KEEP_RULES.join(String.fromCharCode(10)) } : {}) }, ios: {} }],
      ['expo-splash-screen', { image: asset('splash'), imageWidth: 160, backgroundColor: brand.splashBackground }],
      ['expo-secure-store', { faceIDPermission: false, configureAndroidBackup: true }],
      ['expo-image-picker', { photosPermission: PHOTOS, cameraPermission: CAMERA, microphonePermission: false }],
      ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
      ['expo-font', { fonts }],
      'expo-apple-authentication',
      'expo-web-browser',
      'expo-sqlite',
      'expo-localization',
      'expo-asset',
      ['./plugins/with-short-name.cjs', { shortName: brand.shortName }],
      ...(payDriver === 'native' ? ['./plugins/with-native-pay.cjs'] : []),
      ...(googleServices || apnsEnv ? [['expo-notifications', { icon: asset('notificationIcon'), color: brand.colors.primary, mode: apnsEnv ?? 'development' }]] : []),
      ...(apnsEnv ? [] : [withoutPushEntitlement]),
    ],
    extra: {
      // What the running app knows of its brand (src/brand.js). The business id goes out on every request as X-App-Tenant.
      brand: {
        tenantId: brand.tenantId,
        name: brand.name,
        shortName: brand.shortName,
        scheme: brand.scheme,
        shopDomain: brand.shopDomain,
        supportEmail: brand.supportEmail,
        privacyUrl: brand.privacyUrl,
        linkHosts: brand.linkHosts,
        linkPaths: brand.linkPaths,
        colors: brand.colors,
        fonts: brand.fonts,
        fontFamilies,
      },
      apiBaseUrl,
      appEnv,
      payDriver,
      push: { android: Boolean(googleServices), ios: Boolean(apnsEnv) },
    },
  };
};

module.exports.linkData = linkData;
