import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { tenantId } from '../../tenancy.js';

const EDITORS = new Set(['owner', 'manager']);

const toView = (row, userId) => ({ id: row.id, name: row.name, visibility: row.visibility, definition: row.definition, mine: row.created_by === userId, pinned: Boolean(row.pinned), createdAt: row.created_at, updatedAt: row.updated_at });

/** Saved views. Private ones are their maker's. Team ones are open to anyone with analytics, and what a role can't see is hidden when the view runs, not here (7.11). */
export function savedViewsRepo(db) {
  const visible = '(v.visibility = \'team\' OR v.created_by = $2)';
  const pinnedColumn = 'EXISTS (SELECT 1 FROM saved_view_pins p WHERE p.tenant_id = v.tenant_id AND p.view_id = v.id AND p.user_id = $2) AS pinned';

  async function find(id, user, runner = db) {
    const [row] = await runner.query(`SELECT v.*, ${pinnedColumn} FROM saved_views v WHERE v.tenant_id = $1 AND v.id = $3 AND ${visible}`, [tenantId(), user.id, id]);
    return row ?? null;
  }

  return {
    async list({ cursor, limit }, user) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(`SELECT v.*, ${pinnedColumn} FROM saved_views v WHERE v.tenant_id = $1 AND ${visible} AND ($3::int IS NULL OR v.id < $3) ORDER BY v.id DESC LIMIT $4`, [tenantId(), user.id, after, limit + 1]);
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map((row) => toView(row, user.id)), nextCursor: page.nextCursor };
    },

    async get(id, user) {
      const row = await find(id, user);
      return row ? toView(row, user.id) : null;
    },

    async create(input, user) {
      const [row] = await db.query(`INSERT INTO saved_views (tenant_id, created_by, name, visibility, definition) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`, [tenantId(), user.id, input.name, input.visibility, JSON.stringify(input.definition)]);
      return toView(row, user.id);
    },

    /** Its maker, or an owner or manager for a shared view. Anyone else gets the same answer as for a view that doesn't exist. */
    async update(id, patch, user) {
      const row = await find(id, user);
      if (!row || !canEdit(row, user)) return null;
      const [saved] = await db.query(
        `UPDATE saved_views SET name = COALESCE($3, name), visibility = COALESCE($4, visibility), definition = COALESCE($5::jsonb, definition), updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId(), id, patch.name ?? null, patch.visibility ?? null, patch.definition ? JSON.stringify(patch.definition) : null],
      );
      return toView({ ...saved, pinned: row.pinned }, user.id);
    },

    async remove(id, user) {
      const row = await find(id, user);
      if (!row || !canEdit(row, user)) return false;
      await db.query('DELETE FROM saved_views WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return true;
    },

    async pin(id, user) {
      const row = await find(id, user);
      if (!row) return null;
      await db.query(`INSERT INTO saved_view_pins (tenant_id, view_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, view_id, user_id) DO NOTHING`, [tenantId(), id, user.id]);
      return toView({ ...row, pinned: true }, user.id);
    },

    async unpin(id, user) {
      const rows = await db.query('DELETE FROM saved_view_pins WHERE tenant_id = $1 AND view_id = $2 AND user_id = $3 RETURNING view_id', [tenantId(), id, user.id]);
      return rows.length > 0;
    },

    async pinned(user) {
      const rows = await db.query(
        `SELECT v.*, true AS pinned FROM saved_view_pins p JOIN saved_views v ON v.tenant_id = p.tenant_id AND v.id = p.view_id
         WHERE p.tenant_id = $1 AND p.user_id = $2 AND (v.visibility = 'team' OR v.created_by = $2) ORDER BY p.position, p.pinned_at`,
        [tenantId(), user.id],
      );
      return rows.map((row) => toView(row, user.id));
    },
  };
}

const canEdit = (row, user) => row.created_by === user.id || (row.visibility === 'team' && EDITORS.has(user.role));
