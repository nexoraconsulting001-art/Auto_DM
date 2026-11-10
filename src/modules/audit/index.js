import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';

/** Writes one audit row for the current business on `runner`: the db, or a transaction so the row and the change land together. */
export async function writeAudit(runner, { actor, action, target = '', details = {} }) {
  await runner.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [
    tenantId(), String(actor), String(action), String(target), JSON.stringify(details),
  ]);
}

/**
 * The current business's audit log (PRD 5.14): insert-only, and owners read it on screen. Platform-level rows have no
 * tenant_id and never appear here. `actor` is an id such as user:12, and details never hold secrets, tokens or usernames.
 */
export function auditRepo(db) {
  return {
    record: (entry) => writeAudit(db, entry),
    /** Newest first. */
    async list({ cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query(
        `SELECT id, actor, action, target, details, created_at FROM audit_log
         WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
        [tenantId(), after, limit + 1],
      );
      return pageOfFetched(rows, limit, (row) => [Number(row.id)]);
    },
  };
}

export const audit = {
  name: 'audit',
  repos: (db) => ({ audit: auditRepo(db) }),
};
