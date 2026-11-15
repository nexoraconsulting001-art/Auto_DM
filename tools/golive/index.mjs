// `npm run golive` (scripts/golive.js calls run() here): the go-live checklist on the configuration the server would run
// with, secrets from their source included. It never runs a migration, never sends anything, and never prints a value.
//
//   live probes   asked unless --offline; each has its own timeout, so one provider that hangs cannot hold the list
//   the database  opened (without migrating) only for live checks with DATABASE_URL set: backups, the re-wrap, and the
//                 per-business counts. Opening it can fail; those items are then "not checked"
import { config as runtimeConfig, loadSecrets } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { createSecrets } from '../../src/platform/secrets.js';
import { createGolive } from '../../src/modules/golive/checklist.js';

export { formatMarkdown, formatText, groups, verdictLine } from './report.mjs';

export class GoliveRunError extends Error {
  name = 'GoliveRunError';
}

async function loadConfig(config, env) {
  // Loaded with the deploy marker set aside, so a production configuration with a secret missing is reported, not refused.
  const deployEnv = config.deployEnv;
  config.deployEnv = '';
  try {
    await loadSecrets(config, { env });
  } catch {
    throw new GoliveRunError('The secrets could not be loaded from their source.');
  } finally {
    config.deployEnv = deployEnv;
  }
  return config;
}

async function openDatabase(config) {
  if (!config.databaseUrl && !config.databaseOwnerUrl) return null;
  try {
    return await openDb({ url: config.databaseUrl, ownerUrl: config.databaseOwnerUrl, migrate: false, poolSize: 2 });
  } catch {
    return null; // never the error: it can carry the address
  }
}

/** Answers the GoliveStatus. `deps` is for tests: { config, env, db, secrets, options }. */
export async function run(options = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const config = deps.config ?? (await loadConfig(runtimeConfig, env));
  const live = !options.offline;
  const db = deps.db !== undefined ? deps.db : live ? await openDatabase(config) : null;
  let secrets = deps.secrets;
  if (!secrets) {
    try {
      secrets = createSecrets(config);
    } catch {
      secrets = undefined;
    }
  }
  try {
    return await createGolive({ config, db }, { env, secrets, ...deps.options }).status({ live });
  } finally {
    if (db && deps.db === undefined) await db.close?.().catch(() => {});
  }
}
