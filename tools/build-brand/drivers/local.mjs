/**
 * The local build driver: the same commands a developer would type, with no account anywhere.
 *
 *   android   expo prebuild, then Gradle's :app:assembleRelease, giving an APK. Signed with the key named in `options.signing`
 *             ({ storeFile, storePassword, keyAlias, keyPassword }, made by the caller and thrown away by it), or with the
 *             debug key when there is none. Never a store key: store builds go through the eas driver.
 *   ios       expo prebuild, pod install, then xcodebuild for the simulator with signing off. Needs a Mac.
 *
 * Every command runs in apps/shopper with BRAND_FILE set to this run's brand file, so the source tree itself never changes.
 * localCommands() is the list as data, so a test can read it without running anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildBrandError } from '../errors.mjs';

export const name = 'local';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const APP_DIR = path.join(ROOT, 'apps', 'shopper');
const APK = path.join(APP_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

/** What every command of one build is run with. The API address override is for a test build only (app.config.js refuses it in production). */
export function buildEnv({ brand, brandFile, profile, env = process.env }) {
  return {
    ...env,
    BRAND_FILE: brandFile,
    APP_ENV: profile === 'production' ? 'production' : 'preview',
    PAY_DRIVER: brand.payDriver,
    EXPO_NO_TELEMETRY: '1',
    CI: '1',
  };
}

/** The commands of one platform's build, in order: [{ command, args, cwd, secret? }]. `secret` lists the argument indexes never printed. */
export function localCommands({ platform, brandDir, options = {}, windows = process.platform === 'win32' }) {
  const prebuild = { command: 'npx', args: ['expo', 'prebuild', '--platform', platform, '--no-install', '--clean'], cwd: APP_DIR };
  if (platform === 'android') {
    const args = [':app:assembleRelease', '--no-daemon'];
    if (options.androidArchitectures) args.push(`-PreactNativeArchitectures=${options.androidArchitectures}`);
    const secret = [];
    const signing = options.signing;
    if (signing) {
      args.push(`-Pandroid.injected.signing.store.file=${signing.storeFile}`);
      secret.push(args.push(`-Pandroid.injected.signing.store.password=${signing.storePassword}`) - 1);
      args.push(`-Pandroid.injected.signing.key.alias=${signing.keyAlias}`);
      secret.push(args.push(`-Pandroid.injected.signing.key.password=${signing.keyPassword}`) - 1);
    }
    return [prebuild, { command: windows ? 'gradlew.bat' : './gradlew', args, cwd: path.join(APP_DIR, 'android'), secret }];
  }
  const ios = path.join(APP_DIR, 'ios');
  return [
    prebuild,
    { command: 'pod', args: ['install'], cwd: ios },
    {
      // The workspace is named after the app, which differs per brand, so it is found when the command runs.
      command: 'sh',
      args: ['-c', 'WORKSPACE="$(ls -d *.xcworkspace | head -1)"; xcodebuild -workspace "$WORKSPACE" -scheme "${WORKSPACE%.xcworkspace}" -configuration Release -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath "$DERIVED_DATA" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build'],
      cwd: ios,
      env: { DERIVED_DATA: path.join(brandDir, 'ios-derived') },
    },
  ];
}

export async function build({ platform, brand, brandFile, brandDir, profile, options, exec, log }) {
  if (profile === 'production') throw new BuildBrandError({ step: 'build', code: 'needs_store_signing', platform, message: 'A store build is signed by the build service: use the eas driver for a production build.' });
  if (platform === 'ios' && process.platform !== 'darwin' && !options.anyHost) {
    throw new BuildBrandError({ step: 'build', code: 'needs_mac', platform, message: 'The iOS simulator build runs on a Mac.' });
  }
  const env = buildEnv({ brand, brandFile, profile, env: options.env });
  for (const step of localCommands({ platform, brandDir, options })) {
    log(`build-brand: ${platform}: ${step.command} ${step.args.map((arg, i) => (step.secret?.includes(i) ? arg.replace(/=.*/, '=***') : arg)).join(' ').slice(0, 300)}`);
    await exec(step.command, step.args, { cwd: step.cwd, env: { ...env, ...(step.env ?? {}) } });
  }
  if (platform === 'android') {
    if (!fs.existsSync(APK)) throw new BuildBrandError({ step: 'build', code: 'no_artifact', platform, message: 'Gradle finished without an APK.' });
    const artifact = path.join(brandDir, 'android.apk');
    fs.copyFileSync(APK, artifact);
    return { platform, status: 'built', artifact, detail: 'A release APK from the local driver.' };
  }
  const products = path.join(brandDir, 'ios-derived', 'Build', 'Products', 'Release-iphonesimulator');
  const app = fs.existsSync(products) ? fs.readdirSync(products).find((entry) => entry.endsWith('.app')) : null;
  if (!app) throw new BuildBrandError({ step: 'build', code: 'no_artifact', platform, message: 'xcodebuild finished without an app.' });
  return { platform, status: 'built', artifact: path.join(products, app), detail: 'A simulator app with signing off.' };
}
