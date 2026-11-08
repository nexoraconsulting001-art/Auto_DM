import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Any constant works; every process that migrates takes this lock, so two servers starting at once
// never apply the same migration twice.
const MIGRATION_LOCK = 4_242_001;

/**
 * Opens the database and applies any migrations not yet applied.
 * - `url` set: Postgres via `pg`. This is what QA and production use.
 * - `url` empty: embedded Postgres (PGlite) in `dataDir`, or in memory when `dataDir` is omitted.
 *   Only for tests and quick local runs: PGlite can be open in one process at a time, so it cannot
 *   serve a web server and a worker together.
 * Returns { query(sql, params) -> rows, exec(sql), tx(fn), close(), kind }. Inside tx, fn receives { query }.
 */
export async function openDb({ url = '', dataDir, migrate = true, poolSize = 10 } = {}) {
  const db = url ? await openPg(url, poolSize) : await openPglite(dataDir);
  if (migrate) await runMigrations(db);
  return db;
}

/** Applies migrations/NNN_name.sql in order, each in its own transaction. Returns the versions applied. */
export async function runMigrations(db, dir = MIGRATIONS_DIR) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    const version = file.slice(0, 3);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const ran = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const [done] = await t.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (done) return false;
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}

async function openPg(url, poolSize) {
  const { default: pg } = await import('pg');
  const ssl = /sslmode=disable|localhost|127\.0\.0\.1|@postgres[:/]/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: poolSize });
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  return {
    kind: 'postgres',
    query,
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (sql, params = []) => (await client.query(sql, params)).rows,
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const wrap = (runner) => async (sql, params = []) => normalize((await runner.query(sql, params)).rows);
  return {
    kind: 'pglite',
    query: wrap(pg),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn({ query: wrap(t), exec: (sql) => t.exec(sql) })),
    close: () => pg.close(),
  };
}

// PGlite returns bytea as Uint8Array; pg returns Buffer. Normalize to Buffer.
function normalize(rows) {
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
    }
  }
  return rows;
}
