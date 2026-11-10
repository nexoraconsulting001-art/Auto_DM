import crypto from 'node:crypto';
import { reportError } from '../../platform/log.js';
import { ValidationError } from '../../util.js';

const KEEP_DAYS = 7;
const MAX_ROWS = 200_000;
// The only tables a raw export can read, and which column holds each row's time.
const TIME_COLUMN = Object.freeze({ audit_log: 'created_at', compliance_events: 'created_at', events: 'at', traffic_events: 'at' });

/**
 * A super admin's raw event export (PRD 2, 5.14). The file is written first; its record and the audit row of who, when, why and what land
 * together, and the file goes again if they don't.
 */
export async function createRawExport({ db, storage }, { reason, tables, tenantIds, from, to }, actor) {
  if (from > to) throw new ValidationError('The start date must be before the end date.');
  const platform = db.platform ?? db;
  const lines = [];
  for (const table of tables) {
    const column = TIME_COLUMN[table];
    const rows = await platform.query(
      `SELECT * FROM ${table} WHERE tenant_id = ANY($1::int[]) AND ${column} >= $2::date AND ${column} < $3::date + 1 ORDER BY id LIMIT $4`,
      [tenantIds, from, to, MAX_ROWS + 1],
    );
    if (lines.length + rows.length > MAX_ROWS) throw new ValidationError('That is too many rows for one export. Choose a shorter date range.');
    for (const row of rows) lines.push(JSON.stringify({ table, ...row }));
  }

  const key = `platform/raw-exports/${crypto.randomUUID()}.jsonl`;
  await storage.put(key, Buffer.from(lines.join('\n')), 'application/x-ndjson');
  try {
    return await platform.tx(async (t) => {
      const [saved] = await t.query(
        `INSERT INTO raw_exports (actor, reason, tables, tenant_ids, date_from, date_to, row_count, storage_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9)) RETURNING expires_at`,
        [actor, reason, tables, tenantIds, from, to, lines.length, key, KEEP_DAYS],
      );
      await t.query(
        `INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, 'raw_export.create', $2, $3::jsonb)`,
        [actor, tables.join(','), JSON.stringify({ reason, tables, tenantIds, from, to, rowCount: lines.length })],
      );
      return { rowCount: lines.length, expiresAt: saved.expires_at };
    });
  } catch (err) {
    await storage.remove(key).catch((removeError) => reportError(removeError, { msg: 'raw_export.cleanup_failed' }));
    throw err;
  }
}

/** Deletes export files past their time. The record and the audit row stay. */
export async function sweepRawExports({ db, storage }) {
  const platform = db.platform ?? db;
  const due = await platform.query('SELECT id, storage_key FROM raw_exports WHERE deleted_at IS NULL AND expires_at <= now() ORDER BY id LIMIT 200');
  for (const row of due) {
    try {
      await storage.remove(row.storage_key);
      await platform.query('UPDATE raw_exports SET deleted_at = now() WHERE id = $1', [row.id]);
    } catch (err) {
      reportError(err, { msg: 'raw_export.delete_failed', exportId: row.id });
    }
  }
  return due.length;
}
