/**
 * Step 2, validate: nothing is generated or built from a brand that would fail later (P-33). Every problem names its field.
 *
 *   from the database   brandFileProblems(config, kit, { platforms, hosts }) from src/contracts/apps.js
 *   from a file         the BrandFile schema, the platforms asked for, the app version every brand shares, the link paths, and
 *                       no value that names the platform
 *
 * In:  state.brand, or state.config and state.kit
 * Out: { platforms }: the platforms this run builds, in order
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_LINK_PATHS, BrandFile, brandFileProblems, namesPlatform } from '../../../src/contracts/apps.js';
import { BuildBrandError } from '../errors.mjs';

export const name = 'validate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PLATFORMS = ['android', 'ios'];
/** Every brand ships the same app version: the shopper app's own (PRD 10.8). */
export const appVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/shopper/package.json'), 'utf8')).version;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The problems of a brand file: [{ field, code, message, platform }], [] when it can be built. */
export function brandProblems(brand, { platforms = PLATFORMS, version = appVersion() } = {}) {
  const problems = [];
  const add = (field, code, message, platform = null) => problems.push({ field, code, message, platform });
  const parsed = BrandFile.safeParse(brand);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(issue.path.join('.') || 'brand', 'invalid', `${issue.path.join('.') || 'The brand file'}: ${issue.message}`);
    return problems;
  }
  const b = parsed.data;
  for (const platform of platforms) {
    if (!b[platform]) add(platform, 'required', platform === 'ios' ? 'This brand has no iOS bundle ID, build number and Apple team ID.' : 'This brand has no Android package and build number.', platform);
  }
  if (b.appVersion !== version) add('appVersion', 'wrong_version', `Every brand ships app version ${version}; this brand file says ${b.appVersion}.`);
  if (!same(b.linkPaths, APP_LINK_PATHS)) add('linkPaths', 'out_of_step', 'The paths the app opens are not the ones the server answers for.');
  if (!b.linkHosts.includes(b.shopDomain)) add('linkHosts', 'missing_shop_domain', 'The shop’s own address must be one of the hosts the app opens links for.');
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(b.colors.primary ?? ''))) add('colors', 'required', 'Set the brand’s main colour.');
  const visit = (field, value) => {
    if (typeof value === 'string') {
      if (namesPlatform(value) && !problems.some((p) => p.field === field && p.code === 'names_platform')) add(field, 'names_platform', 'Use the brand’s own name here, not the platform’s.');
    } else if (value && typeof value === 'object') Object.values(value).forEach((v) => visit(field, v));
  };
  for (const [field, value] of Object.entries(b)) visit(field, value);
  return problems;
}

export async function run(state, { options }) {
  const asked = options.platforms?.length ? options.platforms : null;
  const unknown = (asked ?? []).find((p) => !PLATFORMS.includes(p));
  if (unknown) throw new BuildBrandError({ step: name, code: 'unknown_platform', message: `There is no platform named ${unknown}. Use android or ios.` });
  let problems;
  let platforms;
  if (!state.brand) {
    platforms = asked ?? PLATFORMS;
    problems = brandFileProblems(state.config, state.kit, { platforms, hosts: state.hosts });
  } else {
    platforms = asked ?? PLATFORMS.filter((p) => state.brand?.[p]);
    problems = brandProblems(state.brand, { platforms });
  }
  if (problems.length) {
    const first = problems[0];
    throw new BuildBrandError({ step: name, code: first.code, field: first.field, platform: first.platform, message: first.message, problems });
  }
  if (!platforms.length) throw new BuildBrandError({ step: name, code: 'no_platform', message: 'This brand has neither an Android package nor an iOS bundle ID.' });
  return { platforms };
}
