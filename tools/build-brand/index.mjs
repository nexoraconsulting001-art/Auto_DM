/**
 * `npm run build-brand -- <slug or brand file>`: one command builds one brand's shopper app (PRD 10.8). One source tree
 * (apps/shopper) serves every brand; what differs is one brand file and the images beside it.
 *
 *   npm run build-brand -- tools/build-brand/fixtures/<name>/brand.json --platform android
 *   npm run build-brand -- <business slug> --driver eas --profile production --submit
 *
 *   --platform android|ios   once or twice; default: every platform the brand has
 *   --driver local|eas       default: APP_BUILD_DRIVER, or local
 *   --profile production|preview|simulator   default: preview
 *   --pay hosted|native      the pay driver built in; default: PAY_DRIVER, or what the brand file says (hosted)
 *   --out <folder>           where the run's brand folder goes; default: .brand-builds (ignored by git)
 *   --report <file>          also write the report as JSON
 *   --no-build               stop after writing the brand file
 *   --submit                 send what was built to the brand's store accounts
 *
 * The steps run in order, each in its own file under steps/, each `{ name, run(state, tools) }` answering what it adds to the
 * state. `tools` is { options, log, exec }. The first failure stops the run; the report step always runs and names the step
 * and the field. The step names are BUILD_STEPS in src/contracts/apps.js (what app_builds.failed_step holds), then submit.
 *
 *   load         steps/load.mjs         a brand file, or a business from the database
 *   validate     steps/validate.mjs     every problem with its field, before anything is made
 *   assets       steps/assets.mjs       the images, held to the stores' specs
 *   brand_file   steps/brand-file.mjs   the folder app.config.js reads
 *   build        steps/build.mjs        per platform, through drivers/local.mjs or drivers/eas.mjs
 *   submit       steps/submit.mjs       to the brand's own accounts
 *   report       steps/report.mjs       what happened, per platform
 *
 * The parts that need the database or the build service are passed in as options (loadBySlug, moreProblems, generateAssets,
 * makeBrand, easBuild, submitBuild): src/modules/app-builds supplies them (pipeline.js), so this folder imports nothing that
 * needs a database. From the command line a slug goes to src/modules/app-builds/cli.js, which opens the database, asks for the
 * builds the plan allows and follows them; none of that is loaded for a brand file.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BuildBrandError } from './errors.mjs';
import * as assets from './steps/assets.mjs';
import * as brandFile from './steps/brand-file.mjs';
import * as build from './steps/build.mjs';
import * as load from './steps/load.mjs';
import * as report from './steps/report.mjs';
import * as submit from './steps/submit.mjs';
import * as validate from './steps/validate.mjs';

export { BuildBrandError } from './errors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The steps, in the order they run. The report step is not in the list: it runs last whatever happened. */
export const STEPS = Object.freeze([load, validate, assets, brandFile, build, submit]);
export const STEP_NAMES = Object.freeze([...STEPS.map((step) => step.name), report.name]);

/** Runs one command with its output on this terminal. Rejects when it exits with anything but 0. Arguments are never printed here. */
export const spawnExec = (command, args, { cwd, env } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  child.once('error', reject);
  child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
});

export function defaultOptions(env = process.env) {
  return {
    cwd: ROOT,
    platforms: [],
    driver: ['local', 'eas'].includes(env.APP_BUILD_DRIVER) ? env.APP_BUILD_DRIVER : 'local',
    profile: 'preview',
    payDriver: ['hosted', 'native'].includes(env.PAY_DRIVER) ? env.PAY_DRIVER : null,
    outDir: '.brand-builds',
    reportFile: null,
    skipBuild: false,
    submit: false,
    env,
  };
}

/** Builds one brand. Answers the report; never throws for a brand's own problem (report.ok is false and it names the step). */
export async function buildBrand(input, given = {}) {
  const options = { ...defaultOptions(given.env ?? process.env), ...given };
  const tools = { options, log: given.log ?? ((line) => console.log(line)), exec: given.exec ?? spawnExec };
  let state = { input };
  let failure = null;
  for (const step of STEPS) {
    try {
      state = { ...state, ...(await step.run(state, tools)) };
    } catch (error) {
      failure = error instanceof BuildBrandError ? error : new BuildBrandError({ step: step.name, code: 'failed', message: `The ${step.name} step failed unexpectedly.` });
      if (!(error instanceof BuildBrandError)) failure.cause = error;
      break;
    }
  }
  const { report: result } = await report.run(state, { ...tools, error: failure });
  return result;
}

export function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);
  let input = null;
  const value = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') options.platforms.push(value(i++, arg));
    else if (arg === '--driver') options.driver = value(i++, arg);
    else if (arg === '--profile') options.profile = value(i++, arg);
    else if (arg === '--pay') options.payDriver = value(i++, arg);
    else if (arg === '--out') options.outDir = value(i++, arg);
    else if (arg === '--report') options.reportFile = value(i++, arg);
    else if (arg === '--no-build') options.skipBuild = true;
    else if (arg === '--submit') options.submit = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (input === null) input = arg;
    else throw new Error('Name one business or one brand file');
  }
  if (!['production', 'preview', 'simulator'].includes(options.profile)) throw new Error('--profile is production, preview or simulator');
  if (options.payDriver !== null && !['hosted', 'native'].includes(options.payDriver)) throw new Error('--pay is hosted or native');
  return { input, options };
}

/** A throwaway signing key for a local Android build, named by the caller's settings; with none the debug key signs. */
const signingFromEnv = (env) => (env.ANDROID_KEYSTORE_FILE && env.ANDROID_KEYSTORE_PASSWORD
  ? { storeFile: env.ANDROID_KEYSTORE_FILE, storePassword: env.ANDROID_KEYSTORE_PASSWORD, keyAlias: env.ANDROID_KEY_ALIAS || 'ci', keyPassword: env.ANDROID_KEY_PASSWORD || env.ANDROID_KEYSTORE_PASSWORD }
  : null);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`build-brand: ${error.message}\nUsage: npm run build-brand -- <slug or brand file> [--platform android|ios] [--driver local|eas] [--profile preview] [--no-build] [--submit]`);
    process.exit(2);
  }
  const options = { ...parsed.options, signing: signingFromEnv(process.env), androidArchitectures: process.env.ANDROID_ARCHITECTURES || null, cwd: process.cwd() };
  if (parsed.input && !load.isBrandFilePath(parsed.input)) {
    const { runFromDatabase } = await import('../../src/modules/app-builds/cli.js');
    const fromDb = await runFromDatabase(parsed.input, options);
    process.exit(fromDb.ok ? 0 : 1);
  }
  const result = await buildBrand(parsed.input, options);
  process.exit(result.ok ? 0 : 1);
}
