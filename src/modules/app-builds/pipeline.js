import fs from 'node:fs';
import path from 'node:path';
import { checkAsset } from '../../contracts/apps.js';
import { BuildBrandError, spawnExec } from '../../../tools/build-brand/index.mjs';
import * as local from '../../../tools/build-brand/drivers/local.mjs';
import { AppConfigProblem, appConfigFor, textProblems } from '../app-config/index.js';
import { checkGenerated, generateBrandImages, measureImage } from './images.js';

/**
 * What the build tool (tools/build-brand) is given to build one row of app_builds from the database: the options it leaves to
 * this track (loadBySlug, generateAssets, makeBrand, easBuild, and moreProblems for its validate step). The tool imports no
 * database; everything here runs inside withTenant() as the build's own business, and loads nothing of any other.
 *
 * Seller text reaches the build only as values of the brand file (JSON written by the tool): the folder is the run's own temp
 * folder, the image names are constants, and the commands' arguments are fixed. The commands get a short list of settings
 * (serverEnv), never the server's own keys, tokens or database address.
 */

/** The settings a build's commands may see. Nothing else of the server's environment reaches Expo, Gradle or xcodebuild. */
const BUILD_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'DEVELOPER_DIR'];
export const serverEnv = (env = process.env) => Object.fromEntries(BUILD_ENV_KEYS.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]]));

/** The local driver, refusing at once on a host that has no app source (the server image has none). */
export const guardedLocal = Object.freeze({
  name: 'local',
  async build(args) {
    if (!fs.existsSync(local.APP_DIR)) {
      return { platform: args.platform, status: 'failed', artifact: null, detail: 'The app’s source is not on this server. Build with the eas driver.' };
    }
    return local.build(args);
  },
});

/** A plain sentence for a failure of the build service. Never its address, a token or what it answered. */
export function easFailure(err) {
  switch (err?.kind) {
    case 'not_configured': return 'The build service is not set up yet.';
    case 'timeout': case 'network': return 'The build service did not answer. Ask for the build again.';
    case 'server': case 'throttled': case 'rate_limited': return 'The build service is busy or down. Ask for the build again later.';
    case 'malformed': return 'The build service gave an answer we could not read. Ask for the build again.';
    case 'rejected': case 'auth': return 'The build service refused the build.';
    default: return 'The build could not be started on the build service.';
  }
}

const ICON_SOURCE = 'icon-source';
const SPLASH_SOURCE = 'splash-source';
const FILES = Object.freeze({ icon: 'icon.png', adaptiveForeground: 'adaptive-foreground.png', adaptiveBackground: 'adaptive-background.png', notificationIcon: 'notification.png', splash: 'splash.png' });

/**
 * The tool's options for one build row. `outDir` is the run's own empty temp folder; `store` collects the store images made
 * on the way ({ platform, kind, buffer }); `seams` lets a test give the commands' runner and the drivers.
 */
export function toolOptions(ctx, build, { outDir, store, seams = {} }) {
  const tid = Number(build.tenant_id);
  const appConfig = appConfigFor(ctx);
  const sourceDir = path.join(outDir, 'source');

  async function loadBySlug(input) {
    if (input !== `t${tid}`) throw new BuildBrandError({ step: 'load', code: 'wrong_business', message: 'A build loads only its own business.' });
    const entitled = await appConfig.entitledPlatforms();
    if (!entitled.includes(build.platform)) throw new BuildBrandError({ step: 'load', code: 'not_entitled', message: 'The plan no longer includes this app.' });
    const config = await appConfig.read();
    let kit = {};
    try {
      kit = (await ctx.repos.brandKit.get()) ?? {};
    } catch {
      kit = {};
    }
    const hosts = await appConfig.hosts();
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const [id, file] of [[config.iconMediaId, ICON_SOURCE], [config.splashMediaId, SPLASH_SOURCE]]) {
      if (!id) continue;
      const media = await ctx.repos.media.get(id).catch(() => null);
      if (media?.data?.length) fs.writeFileSync(path.join(sourceDir, file), media.data);
    }
    return { config, kit, hosts, sourceDir };
  }

  async function generateAssets(state) {
    const iconFile = path.join(state.sourceDir, ICON_SOURCE);
    if (!fs.existsSync(iconFile)) {
      throw new BuildBrandError({ step: 'assets', code: 'missing_image', field: 'iconMediaId', message: 'Upload the app icon: a square image of at least 1024 x 1024 pixels.' });
    }
    const icon = fs.readFileSync(iconFile);
    const measured = await measureImage(icon).catch(() => null);
    if (!measured) throw new BuildBrandError({ step: 'assets', code: 'not_image', field: 'iconMediaId', message: 'The app icon is not an image we can read. Upload a PNG or JPEG.' });
    const iconProblems = checkAsset('source_icon', measured);
    if (iconProblems.length) {
      throw new BuildBrandError({ step: 'assets', code: iconProblems[0].code, field: 'iconMediaId', message: iconProblems.map((p) => p.message).join(' '), problems: iconProblems.map((p) => ({ ...p, field: 'iconMediaId', platform: null })) });
    }
    const splashFile = path.join(state.sourceDir, SPLASH_SOURCE);
    const splash = fs.existsSync(splashFile) ? fs.readFileSync(splashFile) : null;
    if (splash && !(await measureImage(splash).catch(() => null))) {
      throw new BuildBrandError({ step: 'assets', code: 'not_image', field: 'splashMediaId', message: 'The splash image is not an image we can read. Upload a PNG or JPEG.' });
    }
    const colors = state.config.colors ?? {};
    let images;
    try {
      images = await generateBrandImages({ icon, splash, ground: colors.ground ?? '#FFFFFF', background: /^#[0-9A-Fa-f]{6}$/.test(state.config.splashBackground) ? state.config.splashBackground : colors.primary ?? '#FFFFFF' });
    } catch {
      throw new BuildBrandError({ step: 'assets', code: 'not_image', field: 'iconMediaId', message: 'The app’s images could not be made from the icon. Upload a PNG or JPEG.' });
    }
    const problems = await checkGenerated(images);
    if (problems.length) {
      throw new BuildBrandError({ step: 'assets', code: problems[0].code, field: problems[0].field, message: problems[0].message, problems: problems.map((p) => ({ field: p.field, code: p.code, message: p.message, platform: null })) });
    }
    const imageDir = path.join(outDir, 'images');
    fs.mkdirSync(imageDir, { recursive: true });
    const assets = {};
    for (const [key, file] of Object.entries(FILES)) {
      assets[key] = path.join(imageDir, file);
      fs.writeFileSync(assets[key], images[key]);
    }
    store.push(
      { platform: 'android', kind: 'icon', spec: 'icon_play', buffer: images.iconPlay },
      { platform: 'android', kind: 'feature_graphic', spec: 'feature_graphic', buffer: images.featureGraphic },
      { platform: 'ios', kind: 'icon', spec: 'icon_ios', buffer: images.icon },
    );
    return { assets, fonts: [] };
  }

  async function makeBrand() {
    try {
      return await appConfig.brandFile({ platform: build.platform, buildNumber: Number(build.build_number), appVersion: build.app_version, runtimeVersion: build.runtime_version });
    } catch (err) {
      if (err instanceof AppConfigProblem) throw new BuildBrandError({ step: 'brand_file', code: err.code, field: err.field, message: err.message, problems: err.problems });
      throw err;
    }
  }

  async function easBuild({ platform, brand, profile }) {
    if (!ctx.eas?.configured) return { status: 'failed', artifact: null, detail: easFailure({ kind: 'not_configured' }) };
    try {
      const started = await ctx.eas.startBuild({
        platform, profile, channel: brand.updates.channel, appVersion: brand.appVersion, runtimeVersion: brand.runtimeVersion,
        buildNumber: platform === 'ios' ? brand.ios.buildNumber : brand.android.versionCode, brandFile: brand,
        idempotencyKey: `t${tid}-build-${Number(build.id)}`,
      });
      return { status: 'building', artifact: null, providerBuildId: String(started.buildId).slice(0, 80), detail: 'Started on the build service.' };
    } catch (err) {
      return { status: 'failed', artifact: null, detail: easFailure(err) };
    }
  }

  return {
    cwd: outDir,
    outDir: 'out',
    platforms: [build.platform],
    driver: build.driver,
    profile: build.profile,
    payDriver: null,
    reportFile: null,
    skipBuild: false,
    submit: false,
    anyHost: Boolean(seams.anyHost),
    env: serverEnv(process.env),
    log: seams.log ?? (() => {}),
    exec: seams.exec ?? spawnExec,
    drivers: seams.drivers ?? { local: guardedLocal },
    signing: null,
    loadBySlug,
    moreProblems: async (state) => [...textProblems(state.config), ...(await appConfig.imageProblems(state.config))],
    generateAssets,
    makeBrand,
    easBuild,
  };
}
