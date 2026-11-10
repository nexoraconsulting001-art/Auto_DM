import crypto from 'node:crypto';
import { tenantId } from '../../tenancy.js';
import { logDecision } from '../ig-accounts/index.js';
import { DAY, SCOPES_TO_GO_LIVE } from './rules.js';

const newSalt = () => crypto.randomBytes(32).toString('base64url');
const HEALTH_CHECK_VALID_MS = DAY + 2 * 3_600_000;

/** Data for connecting Instagram: connects in progress, the release gates (a business's compliance_settings row is made the first time it is needed), and what the review page shows. */
export function igConnectRepo(db) {
  return {
    /** A connect in progress. Only the hash is stored, and the callback reads it through db.platform. */
    async saveState({ stateHash, provider, userId, returnTo, expiresAt }) {
      await db.query(
        `INSERT INTO oauth_states (state_hash, tenant_id, provider, user_id, return_to, expires_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [stateHash, tenantId(), provider, userId, returnTo, expiresAt],
      );
    },

    /** The review business's account has an app role on the Meta app, which is how it works under Standard Access. */
    async allowAppRole() {
      await db.query(
        `INSERT INTO compliance_settings (tenant_id, subject_salt, app_role_ok) VALUES ($1, $2, true)
         ON CONFLICT (tenant_id) DO UPDATE SET app_role_ok = true`,
        [tenantId(), newSalt()],
      );
    },

    /**
     * Works out PRD 4.15's four gates, stamps the health checks that just passed, keeps gate_passed_at true to the result, and logs
     * only when the result changes. Returns { passed, gates: [{ code, passed }] }, the shape of ComplianceGate.
     */
    async recordGates({ account, health, now = new Date() }) {
      const business = tenantId();
      return db.tx(async (t) => {
        const [settings] = await t.query(
          `INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET
             privacy_url_ok_at = CASE WHEN $3::boolean THEN $5::timestamptz ELSE compliance_settings.privacy_url_ok_at END,
             deletion_callback_ok_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE compliance_settings.deletion_callback_ok_at END,
             updated_at = now()
           RETURNING *`,
          [business, newSalt(), Boolean(health.privacy), Boolean(health.deletion), now],
        );
        // A row made by this insert has no stamps yet, so what was just checked counts here as well.
        const fresh = (at, justPassed) => justPassed || (Boolean(at) && now.getTime() - new Date(at).getTime() < HEALTH_CHECK_VALID_MS);
        const scopes = account?.hasToken ? account.scopes : [];
        const results = [
          { code: 'gate.access_level', passed: settings.access_level === 'advanced' || settings.app_role_ok },
          { code: 'gate.scope_missing', passed: SCOPES_TO_GO_LIVE.every((scope) => scopes.includes(scope)) },
          { code: 'gate.privacy_url', passed: fresh(settings.privacy_url_ok_at, health.privacy) },
          { code: 'gate.deletion_callback', passed: fresh(settings.deletion_callback_ok_at, health.deletion) },
        ];
        const failing = results.filter((gate) => !gate.passed).map((gate) => gate.code);
        const passed = failing.length === 0;
        await t.query(
          `UPDATE compliance_settings SET gate_passed_at = CASE WHEN $2::boolean THEN COALESCE(gate_passed_at, now()) ELSE NULL END, updated_at = now() WHERE tenant_id = $1`,
          [business, passed],
        );
        const [last] = await t.query(`SELECT details FROM compliance_events WHERE tenant_id = $1 AND kind = 'gate' ORDER BY id DESC LIMIT 1`, [business]);
        const unchanged = JSON.stringify(last?.details?.failing ?? null) === JSON.stringify(failing);
        // A business that has never connected has nothing to report.
        if (!unchanged && (account || last)) {
          for (const decision of passed ? ['gate.passed'] : failing) await logDecision(t, { kind: 'gate', decision, details: { failing } });
        }
        return { passed, gates: [...results, { code: 'gate.passed', passed }] };
      });
    },

    /** The newest decisions in the compliance log, which hold no personal data. */
    async recentDecisions(limit = 10) {
      return db.query(`SELECT kind, decision, reason, created_at FROM compliance_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`, [tenantId(), limit]);
    },

    /** Which of these media ids already have an active automation here. */
    async automationsForMedia(mediaIds) {
      if (!mediaIds.length) return new Map();
      const rows = await db.query(
        `SELECT t.media_id, t.automation_id FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id
         WHERE t.tenant_id = $1 AND t.channel = 'instagram' AND t.active AND t.media_id = ANY($2) AND a.state <> 'archived'`,
        [tenantId(), mediaIds],
      );
      return new Map(rows.map((row) => [row.media_id, row.automation_id]));
    },
  };
}

/** PRD 4.14's retention, for every business. The window for each kind of data is in the privacy page, so a change here changes it there. */
export const RETENTION_DAYS = Object.freeze({ rawWebhooks: 7, messages: 30, whyNoDm: 90 });

export async function applyRetention(platformDb) {
  const { rawWebhooks, messages } = RETENTION_DAYS;
  await platformDb.query(`DELETE FROM inbound_events WHERE received_at < now() - make_interval(days => $1)`, [rawWebhooks]);
  await platformDb.query(`DELETE FROM inbox_messages WHERE created_at < now() - make_interval(days => $1)`, [messages]);
  await platformDb.query(`DELETE FROM inbox_threads WHERE COALESCE(last_message_at, created_at) < now() - make_interval(days => $1)`, [messages]);
  await platformDb.query(`DELETE FROM needs_human_items WHERE created_at < now() - make_interval(days => $1)`, [messages]);
  await platformDb.query(
    `UPDATE activity SET username = '', text = '' WHERE created_at < now() - make_interval(days => $1) AND (username <> '' OR text <> '')`,
    [messages],
  );
  await platformDb.query(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`);
}
