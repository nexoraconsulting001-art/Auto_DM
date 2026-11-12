/**
 * What a build is made of (PRD 10.1, 10.7, 10.8): one source tree and one brand file give one brand's app, for both
 * platforms; nothing of a brand is in the tree; payment never goes through in-app purchase.
 * @jest-environment node
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appConfig = require('../app.config.js');
const { BRAND_KEYS, readBrand } = require('../brand.cjs');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(ROOT, 'tools/build-brand/fixtures');
const brands = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json')));
const brandFile = (name) => path.join(FIXTURES, name, 'brand.json');
const brandOf = (name) => JSON.parse(fs.readFileSync(brandFile(name), 'utf8'));

const SETTINGS = ['BRAND_FILE', 'APP_ENV', 'API_BASE_URL', 'PAY_DRIVER', 'GOOGLE_SERVICES_JSON', 'APNS_ENV', 'UPDATES_URL'];
function configWith(env) {
  const before = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of SETTINGS) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return appConfig();
  } finally {
    for (const name of SETTINGS) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
}
const pluginNames = (config) => config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin)).filter((plugin) => typeof plugin === 'string');
const pluginOptions = (config, name) => config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name)?.[1];

function tempBrand(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  fs.cpSync(path.join(FIXTURES, brands[0]), dir, { recursive: true });
  const file = path.join(dir, 'brand.json');
  const brand = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(brand, dir);
  fs.writeFileSync(file, JSON.stringify(brand));
  return file;
}

test('there are two fixture brands to build from', () => {
  expect(brands.length).toBe(2);
});

test('P-01 two brands from one source tree differ in name, icon, ids, link scheme and colours, and in nothing else of the app', () => {
  const [a, b] = brands.map((name) => configWith({ BRAND_FILE: brandFile(name), APP_ENV: 'preview' }));
  for (const pick of [(c) => c.name, (c) => c.slug, (c) => c.scheme, (c) => c.icon, (c) => c.android.package, (c) => c.ios.bundleIdentifier, (c) => c.ios.appleTeamId,
    (c) => c.extra.brand.tenantId, (c) => c.extra.brand.colors.primary, (c) => c.extra.apiBaseUrl, (c) => c.android.adaptiveIcon.foregroundImage, (c) => pluginOptions(c, 'expo-splash-screen').image]) {
    expect(pick(a)).toBeTruthy();
    expect(pick(a)).not.toEqual(pick(b));
  }
  expect(a.version).toBe(pkg.version);
  expect(b.version).toBe(pkg.version);
  expect(pluginNames(a)).toEqual(pluginNames(b));
  expect(a.android.permissions).toEqual(b.android.permissions);
});

test.each(brands)('%s: every value that differs comes from its brand file', (name) => {
  const brand = brandOf(name);
  const config = configWith({ BRAND_FILE: brandFile(name), APP_ENV: 'production' });
  expect(config).toMatchObject({
    name: brand.name, scheme: brand.scheme, version: brand.appVersion, runtimeVersion: brand.runtimeVersion,
    android: { package: brand.android.package, versionCode: brand.android.versionCode },
    ios: { bundleIdentifier: brand.ios.bundleId, buildNumber: String(brand.ios.buildNumber), appleTeamId: brand.ios.teamId, associatedDomains: brand.associatedDomains, supportsTablet: false },
  });
  expect(config.ios.infoPlist.CFBundleDisplayName).toBe(brand.shortName);
  expect(pluginOptions(config, './plugins/with-short-name.cjs')).toEqual({ shortName: brand.shortName });
  expect(pluginOptions(config, 'expo-splash-screen').backgroundColor).toBe(brand.splashBackground);
  expect(config.extra).toMatchObject({
    apiBaseUrl: brand.apiBaseUrl, appEnv: 'production', payDriver: 'hosted',
    brand: { tenantId: brand.tenantId, name: brand.name, shortName: brand.shortName, shopDomain: brand.shopDomain, supportEmail: brand.supportEmail, privacyUrl: brand.privacyUrl, colors: brand.colors, fonts: brand.fonts, linkHosts: brand.linkHosts },
  });
  for (const image of [config.icon, config.android.adaptiveIcon.foregroundImage, config.android.adaptiveIcon.backgroundImage, pluginOptions(config, 'expo-splash-screen').image]) {
    expect(path.dirname(image)).toBe(path.join(FIXTURES, name));
    expect(fs.existsSync(image)).toBe(true);
  }
});

test.each(brands)('%s: its own https links open the app, verified, on its own hosts only', (name) => {
  const brand = brandOf(name);
  const config = configWith({ BRAND_FILE: brandFile(name) });
  expect(config.android.intentFilters).toHaveLength(1);
  const [filter] = config.android.intentFilters;
  expect(filter).toMatchObject({ action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'] });
  expect(new Set(filter.data.map((d) => d.host))).toEqual(new Set(brand.linkHosts));
  expect(filter.data.every((d) => d.scheme === 'https')).toBe(true);
  expect(filter.data).toHaveLength(brand.linkHosts.length * brand.linkPaths.open.length);
  expect(filter.data).toContainEqual({ scheme: 'https', host: brand.shopDomain, path: '/' });
  expect(filter.data).toContainEqual({ scheme: 'https', host: brand.shopDomain, pathPrefix: '/p/' });
  expect(filter.data.some((d) => /checkout|admin|api/.test(d.path ?? d.pathPrefix))).toBe(false);
});

test('there is no default brand: without BRAND_FILE, or with a broken one, the config refuses and says why', () => {
  expect(() => configWith({})).toThrow('BRAND_FILE is not set');
  expect(() => configWith({ BRAND_FILE: path.join(FIXTURES, 'nobody', 'brand.json') })).toThrow('does not exist');
  expect(() => configWith({ BRAND_FILE: tempBrand((b) => { delete b.privacyUrl; }) })).toThrow('privacyUrl is missing');
  expect(() => configWith({ BRAND_FILE: tempBrand((b) => { b.colors.primary = 'teal'; }) })).toThrow('colors.primary');
  expect(() => configWith({ BRAND_FILE: tempBrand((b) => { b.extra = 1; }) })).toThrow('extra is not a key');
  expect(() => configWith({ BRAND_FILE: tempBrand((b, dir) => fs.rmSync(path.join(dir, b.assets.icon))) })).toThrow('is not beside it');
});

test('every brand ships the app’s one version', () => {
  expect(() => configWith({ BRAND_FILE: tempBrand((b) => { b.appVersion = '9.9.9'; }) })).toThrow(`Every brand ships app version ${pkg.version}`);
});

test('a relative BRAND_FILE is read from the app’s folder', () => {
  const relative = path.relative(path.resolve(__dirname, '..'), brandFile(brands[0]));
  expect(readBrand({ BRAND_FILE: relative }).brand.name).toBe(brandOf(brands[0]).name);
});

test('a test build may talk to another server; a production build talks only to the brand’s own address', () => {
  const file = brandFile(brands[0]);
  const local = configWith({ BRAND_FILE: file, APP_ENV: 'preview', API_BASE_URL: 'http://10.0.2.2:3000/' });
  expect(local.extra.apiBaseUrl).toBe('http://10.0.2.2:3000');
  expect(pluginOptions(local, 'expo-build-properties').android.usesCleartextTraffic).toBe(true);
  expect(() => configWith({ BRAND_FILE: file, APP_ENV: 'production', API_BASE_URL: 'http://10.0.2.2:3000' })).toThrow('test builds only');
  expect(() => configWith({ BRAND_FILE: file, API_BASE_URL: 'shop.example.com/api' })).toThrow('must be an origin');
  expect(pluginOptions(configWith({ BRAND_FILE: file, APP_ENV: 'production' }), 'expo-build-properties').android.usesCleartextTraffic).toBe(false);
});

test('Android targets API 36, asks only for what a store needs, and iOS is iPhone-only with Sign in with Apple and no tracking', () => {
  const config = configWith({ BRAND_FILE: brandFile(brands[0]) });
  expect(pluginOptions(config, 'expo-build-properties').android).toMatchObject({ targetSdkVersion: 36, minSdkVersion: 24 });
  expect(config.android.permissions).toEqual(['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS']);
  expect(config.android.blockedPermissions).toContain('android.permission.RECORD_AUDIO');
  expect(config.android.allowBackup).toBe(false);
  expect(config.ios.supportsTablet).toBe(false);
  expect(config.ios.usesAppleSignIn).toBe(true);
  expect(config.ios.privacyManifests.NSPrivacyTracking).toBe(false);
  expect(config.ios.infoPlist.NSCameraUsageDescription).toBeTruthy();
  expect(config.ios.infoPlist.NSPhotoLibraryUsageDescription).toBeTruthy();
  expect(config.ios.infoPlist.NSFaceIDUsageDescription).toBeUndefined();
});

describe('payment', () => {
  const file = brandFile(brands[0]);
  const reactNativeConfig = (payDriver) => {
    const before = process.env.PAY_DRIVER;
    if (payDriver === undefined) delete process.env.PAY_DRIVER;
    else process.env.PAY_DRIVER = payDriver;
    let loaded;
    jest.isolateModules(() => { loaded = require('../react-native.config.js'); });
    if (before === undefined) delete process.env.PAY_DRIVER;
    else process.env.PAY_DRIVER = before;
    return loaded;
  };

  test('hosted is the default, and the gateway’s SDK is then not linked into either platform', () => {
    const config = configWith({ BRAND_FILE: file });
    expect(config.extra.payDriver).toBe('hosted');
    expect(pluginNames(config)).not.toContain('./plugins/with-native-pay.cjs');
    expect(pluginOptions(config, 'expo-build-properties').android.extraProguardRules).toBeUndefined();
    expect(reactNativeConfig(undefined).dependencies['react-native-razorpay']).toEqual({ platforms: { android: null, ios: null } });
    expect(reactNativeConfig('hosted').dependencies['react-native-razorpay']).toEqual({ platforms: { android: null, ios: null } });
  });

  test('PAY_DRIVER=native builds the SDK in, with its plugin', () => {
    const config = configWith({ BRAND_FILE: file, PAY_DRIVER: 'native' });
    expect(config.extra.payDriver).toBe('native');
    expect(pluginNames(config)).toContain('./plugins/with-native-pay.cjs');
    expect(pluginOptions(config, 'expo-build-properties').android.extraProguardRules).toMatch(/com\.razorpay/);
    expect(reactNativeConfig('native').dependencies).toEqual({});
    expect(configWith({ BRAND_FILE: file, PAY_DRIVER: 'card' }).extra.payDriver).toBe('hosted');
  });

  test('physical goods are never sold through in-app purchase: no purchase library is a dependency', () => {
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /iap|in-app-purchase|purchases|storekit|billing/i.test(name))).toEqual([]);
    expect(fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8')).toMatch(/PAY_DRIVER/);
  });
});

test('push is off until a brand has its own push settings, and the build then asks for no push entitlement', () => {
  const config = configWith({ BRAND_FILE: brandFile(brands[0]), APNS_ENV: 'production' });
  expect(config.extra.push).toEqual({ android: false, ios: false });
  expect(pluginNames(config)).not.toContain('expo-notifications');
  const on = configWith({ BRAND_FILE: tempBrand((b) => { b.push.ios = true; }), APNS_ENV: 'production' });
  expect(on.extra.push.ios).toBe(true);
  expect(pluginNames(on)).toContain('expo-notifications');
  expect(pluginOptions(on, 'expo-notifications').color).toBe(brandOf(brands[0]).colors.primary);
});

test('over-the-air updates are off without a server, and otherwise ask for the brand’s own channel', () => {
  const file = brandFile(brands[0]);
  expect(configWith({ BRAND_FILE: file }).updates).toEqual({ enabled: false });
  expect(configWith({ BRAND_FILE: file, UPDATES_URL: 'https://updates.example/manifest' }).updates).toMatchObject({ url: 'https://updates.example/manifest', requestHeaders: { 'expo-channel-name': brandOf(brands[0]).updates.channel } });
});

test('eas.json has the three profiles and names no project, account or brand', () => {
  const eas = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eas.json'), 'utf8'));
  expect(Object.keys(eas.build)).toEqual(['development', 'preview', 'production']);
  expect(JSON.stringify(eas)).not.toMatch(/projectId|owner|appleId|ascAppId|serviceAccountKeyPath|BRAND_FILE/);
  expect(eas.submit.production).toEqual({});
});

test('the app depends on the store’s client and the shared packages, and on nothing of the seller API', () => {
  expect(pkg.dependencies).toMatchObject({ '@bhava/store-client': '*', '@bhava/pay': '*', '@bhava/theme': '*', '@bhava/ui': '*', '@bhava/app-core': '*' });
  expect(pkg.dependencies['@bhava/api-client']).toBeUndefined();
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'android', 'ios', 'dist', '.expo'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(js|cjs|mjs)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
        const code = fs.readFileSync(full, 'utf8');
        // The bare package pulls in the seller's session and client; the shopper app takes app-core by its parts.
        const bare = ['@bhava/api-client', '@bhava/app-core'].some((name) => code.includes(`'${name}'`));
        if (bare || /\/api\/v1\b|(from |require\()['"][^'"]*\/src\/contracts/.test(code)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of ['apps/shopper', 'packages/store-client', 'packages/pay']) visit(path.join(ROOT, dir));
  expect(offenders).toEqual([]);
});

test('the brand reader knows every key a brand file has', () => {
  for (const name of brands) expect(Object.keys(brandOf(name)).sort()).toEqual([...BRAND_KEYS].sort());
});
