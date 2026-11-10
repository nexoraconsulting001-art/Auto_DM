import crypto from 'node:crypto';
import { COMPLIANCE_LIMITS } from '../../contracts/compliance.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { windowOpen } from './inbox.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L, which get mistyped
const CODE_LENGTH = 8;
const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

const normalizeCode = (text) => String(text).trim().toUpperCase().replace(/[\s-]/g, '');
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH * 2);
  let code = '';
  for (let i = 0; code.length < CODE_LENGTH && i < bytes.length; i++) {
    if (bytes[i] < 248) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]; // 248 is the largest multiple of 31 under 256
  }
  return code.length === CODE_LENGTH ? code : newCode();
}

/**
 * Testers are known only by the id the webhook captured when they DM a one-time code (PRD 6.9). A code is kept as a hash,
 * works once and lasts 15 minutes.
 */
export function testersRepo(db) {
  const CODE_ACTION = 'tester.code';

  return {
    async createCode({ createdBy = null, label = '', actor, now = new Date() }) {
      const code = newCode();
      const expiresAt = new Date(now.getTime() + COMPLIANCE_LIMITS.testerCodeMs);
      await db.tx(async (t) => {
        const [row] = await t.query('INSERT INTO tester_codes (tenant_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING id', [tenantId(), hashCode(code), createdBy, expiresAt]);
        // tester_codes has no column for the label, so it travels in the audit row that has to be written anyway.
        await writeAudit(t, { actor, action: CODE_ACTION, target: `tester_code:${row.id}`, details: { label } });
      });
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    },

    /** Adds the sender as a tester when `text` is a live code, and uses it up. Null when it isn't one. */
    async redeem({ channel, subject, recipientId, text, now = new Date() }) {
      const code = normalizeCode(text);
      if (!CODE_SHAPE.test(code)) return null;
      return db.tx(async (t) => {
        const [claimed] = await t.query(
          'UPDATE tester_codes SET used_at = $3 WHERE tenant_id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > $3 RETURNING id',
          [tenantId(), hashCode(code), now],
        );
        if (!claimed) return null;
        const [audit] = await t.query(
          `SELECT details->>'label' AS label FROM audit_log WHERE tenant_id = $1 AND action = $2 AND target = $3 ORDER BY id DESC LIMIT 1`,
          [tenantId(), CODE_ACTION, `tester_code:${claimed.id}`],
        );
        const [tester] = await t.query(
          `INSERT INTO testers (tenant_id, channel, subject_hash, recipient_id, label) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET recipient_id = EXCLUDED.recipient_id, label = COALESCE(NULLIF(EXCLUDED.label, ''), testers.label)
           RETURNING *`,
          [tenantId(), channel, subject, recipientId, audit?.label ?? ''],
        );
        await t.query('UPDATE tester_codes SET tester_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), claimed.id, tester.id]);
        return tester;
      });
    },

    async isTester(channel, subject) {
      const [row] = await db.query('SELECT 1 FROM testers WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3', [tenantId(), channel, subject]);
      return Boolean(row);
    },

    async get(id) {
      const [row] = await db.query('SELECT * FROM testers WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row ?? null;
    },

    async list({ cursor, limit, now = new Date() }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        `SELECT t.*, th.last_user_message_at FROM testers t
         LEFT JOIN inbox_threads th ON th.tenant_id = t.tenant_id AND th.channel = t.channel AND th.subject_hash = t.subject_hash
         WHERE t.tenant_id = $1 AND ($2::int IS NULL OR t.id < $2) ORDER BY t.id DESC LIMIT $3`,
        [tenantId(), after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map((row) => ({ id: row.id, channel: row.channel, label: row.label, windowOpen: windowOpen(row.last_user_message_at, now), addedAt: row.created_at })), nextCursor: page.nextCursor };
    },

    /** False when this business has no such tester. */
    async remove(id, { actor }) {
      return db.tx(async (t) => {
        const removed = await t.query('DELETE FROM testers WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), id]);
        if (removed.length) await writeAudit(t, { actor, action: 'tester.remove', target: `tester:${id}` });
        return removed.length > 0;
      });
    },
  };
}

/** Ice breakers and their answers (PRD 6.4). An answer is a business-wide template. */
export function iceBreakersRepo(db) {
  return {
    async get() {
      const rows = await db.query(
        `SELECT b.position, b.question, v.body FROM ice_breakers b
         LEFT JOIN template_variants v ON v.tenant_id = b.tenant_id AND v.template_id = b.template_id AND v.active AND v.label = 'A'
         WHERE b.tenant_id = $1 ORDER BY b.position`,
        [tenantId()],
      );
      return { items: rows.map((row) => ({ question: row.question, templateBody: row.body ?? '' })) };
    },

    /** Replaces the whole list. */
    async save(items, { actor }) {
      await db.tx(async (t) => {
        await t.query(
          `DELETE FROM message_templates WHERE tenant_id = $1 AND role = 'faq_answer' AND automation_id IS NULL AND id IN (SELECT template_id FROM ice_breakers WHERE tenant_id = $1 AND template_id IS NOT NULL)`,
          [tenantId()],
        );
        await t.query('DELETE FROM ice_breakers WHERE tenant_id = $1', [tenantId()]);
        for (const [index, item] of items.entries()) {
          const [template] = await t.query(`INSERT INTO message_templates (tenant_id, automation_id, role) VALUES ($1, NULL, 'faq_answer') RETURNING id`, [tenantId()]);
          await t.query(`INSERT INTO template_variants (tenant_id, template_id, label, body) VALUES ($1, $2, 'A', $3)`, [tenantId(), template.id, item.templateBody]);
          await t.query('INSERT INTO ice_breakers (tenant_id, position, question, template_id) VALUES ($1, $2, $3, $4)', [tenantId(), index + 1, item.question, template.id]);
        }
        await writeAudit(t, { actor, action: 'ice_breakers.save', details: { count: items.length } });
      });
    },

    /** The answer for a tapped ice breaker, or null. */
    async answerFor(position) {
      const [row] = await db.query(
        `SELECT v.body FROM ice_breakers b JOIN template_variants v ON v.tenant_id = b.tenant_id AND v.template_id = b.template_id AND v.active AND v.label = 'A'
         WHERE b.tenant_id = $1 AND b.position = $2`,
        [tenantId(), position],
      );
      return row?.body ?? null;
    },
  };
}
