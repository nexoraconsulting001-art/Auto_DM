/**
 * Step 5, build: one build per platform, through a driver (BUILD_DRIVERS).
 *
 *   local   expo prebuild, then Gradle for an Android APK, or xcodebuild for the iOS simulator with signing off. No account.
 *   eas     the build service, through src/adapters/eas. Filled by the pipeline track.
 *
 * A driver is { name, build({ platform, brand, brandFile, brandDir, profile, options, exec, log }) } answering
 * { platform, status: 'built' | 'failed', artifact, detail }. A failed platform does not stop the others: the report lists each
 * result (P-35), and the run fails at the end.
 *
 * In:  state.brand, state.brandFile, state.platforms
 * Out: { builds: [{ platform, status: 'built' | 'failed' | 'skipped', artifact, buildNumber, detail }] }
 */
import { BuildBrandError } from '../errors.mjs';
import * as eas from '../drivers/eas.mjs';
import * as local from '../drivers/local.mjs';

export const name = 'build';

export const DRIVERS = Object.freeze({ local, eas });

export const buildNumberOf = (brand, platform) => (platform === 'ios' ? brand.ios?.buildNumber : brand.android?.versionCode) ?? null;

export async function run(state, tools) {
  const { options } = tools;
  const driver = options.drivers?.[options.driver] ?? DRIVERS[options.driver];
  if (!driver) throw new BuildBrandError({ step: name, code: 'unknown_driver', message: `There is no build driver named ${options.driver}. Use local or eas.` });
  const builds = [];
  for (const platform of state.platforms) {
    const buildNumber = buildNumberOf(state.brand, platform);
    if (options.skipBuild) {
      builds.push({ platform, status: 'skipped', artifact: null, buildNumber, detail: 'Not built: this run only wrote the brand file.' });
      continue;
    }
    try {
      const result = await driver.build({ platform, brand: state.brand, brandFile: state.brandFile, brandDir: state.brandDir, profile: options.profile, options, exec: tools.exec, log: tools.log });
      builds.push({ buildNumber, ...result, platform });
    } catch (error) {
      if (error instanceof BuildBrandError && error.code === 'not_built') throw error;
      builds.push({ platform, status: 'failed', artifact: null, buildNumber, detail: error instanceof BuildBrandError ? error.message : 'The build failed. Its log is above.' });
    }
  }
  return { builds };
}
