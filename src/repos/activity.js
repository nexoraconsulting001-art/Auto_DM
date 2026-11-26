import { tenantId } from '../tenancy.js';

export function activityRepo(db) {
  return {
    /** Records a skipped/failed comment. Never overwrites a comment that already got a DM. */
    async log({ commentId = null, reelId = null, userId = '', username = '', text = '', result, error = '' }) {
      const tenant = tenantId();
      const [added] = await db.query(
        `INSERT INTO activity (tenant_id, comment_id, reel_id, user_id, username, text, result, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (comment_id) DO NOTHING RETURNING id`,
        [tenant, commentId, reelId, userId, username, String(text).slice(0, 500), result, String(error).slice(0, 500)],
      );
      if (added || commentId === null) return;
      // The comment is already logged. Only this business's own row is touched (another business's is never visible
      // here, and ON CONFLICT DO UPDATE on a row the fence hides is an error on current Postgres, R2-CORE-2).
      await db.query(
        `UPDATE activity SET result = $3, error = $4, created_at = now()
         WHERE tenant_id = $1 AND comment_id = $2 AND result NOT IN ('sent', 'processing')`,
        [tenant, commentId, result, String(error).slice(0, 500)],
      );
    },
    /**
     * Claims a comment before sending a DM so that duplicate webhook deliveries (even concurrent ones)
     * send at most one DM. Returns false if the comment is already sent or being processed.
     */
    async claim({ commentId, reelId, userId, username, text }) {
      const tenant = tenantId();
      const added = await db.query(
        `INSERT INTO activity (tenant_id, comment_id, reel_id, user_id, username, text, result)
         VALUES ($1, $2, $3, $4, $5, $6, 'processing')
         ON CONFLICT (comment_id) DO NOTHING RETURNING id`,
        [tenant, commentId, reelId, userId, username, String(text).slice(0, 500)],
      );
      if (added.length > 0) return true;
      // Already seen: this business may take it again only if it is its own and was not sent or being sent. The row
      // lock makes a concurrent second claim re-read 'processing' and fail. Another business's row is never claimed.
      const again = await db.query(
        `UPDATE activity SET result = 'processing', error = '', created_at = now()
         WHERE tenant_id = $1 AND comment_id = $2 AND result NOT IN ('sent', 'processing') RETURNING id`,
        [tenant, commentId],
      );
      return again.length > 0;
    },
    async finish(commentId, result, error = '') {
      await db.query('UPDATE activity SET result = $3, error = $4 WHERE tenant_id = $1 AND comment_id = $2', [
        tenantId(), commentId, result, String(error).slice(0, 500),
      ]);
    },
    async hasSentToUser(userId, reelId) {
      const [row] = await db.query(
        `SELECT 1 FROM activity WHERE tenant_id = $1 AND user_id = $2 AND reel_id = $3 AND result = 'sent' LIMIT 1`,
        [tenantId(), userId, reelId],
      );
      return Boolean(row);
    },
    async count() {
      const [{ n }] = await db.query('SELECT count(*)::int AS n FROM activity WHERE tenant_id = $1', [tenantId()]);
      return n;
    },
    async list({ limit = 100 } = {}) {
      return db.query(
        `SELECT a.*, r.headline, r.slug FROM activity a
         LEFT JOIN reels r ON r.tenant_id = a.tenant_id AND r.ig_media_id = a.reel_id
         WHERE a.tenant_id = $1
         ORDER BY a.created_at DESC LIMIT $2`,
        [tenantId(), limit],
      );
    },
  };
}
