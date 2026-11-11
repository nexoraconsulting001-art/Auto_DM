import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

/** Each read of a business's website for its look (PRD 8.9, migration 304). Nothing in a row is applied until someone applies it. */
const COLS = 'id, website, status, colors, heading_font, body_font, logo_url, notes, applied_at, created_at';

export function themeSiteReadsRepo(db) {
  return {
    async add({ website, status, colors = {}, headingFont = '', bodyFont = '', logoUrl = '', notes = [], userId = null }) {
      const [row] = await db.query(
        `INSERT INTO theme_site_reads (tenant_id, website, status, colors, heading_font, body_font, logo_url, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
        [tenantId(), website, status, JSON.stringify(colors), headingFont, bodyFont, logoUrl, notes, userId],
      );
      return row;
    },
    async get(id) {
      const [row] = await db.query(`SELECT ${COLS} FROM theme_site_reads WHERE tenant_id = $1 AND id = $2`, [tenantId(), Number(id)]);
      return row ?? null;
    },
    /** Newest first; `beforeId` is the last id already shown. Returns one more than `limit` when there is another page. */
    async list({ beforeId = null, limit = 25 } = {}) {
      return db.query(
        `SELECT ${COLS} FROM theme_site_reads WHERE tenant_id = $1 AND ($2::integer IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
        [tenantId(), beforeId, limit + 1],
      );
    },
    async markApplied(id) {
      const [row] = await db.query(`UPDATE theme_site_reads SET applied_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`, [tenantId(), Number(id)]);
      return row ?? null;
    },
    /** Whether this preset exists and is still offered. */
    async presetOffered(code) {
      const [row] = await db.query('SELECT colors FROM theme_presets WHERE code = $1 AND active', [String(code)]);
      return row ?? null;
    },
    /** A change to the look, in the business's audit log. Details name what changed and never the values of a logo or a site's text. */
    audit: (entry) => writeAudit(db, entry),
  };
}
