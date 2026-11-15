import { ApiError } from '../../contracts/api/index.js';

/**
 * Imports an old single-shop app into one business (PRD 5.16, F-68 to F-73). The rules are data in
 * src/contracts/migration.js; the tables are migration 800 (migration_runs, migration_id_map), both the platform's.
 * `npm run migrate-business` (scripts/migrate-business.js) is the command. No routes and no jobs.
 *
 *   const importer = createMigration(ctx);
 *
 *   importer.plan(source, options)   -> MigrationReport with mode 'dry'. Counts per table and every conflict. Writes
 *                                       nothing at all: no business row, no id map, no run row (F-68).
 *   importer.run(source, options)    -> MigrationReport with mode 'real' and runId. One transaction for the whole import:
 *                                       any error, any blocking conflict, or counts that do not balance (countsBalance)
 *                                       rolls every row back (F-69), and a `failed` run row is written afterwards, outside
 *                                       that transaction. Safe to run again: rows already in migration_id_map are skipped,
 *                                       and a finished run of the same export (source_hash) answers alreadyImported with
 *                                       nothing written.
 *
 * `source` is a MigrationSource (an export of the old app: tables as rows); `options` is MigrationOptions
 * ({ tenantId, reels?, startedBy? }). Both are parsed, so a caller may pass plain JSON.
 *
 * What the importer holds to (each is a constant of the contract):
 *   - ids are remapped; slugs, order numbers, public tokens and media are kept (MIGRATION_KEEPS)
 *   - usernames and comment or message text are blanked (MIGRATION_STRIPS, F-71)
 *   - password hashes, Instagram tokens and the old owner login are never copied (MIGRATION_NEVER_COPIED); a migrated
 *     shopper is matched by phone when they next sign in with a code (F-72)
 *   - the order counter becomes the highest migrated number plus one (nextOrderNumber, F-70)
 *   - a reel posted on another business's Instagram account blocks until options.reels says drop or reassign (F-73)
 *   - every write is inside withTenant for options.tenantId, through the fence, so nothing can land in another business
 */
export function createMigration(_ctx) {
  const notBuilt = async () => { throw new ApiError('not_implemented'); };
  return { plan: notBuilt, run: notBuilt };
}

export const migration = {
  name: 'migration',
  owns: { migrations: ['800_migration.sql'], tables: ['migration_runs', 'migration_id_map'], api: [], store: [], platform: [], jobs: [] },
};
