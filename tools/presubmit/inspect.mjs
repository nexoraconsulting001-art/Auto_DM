/**
 * Gathers the facts of a built app for the pre-submit gate (checks.mjs). A "built app" is the app's project folder as the build
 * used it: its package.json (what is linked into the binary), its source (the screens, the launch path), its resolved app
 * config (written beside it as app.config.json, or worked out here by running app.config.js for the build's brand file), and
 * the toolchain that built it. Nothing here writes a file, and nothing it reads is printed: only the facts come back.
 *
 *   inspectApp({ appDir, brandFile?, config?, toolchain? })  -> AppFacts (see checks.mjs)
 *   releaseFacts({ appDir, brandFile })                      -> the facts every brand's build of this app version shares, without
 *                                                               the brand's own texts (the server adds those from the brand)
 *   parseToolchain(text)                                     -> { xcode, sdk } from `xcodebuild -version; xcodebuild -showsdks`
 *
 * The workspace packages the app depends on (packages/*) are read too: their dependencies are linked into the same binary.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Xcode of EAS's default build image when eas.json pins none, by Expo SDK. Taken from Expo's published image list when this
 * was written; not re-read from Expo in this build (no outside traffic). Pin an image in eas.json to make it exact.
 */
export const EAS_DEFAULT_TOOLCHAIN = Object.freeze([Object.freeze({ minExpoSdk: 54, xcode: '26.0', sdk: '26.0' })]);
const LAUNCH_FILES = ['App.js', 'index.js', 'src/App.js', 'src/services.js', 'src/shell'];
const ASKS_FOR_PUSH = /requestPermissionsAsync\s*\(|registerForPushNotificationsAsync\s*\(/;
const SHOWS_WEBVIEW = /from\s+['"][^'"]*webview[^'"]*['"]|require\(\s*['"][^'"]*webview[^'"]*['"]\s*\)|<WebView\b/i;
const SOURCE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|__mocks__)/;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file) => fs.existsSync(file);

function sourceFiles(dir) {
  if (!exists(dir)) return [];
  if (fs.statSync(dir).isFile()) return SOURCE.test(dir) ? [dir] : [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE.test(entry.name) && !TEST_FILE.test(full)) out.push(full);
  }
  return out;
}

/** The workspace packages beside the app (../../packages/* and ../../shared/*), by package name. */
function workspacePackages(appDir) {
  const found = new Map();
  for (const folder of ['packages', 'shared']) {
    const root = path.resolve(appDir, '..', '..', folder);
    if (!exists(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const manifest = path.join(root, entry.name, 'package.json');
      if (entry.isDirectory() && exists(manifest)) found.set(readJson(manifest).name, path.join(root, entry.name));
    }
  }
  return found;
}

/** The app's resolved config: app.config.json beside it, or app.config.js run for `brandFile` in a child process (production). */
export function resolveConfig(appDir, brandFile) {
  const written = path.join(appDir, 'app.config.json');
  if (exists(written)) {
    const config = readJson(written);
    return config.expo ?? config;
  }
  if (!brandFile) throw new Error('Give the brand file the app was built for (--brand), or an app.config.json beside the app');
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js")()))'], {
    cwd: appDir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, BRAND_FILE: path.resolve(brandFile), APP_ENV: 'production' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return JSON.parse(out);
}

/** { xcode, sdk } from the text of `xcodebuild -version` and `xcodebuild -showsdks` (or the CI's "Xcode 26.0 / -sdk iphoneos26.0"). */
export function parseToolchain(text) {
  const xcode = /Xcode\s+([0-9]+(?:\.[0-9]+){0,2})/.exec(String(text ?? ''))?.[1] ?? null;
  const sdks = [...String(text ?? '').matchAll(/iphoneos([0-9]+(?:\.[0-9]+)?)/g)].map((m) => m[1]);
  const sdk = sdks.sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))[0] ?? null;
  return { xcode, sdk };
}

/** The production iOS toolchain: the image eas.json pins, or EAS's default image for the app's Expo SDK. */
export function easToolchain(appDir, expoSdk) {
  const easFile = path.join(appDir, 'eas.json');
  const image = exists(easFile) ? readJson(easFile)?.build?.production?.ios?.image : undefined;
  if (image && image !== 'default' && image !== 'latest') {
    const xcode = /xcode-([0-9]+(?:\.[0-9]+)?)/i.exec(String(image))?.[1] ?? null;
    return { xcode, sdk: xcode, source: `eas.json image ${image}` };
  }
  const known = EAS_DEFAULT_TOOLCHAIN.filter((t) => Number(expoSdk) >= t.minExpoSdk).at(-1);
  return known ? { xcode: known.xcode, sdk: known.sdk, source: `EAS default image for Expo SDK ${expoSdk}` } : { xcode: null, sdk: null, source: 'unknown' };
}

const majorOf = (range) => Number.parseInt(String(range ?? '').replace(/^[^0-9]*/, ''), 10) || null;
const rel = (appDir, file) => path.relative(path.resolve(appDir, '..', '..'), file).split(path.sep).join('/');

function pluginOptions(config, name) {
  const entry = (config.plugins ?? []).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  return Array.isArray(entry) ? entry[1] ?? {} : {};
}

/** The brand's own texts in a resolved config: its names, ids, scheme and hosts. */
function brandTextsOf(config) {
  const hosts = (config.ios?.associatedDomains ?? []).map((d) => String(d).replace(/^applinks:/, ''));
  const brand = config.extra?.brand ?? {};
  return [config.name, config.slug, config.scheme, config.ios?.bundleIdentifier, config.android?.package, config.ios?.infoPlist?.CFBundleDisplayName,
    brand.name, brand.shortName, ...(Array.isArray(brand.hosts) ? brand.hosts : []), ...hosts].filter((t) => typeof t === 'string' && t);
}

/** Everything the gate asks of a built app, without the brand's texts. */
function facts(appDir, config, toolchain) {
  const manifest = readJson(path.join(appDir, 'package.json'));
  const packages = workspacePackages(appDir);
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const sourceDirs = [path.join(appDir, 'App.js'), path.join(appDir, 'index.js'), path.join(appDir, 'src')];
  // Breadth first: a workspace package's own workspace dependencies are linked in too.
  for (const name of dependencies) {
    const dir = packages.get(name);
    if (!dir) continue;
    for (const dep of Object.keys(readJson(path.join(dir, 'package.json')).dependencies ?? {})) dependencies.add(dep);
    sourceDirs.push(path.join(dir, 'src'));
  }
  // The workspace packages are the app's own code, read above; what they link in is what counts.
  const storeClientName = [...dependencies].find((d) => /\/store-client$/.test(d)) ?? '';
  for (const name of packages.keys()) dependencies.delete(name);
  const files = sourceDirs.flatMap(sourceFiles);
  const textOf = (file) => fs.readFileSync(file, 'utf8');
  const featuresDir = path.join(appDir, 'src', 'features');
  const features = exists(featuresDir) ? fs.readdirSync(featuresDir, { withFileTypes: true }).filter((e) => e.isDirectory() && exists(path.join(featuresDir, e.name, 'index.js'))).map((e) => e.name).sort() : [];
  const accountIndex = path.join(featuresDir, 'account', 'index.js');
  const storeClient = packages.get(storeClientName);
  const deleteCall = (dir) => sourceFiles(dir).some((file) => /appAccountDelete/.test(textOf(file)));
  const expoSdk = majorOf(manifest.dependencies?.expo);
  const buildProperties = pluginOptions(config, 'expo-build-properties');
  return {
    appVersion: String(manifest.version ?? ''),
    expoSdk,
    dependencies: [...dependencies].sort(),
    webviewImports: files.filter((file) => SHOWS_WEBVIEW.test(textOf(file))).map((file) => rel(appDir, file)).sort(),
    features,
    accountDeleteScreen: exists(accountIndex) && /name:\s*['"]delete['"]/.test(textOf(accountIndex)),
    accountDeleteCall: Boolean(storeClient && deleteCall(path.join(storeClient, 'src'))) || deleteCall(path.join(appDir, 'src')),
    pushAtLaunch: LAUNCH_FILES.flatMap((name) => sourceFiles(path.join(appDir, name))).filter((file) => ASKS_FOR_PUSH.test(textOf(file))).map((file) => rel(appDir, file)).sort(),
    android: {
      targetSdkVersion: Number(buildProperties.android?.targetSdkVersion ?? config.android?.targetSdkVersion) || null,
      permissions: [...(config.android?.permissions ?? [])].sort(),
      blockedPermissions: [...(config.android?.blockedPermissions ?? [])].sort(),
    },
    ios: {
      privacyManifest: config.ios?.privacyManifests ?? null,
      entitlements: config.ios?.entitlements ?? {},
      usesAppleSignIn: config.ios?.usesAppleSignIn === true,
      toolchain: toolchain ?? easToolchain(appDir, expoSdk),
    },
  };
}

/** The facts of one built app, the brand's own texts included. */
export function inspectApp({ appDir, brandFile, config, toolchain } = {}) {
  if (!appDir || !exists(path.join(appDir, 'package.json'))) throw new Error('Give the built app’s folder (--app), the one with its package.json');
  const resolved = config ?? resolveConfig(appDir, brandFile);
  return { ...facts(appDir, resolved, toolchain), brandTexts: brandTextsOf(resolved) };
}

/** What every brand's build of this app version shares. Run with any brand file: its own texts are left out. */
export function releaseFacts({ appDir, brandFile, toolchain } = {}) {
  const { brandTexts: _brand, ...shared } = inspectApp({ appDir, brandFile, toolchain });
  return shared;
}
