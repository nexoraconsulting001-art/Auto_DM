import crypto from 'node:crypto';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { BASE_WORDS, normalizeWord } from './words.js';

const cursorId = (cursor) => (/^\d{1,18}$/.test(cursor ?? '') ? cursor : null);

/**
 * The compliance log, each business's settings and salt, its word lists and blocklist. compliance_settings gets its row the first
 * time it is needed. Every method works on the current business. Anything that decides whether to send is in gate.js and send.js.
 */
export function complianceRepo(db) {
  // A salt never changes, so it is read once per process: the hot path hashes on every event.
  const salts = new Map();

  async function salt() {
    const business = tenantId();
    const known = salts.get(business);
    if (known) return known;
    const [row] = await db.query(
      `INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING subject_salt`,
      [business, crypto.randomBytes(32).toString('base64url')],
    );
    salts.set(business, row.subject_salt);
    return row.subject_salt;
  }

  const fromRow = (row) => ({
    id: Number(row.id),
    at: row.created_at,
    channel: row.channel,
    kind: row.kind,
    outcome: row.decision,
    reason: row.reason,
    automationId: row.automation_id,
    mediaId: row.media_id,
    commentId: row.comment_id,
  });

  return {
    /** The HMAC of a person's id under this business's salt: all the log, blocklist and caps ever hold (PRD 4.6, 4.16). */
    async subjectHash(channel, personId) {
      return crypto.createHmac('sha256', await salt()).update(`${channel}:${personId}`).digest('hex');
    },

    /** Adds one row. decision and reason must be reason codes; the database refuses anything else. Details never hold personal data. */
    async record({ channel, kind, subject = '', decision, reason = '', details = {}, automationId = null, jobId = null, mediaId = '', commentId = '', at = null }) {
      await db.query(
        `INSERT INTO compliance_events (tenant_id, channel, kind, subject, decision, reason, details, automation_id, job_id, media_id, comment_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))`,
        [tenantId(), channel, kind, subject, decision, reason, JSON.stringify(details), automationId, jobId, mediaId, commentId, at],
      );
    },

    /** This business's settings row, made if it doesn't exist yet. */
    async settings() {
      await salt();
      const [row] = await db.query('SELECT * FROM compliance_settings WHERE tenant_id = $1', [tenantId()]);
      return row;
    },

    /** Only these columns, so a caller's field names can never reach the SQL. */
    async updateSettings({ dryRun, disclosureEnabled, utmEnabled, capOverrides }) {
      await salt();
      const [row] = await db.query(
        `UPDATE compliance_settings SET dry_run = COALESCE($2, dry_run), disclosure_enabled = COALESCE($3, disclosure_enabled), utm_enabled = COALESCE($4, utm_enabled),
           cap_overrides = COALESCE($5::jsonb, cap_overrides), updated_at = now() WHERE tenant_id = $1 RETURNING *`,
        [tenantId(), dryRun ?? null, disclosureEnabled ?? null, utmEnabled ?? null, capOverrides === undefined ? null : JSON.stringify(capOverrides)],
      );
      return row;
    },

    /** The words this business added to one list, normalised. The base list is added by the caller. */
    async wordsFor(list) {
      const rows = await db.query('SELECT normalized FROM tenant_words WHERE tenant_id = $1 AND list = $2', [tenantId(), list]);
      return rows.map((r) => r.normalized);
    },

    async listWords(list) {
      const added = await db.query('SELECT id, list, word FROM tenant_words WHERE tenant_id = $1 AND list = $2 ORDER BY id', [tenantId(), list]);
      return { base: [...BASE_WORDS[list]], added };
    },

    /** Null when the word is already on the list. */
    async addWord(list, word) {
      const normalized = normalizeWord(word);
      if (!normalized) throw new ValidationError('Enter a word');
      if (BASE_WORDS[list].some((w) => normalizeWord(w) === normalized)) return null;
      const [row] = await db.query(
        `INSERT INTO tenant_words (tenant_id, list, word, normalized) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, list, normalized) DO NOTHING RETURNING id, list, word`,
        [tenantId(), list, String(word).trim(), normalized],
      );
      return row ?? null;
    },

    /** False when this business has no such word. A base word has no row, so it can't be removed. */
    async removeWord(id) {
      const rows = await db.query('DELETE FROM tenant_words WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), id]);
      return rows.length > 0;
    },

    async isOptedOut(channel, subject) {
      const [row] = await db.query('SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3', [tenantId(), channel, subject]);
      return Boolean(row);
    },

    /** True when this is a new opt-out. */
    async addOptOut(channel, subject, source, at = null) {
      const rows = await db.query(
        `INSERT INTO opt_outs (tenant_id, channel, subject_hash, source, created_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
         ON CONFLICT (tenant_id, channel, subject_hash) DO NOTHING RETURNING subject_hash`,
        [tenantId(), channel, subject, source, at],
      );
      return rows.length > 0;
    },

    /** True when the person was on the blocklist. */
    async removeOptOut(channel, subject) {
      const rows = await db.query('DELETE FROM opt_outs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 RETURNING subject_hash', [tenantId(), channel, subject]);
      return rows.length > 0;
    },

    /** The activity view (PRD 4.16). Never a person's id, hashed or otherwise. */
    async activity({ cursor, limit = 25, reason, outcome, automationId, mediaId } = {}) {
      const rows = await db.query(
        `SELECT id, created_at, channel, kind, decision, reason, automation_id, media_id, comment_id FROM compliance_events
         WHERE tenant_id = $1 AND channel IS NOT NULL AND channel <> 'whatsapp' AND ($2::bigint IS NULL OR id < $2::bigint) AND ($3::text IS NULL OR reason = $3)
           AND ($4::text IS NULL OR decision = $4) AND ($5::integer IS NULL OR automation_id = $5) AND ($6::text IS NULL OR media_id = $6)
         ORDER BY id DESC LIMIT $7`,
        [tenantId(), cursorId(cursor), reason ?? null, outcome ?? null, automationId ?? null, mediaId ?? null, limit + 1],
      );
      const items = rows.slice(0, limit).map(fromRow);
      return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
    },

    /** The newest decision about one comment, within the 90 days "Why no DM?" is kept (PRD 4.14). */
    async latestForComment(commentId) {
      const [row] = await db.query(
        `SELECT decision, reason, created_at FROM compliance_events
         WHERE tenant_id = $1 AND comment_id = $2 AND created_at > now() - interval '90 days' ORDER BY id DESC LIMIT 1`,
        [tenantId(), commentId],
      );
      return row ?? null;
    },

    async heldJobs({ cursor, limit = 25 } = {}) {
      const rows = await db.query(
        `SELECT id, kind, automation_id, reason, updated_at, expires_at FROM outbound_jobs
         WHERE tenant_id = $1 AND status = 'held' AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
        [tenantId(), cursorId(cursor), limit + 1],
      );
      const items = rows.slice(0, limit).map((r) => ({ id: Number(r.id), kind: r.kind, automationId: r.automation_id, reason: r.reason, heldAt: r.updated_at, expiresAt: r.expires_at }));
      return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
    },
  };
}
