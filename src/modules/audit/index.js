import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';

/** Writes one audit row for the current business on `runner`: the db, or a transaction so the row and the change land together. */
export async function writeAudit(runner, { actor, action, target = '', details = {} }) {
  await runner.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [
    tenantId(), String(actor), String(action), String(target), JSON.stringify(details),
  ]);
}

/**
 * The email of each Bhava operator named in a set of audit rows, for showing next to the row. The log itself keeps only the id
 * (`platform:<id>`), so no email is stored in a long-kept log; it is looked up here when a row is shown (D2 decision, F-62/U-04/C-57).
 * `runner` must be the platform handle: platform_users belongs to no business. Returns a Map of the row's actor to the email.
 */
export async function operatorEmails(runner, rows) {
  const ids = [...new Set(rows.map((r) => /^platform:(\d{1,9})$/.exec(String(r.actor))?.[1]).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const found = await runner.query('SELECT id, email FROM platform_users WHERE id = ANY($1::integer[])', [ids]);
  return new Map(found.map((u) => [`platform:${u.id}`, u.email]));
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
      const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
      const emails = await operatorEmails(db.platform ?? db, page.items);
      return { ...page, items: page.items.map((row) => ({ ...row, actorEmail: emails.get(row.actor) ?? null })) };
    },
  };
}

export const audit = {
  name: 'audit',
  repos: (db) => ({ audit: auditRepo(db) }),
};
