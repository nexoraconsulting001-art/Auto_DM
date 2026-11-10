import crypto from 'node:crypto';
import { log } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';

/**
 * Who gets the weekly and monthly reports, and one-click unsubscribe (7.9). A person's link carries a token that is worked out from a server key, so
 * every email can carry it again, and only its hash is stored. The token alone finds the person, through db.platform, whatever address it is opened on.
 */
const TOKEN_LABEL = 'bhava.report-unsubscribe.v1';

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** The key the tokens are made with. DATA_KEY is the same in the web app and the worker; SESSION_SECRET is the fallback. */
function tokenKey(config) {
  const base = config?.dataKey || config?.sessionSecret || '';
  return crypto.createHmac('sha256', String(base)).update(TOKEN_LABEL).digest();
}

export function createPreferences(ctx) {
  const { db, repos, config } = ctx;

  const tokenFor = (userId) => crypto.createHmac('sha256', tokenKey(config)).update(`${tenantId()}:${userId}`).digest('base64url');

  async function row(userId) {
    const [found] = await db.query('SELECT weekly, monthly FROM report_preferences WHERE tenant_id = $1 AND user_id = $2', [tenantId(), userId]);
    return found ?? { weekly: true, monthly: true };
  }

  /**
   * The person's unsubscribe token, with its hash stored. Called on `runner` (a transaction) right before an email that carries it is written, so the
   * newest email's link always works. The person's choices are kept.
   */
  async function issueToken(runner, userId) {
    const token = tokenFor(userId);
    await runner.query(
      `INSERT INTO report_preferences (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash WHERE report_preferences.token_hash <> EXCLUDED.token_hash`,
      [tenantId(), userId, hashToken(token)],
    );
    return token;
  }

  /** Everyone's choices at once, for a run. A person with no row has both reports on. */
  async function all() {
    const rows = await db.query('SELECT user_id, weekly, monthly FROM report_preferences WHERE tenant_id = $1', [tenantId()]);
    return new Map(rows.map((r) => [r.user_id, r]));
  }

  async function view(user) {
    const prefs = await row(user.id);
    return { weekly: prefs.weekly, monthly: prefs.monthly, monthlyAvailable: await repos.entitlements.can('report.monthly') };
  }

  async function update(user, change) {
    const weekly = change.weekly ?? null;
    const monthly = change.monthly ?? null;
    await db.query(
      `INSERT INTO report_preferences (tenant_id, user_id, weekly, monthly, token_hash) VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true), $5)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET weekly = COALESCE($3, report_preferences.weekly), monthly = COALESCE($4, report_preferences.monthly), updated_at = now()`,
      [tenantId(), user.id, weekly, monthly, hashToken(tokenFor(user.id))],
    );
    return view(user);
  }

  /**
   * One click from an email. A token nobody holds changes nothing and says only that, so the answer can't be used to learn about people. The token
   * names its own business, so the change is made there, not in the business whose address the link was opened on.
   */
  async function unsubscribe({ token, report }) {
    const [found] = await db.platform.query('SELECT tenant_id, user_id FROM report_preferences WHERE token_hash = $1', [hashToken(token)]);
    if (!found) return { ok: false };
    await withTenant(found.tenant_id, () => db.query(
      `UPDATE report_preferences SET weekly = CASE WHEN $3 IN ('weekly', 'all') THEN false ELSE weekly END,
         monthly = CASE WHEN $3 IN ('monthly', 'all') THEN false ELSE monthly END, updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [found.tenant_id, found.user_id, report],
    ));
    log.info('reports.unsubscribed', { tenantId: found.tenant_id, userId: found.user_id, report });
    return { ok: true };
  }

  return { view, update, unsubscribe, issueToken, all };
}
