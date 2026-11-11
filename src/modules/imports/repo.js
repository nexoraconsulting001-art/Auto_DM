import { IMPORT_REASONS } from '../../contracts/catalog.js';
import { tenantId } from '../../tenancy.js';

/**
 * Import jobs and their items (PRD 8.3 to 8.7, migration 301), and which site adapters a business may use (8.4). Every query
 * names the current business; an item is only ever reached through a job of that business. The adapter switches are written
 * by our team from the Platform Console, through db.platform, for the business named in the address.
 */

const JOB_COLS = 'id, kind, status, source, total, created, updated, unchanged, refused, failed, archived, error_code, created_at, started_at, finished_at';
const ITEM_COLS = 'id, job_id, line, url, sku, status, read_from, gate_passed, reason, message, draft, product_id';
const INT32_MAX = 2147483647;
const rowId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT32_MAX ? n : 0;
};

/** The words for an item: its own message when it has one, else the reason's. */
export const itemMessage = (item) => item.message || IMPORT_REASONS[item.reason] || '';

export function importsRepo(db) {
  const platformDb = db.platform ?? db;

  return {
    async createJob({ kind, source = '', status = 'queued', createdBy = null }) {
      const [row] = await db.query(
        `INSERT INTO import_jobs (tenant_id, kind, status, source, created_by, started_at, finished_at)
         VALUES ($1, $2, $3, $4, (SELECT id FROM users WHERE tenant_id = $1 AND id = $5),
                 CASE WHEN $3 IN ('running', 'done') THEN now() END, CASE WHEN $3 = 'done' THEN now() END)
         RETURNING ${JOB_COLS}`,
        [tenantId(), kind, status, String(source).slice(0, 500), rowId(createdBy) || null],
      );
      return row;
    },

    async job(id) {
      const [row] = await db.query(`SELECT ${JOB_COLS} FROM import_jobs WHERE tenant_id = $1 AND id = $2`, [tenantId(), rowId(id)]);
      return row ?? null;
    },

    /** Newest first. `before` is the id of the last job shown. */
    async jobs({ before = null, limit = 25 } = {}) {
      return db.query(`SELECT ${JOB_COLS} FROM import_jobs WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [tenantId(), before, limit + 1]);
    },

    /** Marks a waiting job as running. False when it is already finished, so a job delivered twice does nothing the second time. */
    async start(id) {
      const [row] = await db.query(
        `UPDATE import_jobs SET status = 'running', started_at = coalesce(started_at, now())
         WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING id`,
        [tenantId(), rowId(id)],
      );
      return Boolean(row);
    },

    async setError(id, errorCode) {
      await db.query('UPDATE import_jobs SET error_code = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), rowId(id), errorCode]);
    },

    /** Ends the job with its counts taken from its items, so running a step twice never counts anything twice. */
    async finish(id, { status = 'done' } = {}) {
      const [row] = await db.query(
        `UPDATE import_jobs j SET status = $3, finished_at = now(),
           total = c.total, created = c.created, updated = c.updated, unchanged = c.unchanged, refused = c.refused, failed = c.failed, archived = c.archived
         FROM (SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE status = 'created')::int AS created, count(*) FILTER (WHERE status = 'updated')::int AS updated,
                 count(*) FILTER (WHERE status = 'unchanged')::int AS unchanged, count(*) FILTER (WHERE status = 'refused')::int AS refused,
                 count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'archived')::int AS archived
               FROM import_items WHERE tenant_id = $1 AND job_id = $2) c
         WHERE j.tenant_id = $1 AND j.id = $2 RETURNING ${JOB_COLS.split(', ').map((c) => `j.${c}`).join(', ')}`,
        [tenantId(), rowId(id), status],
      );
      return row ?? null;
    },

    /** Refreshes a job's counts while it runs, so the owner watching sees progress. */
    async count(id) {
      await db.query(
        `UPDATE import_jobs j SET total = c.total, created = c.created, updated = c.updated, unchanged = c.unchanged, refused = c.refused, failed = c.failed, archived = c.archived
         FROM (SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE status = 'created')::int AS created, count(*) FILTER (WHERE status = 'updated')::int AS updated,
                 count(*) FILTER (WHERE status = 'unchanged')::int AS unchanged, count(*) FILTER (WHERE status = 'refused')::int AS refused,
                 count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'archived')::int AS archived
               FROM import_items WHERE tenant_id = $1 AND job_id = $2) c
         WHERE j.tenant_id = $1 AND j.id = $2`,
        [tenantId(), rowId(id)],
      );
    },

    /**
     * Adds items to a job in one statement. An item whose line the job already has is left as it is, so reading a page of a
     * feed twice adds nothing. Each item: { line, url, sku, status, readFrom, gatePassed, reason, message, draft, productId }.
     */
    async addItems(jobId, items) {
      if (!items.length) return;
      const rows = items.map((item) => ({
        line: item.line,
        url: String(item.url ?? '').slice(0, 2000),
        sku: String(item.sku ?? '').slice(0, 100),
        status: item.status ?? 'pending',
        read_from: item.readFrom ?? '',
        gate_passed: item.gatePassed ?? null,
        reason: item.reason ?? '',
        message: String(item.message ?? '').slice(0, 300),
        draft: item.draft ?? null,
        product_id: item.productId ?? null,
      }));
      await db.query(
        `INSERT INTO import_items (tenant_id, job_id, line, url, sku, status, read_from, gate_passed, reason, message, draft, product_id)
         SELECT $1, j.id, r.line, r.url, r.sku, r.status, r.read_from, r.gate_passed, r.reason, r.message, r.draft, r.product_id
         FROM import_jobs j,
              jsonb_to_recordset($3::jsonb) AS r(line int, url text, sku text, status text, read_from text, gate_passed boolean, reason text, message text, draft jsonb, product_id int)
         WHERE j.tenant_id = $1 AND j.id = $2
         ON CONFLICT (tenant_id, job_id, line) DO NOTHING`,
        [tenantId(), rowId(jobId), JSON.stringify(rows)],
      );
    },

    async item(id) {
      const [row] = await db.query(`SELECT ${ITEM_COLS} FROM import_items WHERE tenant_id = $1 AND id = $2`, [tenantId(), rowId(id)]);
      return row ?? null;
    },

    /** A job's items in line order. `after` is the line of the last one shown. */
    async items(jobId, { status = 'all', after = null, limit = 25 } = {}) {
      return db.query(
        `SELECT ${ITEM_COLS} FROM import_items
         WHERE tenant_id = $1 AND job_id = $2 AND ($3 = 'all' OR status = $3) AND ($4::int IS NULL OR line > $4) ORDER BY line LIMIT $5`,
        [tenantId(), rowId(jobId), status, after, limit + 1],
      );
    },

    async pending(jobId, limit = 50) {
      return db.query(`SELECT ${ITEM_COLS} FROM import_items WHERE tenant_id = $1 AND job_id = $2 AND status = 'pending' ORDER BY line LIMIT $3`, [tenantId(), rowId(jobId), limit]);
    },

    async pendingCount(jobId) {
      const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM import_items WHERE tenant_id = $1 AND job_id = $2 AND status = 'pending'`, [tenantId(), rowId(jobId)]);
      return n;
    },

    /** Product ids this job's items ended on. */
    async productIds(jobId) {
      return (await db.query('SELECT DISTINCT product_id FROM import_items WHERE tenant_id = $1 AND job_id = $2 AND product_id IS NOT NULL', [tenantId(), rowId(jobId)])).map((r) => r.product_id);
    },

    async lastLine(jobId) {
      const [{ line }] = await db.query('SELECT coalesce(max(line), 0)::int AS line FROM import_items WHERE tenant_id = $1 AND job_id = $2', [tenantId(), rowId(jobId)]);
      return line;
    },

    /** Sets what became of an item. Only the fields given change. */
    async setItem(id, { status, readFrom, gatePassed, reason, message, draft, productId }) {
      await db.query(
        `UPDATE import_items SET status = coalesce($3, status), read_from = coalesce($4, read_from), gate_passed = CASE WHEN $5 THEN $6::boolean ELSE gate_passed END,
           reason = coalesce($7, reason), message = coalesce($8, message), draft = CASE WHEN $9 THEN $10::jsonb ELSE draft END,
           product_id = coalesce((SELECT id FROM products WHERE tenant_id = $1 AND id = $11), product_id), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), rowId(id), status ?? null, readFrom ?? null, gatePassed !== undefined, gatePassed ?? null, reason ?? null,
          message === undefined ? null : String(message).slice(0, 300), draft !== undefined, draft === undefined ? null : JSON.stringify(draft), rowId(productId) || null],
      );
    },

    // ---- site adapters ----

    /** The names of the adapters this business may use. */
    async enabledAdapters() {
      return (await db.query('SELECT adapter FROM site_adapters WHERE tenant_id = $1 AND enabled ORDER BY adapter', [tenantId()])).map((r) => r.adapter);
    },

    /** For the Platform Console: the switches of one business, by its id. Null when there is no such business. */
    async adaptersOf(businessId) {
      const [tenant] = await platformDb.query('SELECT id FROM tenants WHERE id = $1', [rowId(businessId)]);
      if (!tenant) return null;
      return (await platformDb.query('SELECT adapter FROM site_adapters WHERE tenant_id = $1 AND enabled', [tenant.id])).map((r) => r.adapter);
    },

    async setAdapterFor(businessId, adapter, enabled) {
      await platformDb.query(
        `INSERT INTO site_adapters (tenant_id, adapter, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, adapter) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [rowId(businessId), adapter, Boolean(enabled)],
      );
    },
  };
}
