import { codeHash, isCode, reviewCodeProblem, sameSecret, subjectHash, toE164 } from '../../contracts/accounts.js';
import { log } from '../../platform/log.js';
import { NO_PASSWORD, accountPhone, platformOf } from './shared.js';

/**
 * App Review's fixed login (PRD 5.11, 10.6; F-50, P-24). One number and the hash of its code come from
 * REVIEW_LOGIN_PHONE and REVIEW_LOGIN_CODE_HASH (codeHash with purpose "signin" and the review number as subject, keyed
 * with SESSION_SECRET); the code itself is never in the environment. Both set turns the flag on; both empty turns it off.
 * review_logins.tenant_id names the demo business (src/modules/demo-tenant), which is all the login opens.
 *
 * reviewCodeProblem decides. Every try of it is a row in review_login_uses, accepted or not: the review number with any
 * code, and the review code on any number. A refusal is then an ordinary wrong code.
 */
export function reviewLoginService(ctx, { people }) {
  const db = () => platformOf(ctx.db);
  const secret = () => ctx.config.sessionSecret;
  let synced = null;

  /** Writes the configured login once per process, and turns off any other. */
  function sync() {
    synced ??= (async () => {
      const phone = toE164(ctx.config.reviewLoginPhone);
      const hash = String(ctx.config.reviewLoginCodeHash ?? '').trim();
      if (!phone || !hash) {
        await db().query('UPDATE review_logins SET enabled = false, updated_at = now() WHERE enabled');
        return;
      }
      await db().query(
        `INSERT INTO review_logins (phone, code_hash, enabled) VALUES ($1, $2, true)
         ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, enabled = true, updated_at = now()`,
        [phone, hash],
      );
      await db().query('UPDATE review_logins SET enabled = false, updated_at = now() WHERE phone <> $1 AND enabled', [phone]);
    })().catch((err) => {
      synced = null;
      throw err;
    });
    return synced;
  }

  /** { login } when this try is the review login and may open it; { login: null } for an ordinary try. Logs every review try. */
  async function check({ phone, code, ip }) {
    await sync();
    const logins = await db().query('SELECT id, phone, code_hash, enabled, tenant_id FROM review_logins ORDER BY enabled DESC, id');
    for (const login of logins) {
      const isReviewNumber = Boolean(phone) && sameSecret(login.phone, phone);
      const codeMatches = isCode(code) && sameSecret(codeHash(secret(), { purpose: 'signin', subject: login.phone, code }), login.code_hash);
      if (!isReviewNumber && !codeMatches) continue;
      let reason = reviewCodeProblem(login, { phone: phone ?? '', codeMatches });
      if (reason === '' && !login.tenant_id) reason = 'flag_off';
      await db().query(
        'INSERT INTO review_login_uses (subject_hash, accepted, reason, ip_hash) VALUES ($1, $2, $3, $4)',
        [subjectHash(secret(), 'phone', phone ?? ''), reason === '', reason, subjectHash(secret(), 'ip', ip ?? '')],
      );
      if (reason) {
        log.warn('accounts.review_login_refused', { reason });
        return { login: null };
      }
      log.info('accounts.review_login', { tenantId: login.tenant_id });
      return { login };
    }
    return { login: null };
  }

  /** The review person's account in the demo business, made the first time: the owner there, so every screen shows. */
  async function account(login) {
    const { personId } = await people.findOrMake({ kind: 'phone', subject: login.phone, name: 'App Review' });
    const tenantId = login.tenant_id;
    const phone = accountPhone(login.phone, personId);
    return db().tx(async (t) => {
      const [mine] = await t.query('SELECT id FROM users WHERE tenant_id = $1 AND person_id = $2 AND removed_at IS NULL LIMIT 1', [tenantId, personId]);
      if (mine) return { personId, account: { tenant_id: tenantId, user_id: mine.id } };
      const [byPhone] = await t.query(
        `SELECT id FROM users WHERE tenant_id = $1 AND phone = $2 AND (person_id IS NULL OR person_id = $3) FOR UPDATE`,
        [tenantId, phone, personId],
      );
      if (byPhone) {
        await t.query(`UPDATE users SET person_id = $3, removed_at = NULL, role = CASE WHEN role IN ('owner', 'manager', 'staff') THEN role ELSE 'owner' END WHERE tenant_id = $1 AND id = $2`, [tenantId, byPhone.id, personId]);
        await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [tenantId, byPhone.id]);
        return { personId, account: { tenant_id: tenantId, user_id: byPhone.id } };
      }
      const [made] = await t.query(
        `INSERT INTO users (tenant_id, name, phone, email, password_hash, role, person_id) VALUES ($1, 'App Review', $2, '', $3, 'owner', $4) RETURNING id`,
        [tenantId, phone, NO_PASSWORD, personId],
      );
      return { personId, account: { tenant_id: tenantId, user_id: made.id } };
    });
  }

  return { sync, check, account };
}
