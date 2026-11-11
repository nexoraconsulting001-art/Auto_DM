import { CODE_RULES, codeHash, isCode, newCode, sameSecret, subjectHash } from '../../contracts/accounts.js';
import { log } from '../../platform/log.js';
import { platformOf } from './shared.js';

// Compared against when there is no code at all, so a number that never asked takes the same path as one that did.
const NOTHING = 'no-code-was-sent';

/**
 * One-time codes for sellers (PRD 5.11): six digits, used once, dead after CODE_RULES.ttlMs and after
 * CODE_RULES.maxAttempts wrong tries. Only keyed hashes are stored: subjectHash of the number and codeHash of the code,
 * which also names the number and the purpose, so a code opens nothing else. A code is never logged, never returned
 * and never put in an error. `personId` binds a re-auth or link code to the person who asked.
 */
export function codesService(ctx) {
  const db = () => platformOf(ctx.db);
  const secret = () => ctx.config.sessionSecret;
  const subjectOf = (subject) => subjectHash(secret(), 'phone', subject);

  /** True while a code sent in the last CODE_RULES.resendAfterMs is still waiting: a resend inside that time sends nothing. */
  async function waiting({ subject, purpose, personId = null }) {
    const [row] = await db().query(
      `SELECT 1 FROM seller_login_codes
       WHERE subject_hash = $1 AND purpose = $2 AND person_id IS NOT DISTINCT FROM $3::bigint AND used_at IS NULL AND attempts < $4
         AND expires_at > now() AND created_at > now() - make_interval(secs => $5::float)
       LIMIT 1`,
      [subjectOf(subject), purpose, personId, CODE_RULES.maxAttempts, CODE_RULES.resendAfterMs / 1000],
    );
    return Boolean(row);
  }

  /**
   * A new code for `subject`, or null when one is still waiting (two requests at the same moment send one code). Any
   * older code for the same number and purpose stops working. The caller sends it and forgets it.
   */
  async function issue({ subject, purpose, personId = null }) {
    const hash = subjectOf(subject);
    return db().tx(async (t) => {
      // One number at a time, across every process: the check and the new row are one step.
      await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`seller_code:${purpose}:${hash}`]);
      const [recent] = await t.query(
        `SELECT 1 FROM seller_login_codes
         WHERE subject_hash = $1 AND purpose = $2 AND person_id IS NOT DISTINCT FROM $3::bigint AND used_at IS NULL AND attempts < $4
           AND expires_at > now() AND created_at > now() - make_interval(secs => $5::float) LIMIT 1`,
        [hash, purpose, personId, CODE_RULES.maxAttempts, CODE_RULES.resendAfterMs / 1000],
      );
      if (recent) return null;
      await t.query(
        'UPDATE seller_login_codes SET expires_at = now() WHERE subject_hash = $1 AND purpose = $2 AND person_id IS NOT DISTINCT FROM $3::bigint AND used_at IS NULL AND expires_at > now()',
        [hash, purpose, personId],
      );
      const code = newCode();
      await t.query(
        `INSERT INTO seller_login_codes (subject_hash, code_hash, purpose, person_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::float))`,
        [hash, codeHash(secret(), { purpose, subject, code }), purpose, personId, CODE_RULES.ttlMs / 1000],
      );
      return code;
    });
  }

  /**
   * True when `code` is the live code for this number and purpose (and person), and uses it up. The try is counted
   * before the comparison, in one statement that stops at the fifth, so two tries at the same moment can never both
   * be the fifth; the code is then spent in another that only one of two winners can make.
   */
  async function check({ subject, purpose, personId = null, code }) {
    const wanted = isCode(code) ? codeHash(secret(), { purpose, subject, code }) : '';
    const [live] = await db().query(
      `SELECT id FROM seller_login_codes
       WHERE subject_hash = $1 AND purpose = $2 AND person_id IS NOT DISTINCT FROM $3::bigint AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [subjectOf(subject), purpose, personId],
    );
    if (!live) {
      sameSecret(wanted, NOTHING);
      return false;
    }
    const [counted] = await db().query(
      'UPDATE seller_login_codes SET attempts = attempts + 1 WHERE id = $1 AND attempts < $2 AND used_at IS NULL AND expires_at > now() RETURNING code_hash',
      [live.id, CODE_RULES.maxAttempts],
    );
    if (!counted || !wanted || !sameSecret(wanted, counted.code_hash)) return false;
    const [spent] = await db().query('UPDATE seller_login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [live.id]);
    return Boolean(spent);
  }

  /** Sends a code from Bhava's own WhatsApp number through the seller notifications interface. Never throws; says only the outcome. */
  async function send({ subject, code, purpose }) {
    try {
      const result = await ctx.notify.sendCode({ to: subject, code, purpose });
      log.info('accounts.code_sent', { purpose, outcome: result?.outcome ?? 'unknown', reason: result?.reason ?? '' });
      return result;
    } catch (err) {
      log.warn('accounts.code_not_sent', { purpose, kind: err?.name ?? 'error' });
      return { outcome: 'failed', reason: 'provider', retryable: false };
    }
  }

  /** Housekeeping: codes long dead are deleted. */
  async function purge() {
    await db().query(`DELETE FROM seller_login_codes WHERE expires_at < now() - interval '1 day'`);
  }

  return { waiting, issue, check, send, purge };
}
