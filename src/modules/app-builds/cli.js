import crypto from 'node:crypto';
import { withTenant } from '../../tenancy.js';
import { appConfigFor } from '../app-config/index.js';
import { createAppBuilds } from './service.js';

/**
 * `npm run build-brand -- <slug> [--platform android|ios] [--driver local|eas] [--submit]`: one command builds one business's
 * app from the database (PRD 10.8, P-32), the same way the console's button does: the plan and the details are checked first,
 * each platform gets its own build number, and a production build is sent to the brand's own store accounts only with
 * --submit. It prints ids, build numbers and statuses only: no name, no token, no message from a provider.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Builds the current business (inside withTenant). `options` are the tool's: platforms, submit. `seams` as createAppBuilds
 * takes them (a test's drivers and runner). Answers { ok, builds }.
 */
export async function runForBusiness(ctx, { platforms = [], submit = false, timeoutMs, everyMs } = {}, print = (line) => console.log(line), seams = {}) {
  const service = createAppBuilds(ctx, { ...seams, autoSubmit: Boolean(submit) });
  const entitled = await appConfigFor(ctx).entitledPlatforms();
  const asked = platforms.length ? platforms : entitled;
  if (!asked.length) {
    print('build-brand: this plan has no shopper app.');
    return { ok: false, builds: [] };
  }
  let builds;
  try {
    builds = await service.request({ platforms: asked, requestKey: `cli-${crypto.randomUUID()}`, actor: 'system' });
  } catch (err) {
    print(`build-brand: stopped before building: ${err.message}`);
    for (const [field, message] of Object.entries(err.fields ?? {})) print(`  ${field}: ${message}`);
    return { ok: false, builds: [], fields: err.fields ?? {} };
  }
  for (const b of builds) await service.run(b.id);
  const settled = await service.follow(builds.map((b) => b.id), { timeoutMs, everyMs });
  for (const b of settled) {
    const where = b.status === 'failed' ? ` at ${b.failedStep}${b.failedField ? ` (${b.failedField})` : ''}: ${b.failedMessage}` : '';
    print(`build-brand: ${b.platform} build ${b.buildNumber}: ${b.status}${where}${b.submitError ? ` (not sent: ${b.submitError})` : ''}`);
  }
  const ok = settled.length === builds.length && settled.every((b) => b.status !== 'failed' && !['queued', 'building'].includes(b.status) && !b.submitError);
  return { ok, builds: settled };
}

/** Opens the database the server uses, finds the business by its slug and builds it. */
export async function runFromDatabase(slug, options = {}, print = (line) => console.log(line)) {
  if (!SLUG.test(String(slug))) {
    print('build-brand: a business is named by its slug: lower-case letters, digits and dashes.');
    return { ok: false };
  }
  const [{ config }, { openRuntimeDb }, { createPlatform }, { createRepos }, { createEas }] = await Promise.all([
    import('../../config.js'), import('../../db/index.js'), import('../../platform/index.js'), import('../../repos/index.js'), import('../../adapters/eas/index.js'),
  ]);
  const settings = { ...config, appBuildDriver: options.driver === 'eas' ? 'eas' : 'local' };
  const db = await openRuntimeDb(settings);
  const platform = createPlatform(settings, { db });
  try {
    const repos = createRepos(db, { storage: platform.storage, secrets: platform.secrets });
    const tenant = await repos.tenants.getBySlug(slug);
    if (!tenant) {
      print('build-brand: there is no business with that slug.');
      return { ok: false };
    }
    const ctx = { db, repos, platform, config: settings, eas: createEas(settings), notify: null };
    return await withTenant(tenant, () => runForBusiness(ctx, options, print));
  } finally {
    await platform.queue?.close?.().catch(() => {});
    await platform.cache?.close?.().catch(() => {});
    await db.close();
  }
}
