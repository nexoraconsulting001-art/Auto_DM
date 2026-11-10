import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from './paging.js';

const isSafe = (value) => Number.isSafeInteger(value);

/**
 * Lists that grow without end and that the core repos cap (orders at 200, customers at 500), so they are
 * paged in the database here. Each list keeps the order the core repo gives it.
 */
export function adminListsRepo(db) {
  return {
    async orders({ status = '', search = '', cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        `SELECT o.*, (SELECT coalesce(sum(qty), 0)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count
         FROM orders o
         WHERE o.tenant_id = $1 AND ($2 = '' OR o.status = $2)
           AND ($3 = '' OR o.order_number ILIKE '%' || $3 || '%' OR o.customer_name ILIKE '%' || $3 || '%' OR o.phone LIKE '%' || $3 || '%')
           AND ($4::int IS NULL OR o.id < $4)
         ORDER BY o.id DESC LIMIT $5`,
        [tenantId(), status, search, after, limit + 1],
      );
      return pageOfFetched(rows, limit, (o) => [o.id]);
    },

    /** Owners first, then the newest. */
    async customers({ search = '', cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 2 && (key[0] === 0 || key[0] === 1) && isRowId(key[1])) : null;
      const rows = await db.query(
        `SELECT u.id, u.name, u.phone, u.email, u.role, u.created_at,
           (SELECT count(*)::int FROM orders o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.id) AS order_count,
           (SELECT coalesce(sum(total_paise), 0)::bigint FROM orders o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.id AND o.status <> 'cancelled') AS spent
         FROM users u
         WHERE u.tenant_id = $1 AND ($2 = '' OR u.name ILIKE '%' || $2 || '%' OR u.phone LIKE '%' || $2 || '%')
           AND ($3::boolean IS NULL OR (u.role = 'owner', u.id) < ($3::boolean, $4::int))
         ORDER BY u.role = 'owner' DESC, u.id DESC LIMIT $5`,
        [tenantId(), search, after ? after[0] === 1 : null, after ? after[1] : null, limit + 1],
      );
      return pageOfFetched(rows, limit, (u) => [u.role === 'owner' ? 1 : 0, u.id]);
    },

    /** Newest first. A comment that is retried moves back to the top, as created_at does. */
    async activity({ cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 2 && isSafe(key[0]) && isRowId(key[1])) : null;
      const rows = await db.query(
        `SELECT a.*, r.headline, r.slug, (extract(epoch FROM a.created_at) * 1000000)::bigint AS at_micros
         FROM activity a
         LEFT JOIN reels r ON r.tenant_id = a.tenant_id AND r.ig_media_id = a.reel_id
         WHERE a.tenant_id = $1
           AND ($2::bigint IS NULL OR ((extract(epoch FROM a.created_at) * 1000000)::bigint, a.id) < ($2::bigint, $3::int))
         ORDER BY a.created_at DESC, a.id DESC LIMIT $4`,
        [tenantId(), after ? after[0] : null, after ? after[1] : null, limit + 1],
      );
      return pageOfFetched(rows, limit, (a) => [Number(a.at_micros), a.id]);
    },

    /** True when another business holds this Instagram post. Media ids are unique across Instagram, so a claim on it can only be refused. */
    async reelHeldElsewhere(id) {
      const [row] = await db.query('SELECT 1 FROM reels WHERE ig_media_id = $1 AND tenant_id <> $2', [String(id), tenantId()]);
      return Boolean(row);
    },
  };
}
