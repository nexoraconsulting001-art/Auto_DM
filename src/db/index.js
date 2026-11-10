import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../platform/log.js';
import { currentTenant } from '../tenancy.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Any constant works; every process that migrates takes this lock, so two servers starting at once
// never apply the same migration twice.
const MIGRATION_LOCK = 4_242_001;

/** The role business work runs as: not the owner of anything, no superuser, and unable to bypass row-level security. */
export const APP_ROLE = 'bhava_app';

// A role belongs to the whole server, so another database there may have made it first, even at this moment.
// A login that is not a superuser has to be a member of the role to step down into it.
const ENSURE_APP_ROLE = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    BEGIN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT ${APP_ROLE} TO %I', current_user);
  END IF;
END $$`;

/** Makes the app role on this server. Migrations do it, and so does a restore, which may be onto a new server. */
export const ensureAppRole = (db) => db.exec(ENSURE_APP_ROLE);

/**
 * Opens the database and applies any migrations not yet applied.
 * - `url` set: Postgres via `pg`. This is what QA and production use.
 * - `url` empty: embedded Postgres (PGlite) in `dataDir`, or in memory when `dataDir` is omitted.
 *   Only for tests and quick local runs: PGlite can be open in one process at a time, so it cannot
 *   serve a web server and a worker together.
 * Returns { query(sql, params) -> rows, exec(sql), tx(fn), close(), kind, platform }. Inside tx, fn receives { query, exec }.
 *
 * Inside withTenant() every query and transaction runs as APP_ROLE with app.tenant_id set for that transaction, so
 * row-level security holds it to the current business. `platform` is the same three calls without that fence, for
 * the few things that are about no single business or look across them: routing, the job queue, the Platform Console.
 */
export async function openDb({ url = '', dataDir, migrate = true, poolSize = 10 } = {}) {
  const db = fenced(url ? await openPg(url, poolSize) : await openPglite(dataDir));
  if (migrate) await runMigrations(db);
  return db;
}

/**
 * Opens the database for a running process (web, worker, server commands). Postgres is the only runtime
 * database: without DATABASE_URL this refuses, unless NODE_ENV=test or ALLOW_PGLITE=1.
 */
export async function openRuntimeDb(config, env = process.env) {
  if (!config.databaseUrl && env.NODE_ENV !== 'test' && env.ALLOW_PGLITE !== '1') {
    throw new Error('DATABASE_URL is required: Postgres is the only runtime database. For a quick local run on the built-in database, set ALLOW_PGLITE=1.');
  }
  return openDb({ url: config.databaseUrl, dataDir: config.dataDir });
}

/** Applies migrations/NNN_name.sql in order, each in its own transaction. Returns the versions applied. */
export async function runMigrations(handle, dir = MIGRATIONS_DIR) {
  const db = handle.platform ?? handle;
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await t.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await t.exec(ENSURE_APP_ROLE);
  });
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

/** Wraps a driver so that work inside withTenant() can only touch the current business. */
function fenced(driver) {
  // withTenant() only accepts a positive integer, so the id is safe to write into the statement.
  const fence = () => {
    const tenant = currentTenant();
    return tenant ? `SET LOCAL ROLE ${APP_ROLE}; SELECT set_config('app.tenant_id', '${Number(tenant.id)}', true)` : '';
  };
  return {
    kind: driver.kind,
    close: driver.close,
    platform: { query: driver.query, exec: driver.exec, tx: (fn) => driver.tx(fn) },
    query(sql, params = []) {
      const start = fence();
      return start ? driver.tx((t) => t.query(sql, params), start) : driver.query(sql, params);
    },
    exec(sql) {
      const start = fence();
      return start ? driver.tx((t) => t.exec(sql), start) : driver.exec(sql);
    },
    tx: (fn) => driver.tx(fn, fence()),
  };
}

/**
 * bigint (int8) as PGlite gives it: a number when it fits exactly, a BigInt when it doesn't. pg's own default is a string, so
 * money in bigint paise (Phase 3) and every count(*) would be a number on one driver and text on the other.
 */
export const parseInt8 = (text) => {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : BigInt(text);
};

function pgTypes(pg) {
  const INT8 = 20;
  const INT8_ARRAY = 1016;
  const int8Array = pg.types.getTypeParser(INT8_ARRAY, 'text');
  return {
    getTypeParser(oid, format) {
      if (format !== 'binary' && oid === INT8) return parseInt8;
      if (format !== 'binary' && oid === INT8_ARRAY) return (text) => int8Array(text)?.map((v) => (v === null ? null : parseInt8(v)));
      return pg.types.getTypeParser(oid, format);
    },
  };
}

async function openPg(url, poolSize) {
  const { default: pg } = await import('pg');
  const ssl = /sslmode=disable|localhost|127\.0\.0\.1|@postgres[:/]/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: poolSize, allowExitOnIdle: true, types: pgTypes(pg) });
  // Postgres restarting or killing a connection is an error event, which would end the process with no listener.
  const connectionLost = (err) => log.warn('db.connection_lost', { code: err?.code });
  pool.on('error', connectionLost);
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  return {
    kind: 'postgres',
    query,
    exec: (sql) => pool.query(sql),
    async tx(fn, start = '') {
      const client = await pool.connect();
      client.on('error', connectionLost);
      let dead = false;
      try {
        await client.query(start ? `BEGIN; ${start}` : 'BEGIN');
        const result = await fn({
          query: async (sql, params = []) => (await client.query(sql, params)).rows,
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // A connection that can't even roll back is gone: it must not go back in the pool.
        await client.query('ROLLBACK').catch(() => {
          dead = true;
        });
        throw err;
      } finally {
        client.removeListener('error', connectionLost);
        client.release(dead);
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
    tx: (fn, start = '') => pg.transaction(async (t) => {
      if (start) await t.exec(start);
      return fn({ query: wrap(t), exec: (sql) => t.exec(sql) });
    }),
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
