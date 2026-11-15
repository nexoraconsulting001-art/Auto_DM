/**
 * The glue of the showcase builds (Phase 8, Q-11): the same steps the workflow runs, so they can be run by hand.
 *
 *   node tools/showcase-build/index.mjs brands <folder>
 *       load both sample businesses on a built-in database and export each one's brand file under <folder>/<key>/.
 *   node tools/showcase-build/index.mjs build <folder> <key> --platform android|ios [--out <folder>]
 *       build one business's app from its brand file with the local driver: an APK (checked for its package, name, icon,
 *       colours, and for no other business and no platform name), or an iOS simulator app on a Mac.
 *   node tools/showcase-build/index.mjs owner [--out <folder>]
 *       build the owner app's APK against the same server address.
 *   node tools/showcase-build/index.mjs note <folder> --out <file>
 *       the short install note that goes with the APKs in <folder>.
 *
 * One setting points every build and every flow at a server: SHOWCASE_API_URL. Unset, an Android build reaches the job's own
 * server at http://10.0.2.2:3000 and an iOS build at http://localhost:3000; set it to the QA server's address to build
 * against that. Nothing here needs an account. The Android signing key is made for the run, never printed, and deleted.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLog } from '../../apps/shopper/.maestro/support/scan-binary.mjs';
import { checkApkBadging } from '../build-check.mjs';
import { ShowcaseBuildError, apiUrl, holdsSecret, installNote, readZip, verifyApkBrand } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Runs a command with its output in `logFile`; never on the console. Resolves the exit code. */
function run(command, args, { cwd = ROOT, env = process.env, logFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, out], shell: process.platform === 'win32' });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => {
      fs.closeSync(out);
      resolve(code ?? 1);
    });
  });
}

const tail = (file, lines = 60) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n') : '');

/** A signing key for this run only: a keystore and its password, made here, never printed, deleted by `dispose`. */
export function makeSigningKey({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-key-')), keytool = 'keytool', env = process.env } = {}) {
  const password = crypto.randomBytes(24).toString('hex');
  // On a runner the password is masked in everything the job prints, before it exists anywhere else.
  if (env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`);
  const storeFile = path.join(dir, 'showcase.keystore');
  const made = spawnSync(keytool, ['-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', storeFile, '-alias', 'ci', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
    '-storepass', password, '-keypass', password, '-dname', 'CN=Showcase build, O=Sample'], { encoding: 'utf8' });
  if (made.status !== 0) throw new ShowcaseBuildError('keytool could not make a signing key for this build (is a JDK installed?)');
  return {
    env: { ANDROID_KEYSTORE_FILE: storeFile, ANDROID_KEYSTORE_PASSWORD: password, ANDROID_KEY_ALIAS: 'ci' },
    password,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Looks at a finished build log; a key or password in it fails the build. Prints where, never what. */
export function checkLog(logFile, secrets = []) {
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const problems = scanLog(text, { secrets });
  if (problems.length || holdsSecret(text, secrets)) throw new ShowcaseBuildError(`The build log holds a key or a password (line ${problems[0]?.line ?? '?'}); it was not kept`);
}

function aapt2Badging(apk) {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!home) return null;
  const tools = path.join(home, 'build-tools');
  if (!fs.existsSync(tools)) return null;
  const version = fs.readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const exe = path.join(tools, version ?? '', process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
  if (!fs.existsSync(exe)) return null;
  const result = spawnSync(exe, ['dump', 'badging', apk], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** Every check on a built APK against its business's brand file and the other businesses'. Throws ShowcaseBuildError listing the problems. */
export function checkApk(apk, brand, others) {
  const problems = [];
  const badging = aapt2Badging(apk);
  if (badging) problems.push(...checkApkBadging(badging, { packageName: brand.android.package, label: brand.shortName }).problems);
  else console.log('showcase-build: aapt2 is not available here, so the name and package are checked in the APK\'s files only');
  problems.push(...verifyApkBrand(readZip(fs.readFileSync(apk)), brand, { others }).problems);
  if (problems.length) throw new ShowcaseBuildError(`The APK is not right for its business:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

const brandFiles = (folder) => fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(folder, e.name, 'brand.json'))).map((e) => e.name).sort();

async function buildShopper({ folder, key, platform, outDir }) {
  const keys = brandFiles(folder);
  if (!keys.includes(key)) throw new ShowcaseBuildError(`There is no brand file for "${key}" in ${folder}`);
  const file = path.join(folder, key, platform === 'ios' ? 'brand-ios.json' : 'brand.json');
  const brand = readJson(file);
  const others = keys.filter((k) => k !== key).map((k) => readJson(path.join(folder, k, 'brand.json')));
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-build-'));
  const logFile = path.join(work, 'build.log');
  const report = path.join(work, 'report.json');
  const signing = platform === 'android' && !process.env.ANDROID_KEYSTORE_FILE ? makeSigningKey() : null;
  const env = { ...process.env, ...(signing?.env ?? {}), API_BASE_URL: apiUrl(platform) };
  try {
    const code = await run(process.execPath, ['tools/build-brand/index.mjs', file, '--platform', platform, '--driver', 'local', '--profile', platform === 'ios' ? 'simulator' : 'preview', '--out', path.join(work, 'brands'), '--report', report], { env, logFile });
    checkLog(logFile, [env.ANDROID_KEYSTORE_PASSWORD]);
    if (code !== 0) throw new ShowcaseBuildError(`The ${platform} build of "${key}" failed:\n${tail(logFile)}`);
    const artifact = readJson(report).builds?.[0]?.artifact;
    if (!artifact || !fs.existsSync(artifact)) throw new ShowcaseBuildError(`The ${platform} build of "${key}" made no file`);
    if (platform === 'android') {
      checkApk(artifact, brand, others);
      const target = path.join(outDir, `showcase-${key}.apk`);
      fs.copyFileSync(artifact, target);
      return target;
    }
    const target = path.join(outDir, `showcase-${key}-ios-simulator.zip`);
    const zip = spawnSync('zip', ['-qry', path.resolve(target), path.basename(artifact)], { cwd: path.dirname(artifact) });
    if (zip.status !== 0) throw new ShowcaseBuildError('zip could not pack the iOS simulator app');
    return target;
  } finally {
    signing?.dispose();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function buildOwner({ outDir }) {
  const dir = path.join(ROOT, 'apps', 'owner');
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-owner-'));
  const logFile = path.join(work, 'build.log');
  const signing = makeSigningKey();
  const env = { ...process.env, APP_ENV: 'preview', API_BASE_URL: apiUrl('android'), EXPO_NO_TELEMETRY: '1', CI: '1' };
  try {
    let code = await run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], { cwd: dir, env, logFile });
    if (code === 0) {
      const { ANDROID_KEYSTORE_FILE: store, ANDROID_KEYSTORE_PASSWORD: pass } = signing.env;
      code = await run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:assembleRelease', '--no-daemon', '-PreactNativeArchitectures=x86_64',
        `-Pandroid.injected.signing.store.file=${store}`, `-Pandroid.injected.signing.store.password=${pass}`, '-Pandroid.injected.signing.key.alias=ci', `-Pandroid.injected.signing.key.password=${pass}`],
      { cwd: path.join(dir, 'android'), env, logFile });
    }
    checkLog(logFile, [signing.password]);
    if (code !== 0) throw new ShowcaseBuildError(`The owner app build failed:\n${tail(logFile)}`);
    const apk = path.join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    if (!fs.existsSync(apk)) throw new ShowcaseBuildError('The owner app build made no APK');
    const target = path.join(outDir, 'showcase-owner.apk');
    fs.copyFileSync(apk, target);
    return target;
  } finally {
    signing.dispose();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The install note for the APKs of `folder` (brand files) and `apkDir`. */
export function writeNote({ folder, apkDir, out }) {
  const builds = brandFiles(folder).map((key) => {
    const brand = readJson(path.join(folder, key, 'brand.json'));
    return { name: brand.name, shortName: brand.shortName, package: brand.android.package, file: `showcase-${key}.apk` };
  });
  const owner = fs.existsSync(path.join(apkDir, 'showcase-owner.apk')) ? { file: 'showcase-owner.apk' } : null;
  fs.writeFileSync(out, installNote({ builds, apiUrl: apiUrl('android'), owner }));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : '');
  const positional = rest.filter((arg, i) => !arg.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  if (command === 'brands' && positional[0]) {
    const code = spawnSync(process.execPath, ['tools/showcase-build/server.mjs', '--mode', 'export', '--brands', path.resolve(positional[0])], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development', ALLOW_PGLITE: '1', SIM_BASE_PORT: process.env.SIM_BASE_PORT || '0' } }).status;
    return code ?? 1;
  }
  if (command === 'build' && positional.length === 2 && flag('--platform')) {
    const target = await buildShopper({ folder: path.resolve(positional[0]), key: positional[1], platform: flag('--platform'), outDir: path.resolve(flag('--out') || 'showcase-out') });
    console.log(`showcase-build: ${path.relative(process.cwd(), target)}`);
    return 0;
  }
  if (command === 'owner') {
    const target = await buildOwner({ outDir: path.resolve(flag('--out') || 'showcase-out') });
    console.log(`showcase-build: ${path.relative(process.cwd(), target)}`);
    return 0;
  }
  if (command === 'note' && positional[0] && flag('--out')) {
    writeNote({ folder: path.resolve(positional[0]), apkDir: path.resolve(flag('--apks') || path.dirname(path.resolve(flag('--out')))), out: path.resolve(flag('--out')) });
    return 0;
  }
  console.error('Usage: node tools/showcase-build/index.mjs brands <folder> | build <folder> <key> --platform android|ios [--out <folder>] | owner [--out <folder>] | note <folder> --out <file> [--apks <folder>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`showcase-build: ${error.message}`);
    process.exitCode = 1;
  });
}
