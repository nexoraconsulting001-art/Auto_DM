/**
 * The hosting and scale readiness checks (PRD 11: R-05, R-06, R-07) as repeatable scripts, and the validation of the
 * production templates (Phase 9; G-08, G-10 to G-12). Nothing here deploys anything or reaches an outside service: each
 * check runs against services on this machine (CI's service containers, or ones a developer started).
 *
 *   npm run check:r05        the whole test suite on the production drivers, with no code change
 *   npm run check:r06        two web servers behind a load balancer: one session, one upload, each scheduled job once
 *   npm run check:r07        a backup and its files moved to a new database and object store; counts and checksums match
 *   npm run prod:validate    the compose file, the Kubernetes manifests, the Terraform templates and the monitoring rules
 *
 * READINESS_CHECKS is the list as data: the requirement each proves, the services it needs (by the environment variable
 * that names each), and what it reports. `needs` are checked before anything runs, and a missing one is named.
 *
 *   node tools/readiness/index.mjs <check> [--json] [--keep]
 *     --json   the report as JSON on stdout (ReadinessReport below)
 *     --keep   leave what the check created (databases, buckets, processes it started are still stopped)
 *
 * Exit code: 0 passed, 1 failed, 2 a bad argument, a missing service, or a check that is not built.
 *
 * A check's run({ env, keep, log }) answers { check, ok, steps: [{ name, ok, detail }], startedAt, finishedAt }. `detail`
 * holds counts and names only: never a connection string, a key or a business's data.
 *
 * Built here: the list, the arguments, and the pre-flight for missing services. The checks themselves are the readiness
 * track's (r05.mjs, r06.mjs, r07.mjs, validate.mjs beside this file, each exporting run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The production services a check runs against, each by the variable that names it. */
const SERVICES = Object.freeze({
  postgres: 'TEST_DATABASE_URL',
  redis: 'REDIS_URL',
  analytics: 'CLICKHOUSE_URL',
  objectStorage: 'S3_ENDPOINT',
});

export const READINESS_CHECKS = Object.freeze({
  r05: Object.freeze({
    requirement: 'G-10',
    scenario: 'R-05',
    title: 'The whole test suite passes on Redis, the analytics database and object storage with no code change',
    needs: Object.freeze([SERVICES.postgres, SERVICES.redis, SERVICES.analytics, SERVICES.objectStorage, 'S3_BUCKET']),
    file: 'r05.mjs',
    steps: Object.freeze(['drivers_are_production', 'no_source_change', 'suite_passes']),
  }),
  r06: Object.freeze({
    requirement: 'G-11',
    scenario: 'R-06',
    title: 'Two web servers behind a load balancer: one session, one upload, each scheduled job once',
    needs: Object.freeze([SERVICES.postgres, SERVICES.redis, SERVICES.objectStorage, 'S3_BUCKET']),
    file: 'r06.mjs',
    steps: Object.freeze(['two_servers_ready', 'session_survives_switch', 'upload_shows_on_both', 'scheduled_job_runs_once', 'drain_loses_nothing']),
  }),
  r07: Object.freeze({
    requirement: 'G-12',
    scenario: 'R-07',
    title: 'A VM backup and its files move to a new database and object store; counts and checksums match',
    needs: Object.freeze([SERVICES.postgres, SERVICES.objectStorage, 'S3_BUCKET']),
    file: 'r07.mjs',
    steps: Object.freeze(['source_seeded', 'backup_taken', 'restored_to_new_database', 'files_copied_to_object_storage', 'counts_match_per_business', 'checksums_match_per_business', 'only_config_changed']),
  }),
  validate: Object.freeze({
    requirement: 'G-08',
    scenario: '',
    title: 'The compose file, the Kubernetes manifests, the Terraform templates and the monitoring rules validate',
    needs: Object.freeze([]),
    file: 'validate.mjs',
    steps: Object.freeze(['compose_config', 'kustomize_build', 'kubeconform', 'terraform_validate', 'region_is_india_only', 'promtool_check_rules', 'promtool_test_rules', 'dashboards_parse', 'metrics_exist']),
  }),
});

export class ReadinessArgError extends Error {}

export function parseArgs(argv) {
  const [check, ...rest] = argv;
  if (!check || !READINESS_CHECKS[check]) throw new ReadinessArgError(`Name a check: ${Object.keys(READINESS_CHECKS).join(', ')}`);
  const options = { check, json: false, keep: false };
  for (const arg of rest) {
    if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else throw new ReadinessArgError(`Unknown argument: ${arg}`);
  }
  return options;
}

/** The variables a check needs that are not set. Names only. */
export const missingServices = (check, env = process.env) => READINESS_CHECKS[check].needs.filter((name) => !env[name]);

/** Runs one check. Throws with code `not_implemented` until its file exists, and `missing_services` when a service is not named. */
export async function run({ check, keep = false, env = process.env, log = () => {} }) {
  const spec = READINESS_CHECKS[check];
  if (!spec) throw new ReadinessArgError(`Unknown check: ${check}`);
  const missing = missingServices(check, env);
  if (missing.length) throw Object.assign(new Error(`${check} needs these set: ${missing.join(', ')}`), { code: 'missing_services', missing });
  const file = path.join(HERE, spec.file);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`${check} is not built yet (tools/readiness/${spec.file}).`), { code: 'not_implemented' });
  const built = await import(pathToFileURL(file).href);
  return built.run({ env, keep, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await run({ ...options, log: (line) => process.stderr.write(`${line}\n`) });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else for (const step of report.steps) process.stdout.write(`${step.ok ? 'ok    ' : 'FAILED'}  ${step.name}${step.detail ? `  ${step.detail}` : ''}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
