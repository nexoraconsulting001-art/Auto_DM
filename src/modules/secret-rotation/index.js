import crypto from 'node:crypto';
import { REWRAP_BATCH, REWRAP_JOB, RewrapProgress, SECRET_COLUMNS, oldKeysRetirable, secretBinding } from '../../contracts/secrets.js';
import { log as defaultLog, reportError } from '../../platform/log.js';

/**
 * Master-key rotation (PRD 5.15, F-66; Phase 9). Track: prod-runtime.
 *
 * Owns secret_rewraps (migration 900): the platform's, reached through db.platform. The job walks every column of
 * SECRET_COLUMNS (src/contracts/secrets.js) by its primary key, REWRAP_BATCH rows a step, each step its own short
 * transaction, and writes each value again with platform.secrets.rewrap(): the wrapped data key changes, the value's
 * ciphertext does not, and a v1 value becomes v2. A row is skipped when it is NULL or '', and when it is already under
 * the current key and sealed to its own record.
 *
 * R2-SEC-1: each row is read with the columns its value is sealed to (SECRET_COLUMNS `bind`), and rewrap() binds a value
 * written before the binding to that row. A value bound to another record (one copied in from elsewhere) is not moved:
 * it counts as a failure, so the column ends `failed` and the old key stays needed until someone looks at it. Once
 * every column is done, SECRETS_REQUIRE_BINDING can be set and an unbound value is refused everywhere.
 *
 * Why nothing is lost, and nothing is ever readable by neither key:
 * - The batch, its writes and the place it reached (secret_rewraps.last_id) commit together. A crash anywhere in a step
 *   rolls all of it back: every value stays as it was, under the key it had, and the next step does the batch again.
 * - A value is written only if it is still the one that was read (compare and swap), and only once the new form has
 *   been proved to decrypt to the same secret. A value that cannot be read is never written; it is counted as a failure.
 * - Rows are locked FOR UPDATE SKIP LOCKED, so a writer is never made to wait and the job never waits for a writer.
 *   Readers never wait at all: both keys decrypt throughout, since the old key stays in DATA_KEY_OLD until the end.
 * - A column is `done` only when a final count finds no value left under another key or format. A value the walk
 *   skipped (locked at that moment) or one written since by a process still on the old key starts another pass.
 *   A pass that met a value it could not read ends `failed`, and the old key is then not retirable.
 * - Two workers never take the same column at once: the column's secret_rewraps row is locked for the step.
 *
 * It logs and counts ids and numbers only (secret_rewrap_rows_total): never a value, a key or a business. progress()
 * answers the place reached as a short hash, because a primary key can name a business.
 *
 *   createSecretRotation(ctx).start()      -> makes the secret_rewraps rows for the current key and enqueues the job
 *   createSecretRotation(ctx).step()       -> one batch; answers { table, column, done, skipped, failed, status, finished }
 *   createSecretRotation(ctx).run()        -> the job: steps until finished or the time budget is spent, then enqueues itself
 *   createSecretRotation(ctx).progress()   -> RewrapProgress
 *   createSecretRotation(ctx).retirable()  -> { ok, remaining: [{ table, column, count }], oldKeyIds }: may DATA_KEY_OLD go?
 */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw new Error('Not a table or column name');
  return `"${name}"`;
};

class RotationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RotationError';
    this.code = code;
  }
}

/** The parts of secret_rewraps.last_id, for a key of `n` columns: the last part takes whatever is left. */
function splitKey(text, n) {
  if (n === 1) return [text];
  const parts = String(text).split(',');
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(',')];
}
const joinKey = (row, key) => key.map((k) => String(row[k])).join(',');
const maskPlace = (lastId) => (lastId ? crypto.createHash('sha256').update(String(lastId)).digest('base64url').slice(0, 8) : '');

export function createSecretRotation(ctx, { batch = REWRAP_BATCH, budgetMs = 20_000, pauseMs = 25, columns = SECRET_COLUMNS, log = defaultLog } = {}) {
  const db = ctx.db?.platform ?? ctx.db;
  const secrets = ctx.platform?.secrets;
  const metrics = ctx.platform?.metrics;
  const queue = ctx.platform?.queue;
  const size = Math.max(1, Math.min(10_000, Number(batch) || REWRAP_BATCH));

  const target = () => {
    if (!db) throw new RotationError('The re-wrap job needs the database', 'no_database');
    if (!secrets?.configured) throw new RotationError('DATA_KEY is not set, so nothing can be re-wrapped', 'no_key');
    return { keyId: secrets.currentKeyId, format: secrets.format };
  };
  const columnOf = (table, column) => columns.find((c) => c.table === table && c.column === column) ?? null;

  /**
   * SQL that is true for a stored value still under another key, not yet sealed to a record, or, when v2 is written, in
   * the v1 form. (Whether it is sealed to its own record needs the row's binding: the walk checks that.)
   */
  const staleWhere = (col, format, at) =>
    format === 'v2'
      ? `(split_part(${col}, '.', 1) NOT LIKE 'v2~%' OR split_part(${col}, '.', 2) <> $${at})`
      : `((split_part(${col}, '.', 1) NOT LIKE 'v1~%' AND split_part(${col}, '.', 1) NOT LIKE 'v2~%') OR split_part(${col}, '.', 2) <> $${at})`;

  async function remainingIn(q, def, { keyId, format }) {
    const col = ident(def.column);
    const [row] = await q(`SELECT count(*)::int AS n FROM ${ident(def.table)} WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${staleWhere(col, format, 1)}`, [keyId]);
    return Number(row?.n ?? 0);
  }

  const count = (result, n) => {
    if (n > 0) metrics?.inc?.('secret_rewrap_rows_total', { result }, n);
  };

  async function start() {
    const { keyId, format } = target();
    for (const c of columns) {
      // A column that failed before starts a fresh pass: the operator has fixed what it could not read.
      await db.query(
        `INSERT INTO secret_rewraps (table_name, column_name, key_id, format) VALUES ($1, $2, $3, $4)
         ON CONFLICT (table_name, column_name, key_id, format) DO UPDATE
           SET status = 'pending', last_id = '', failures = 0, updated_at = now()
           WHERE secret_rewraps.status = 'failed'`,
        [c.table, c.column, keyId, format],
      );
      // A column done before, where a process still on the old key has written since, is walked again.
      if ((await remainingIn(db.query, c, { keyId, format })) > 0) {
        await db.query(
          `UPDATE secret_rewraps SET status = 'pending', last_id = '', failures = 0, finished_at = NULL, updated_at = now()
            WHERE table_name = $1 AND column_name = $2 AND key_id = $3 AND format = $4 AND status = 'done'`,
          [c.table, c.column, keyId, format],
        );
      }
    }
    if (queue?.enqueue) await queue.enqueue(REWRAP_JOB, {}, { retryInFlight: true });
    log.info('secrets.rewrap.started', { keyId, format, columns: columns.length });
    return progress();
  }

  async function finished({ keyId, format }) {
    const rows = await db.query(`SELECT table_name, column_name, status FROM secret_rewraps WHERE key_id = $1 AND format = $2`, [keyId, format]);
    return oldKeysRetirable(rows.map((r) => ({ table: r.table_name, column: r.column_name, keyId, format, status: r.status })), { keyId, format });
  }

  async function step() {
    const goal = target();
    const { keyId, format } = goal;
    const result = await db.tx(async (t) => {
      const q = t.query;
      await q(`SET LOCAL statement_timeout = '30s'`);
      await q(`SET LOCAL lock_timeout = '5s'`);
      const [row] = await q(
        `SELECT id, table_name, column_name, last_id, failures FROM secret_rewraps
          WHERE key_id = $1 AND format = $2 AND status IN ('pending', 'running')
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [keyId, format],
      );
      if (!row) return null;
      const def = columnOf(row.table_name, row.column_name);
      if (!def) {
        await q(`UPDATE secret_rewraps SET status = 'failed', updated_at = now() WHERE id = $1`, [row.id]);
        return { table: row.table_name, column: row.column_name, done: 0, skipped: 0, failed: 0, status: 'failed' };
      }
      const keys = def.key;
      const keyCols = keys.map(ident).join(', ');
      const bindCols = (def.bind ?? []).filter((c) => !keys.includes(c)).map((c) => `, ${ident(c)}`).join('');
      const col = ident(def.column);
      const after = row.last_id ? splitKey(row.last_id, keys.length) : null;
      const from = after ? `AND (${keyCols}) > (${keys.map((_, i) => `$${i + 1}`).join(', ')})` : '';
      const rows = await q(
        `SELECT ${keyCols}${bindCols}, ${col} AS value FROM ${ident(def.table)}
          WHERE ${col} IS NOT NULL AND ${col} <> '' ${from}
          ORDER BY ${keyCols} LIMIT ${size} FOR UPDATE SKIP LOCKED`,
        after ?? [],
      );
      let done = 0;
      let skipped = 0;
      let failed = 0;
      const match = keys.map((k, i) => `${ident(k)} = $${i + 3}`).join(' AND ');
      for (const r of rows) {
        let binding;
        try {
          binding = secretBinding(def.table, def.column, r);
        } catch {
          failed += 1;
          continue;
        }
        if (!secrets.needsRotation(r.value, binding)) {
          skipped += 1;
          continue;
        }
        let next;
        try {
          next = secrets.rewrap(r.value, binding);
          // Proved before it is written: the new form reads, as this row's, and reads as the same secret.
          if (next === r.value || secrets.decrypt(next, binding) !== secrets.decrypt(r.value)) throw new Error('mismatch');
        } catch {
          failed += 1;
          continue;
        }
        const written = await q(`UPDATE ${ident(def.table)} SET ${col} = $1 WHERE ${col} = $2 AND ${match} RETURNING 1 AS ok`, [next, r.value, ...keys.map((k) => r[k])]);
        if (written.length) done += 1;
        else skipped += 1;
      }
      const passFailures = Number(row.failures) + failed;
      let status = 'running';
      let lastId = rows.length ? joinKey(rows[rows.length - 1], keys) : row.last_id;
      let failures = passFailures;
      if (rows.length < size) {
        // The walk reached the end of the table.
        if (passFailures > 0) status = 'failed';
        else if ((await remainingIn(q, def, goal)) > 0) {
          // Something was skipped or written under the old key since: another pass.
          lastId = '';
          failures = 0;
        } else status = 'done';
      }
      await q(
        `UPDATE secret_rewraps SET last_id = $2, status = $3, rows_done = rows_done + $4, failures = $5,
           started_at = COALESCE(started_at, now()), finished_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1`,
        [row.id, lastId, status, done, failures],
      );
      return { table: def.table, column: def.column, done, skipped, failed, status };
    });
    const isFinished = await finished(goal);
    if (!result) return { table: null, column: null, done: 0, skipped: 0, failed: 0, status: null, finished: isFinished };
    count('rewrapped', result.done);
    count('skipped', result.skipped);
    count('failed', result.failed);
    log.info('secrets.rewrap.step', { table: result.table, column: result.column, rewrapped: result.done, skipped: result.skipped, failed: result.failed, status: result.status });
    return { ...result, finished: isFinished };
  }

  /** The job: steps until finished, until no open column is free, or until the budget is spent; then it carries on as a new job. */
  async function run() {
    const until = Date.now() + budgetMs;
    let last;
    for (;;) {
      last = await step();
      if (last.finished || !last.table) return last;
      if (Date.now() >= until) break;
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    if (queue?.enqueue) await queue.enqueue(REWRAP_JOB, {}, { retryInFlight: true });
    return last;
  }

  async function progress() {
    const { keyId, format } = target();
    const rows = await db.query(`SELECT table_name, column_name, status, last_id, rows_done FROM secret_rewraps WHERE key_id = $1 AND format = $2`, [keyId, format]);
    const byColumn = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    const list = columns.map((c) => {
      const r = byColumn.get(`${c.table}.${c.column}`);
      return { table: c.table, column: c.column, status: r?.status ?? 'pending', lastId: maskPlace(r?.last_id), done: Number(r?.rows_done ?? 0) };
    });
    const isFinished = rows.length > 0 && oldKeysRetirable(rows.map((r) => ({ table: r.table_name, column: r.column_name, keyId, format, status: r.status })), { keyId, format });
    return RewrapProgress.parse({ keyId, format, columns: list, finished: isFinished });
  }

  /** May the old master keys leave DATA_KEY_OLD? Only when every column is done and a live count finds nothing under them. */
  async function retirable() {
    const goal = target();
    const listed = await finished(goal);
    const remaining = [];
    for (const def of columns) {
      const n = await remainingIn(db.query, def, goal);
      if (n > 0) remaining.push({ table: def.table, column: def.column, count: n });
    }
    return { ok: listed && remaining.length === 0, remaining, oldKeyIds: (secrets.keyIds ?? []).filter((id) => id !== goal.keyId) };
  }

  /** True while a column for the current key is still to walk (the schedule asks this every minute). */
  async function open() {
    if (!secrets?.configured || !db) return false;
    const [row] = await db.query(`SELECT 1 AS open FROM secret_rewraps WHERE key_id = $1 AND format = $2 AND status IN ('pending', 'running') LIMIT 1`, [secrets.currentKeyId, secrets.format]);
    return Boolean(row);
  }

  return { start, step, run, progress, retirable, open };
}

export const secretRotation = {
  name: 'secret-rotation',
  owns: { migrations: ['900_secrets_envelope.sql', '970_secrets_bound.sql'], tables: ['secret_rewraps'], api: [], store: [], platform: [], jobs: [REWRAP_JOB] },
  jobs(ctx) {
    const rotation = createSecretRotation(ctx);
    ctx.platform.queue.work(REWRAP_JOB, () => rotation.run());
    // A job lost with its worker is picked up again: while a column is open, one job is queued every five minutes.
    return async () => {
      try {
        if (await rotation.open()) await ctx.platform.queue.every(REWRAP_JOB, 5 * 60_000);
      } catch (err) {
        reportError(err, { msg: 'secrets.rewrap.schedule_failed' });
      }
    };
  },
};
