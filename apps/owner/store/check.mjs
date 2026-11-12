/**
 * `node apps/owner/store/check.mjs`: the store listings and privacy answers agree with the app (PRD 10.6, "iOS ready
 * from day one"). Run by app-tests in .github/workflows/apps.yml. Exits 1 and names each problem when:
 *
 *   - the app config asks for a permission (an Android permission, an iOS usage description, or one a plugin adds)
 *     that listing.json does not explain, or whose sentence is missing from either store description
 *   - listing.json explains a permission the app no longer asks for, or breaks a store's length limit
 *   - the app has a field, picker or SDK that collects something collection.json does not list with that file as a
 *     source, a source that no longer exists, or an analytics, crash or tracking SDK at all
 *   - a reason in privacy-manifest.json is not one Apple allows for that API, or names a package the app lacks
 *   - the privacy manifest in app.config.js, or the committed answers in play/ and app-store/, are not what
 *     collection.json gives (answers.cjs)
 *
 *   node apps/owner/store/check.mjs           the check
 *   node apps/owner/store/check.mjs --write   rewrites play/data-safety.json and app-store/app-privacy.json first
 *   node apps/owner/store/check.mjs --apk-badging <file>
 *                                             also: every permission the built APK holds (aapt2 dump badging), added
 *                                             by the config or by a library, is normal or explained in the listing
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const STORE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(STORE, '../../..');
const answers = require('./answers.cjs');

export const ANSWER_FILES = Object.freeze({ 'play/data-safety.json': () => answers.dataSafety(), 'app-store/app-privacy.json': () => answers.appPrivacy() });

/** Google Play's and the App Store's limits, in characters (keywords: bytes). */
export const LIMITS = Object.freeze({
  play: { title: 30, shortDescription: 80, fullDescription: 4000 },
  appStore: { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100 },
});

/** Apple's allowed reasons for each required-reason API. */
export const API_REASONS = Object.freeze({
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1'],
  NSPrivacyAccessedAPICategoryFileTimestamp: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
});

/** Plugin options that make prebuild add an iOS usage description. */
const PLUGIN_PERMISSIONS = Object.freeze({
  photosPermission: 'NSPhotoLibraryUsageDescription',
  cameraPermission: 'NSCameraUsageDescription',
  microphonePermission: 'NSMicrophoneUsageDescription',
  faceIDPermission: 'NSFaceIDUsageDescription',
  locationWhenInUsePermission: 'NSLocationWhenInUseUsageDescription',
  contactsPermission: 'NSContactsUsageDescription',
  calendarPermission: 'NSCalendarsUsageDescription',
  savePhotosPermission: 'NSPhotoLibraryAddUsageDescription',
});

/**
 * What in the app's code collects something, and the collection.json item it belongs to. A line that matches must be
 * in a file that item lists as a source.
 */
export const SIGNALS = Object.freeze([
  { item: 'phone', pattern: /autoComplete="tel"|keyboardType="phone-pad"|textContentType="telephoneNumber"/ },
  { item: 'email', pattern: /autoComplete="email"|keyboardType="email-address"|textContentType="emailAddress"/ },
  { item: 'name', pattern: /autoComplete="(?:name|organization)"|textContentType="(?:name|organizationName)"/ },
  { item: 'address', pattern: /<(?:Field|TextInput)\b[^>]*testID=["'{`][^"'`]*(?:pincode|line1|address)/i },
  { item: 'payment-details', pattern: /testID="[^"]*upi-id"|name: 'razorpayKey(?:Id|Secret)'/ },
  { item: 'photos', pattern: /['"]expo-image-picker['"]/ },
  { item: 'files', pattern: /['"]expo-document-picker['"]/ },
  { item: 'device', pattern: /['"]expo-device['"]|getDevicePushTokenAsync/ },
  { item: 'user-id', pattern: /identityToken|['"]expo-apple-authentication['"]/ },
  { item: 'messages', pattern: /api\.inbox\.reply\(/ },
  { item: 'content', pattern: /api\.automations\.(?:create|update)\(/ },
]);

/** Packages that collect something on their own: none may be a dependency without an item and a store answer. */
export const COLLECTING_PACKAGES = /^(?:expo-location|expo-contacts|expo-calendar|expo-media-library|expo-sensors|expo-av|expo-audio|expo-camera|expo-tracking-transparency|expo-insights|react-native-fbsdk-next|@react-native-firebase\/.+|@sentry\/.+|sentry-expo|@segment\/.+|@amplitude\/.+|mixpanel-react-native|react-native-appsflyer|react-native-branch|@bugsnag\/.+|@datadog\/.+|react-native-device-info|@react-native-community\/geolocation)$/;

const SCANNED = ['apps/owner/src', 'packages/app-core/src', 'packages/ui/src'];
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__mocks__'].includes(entry.name)) walk(full, out);
    } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** The owner app's config as Expo reads it, with no build settings set. */
export function readAppConfig(root = ROOT, env = {}) {
  const file = path.join(root, 'apps/owner/app.config.js');
  const saved = { ...process.env };
  Object.assign(process.env, { APP_ENV: '', API_BASE_URL: '', GOOGLE_SERVICES_JSON: '', APNS_ENV: '', ...env });
  try {
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'apps/owner/'))) delete require.cache[key];
    const made = require(file);
    return typeof made === 'function' ? made({ config: {} }) : made;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** Every permission the config asks for: Android permissions, iOS usage descriptions, and those plugins add. */
export function askedPermissions(config) {
  const asked = new Set(config.android?.permissions ?? []);
  for (const key of Object.keys(config.ios?.infoPlist ?? {})) if (/^NS\w+UsageDescription$/.test(key)) asked.add(key);
  for (const plugin of config.plugins ?? []) {
    const options = Array.isArray(plugin) ? plugin[1] : null;
    for (const [option, key] of Object.entries(PLUGIN_PERMISSIONS)) if (typeof options?.[option] === 'string' && options[option]) asked.add(key);
  }
  return asked;
}

const PLAY_ONLY = /\b(?:iPhone|iPad|iOS|App Store|Apple Watch)\b/;
const APPLE_ONLY = /\b(?:Android|Google Play|Play Store)\b/;

export function listingProblems(listing, config) {
  const problems = [];
  const { play, appStore } = listing;
  if (listing.appName !== config.name) problems.push(`listing.json names the app "${listing.appName}", but the app is "${config.name}"`);
  if (play.title !== listing.appName || appStore.name !== listing.appName) problems.push('The store titles must be the app name, Bhava for Business');
  for (const [store, limits] of Object.entries(LIMITS)) {
    for (const [field, max] of Object.entries(limits)) {
      const value = listing[store]?.[field];
      if (typeof value !== 'string' || !value.trim()) problems.push(`listing.json: ${store}.${field} is empty`);
      else if ((field === 'keywords' ? Buffer.byteLength(value) : [...value].length) > max) problems.push(`listing.json: ${store}.${field} is longer than ${max}`);
    }
  }
  const playText = [play.title, play.shortDescription, play.fullDescription].join('\n');
  const appleText = [appStore.name, appStore.subtitle, appStore.promotionalText, appStore.description, appStore.keywords].join('\n');
  if (PLAY_ONLY.test(playText)) problems.push(`The Play listing mentions "${PLAY_ONLY.exec(playText)[0]}"`);
  if (APPLE_ONLY.test(appleText)) problems.push(`The App Store listing mentions "${APPLE_ONLY.exec(appleText)[0]}"`);
  const asked = askedPermissions(config);
  for (const permission of asked) {
    const sentence = listing.permissions?.[permission];
    if (!sentence) problems.push(`The app asks for ${permission}, and the store listing does not explain it: add it to permissions in apps/owner/store/listing.json`);
    else {
      if (!play.fullDescription.includes(sentence)) problems.push(`${permission} is explained as "${sentence}", which the Play description does not say`);
      if (!appStore.description.includes(sentence)) problems.push(`${permission} is explained as "${sentence}", which the App Store description does not say`);
    }
  }
  for (const permission of Object.keys(listing.permissions ?? {})) if (!asked.has(permission)) problems.push(`listing.json explains ${permission}, which the app does not ask for: delete it`);
  return problems;
}

function dependenciesOf(root) {
  const deps = new Set();
  for (const dir of ['apps/owner', ...fs.readdirSync(path.join(root, 'packages')).map((name) => `packages/${name}`)]) {
    const file = path.join(root, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) deps.add(name);
  }
  return deps;
}

export function collectionProblems(root = ROOT, collection = answers.collection) {
  const problems = answers.shapeProblems(collection);
  const items = new Map(collection.items.map((item) => [item.id, item]));
  for (const item of collection.items) {
    for (const source of item.sources ?? []) if (!fs.existsSync(path.join(root, source))) problems.push(`collection.json: "${item.id}" names ${source}, which does not exist`);
  }
  const found = new Map();
  for (const dir of SCANNED) {
    for (const file of walk(path.join(root, dir))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const signal of SIGNALS) {
        const index = lines.findIndex((line) => signal.pattern.test(line));
        if (index >= 0) found.set(`${signal.item}|${rel(root, file)}`, index + 1);
      }
    }
  }
  for (const [key, line] of found) {
    const [id, file] = key.split('|');
    if (!items.get(id)?.sources?.includes(file)) problems.push(`${file}:${line} collects "${id}", but collection.json does not list that file for it: add it to the item's sources (and check the answers still hold)`);
  }
  for (const name of dependenciesOf(root)) if (COLLECTING_PACKAGES.test(name)) problems.push(`${name} is a dependency of the apps: it collects data the store answers do not cover. Add it to collection.json and the answers, or remove it`);
  return problems;
}

export function manifestProblems(root = ROOT, config = readAppConfig(root), privacy = answers.manifest) {
  const problems = [];
  const deps = dependenciesOf(root);
  for (const api of privacy.accessedApis) {
    const allowed = API_REASONS[api.type];
    if (!allowed) problems.push(`privacy-manifest.json: ${api.type} is not a required-reason API`);
    for (const reason of api.reasons ?? []) if (allowed && !allowed.includes(reason)) problems.push(`privacy-manifest.json: ${reason} is not a reason Apple allows for ${api.type}`);
    if (!api.reasons?.length) problems.push(`privacy-manifest.json: ${api.type} has no reason`);
    if (!api.why) problems.push(`privacy-manifest.json: ${api.type} does not say why`);
    for (const name of api.usedBy ?? []) if (!deps.has(name)) problems.push(`privacy-manifest.json: ${api.type} names ${name}, which the owner app does not depend on`);
  }
  if (JSON.stringify(config.ios?.privacyManifests) !== JSON.stringify(answers.privacyManifest())) {
    problems.push('The privacy manifest in apps/owner/app.config.js is not the one apps/owner/store/answers.cjs gives: build it with privacyManifest()');
  }
  return problems;
}

export function answerFileProblems(root = ROOT, { write = false } = {}) {
  const problems = [];
  for (const [name, make] of Object.entries(ANSWER_FILES)) {
    const file = path.join(root, 'apps/owner/store', name);
    const want = `${JSON.stringify(make(), null, 2)}\n`;
    if (write) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, want);
    } else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== want) {
      problems.push(`apps/owner/store/${name} is not what collection.json gives: run node apps/owner/store/check.mjs --write and commit it`);
    }
  }
  return problems;
}

/**
 * Android permissions of protection level "normal": granted at install, shown to no one, so no listing sentence. Every
 * other permission the built APK holds must be explained, whichever library added it.
 */
export const NORMAL_ANDROID_PERMISSIONS = Object.freeze(new Set([
  'android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.ACCESS_WIFI_STATE', 'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK', 'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.FOREGROUND_SERVICE', 'android.permission.USE_FINGERPRINT',
  'com.google.android.c2dm.permission.RECEIVE',
]));

/**
 * What the built APK asks for, from `aapt2 dump badging` (run by the android job): each permission that is not
 * normal and not the app's own must be explained in listing.json. This catches one a library adds at build time.
 */
export function apkPermissionProblems(badging, listing, { appId = 'com.bhava.business' } = {}) {
  const held = [...String(badging).matchAll(/^uses-permission: name='([^']+)'/gm)].map((m) => m[1]);
  if (!/^package: name='/m.test(String(badging))) return ['This is not the output of aapt2 dump badging'];
  return [...new Set(held)]
    .filter((name) => !NORMAL_ANDROID_PERMISSIONS.has(name) && !name.startsWith(`${appId}.`) && !listing.permissions?.[name])
    .map((name) => `The APK holds ${name}, and the store listing does not explain it: add it to permissions in apps/owner/store/listing.json, or block it in app.config.js`);
}

/** Every problem, in the order the header lists them. */
export function checkStore(root = ROOT, { write = false, badging = null } = {}) {
  const config = readAppConfig(root);
  const listing = JSON.parse(fs.readFileSync(path.join(root, 'apps/owner/store/listing.json'), 'utf8'));
  return [
    ...listingProblems(listing, config), ...collectionProblems(root), ...manifestProblems(root, config), ...answerFileProblems(root, { write }),
    ...(badging === null ? [] : apkPermissionProblems(badging, listing, { appId: config.android.package })),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const badgingFile = argv.includes('--apk-badging') ? argv[argv.indexOf('--apk-badging') + 1] : null;
  const problems = checkStore(ROOT, { write: argv.includes('--write'), badging: badgingFile ? fs.readFileSync(badgingFile, 'utf8') : null });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`\nstore: ${problems.length} problem(s). The listings and privacy answers must match what the app asks for and collects.`);
    process.exit(1);
  }
  console.log(`store: listings explain ${askedPermissions(readAppConfig()).size} permissions; ${answers.collection.items.length} kinds of data in the privacy answers.`);
}
