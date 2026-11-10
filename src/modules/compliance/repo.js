import crypto from 'node:crypto';
import { tenantId } from '../../tenancy.js';

/** The compliance log and each business's salt. compliance_settings gets its row the first time it is needed. */
export function complianceRepo(db) {
  async function salt() {
    const [row] = await db.query(
      `INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING subject_salt`,
      [tenantId(), crypto.randomBytes(32).toString('base64url')],
    );
    return row.subject_salt;
  }

  return {
    /** The HMAC of a person's id under this business's salt: all the log, blocklist and caps ever hold (PRD 4.6, 4.16). */
    async subjectHash(channel, personId) {
      return crypto.createHmac('sha256', await salt()).update(`${channel}:${personId}`).digest('hex');
    },

    /** Adds one row. decision and reason must be reason codes; the database refuses anything else. Details never hold personal data. */
    async record({ channel, kind, subject = '', decision, reason = '', details = {}, automationId = null, jobId = null, mediaId = '', commentId = '' }) {
      await db.query(
        `INSERT INTO compliance_events (tenant_id, channel, kind, subject, decision, reason, details, automation_id, job_id, media_id, comment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [tenantId(), channel, kind, subject, decision, reason, JSON.stringify(details), automationId, jobId, mediaId, commentId],
      );
    },
  };
}
