// Imports an old single-shop app into one business (PRD 5.16). The importer is src/modules/migration.
//
//   npm run migrate-business -- --source export.json --tenant <slug>                 a dry run: counts and conflicts, nothing written
//   npm run migrate-business -- --source export.json --tenant <slug> --run           the real import, in one transaction
//   npm run migrate-business -- --source export.json --tenant <slug> --run --reels drop|reassign
//   --reason "<why>" is required with --run and goes in the audit log; --by <email> names the Platform Console user who ran it.
//
// The source is an export of the old app (MigrationSource in src/contracts/migration.js). The business exists already:
// create it in the Platform Console first. A dry run is the default, so the real import is always asked for by name.
// Run on the owner's connection (DATABASE_OWNER_URL), like a backup. Prints counts and conflict codes only: never a row.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MigrationSource, REEL_CHOICES } from '../src/contracts/migration.js';

export class MigrateError extends Error {}

export function parseArgs(argv) {
  const options = { source: '', tenant: '', run: false, reels: undefined };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new MigrateError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') options.source = value(i++, arg);
    else if (arg === '--tenant') options.tenant = value(i++, arg);
    else if (arg === '--run') options.run = true;
    else if (arg === '--reels') options.reels = value(i++, arg);
    // Only set when given, so the options read the same as before for a run without them.
    else if (arg === '--reason') options.reason = value(i++, arg);
    else if (arg === '--by') options.by = value(i++, arg);
    else throw new MigrateError(`Unknown option ${arg}`);
  }
  if (!options.source) throw new MigrateError('Give the export to import: --source <file>');
  if (!options.tenant) throw new MigrateError('Give the business to import into: --tenant <slug>');
  if (options.reels !== undefined && !REEL_CHOICES.includes(options.reels)) throw new MigrateError(`--reels is one of ${REEL_CHOICES.join(', ')}`);
  return options;
}

/** Reads an export file and checks its shape. Throws MigrateError naming the field, never the row's contents. */
export function readSource(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MigrateError(`The export cannot be read: ${err.code === 'ENOENT' ? 'no such file' : 'it is not valid JSON'}`);
  }
  const parsed = MigrationSource.safeParse(data);
  if (!parsed.success) throw new MigrateError(`The export does not fit: ${parsed.error.issues[0].path.join('.') || 'file'}: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

/** Prints a report: counts and conflict codes only, never a row. `print` is console.log by default. */
export function printReport(report, { run }, print = console.log) {
  for (const [table, c] of Object.entries(report.counts)) print(`${table.padEnd(20)} source ${c.source}  ${run ? 'imported' : 'to import'} ${c.imported}  skipped ${c.skipped}`);
  for (const c of report.conflicts) print(`conflict ${c.kind} in ${c.table}${c.oldId ? ` (old id ${c.oldId})` : ''}${c.blocking ? ' [blocks the import]' : ''}`);
  if (report.alreadyImported) print(run ? 'This export was already imported into this business: nothing was written.' : 'This export was already imported into this business: a real run writes nothing.');
  else if (report.blocked) print('Blocked: settle the conflicts above, then run again.');
  else print(run ? `Imported (run ${report.runId}). The next order number is ${report.nextOrderNumber}.` : 'Dry run: nothing was written. Add --run to import.');
}

/**
 * The command's work on an open database: finds the business and the operator, then plans or runs. `platform` is
 * createPlatform()'s modules (storage and images are the ones the importer uses). Returns the report.
 */
export async function migrateBusiness({ db, platform, options, source }) {
  const { createMigration } = await import('../src/modules/migration/index.js');
  const owner = db.platform ?? db;
  const [tenant] = await owner.query('SELECT id FROM tenants WHERE slug = $1', [options.tenant]);
  if (!tenant) throw new MigrateError('No business has that slug. Create it in the Platform Console first.');
  let startedBy = null;
  if (options.by) {
    const [user] = await owner.query('SELECT id FROM platform_users WHERE lower(email) = lower($1)', [options.by]);
    if (!user) throw new MigrateError('--by names no Platform Console user');
    startedBy = user.id;
  }
  if (options.run && !String(options.reason ?? '').trim()) throw new MigrateError('Say why with --reason "<why>": the import is audited');
  const importer = createMigration({ db, platform });
  const opts = { tenantId: tenant.id, startedBy, ...(options.reels ? { reels: options.reels } : {}) };
  return options.run ? importer.run(source, opts, { reason: options.reason }) : importer.plan(source, opts);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = readSource(options.source);
  const { config } = await import('../src/config.js');
  const { openRuntimeDb } = await import('../src/db/index.js');
  const { createPlatform } = await import('../src/platform/index.js');
  const db = await openRuntimeDb(config);
  try {
    const report = await migrateBusiness({ db, platform: createPlatform(config, { db }), options, source });
    printReport(report, options);
    if (report.blocked) process.exitCode = 3;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // The message and, for a refused value, the table, old id and field: never the value itself.
    const fields = err.fields ? ` (${Object.keys(err.fields).join(', ')})` : '';
    console.error(`migrate-business: ${err.message}${fields}`);
    process.exit(err instanceof MigrateError ? 2 : 1);
  });
}
