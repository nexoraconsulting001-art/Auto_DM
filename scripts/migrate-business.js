// Imports an old single-shop app into one business (PRD 5.16). The importer is src/modules/migration.
//
//   npm run migrate-business -- --source export.json --tenant <slug>                 a dry run: counts and conflicts, nothing written
//   npm run migrate-business -- --source export.json --tenant <slug> --run           the real import, in one transaction
//   npm run migrate-business -- --source export.json --tenant <slug> --run --reels drop|reassign
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = readSource(options.source);
  const { config } = await import('../src/config.js');
  const { openRuntimeDb } = await import('../src/db/index.js');
  const { createRepos } = await import('../src/repos/index.js');
  const { createSecrets } = await import('../src/platform/secrets.js');
  const { createMigration } = await import('../src/modules/migration/index.js');
  const db = await openRuntimeDb(config);
  try {
    const repos = createRepos(db, { secrets: createSecrets(config) });
    const [tenant] = await (db.platform ?? db).query('SELECT id FROM tenants WHERE slug = $1', [options.tenant]);
    if (!tenant) throw new MigrateError('No business has that slug. Create it in the Platform Console first.');
    const importer = createMigration({ db, repos, config });
    const report = await importer[options.run ? 'run' : 'plan'](source, { tenantId: tenant.id, reels: options.reels });
    for (const [table, c] of Object.entries(report.counts)) console.log(`${table.padEnd(20)} source ${c.source}  ${options.run ? 'imported' : 'to import'} ${c.imported}  skipped ${c.skipped}`);
    for (const c of report.conflicts) console.log(`conflict ${c.kind} in ${c.table}${c.oldId ? ` (old id ${c.oldId})` : ''}${c.blocking ? ' [blocks the import]' : ''}`);
    if (report.alreadyImported) console.log('This export was already imported into this business: nothing was written.');
    else if (report.blocked) console.log('Blocked: settle the conflicts above, then run again.');
    else console.log(options.run ? `Imported. The next order number is ${report.nextOrderNumber}.` : 'Dry run: nothing was written. Add --run to import.');
    if (report.blocked) process.exitCode = 3;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`migrate-business: ${err.code === 'not_implemented' ? 'the importer is not built yet (Phase 8, migration track).' : err.message}`);
    process.exit(err instanceof MigrateError ? 2 : 1);
  });
}
