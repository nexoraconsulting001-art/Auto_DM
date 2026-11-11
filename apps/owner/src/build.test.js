/**
 * What the build is made of: the config for both platforms, where secrets may live, and that tests cannot reach
 * the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OWNER_APP_SCHEME } from '@bhava/app-core';

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '../..');
const SETTINGS = ['API_BASE_URL', 'APP_ID', 'APP_ENV', 'GOOGLE_SERVICES_JSON', 'APNS_ENV', 'UPDATES_URL', 'HIDE_PLAN_PURCHASE'];

function config(env = {}) {
  const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of SETTINGS) delete process.env[name];
  Object.assign(process.env, env);
  try {
    let made;
    jest.isolateModules(() => {
      made = require('../app.config.js')();
    });
    return made;
  } finally {
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const pluginNames = (cfg) => cfg.plugins.map((p) => (Array.isArray(p) ? p[0] : typeof p === 'function' ? `fn:${p.name}` : p));

test('with no setting and no account the app still has a complete config for both platforms', () => {
  const cfg = config();
  expect(cfg.name).toBe('Bhava for Business');
  expect(cfg.version).toBe(require('../package.json').version);
  expect(cfg.runtimeVersion).toEqual({ policy: 'fingerprint' });
  expect(cfg.android.package).toBe('com.bhava.business');
  expect(cfg.ios.bundleIdentifier).toBe('com.bhava.business');
  expect(cfg.platforms).toEqual(['android', 'ios']);
  expect(cfg.ios.supportsTablet).toBe(false);
  expect(cfg.android.googleServicesFile).toBeUndefined();
  expect(pluginNames(cfg)).not.toContain('expo-notifications');
  expect(pluginNames(cfg)).toContain('fn:withoutPushEntitlement');
  expect(cfg.updates).toEqual({ enabled: false });
  expect(cfg.extra).toMatchObject({ apiBaseUrl: 'http://localhost:3000', push: { android: false, ios: false } });
  expect(cfg.owner).toBeUndefined();
  expect(cfg.extra.eas).toBeUndefined(); // no project id
});

test('the link scheme is the one the server writes into pushes and the browser sign-in', () => {
  const cfg = config();
  expect(cfg.scheme).toContain(OWNER_APP_SCHEME);
  expect(cfg.scheme).toContain('bhava');
});

test('the application id, API address and push settings come from build settings', () => {
  const cfg = config({ APP_ID: 'com.example.owner', API_BASE_URL: 'https://app.example.com/', APNS_ENV: 'production', APP_ENV: 'production', UPDATES_URL: 'https://updates.example.com/owner' });
  expect(cfg.android.package).toBe('com.example.owner');
  expect(cfg.ios.bundleIdentifier).toBe('com.example.owner');
  expect(cfg.extra.apiBaseUrl).toBe('https://app.example.com');
  expect(cfg.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-notifications')[1]).toMatchObject({ mode: 'production' });
  expect(pluginNames(cfg)).not.toContain('fn:withoutPushEntitlement');
  expect(cfg.updates.url).toBe('https://updates.example.com/owner');
  expect(cfg.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties')[1].android.usesCleartextTraffic).toBe(false);
  expect(cfg.ios.infoPlist.NSAppTransportSecurity).toBeUndefined();
});

test('a google-services file is used only when it exists', () => {
  expect(config({ GOOGLE_SERVICES_JSON: './no-such-file.json' }).android.googleServicesFile).toBeUndefined();
  const cfg = config({ GOOGLE_SERVICES_JSON: './package.json' }); // any file that exists stands in for it
  expect(cfg.android.googleServicesFile).toBe('./package.json');
  expect(pluginNames(cfg)).toContain('expo-notifications');
  expect(pluginNames(cfg)).toContain('fn:withoutPushEntitlement'); // Android push alone adds no iOS entitlement
});

test('a bad application id or API address stops the build, and production needs https', () => {
  expect(() => config({ APP_ID: 'not an id' })).toThrow(/APP_ID/);
  expect(() => config({ API_BASE_URL: 'https://app.example.com/api/v1' })).toThrow(/API_BASE_URL/);
  expect(() => config({ APP_ENV: 'production' })).toThrow(/https/);
  expect(() => config({ APP_ENV: 'production', API_BASE_URL: 'http://app.example.com' })).toThrow(/https/);
});

test('Android targets API 36 and asks only for what the app uses', () => {
  const cfg = config();
  const build = cfg.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties')[1];
  expect(build.android.targetSdkVersion).toBeGreaterThanOrEqual(36);
  expect(cfg.android.permissions.sort()).toEqual(['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'android.permission.USE_BIOMETRIC']);
  expect(cfg.android.blockedPermissions).toEqual(expect.arrayContaining(['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE']));
  expect(cfg.android.allowBackup).toBe(false);
});

test('iOS has its permission texts, Sign in with Apple and a privacy manifest with no tracking', () => {
  const { ios } = config();
  for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSFaceIDUsageDescription']) expect(ios.infoPlist[key].length).toBeGreaterThan(20);
  expect(ios.usesAppleSignIn).toBe(true);
  expect(ios.privacyManifests.NSPrivacyTracking).toBe(false);
  expect(ios.privacyManifests.NSPrivacyTrackingDomains).toEqual([]);
  expect(ios.privacyManifests.NSPrivacyCollectedDataTypes.every((t) => t.NSPrivacyCollectedDataTypeTracking === false)).toBe(true);
  expect(ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t) => t.NSPrivacyAccessedAPIType)).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
});

test('eas.json has the three profiles and names no project or account', () => {
  const text = fs.readFileSync(path.join(APP, 'eas.json'), 'utf8');
  expect(Object.keys(JSON.parse(text).build)).toEqual(['development', 'preview', 'production']);
  expect(text).not.toMatch(/projectId|appleId|ascAppId|appleTeamId|serviceAccountKeyPath/);
});

test('every icon the config names is in the repository', () => {
  const cfg = config();
  const files = [cfg.icon, cfg.android.adaptiveIcon.foregroundImage, cfg.android.adaptiveIcon.monochromeImage, cfg.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen')[1].image, './assets/notification.png', './assets/logo.png'];
  for (const file of files) expect([file, fs.existsSync(path.join(APP, file))]).toEqual([file, true]);
});

describe('where tokens may live', () => {
  const SKIP = new Set(['node_modules', 'android', 'ios', 'dist', '.expo']);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIP.has(entry.name)) return [];
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const workspaces = [...fs.readdirSync(path.join(ROOT, 'apps')).map((n) => path.join(ROOT, 'apps', n)), ...fs.readdirSync(path.join(ROOT, 'packages')).map((n) => path.join(ROOT, 'packages', n))];

  test('nothing in apps/ or packages/ imports AsyncStorage, and no workspace depends on it', () => {
    const offenders = [];
    for (const workspace of workspaces) {
      for (const file of walk(workspace)) {
        if (!/\.(jsx?|tsx?|mjs|cjs|json)$/.test(file) || /\.test\.jsx?$/.test(file)) continue;
        const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''); // comments may say where tokens must not go
        if (/async-storage|AsyncStorage/.test(code)) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('only @bhava/app-core’s storage.js touches SecureStore', () => {
    const users = [];
    for (const workspace of workspaces) {
      for (const file of walk(workspace)) {
        if (!/\.jsx?$/.test(file) || /\.test\.jsx?$/.test(file)) continue;
        if (/from 'expo-secure-store'|require\('expo-secure-store'\)/.test(fs.readFileSync(file, 'utf8'))) users.push(path.relative(ROOT, file).split(path.sep).join('/'));
      }
    }
    expect(users).toEqual(['packages/app-core/src/storage.js']);
  });
});

describe('the network guard', () => {
  test('a call to any host but this machine is refused before it leaves', async () => {
    await expect(fetch('https://graph.facebook.com/v1/me')).rejects.toMatchObject({ code: 'ENETGUARD' });
    await expect(fetch('https://example.com')).rejects.toThrow(/only reach localhost/);
    expect(() => new WebSocket('wss://example.com/socket')).toThrow(/refused/);
    expect(() => new XMLHttpRequest().open('GET', 'https://example.com/')).toThrow(/refused/);
  });

  test('localhost is let through to the real fetch', async () => {
    // Nothing listens on port 9, so the call fails, but not because the guard refused it.
    const error = await fetch('http://127.0.0.1:9/').catch((e) => e);
    expect(error.code).not.toBe('ENETGUARD');
  });

  test('a raw socket to another host is refused too', async () => {
    const net = require('node:net');
    const error = await new Promise((resolve) => {
      const socket = net.connect({ host: 'example.com', port: 443 });
      socket.on('error', resolve);
      socket.on('connect', () => resolve(new Error('connected')));
    });
    expect(error.code).toBe('ENETGUARD');
  });
});
