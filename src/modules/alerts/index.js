import { tenantId } from '../../tenancy.js';

const toAlert = (row) => ({ id: Number(row.id), kind: row.kind, severity: row.severity, message: row.message, target: row.target, createdAt: row.created_at, readAt: row.read_at });

/**
 * What the owner must be told. Message is Bhava's own words to the seller, with no shopper's name or text. Raising an
 * alert with a dedupeKey it already has does nothing, so a job that repeats can raise it every time.
 */
export function alertsRepo(db) {
  return {
    async raise({ kind, message, severity = 'warning', target = '', dedupeKey = null, audience = 'owner' }) {
      const [row] = await db.query(
        `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, audience, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
        [tenantId(), audience, kind, severity, message, target, dedupeKey],
      );
      return row ? toAlert(row) : null;
    },

    async list({ cursor, limit = 25 } = {}) {
      const rows = await db.query(
        `SELECT * FROM alerts WHERE tenant_id = $1 AND audience = 'owner' AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
        [tenantId(), /^\d{1,18}$/.test(cursor ?? '') ? cursor : null, limit + 1],
      );
      const items = rows.slice(0, limit).map(toAlert);
      return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
    },

    async markRead(id) {
      await db.query(`UPDATE alerts SET read_at = COALESCE(read_at, now()) WHERE tenant_id = $1 AND audience = 'owner' AND id = $2`, [tenantId(), id]);
    },
  };
}

export const alerts = {
  name: 'alerts',
  repos: (db) => ({ alerts: alertsRepo(db) }),
  api: ({ repos }) => ({
    'alerts.list': ({ query }) => repos.alerts.list(query),
    'alerts.markRead': async ({ params }) => {
      await repos.alerts.markRead(params.id);
    },
  }),
};
