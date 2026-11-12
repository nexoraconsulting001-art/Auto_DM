/**
 * Step 6, submit: each built platform goes to the brand's own store account. Off unless the run asks for it (`--submit`).
 * Filled by the pipeline track through `options.submitBuild({ build, brand, state })`, which answers
 * { status: 'submitted' | 'failed', detail }. Signing keys and store keys stay with the build service; none is read, written or
 * printed here (P-36).
 *
 * In:  state.builds
 * Out: { submissions: [{ platform, status, detail }] }
 */
import { notBuilt } from '../errors.mjs';

export const name = 'submit';

export async function run(state, { options }) {
  if (!options.submit) return { submissions: [] };
  if (typeof options.submitBuild !== 'function') throw notBuilt(name, 'Submitting a build to a store');
  const submissions = [];
  for (const build of state.builds.filter((b) => b.status === 'built')) {
    submissions.push({ ...(await options.submitBuild({ build, brand: state.brand, state })), platform: build.platform });
  }
  return { submissions };
}
