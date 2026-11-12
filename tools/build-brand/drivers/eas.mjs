/**
 * The eas build driver: the build service, through src/adapters/eas (and tools/sim/eas in tests), never called from here
 * directly. Filled by the pipeline track through `options.easBuild({ platform, brand, brandFile, brandDir, profile })`, which
 * answers { status: 'built' | 'failed', artifact, detail }. Signing keys live in the build service's own store, per brand; this
 * driver never reads one.
 */
import { notBuilt } from '../errors.mjs';

export const name = 'eas';

export async function build({ platform, brand, brandFile, brandDir, profile, options }) {
  if (typeof options.easBuild !== 'function') throw notBuilt('build', 'Building through the build service');
  return { platform, ...(await options.easBuild({ platform, brand, brandFile, brandDir, profile })) };
}
