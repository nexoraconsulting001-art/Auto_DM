/**
 * Moving Bhava from the VM to the cloud (PRD 11, R-07; G-12), and the schema step the migration Job runs.
 * runbooks/move-from-vm.md is the order a person follows; every step can be run again.
 *
 *   node scripts/move-to-cloud.js fingerprint --out <file>
 *       On the VM, once writes have stopped and the last backup is taken. Reads the VM's database in one read-only
 *       snapshot and writes every table's row count and checksum, whole and per business, with the sequences, the
 *       grants and the row-level security rules. No row is in the file. Nothing on the VM is changed.
 *   node scripts/move-to-cloud.js restore --dump <file>
 *       Into the new, EMPTY Postgres that DATABASE_OWNER_URL names: checks the backup can be read, restores it in one
 *       transaction (a failure leaves the target as empty as it was), then makes the restricted app login of
 *       DATABASE_URL. The grants are the dump's. Refuses a target that holds anything; a second run of the same
 *       backup after it finished changes nothing.
 *   node scripts/move-to-cloud.js verify --fingerprint <file> [--files <copy-files state>]
 *       The new database against the fingerprint: every business's counts and checksums, the sequences, the grants,
 *       the row-level security rules, both logins and the fence; with --files, every copied file read back from
 *       object storage and checked against its checksum. Exits 1 and names every difference. Run before switching.
 *   node scripts/move-to-cloud.js rollups
 *       The analytics summaries, from the restored Postgres into the analytics database (ANALYTICS_DRIVER=clickhouse),
 *       business by business and day by day, then their totals compared. With ANALYTICS_DRIVER=pg there is nothing to
 *       do: they came with the database. Safe to run again: each day is replaced whole.
 *   node scripts/move-to-cloud.js schema
 *       The migrations this release ships, and the app login (the migration Job, before every rollout). Run it on a
 *       moved database only after verify: a newer migration changes what verify compares.
 *
 * Every address and credential comes from the settings (src/config.js, through the secret source), never from the
 * command line, and nothing printed holds an address, a credential or a business's data: tables, business ids,
 * counts and checksums only.
 *
 * Exit code: 0 done, 1 a difference or a failed step, 2 a bad argument or a target refused before anything ran.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLLUP_STORES } from '../src/contracts/analytics.js';
import { pgEnv } from '../src/backup.js';
import { assertRestrictedLogin, ensureAppLogin, ensureAppRole, openDb } from '../src/db/index.js';
import { withTenant } from '../src/tenancy.js';
import { checkBackup, toolEnv } from '../tools/drill/backup-check.mjs';
import { checkFence, checkLogins, coverage, diffSnapshots, rowsOf, snapshot } from '../tools/drill/compare.mjs';
import { verifyCopy } from './copy-files.js';

export const STEPS = Object.freeze(['fingerprint', 'restore', 'verify', 'rollups', 'schema']);
export const FINGERPRINT_FORMAT = 'bhava-move-fingerprint';
/** Where restore records what it did on the target. Outside `public`, so it is never part of what verify compares. */
export const MOVE_SCHEMA = 'bhava_move';

export class MoveError extends Error {
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = 'MoveError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const OPTIONS = { fingerprint: ['out'], restore: ['dump'], verify: ['fingerprint', 'files'], rollups: [], schema: [] };
const REQUIRED = { fingerprint: ['out'], restore: ['dump'], verify: ['fingerprint'], rollups: [], schema: [] };

export function parseArgs(argv) {
  const [step, ...rest] = argv;
  if (!STEPS.includes(step)) throw new MoveError(`Name a step: ${STEPS.join(', ')}`, 'bad_argument', 2);
  const options = { step };
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m || !OPTIONS[step].includes(m[1])) throw new MoveError(`Unknown argument for ${step}: ${rest[i]}`, 'bad_argument', 2);
    const value = m[2] ?? rest[++i];
    if (!value || value.startsWith('--')) throw new MoveError(`--${m[1]} needs a value`, 'bad_argument', 2);
    options[m[1]] = value;
  }
  for (const name of REQUIRED[step]) if (!options[name]) throw new MoveError(`${step} needs --${name}`, 'bad_argument', 2);
  return options;
}

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
});

/** A tool's error, cut to its first line with any quoted value taken out, so no row of data reaches a log. */
export function toolProblem(stderr) {
  const line = String(stderr || '').split('\n').map((l) => l.trim()).find((l) => /error/i.test(l)) || String(stderr || '').split('\n')[0] || '';
  return line.replace(/'[^']*'/g, "'…'").replace(/\bline \d+:.*$/i, '').slice(0, 200).trim();
}

function runTool(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => resolve({ code: -1, stderr: `${cmd} could not start: ${err.code || 'error'}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** pg_restore into the owner's database, as one transaction: it all lands or none of it does. */
export async function pgRestore({ dumpFile, ownerUrl }) {
  const dbname = decodeURIComponent(new URL(ownerUrl).pathname.slice(1));
  const result = await runTool('pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${dbname}`, dumpFile], toolEnv(pgEnv(ownerUrl)));
  if (result.code !== 0) throw new MoveError(`pg_restore stopped and the target was left as it was: ${toolProblem(result.stderr)}`, 'restore_failed');
}

// ---- reading a database -------------------------------------------------------------------------------------------

/**
 * The fingerprint of the database `client` is connected to (a pg client or PGlite: query(sql, params) -> { rows }),
 * read in one read-only snapshot, so it changes nothing and sees one moment.
 */
export async function fingerprint(client, { now = new Date() } = {}) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snap = await snapshot(client);
    return { format: FINGERPRINT_FORMAT, version: 1, takenAt: now.toISOString(), coverage: coverage(snap), snapshot: snap };
  } finally {
    await client.query('ROLLBACK');
  }
}

export function readFingerprint(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new MoveError('The fingerprint file cannot be read as JSON.', 'bad_fingerprint', 2);
  }
  if (doc?.format !== FINGERPRINT_FORMAT || doc.version !== 1 || !doc.snapshot?.tables) throw new MoveError('That file is not a fingerprint made by this script.', 'bad_fingerprint', 2);
  return doc;
}

/** What the target holds: the relations in `public` that no extension owns, and restore's record, if any. */
export async function targetState(client) {
  const [{ n }] = (await client.query(`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`)).rows;
  const [{ has }] = (await client.query(`SELECT to_regclass('${MOVE_SCHEMA}.restore') IS NOT NULL AS has`)).rows;
  const record = has ? (await client.query(`SELECT dump_sha256, status FROM ${MOVE_SCHEMA}.restore WHERE id = 1`)).rows[0] ?? null : null;
  return { relations: Number(n), record };
}

async function writeRecord(client, sha, status) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${MOVE_SCHEMA}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${MOVE_SCHEMA}.restore (
    id integer PRIMARY KEY CHECK (id = 1), dump_sha256 text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(`INSERT INTO ${MOVE_SCHEMA}.restore (id, dump_sha256, status) VALUES (1, $1, $2)
    ON CONFLICT (id) DO UPDATE SET dump_sha256 = EXCLUDED.dump_sha256, status = EXCLUDED.status, updated_at = now()`, [sha, status]);
}

// ---- restore --------------------------------------------------------------------------------------------------------

/**
 * Restores `dumpFile` into the database `owner` is connected to. `tools` are injectable for tests:
 * { check(file) -> { ok, reason }, restore({ dumpFile, ownerUrl }) }. Answers { status: 'restored' | 'already_restored' | 'finished', sha256 }.
 */
export async function restoreDump({ dumpFile, owner, ownerUrl, appUrl = '', tools = {}, say = () => {} }) {
  const check = tools.check ?? ((file) => checkBackup(file));
  const restore = tools.restore ?? pgRestore;
  if (!fs.existsSync(dumpFile)) throw new MoveError('The backup file does not exist.', 'no_backup', 2);
  const sha = await sha256File(dumpFile);
  const state = await targetState(owner);
  const same = state.record?.dump_sha256 === sha;
  if (state.record && !same) throw new MoveError('The target was restored from a different backup. Restore into a new, empty database.', 'target_has_other_backup', 2);
  let status = 'restored';
  if (same && state.record.status === 'restored') {
    say('restore: this backup is already restored here; nothing changed');
    status = 'already_restored';
  } else if (state.relations > 0 && !(same && state.record.status === 'restoring')) {
    throw new MoveError(`The target is not empty (${state.relations} tables, views or sequences in public). Restore only into a new, empty database.`, 'target_not_empty', 2);
  } else if (state.relations > 0) {
    // The single-transaction restore committed before the record was updated: everything is there.
    await writeRecord(owner, sha, 'restored');
    status = 'finished';
  } else {
    const checked = await check(dumpFile);
    if (!checked.ok) throw new MoveError(`The backup cannot be restored: ${checked.reason}`, 'bad_backup', 2);
    // The dump grants to the app role, which a new server does not have yet.
    await ensureAppRole(rowsOf(owner));
    await writeRecord(owner, sha, 'restoring');
    say('restore: restoring in one transaction');
    try {
      await restore({ dumpFile, ownerUrl });
    } catch (err) {
      await writeRecord(owner, sha, 'failed').catch(() => {});
      throw err instanceof MoveError ? err : new MoveError(`The restore failed and the target was left as it was: ${toolProblem(err.message)}`, 'restore_failed');
    }
    await writeRecord(owner, sha, 'restored');
  }
  if (appUrl && appUrl !== ownerUrl) {
    await ensureAppLogin(rowsOf(owner), appUrl);
    say('restore: the app login is in place');
  }
  return { status, sha256: sha };
}

// ---- verify ---------------------------------------------------------------------------------------------------------

/**
 * The target against a fingerprint. `owner` reads everything; `app` (the restricted login's client), when given,
 * proves both logins and the fence; `files` ({ manifest, store }) checks every copied file. Answers
 * { ok, differences: [sentence], coverage, files }. Sentences name tables, business ids and counts only.
 */
export async function verifyTarget({ fp, owner, app = null, files = null }) {
  const target = await snapshot(owner);
  const differences = diffSnapshots(fp.snapshot, target, { limit: 200 }).map((line) => line.replace(/after restore/g, 'in the target'));
  if (differences.some((line) => /^table schema_migrations/.test(line))) {
    differences.push('the migrations differ: run verify before the schema step, on the database exactly as restored');
  }
  if (app) {
    const logins = await checkLogins({ owner, app, assertRestrictedLogin });
    differences.push(...logins.problems);
    const fence = await checkFence(app, target);
    differences.push(...fence.problems);
  }
  let filesReport = null;
  if (files) {
    filesReport = await verifyCopy(files);
    differences.push(...filesReport.problems);
  }
  return { ok: differences.length === 0, differences, coverage: coverage(target), files: filesReport };
}

// ---- rollups --------------------------------------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const writable = (store) => [...new Set([...store.key.filter((k) => k !== 'dims_hash'), ...store.dimensions, ...store.columns, ...store.extras])];
const sumMeasures = (store) => Object.entries(store.measures).filter(([, m]) => m.fn === 'sum').map(([name, m]) => [name, m.column]);

/**
 * Copies every business's rows of every rollup store from Postgres (`owner`, rows-style: query -> rows) into `rollups`
 * (the analytics database's rollups interface), one day at a time with rebuild(), then compares each store's totals
 * per business. Answers { businesses, rows, problems }.
 */
export async function copyRollups({ owner, rollups, say = () => {} }) {
  const tenants = (await owner.query('SELECT id FROM tenants ORDER BY id')).map((r) => Number(r.id));
  const problems = [];
  let total = 0;
  for (const id of tenants) {
    for (const [name, store] of Object.entries(ROLLUP_STORES)) {
      if (!IDENT.test(name)) throw new MoveError(`The rollup store "${name}" has a name this script cannot read safely.`, 'bad_store');
      const cols = writable(store).filter((c) => c !== 'day');
      for (const c of cols) if (!IDENT.test(c)) throw new MoveError(`The column "${name}.${c}" has a name this script cannot read safely.`, 'bad_store');
      const rows = await owner.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, ${cols.join(', ')} FROM ${name} WHERE tenant_id = $1 ORDER BY day`, [id]);
      if (!rows.length) continue;
      const byDay = new Map();
      for (const raw of rows) {
        const row = { day: raw.day };
        for (const c of cols) {
          const v = raw[c];
          if (store.numericDimensions.includes(c) || store.columns.includes(c)) row[c] = v === null || v === undefined ? null : Number(v);
          else row[c] = v instanceof Date ? v.toISOString() : v;
        }
        byDay.set(raw.day, [...(byDay.get(raw.day) ?? []), row]);
      }
      await withTenant({ id }, async () => {
        for (const [day, dayRows] of byDay) await rollups.rebuild(name, { since: day, until: day }, dayRows);
      });
      total += rows.length;
      const measures = sumMeasures(store);
      if (!measures.length) continue;
      const since = rows[0].day;
      const until = rows[rows.length - 1].day;
      const [want] = await owner.query(`SELECT ${measures.map(([m, c]) => `COALESCE(sum(${c}), 0)::text AS ${m}`).join(', ')} FROM ${name} WHERE tenant_id = $1`, [id]);
      const [got] = await withTenant({ id }, () => rollups.read(name, { measures: measures.map(([m]) => m), since, until, limit: 1 }));
      for (const [m] of measures) {
        if (Number(want[m]) !== Number(got?.[m] ?? 0)) problems.push(`rollup ${name}, business ${id}: ${m} totals ${want[m]} in Postgres, ${got?.[m] ?? 0} in the analytics database`);
      }
    }
    say(`rollups: business ${id} done`);
  }
  return { businesses: tenants.length, rows: total, problems };
}

// ---- the command line -----------------------------------------------------------------------------------------------

const sslFor = (url) => (/sslmode=disable|localhost|127\.0\.0\.1|@postgres[:/]/.test(url) ? false : { rejectUnauthorized: false });

async function connect(url) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function loadConfig() {
  const { config, loadSecrets } = await import('../src/config.js');
  await loadSecrets(config);
  return config;
}

const ownerUrlOf = (config) => config.databaseOwnerUrl || config.databaseUrl;

async function main(argv, say) {
  const options = parseArgs(argv);
  const config = await loadConfig();
  const ownerUrl = ownerUrlOf(config);
  if (!ownerUrl) throw new MoveError('Set DATABASE_URL (and DATABASE_OWNER_URL for two logins) first.', 'not_configured', 2);

  if (options.step === 'schema') {
    const db = await openDb({ url: config.databaseUrl, ownerUrl: config.databaseOwnerUrl, poolSize: 2 });
    await db.close();
    say(`schema: migrations applied and the app login checked (${db.logins} login${db.logins === 1 ? '' : 's'})`);
    return 0;
  }

  const owner = await connect(ownerUrl);
  try {
    if (options.step === 'fingerprint') {
      const out = path.resolve(options.out);
      if (fs.existsSync(out)) throw new MoveError('The fingerprint file exists already: name a new one.', 'file_exists', 2);
      const fp = await fingerprint(owner);
      fs.writeFileSync(out, `${JSON.stringify(fp)}\n`, { flag: 'wx' });
      say(`fingerprint: ${fp.coverage.tables} tables, ${fp.coverage.businesses} businesses, ${fp.coverage.rows} rows`);
      return 0;
    }
    if (options.step === 'restore') {
      const appUrl = config.databaseOwnerUrl ? config.databaseUrl : '';
      const result = await restoreDump({ dumpFile: path.resolve(options.dump), owner, ownerUrl, appUrl, say });
      say(`restore: ${result.status}`);
      return 0;
    }
    if (options.step === 'verify') {
      const fp = readFingerprint(options.fingerprint);
      const app = config.databaseOwnerUrl && config.databaseUrl !== config.databaseOwnerUrl ? await connect(config.databaseUrl) : null;
      try {
        let files = null;
        if (options.files) {
          const { targetStore } = await import('./copy-files.js');
          files = { manifest: path.resolve(options.files), store: targetStore(config) };
        }
        const report = await verifyTarget({ fp, owner, app, files });
        if (!app) say('verify: one login only, so the app login and the fence were not checked');
        for (const line of report.differences) say(`DIFFERENT  ${line}`);
        say(`verify: ${report.coverage.tables} tables, ${report.coverage.businesses} businesses, ${report.coverage.rows} rows${report.files ? `, ${report.files.files} files` : ''}: ${report.ok ? 'everything matches' : `${report.differences.length} differences`}`);
        return report.ok ? 0 : 1;
      } finally {
        await app?.end();
      }
    }
    if (options.step === 'rollups') {
      if (config.analyticsDriver !== 'clickhouse') {
        say('rollups: ANALYTICS_DRIVER is pg, so the summaries came with the database; nothing to do');
        return 0;
      }
      const { createAnalytics } = await import('../src/platform/analytics.js');
      const report = await copyRollups({ owner: rowsOf(owner), rollups: createAnalytics(config).rollups, say });
      for (const line of report.problems) say(`DIFFERENT  ${line}`);
      say(`rollups: ${report.rows} rows for ${report.businesses} businesses${report.problems.length ? `, ${report.problems.length} differences` : ', totals match'}`);
      return report.problems.length ? 1 : 0;
    }
  } finally {
    await owner.end();
  }
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const say = (line) => process.stderr.write(`${line}\n`);
  main(process.argv.slice(2), say).then(
    (code) => process.exit(code),
    (err) => {
      say(err instanceof MoveError ? err.message : `Failed: ${toolProblem(err.message)}`);
      process.exit(err instanceof MoveError ? err.exitCode : 1);
    },
  );
}

