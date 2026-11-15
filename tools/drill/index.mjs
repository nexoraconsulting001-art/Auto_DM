/**
 * `npm run drill`: the backup and restore drill (Phase 8, Q-08 and Q-09; R-03 as a timed drill with a written report).
 * Run monthly, and before the showcase. Everything is on this machine: two embedded Postgres servers set as the QA
 * server's (tools/load/stack.mjs), the backup written to a local folder through the storage driver, the app started on
 * the restored copy. It refuses to run with NODE_ENV=production and never touches a database it did not start.
 *
 *   npm run drill                     the whole drill
 *   npm run drill -- --only refuse    one part: restore or refuse
 *   npm run drill -- --out <name>     the report's folder under test-results (default: drill)
 *
 * The steps, in order (DRILL_STEPS). The drill track builds run(); the backup and restore themselves are src/backup.js
 * (runBackup, runRestore), which this drill exercises and does not replace.
 *
 *   seed        a source database with the sample businesses loaded (scripts/showcase.js) and some activity
 *   backup      runBackup on the owner login; the time and the size are recorded
 *   restore     runRestore into a second, empty Postgres; timed against budgets.drill.restoreWithinSeconds
 *   compare     for every business: the row count and a checksum of every table that has tenant_id, source against
 *               restored, read as the platform; and the same for the platform's own tables. All must match (Q-08)
 *   fence       on the restored copy, as the app login: each business reads only its own rows, and none with no business set
 *   logins      both logins connect to the restored copy; the app login cannot read across businesses or change a table
 *   start       the web app starts on the restored copy and answers /readyz
 *   refuse      a truncated backup, a corrupted one and one of the wrong version are each refused, and the target
 *               database is byte-for-byte what it was before the attempt: counts and checksums again (Q-09)
 *
 * A checksum is over a table's rows in primary-key order with every column as text, so it is the same on any server:
 * checksumSql(table, keyColumns) below is the one statement both sides run.
 *
 *   run(options) -> report     options { only: [], out: 'drill', budgets }; the report is what writeReport takes, one
 *                              check per step, with `id` Q-08 on compare, fence, logins and start, and Q-09 on refuse
 */
import { pathToFileURL } from 'node:url';
import { loadBudgets } from '../load/stack.mjs';

export const DRILL_STEPS = Object.freeze(['seed', 'backup', 'restore', 'compare', 'fence', 'logins', 'start', 'refuse']);
export const DRILL_PARTS = Object.freeze({ restore: Object.freeze(['seed', 'backup', 'restore', 'compare', 'fence', 'logins', 'start']), refuse: Object.freeze(['seed', 'backup', 'refuse']) });
/** The three damaged backups of Q-09, and what is done to a good one to make each. */
export const BAD_BACKUPS = Object.freeze({
  truncated: 'the last third of the file is cut off',
  corrupted: 'bytes in the middle of the file are overwritten',
  wrong_version: 'the archive header names a format version this server does not read',
});

export class DrillError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * One statement that answers { rows, checksum } for a table: the number of rows and an md5 over every row as text, in
 * the order of `keyColumns`. With `tenantColumn` it takes $1, the business's id, and covers that business's rows only.
 */
export function checksumSql(table, keyColumns, { tenantColumn = '' } = {}) {
  for (const name of [table, ...keyColumns, ...(tenantColumn ? [tenantColumn] : [])]) {
    if (!IDENT.test(name)) throw new DrillError(`"${name}" is not a table or column name`);
  }
  if (!keyColumns.length) throw new DrillError('A checksum needs the columns to order by');
  const where = tenantColumn ? ` WHERE t.${tenantColumn} = $1` : '';
  const order = keyColumns.map((column) => `t.${column}`).join(', ');
  return `SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY ${order})), '') AS checksum FROM ${table} t${where}`;
}

export function parseArgs(argv) {
  const options = { only: [], out: 'drill' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--only' || arg === '--out') && (next === undefined || next.startsWith('--'))) throw new DrillError(`${arg} needs a value`);
    if (arg === '--only') options.only.push(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else throw new DrillError(`Unknown option ${arg}`);
  }
  for (const part of options.only) if (!DRILL_PARTS[part]) throw new DrillError(`--only is one of ${Object.keys(DRILL_PARTS).join(', ')}`);
  return options;
}

/** Runs the drill and answers the report. The drill track builds it. */
export async function run(_options) {
  throw new DrillError('The restore drill is not built yet (Phase 8, drill track).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (String(process.env.NODE_ENV).toLowerCase() === 'production') throw new DrillError('The drill never runs with NODE_ENV=production');
    const options = parseArgs(process.argv.slice(2));
    const report = await run({ ...options, budgets: loadBudgets() });
    process.exit(report.ok ? 0 : 1);
  })().catch((err) => {
    console.error(`drill: ${err.message}`);
    process.exit(err instanceof DrillError ? 2 : 1);
  });
}
