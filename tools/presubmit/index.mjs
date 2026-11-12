#!/usr/bin/env node
/**
 * The pre-submit gate (PRD 10.14): what must hold before a build of a brand's app goes to store review, each check with the
 * guideline it guards (PRESUBMIT_CHECKS in src/contracts/apps.js). One implementation for every caller: this command, run against
 * a built app on the build machine or in CI, and the server, which runs the same checks (checks.mjs) before it submits a build.
 *
 *   node tools/presubmit/index.mjs --platform ios --app apps/shopper --brand <brand.json> [--server <facts.json>]
 *        [--toolchain <file with `xcodebuild -version; xcodebuild -showsdks`>] [--json]
 *     Prints one line per check and exits 1 when any fails, naming its guideline. --server holds what only the server knows
 *     ({ reviewAccess: { enabled, phone, code }, push: { toggles, defaultOn } }); without it review access counts as off.
 *
 *   node tools/presubmit/index.mjs --release-facts [--app apps/shopper] [--brand <brand.json>] [--write]
 *     The facts every brand's build of this app version shares, for the server: the server image holds no app source, so it reads
 *     them from src/modules/app-submissions/release-facts.json. --write updates that file for this app version. Run it whenever
 *     the app's dependencies, config or screens change (test/p6/store-release keeps the file equal to the app).
 *
 *   runPresubmit({ platform, app, server }) -> { tool, toolVersion, platform, passed, checks }
 *
 * Nothing it prints holds a key, a password or a person's details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROUTES } from '../../src/contracts/store-routes.js';
import { SHOPPER_PUSH_TOGGLES } from '../../src/contracts/apps.js';
import { runChecks } from './checks.mjs';
import { inspectApp, parseToolchain, releaseFacts } from './inspect.mjs';

export { runChecks, failureSummary, versionAtLeast, NATIVE_SCREENS, REQUIRED_REASON_APIS } from './checks.mjs';
export { inspectApp, releaseFacts, parseToolchain, easToolchain, EAS_DEFAULT_TOOLCHAIN } from './inspect.mjs';

export const PRESUBMIT_TOOL_VERSION = 'presubmit-1';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELEASE_FACTS_FILE = path.join(REPO_ROOT, 'src', 'modules', 'app-submissions', 'release-facts.json');
export const DEFAULT_APP_DIR = path.join(REPO_ROOT, 'apps', 'shopper');
/** Any brand file builds the shared facts; its own texts are left out. The first fixture brand is invented and always present. */
export const DEFAULT_BRAND_FILE = path.join(REPO_ROOT, 'tools', 'build-brand', 'fixtures', 'quindle', 'brand.json');

/** What the server says about itself when the command runs away from it: its routes and its notification switches. */
export const LOCAL_SERVER_FACTS = Object.freeze({
  reviewAccess: Object.freeze({ enabled: false, phone: false, code: false }),
  accountDeletionRoute: Boolean(APP_ROUTES.appAccountDelete),
  push: Object.freeze({ toggles: SHOPPER_PUSH_TOGGLES, defaultOn: Object.freeze([]) }),
});

export function runPresubmit({ platform, app, server = LOCAL_SERVER_FACTS }) {
  const { passed, checks } = runChecks({ platform, app, server });
  return { tool: 'presubmit', toolVersion: PRESUBMIT_TOOL_VERSION, platform, passed, checks };
}

/** The release facts file with this app version's facts in it (older versions are kept: their builds may still be submitted). */
export function releaseFactsFile({ appDir = DEFAULT_APP_DIR, brandFile = DEFAULT_BRAND_FILE, current = readReleaseFacts() } = {}) {
  const shared = releaseFacts({ appDir, brandFile });
  return { tool: 'presubmit', toolVersion: PRESUBMIT_TOOL_VERSION, releases: { ...(current?.releases ?? {}), [shared.appVersion]: shared } };
}

export function readReleaseFacts(file = RELEASE_FACTS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function argsOf(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (['json', 'write', 'release-facts'].includes(key)) out.flags.add(key);
    else out[key] = argv[++i];
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = argsOf(argv);
  try {
    if (args.flags.has('release-facts')) {
      const file = releaseFactsFile({ appDir: path.resolve(args.app ?? DEFAULT_APP_DIR), brandFile: path.resolve(args.brand ?? DEFAULT_BRAND_FILE) });
      const text = `${JSON.stringify(file, null, 2)}\n`;
      if (args.flags.has('write')) {
        fs.writeFileSync(RELEASE_FACTS_FILE, text);
        stdout.write(`Wrote the facts of app version ${Object.keys(file.releases).sort().at(-1)} to ${path.relative(REPO_ROOT, RELEASE_FACTS_FILE)}\n`);
      } else stdout.write(text);
      return 0;
    }
    if (!['android', 'ios'].includes(args.platform)) {
      stderr.write('Usage: node tools/presubmit/index.mjs --platform android|ios --app <built app folder> --brand <brand file> [--server <facts.json>] [--toolchain <file>] [--json]\n');
      return 2;
    }
    const toolchain = args.toolchain ? { ...parseToolchain(fs.readFileSync(args.toolchain, 'utf8')), source: 'xcodebuild' } : undefined;
    const app = inspectApp({ appDir: path.resolve(args.app ?? DEFAULT_APP_DIR), brandFile: args.brand, toolchain });
    const server = args.server ? { ...LOCAL_SERVER_FACTS, ...JSON.parse(fs.readFileSync(args.server, 'utf8')) } : LOCAL_SERVER_FACTS;
    const report = runPresubmit({ platform: args.platform, app, server: { ...server, brand: { texts: app.brandTexts } } });
    if (args.flags.has('json')) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const check of report.checks) stdout.write(`${check.passed ? 'pass' : 'FAIL'}  ${check.code.padEnd(18)} ${(check.guideline || '-').padEnd(22)} ${check.detail}\n`);
      stdout.write(report.passed ? 'Every pre-submit check passed.\n' : 'The build cannot go to review: fix the checks marked FAIL.\n');
    }
    return report.passed ? 0 : 1;
  } catch (err) {
    stderr.write(`presubmit: ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
