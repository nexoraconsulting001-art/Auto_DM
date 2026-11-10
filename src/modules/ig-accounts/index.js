import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { writeAudit } from '../audit/index.js';

/** status_reason of a connection the seller ended. It reads as "not connected", and frees the account for another business. */
export const DISCONNECTED_BY_OWNER = 'owner.disconnected';
const DELETION_REQUESTED = 'deletion.requested';

/** One row of the compliance log (PRD 4.16) on `runner`, so a change and its row land together. Ids only. */
export async function logDecision(runner, { decision, reason = '', kind = 'token', details = {} }) {
  await runner.query(
    `INSERT INTO compliance_events (tenant_id, channel, kind, decision, reason, details) VALUES ($1, 'instagram', $2, $3, $4, $5)`,
    [tenantId(), kind, decision, reason, JSON.stringify(details)],
  );
}

/** repos.alerts.raise on `runner`, for an alert that must land with the change it reports. */
export async function raiseAlert(runner, { kind, message, severity = 'warning', target = '', dedupeKey = null, audience = 'owner' }) {
  await runner.query(
    `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, audience, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tenantId(), audience, kind, severity, message, target, dedupeKey],
  );
}

const targetOf = (igUserId) => `instagram:${igUserId}`;

/** What happens when each kind of event takes a working token away (PRD 4.2). */
const LOSSES = Object.freeze({
  'token.rejected': {
    status: 'reconnect_needed',
    tokenAlert: 'rejected',
    audiences: ['owner'],
    message: 'Instagram stopped accepting your connection, so your DMs are on hold. Reconnect Instagram to start them again.',
  },
  'token.deauthorized': {
    status: 'deauthorized',
    tokenAlert: 'deauthorized',
    audiences: ['owner', 'ops'],
    message: 'Access to your Instagram account was removed, so your DMs are on hold. Reconnect Instagram to start them again.',
  },
});

/**
 * The current business's Instagram accounts and their tokens. A token is encrypted here, decrypted only when it is about
 * to be used, and goes to src/instagram.js with each call. An account is { igUserId, username, token }, plus loginKind
 * for a Unified Login account, which is what the Meta adapter binds to. Only an active account ever has a token: one
 * that lost its token, or whose token can no longer be decrypted, comes back with none, so nothing can send with it.
 */
export function igAccountsRepo(db, { secrets }) {
  function reveal(row) {
    if (!row.access_token_enc || row.status !== 'active') return '';
    try {
      return secrets.decrypt(row.access_token_enc);
    } catch {
      log.warn('ig_accounts.undecryptable', { igUserId: row.ig_user_id });
      return '';
    }
  }

  const toAccount = (row) => ({
    igUserId: row.ig_user_id,
    username: row.username,
    token: reveal(row),
    ...(row.login_kind === 'unified' ? { loginKind: 'unified' } : {}),
  });

  /** Everything known about a connection, never the token. */
  const toDetail = (row) => ({
    igUserId: row.ig_user_id,
    appScopedId: row.app_scoped_id,
    username: row.username,
    loginKind: row.login_kind,
    pageId: row.page_id,
    status: row.status,
    statusReason: row.status_reason,
    hasToken: row.access_token_enc !== '',
    tokenVersion: row.token_version,
    tokenIssuedAt: row.token_issued_at,
    tokenExpiresAt: row.token_expires_at,
    scopes: row.granted_scopes ?? [],
    subscribedFields: row.subscribed_fields ?? [],
    subscribedAt: row.subscribed_at,
    refreshFailures: row.refresh_failures,
    lastRefreshAt: row.last_refresh_at,
    nextRefreshAt: row.next_refresh_at,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
  });

  const holdJobs = (t, igUserId) => t.query(
    `UPDATE outbound_jobs SET status = 'held', reason = 'paused.reconnect', updated_at = now()
     WHERE tenant_id = $1 AND ig_user_id = $2 AND status = 'queued' RETURNING id`,
    [tenantId(), igUserId],
  );

  /** Everything waiting to go out from this account, stopped for good. */
  const cancelJobs = (t, igUserId) => t.query(
    `UPDATE outbound_jobs SET status = 'cancelled', reason = 'cancelled.owner', updated_at = now()
     WHERE tenant_id = $1 AND ig_user_id = $2 AND status IN ('queued', 'held') RETURNING id`,
    [tenantId(), igUserId],
  );

  /** Jobs held for a reconnect go back in the queue. One past its expires_at stays held for the compliance engine to expire with its own reason (PRD 4.12). */
  const releaseHeldJobs = (t, igUserId) => t.query(
    `UPDATE outbound_jobs SET status = 'queued', reason = '', run_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND ig_user_id = $2 AND status = 'held' AND reason = 'paused.reconnect' AND expires_at > now() RETURNING id`,
    [tenantId(), igUserId],
  );

  const removeToken = (t, igUserId, status, reason, expectedVersion = null) => t.query(
    `UPDATE ig_accounts SET access_token_enc = '', status = $3, status_reason = $4, status_changed_at = now(), token_updated_at = now(),
       granted_scopes = '{}', subscribed_fields = '{}', subscribed_at = NULL, next_refresh_at = NULL
     WHERE tenant_id = $1 AND ig_user_id = $2 AND access_token_enc <> '' AND ($5::integer IS NULL OR token_version = $5::integer)
     RETURNING token_version`,
    [tenantId(), igUserId, status, reason, expectedVersion],
  );

  return {
    /** Stores a token for an account this business has linked (tenants.linkIgAccount). Its expiry is unknown until its first refresh, a day later. */
    async setToken(igUserId, token) {
      const value = String(token ?? '').trim();
      if (!value) throw new ValidationError('An access token is required');
      const rows = await db.query(
        `UPDATE ig_accounts SET access_token_enc = $3, token_updated_at = now(), token_version = token_version + 1, token_issued_at = now(), token_expires_at = NULL,
           next_refresh_at = now() + interval '24 hours', refresh_failures = 0, status = 'active', status_reason = '', status_changed_at = now()
         WHERE tenant_id = $1 AND ig_user_id = $2 RETURNING ig_user_id`,
        [tenantId(), String(igUserId), secrets.encrypt(value)],
      );
      if (!rows.length) throw new ValidationError('This Instagram account is not linked to this business');
    },

    /** One of this business's accounts, or null. */
    async get(igUserId) {
      const [row] = await db.query('SELECT * FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenantId(), String(igUserId)]);
      return row ? toAccount(row) : null;
    },

    /** The account this business sends from: the one with the newest token, or null when none is connected. */
    async current() {
      const [row] = await db.query(
        `SELECT * FROM ig_accounts WHERE tenant_id = $1 AND access_token_enc <> '' AND status = 'active' ORDER BY token_updated_at DESC NULLS LAST LIMIT 1`,
        [tenantId()],
      );
      if (!row) return null;
      const account = toAccount(row);
      return account.token ? account : null;
    },

    /** One account's connection details, with no token, or null. */
    async detail(igUserId) {
      const [row] = await db.query('SELECT * FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenantId(), String(igUserId)]);
      return row ? toDetail(row) : null;
    },

    /** The connection a seller sees: a working one, otherwise the one that most recently stopped working. Null when there is none. */
    async primary() {
      const [row] = await db.query(
        `SELECT * FROM ig_accounts WHERE tenant_id = $1 AND status_reason <> $2
         ORDER BY (access_token_enc <> '') DESC, status_changed_at DESC NULLS LAST, token_updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [tenantId(), DISCONNECTED_BY_OWNER],
      );
      return row ? toDetail(row) : null;
    },

    /** This business's other accounts that still hold a token: connecting a new account replaces them. */
    async othersWithTokens(igUserId) {
      const rows = await db.query(`SELECT ig_user_id FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id <> $2 AND access_token_enc <> ''`, [tenantId(), String(igUserId)]);
      return rows.map((row) => row.ig_user_id);
    },

    /**
     * Connect or reconnect (PRD 4.2): the token, its version, what was granted and the release of jobs held for a reconnect, in one
     * transaction. Returns the new details and how many jobs went back in the queue. The account must already be linked.
     */
    async saveConnection({ igUserId, appScopedId = '', username = '', token, expiresAt = null, scopes = [], loginKind = 'instagram', pageId = '', connectedBy = null, nextRefreshAt = null }) {
      const id = String(igUserId);
      if (!token) throw new ValidationError('An access token is required');
      const encrypted = secrets.encrypt(token);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE ig_accounts SET username = $3, app_scoped_id = $4, login_kind = $5, page_id = $6, status = 'active', status_reason = '', status_changed_at = now(),
             access_token_enc = $7, token_version = token_version + 1, token_updated_at = now(), token_issued_at = now(), token_expires_at = $8::timestamptz,
             granted_scopes = $9, subscribed_fields = '{}', subscribed_at = NULL, refresh_failures = 0, last_refresh_at = NULL, next_refresh_at = $10::timestamptz,
             connected_by = $11::integer, connected_at = now()
           WHERE tenant_id = $1 AND ig_user_id = $2 RETURNING *`,
          [tenantId(), id, username, appScopedId, loginKind, pageId, encrypted, expiresAt, scopes, nextRefreshAt, connectedBy],
        );
        if (!row) throw new ValidationError('This Instagram account is not linked to this business');
        const released = await releaseHeldJobs(t, id);
        await writeAudit(t, {
          actor: connectedBy ? `user:${connectedBy}` : 'system',
          action: 'instagram.connected',
          target: targetOf(id),
          details: { loginKind, scopes, tokenVersion: row.token_version, jobsReleased: released.length },
        });
        return { account: toDetail(row), jobsReleased: released.length };
      });
    },

    /** Records which webhook fields Meta has confirmed for this account. */
    async setSubscribed(igUserId, fields) {
      await db.query(
        `UPDATE ig_accounts SET subscribed_fields = $3, subscribed_at = now() WHERE tenant_id = $1 AND ig_user_id = $2`,
        [tenantId(), String(igUserId), [...fields]],
      );
    },

    /** Slow mode from a missing insights permission (PRD 4.15). Any other cause of slow mode is left alone. Ending it starts the compliance engine's restore. */
    async setInsightsDenied(igUserId, denied) {
      if (denied) {
        await db.query(
          `INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), 'insights_denied')
           ON CONFLICT (tenant_id, channel, account_id) DO UPDATE
             SET slow_mode_started_at = now(), slow_mode_trigger = 'insights_denied', slow_mode_until = NULL, updated_at = now()
             WHERE account_rate_state.slow_mode_started_at IS NULL OR account_rate_state.slow_mode_until <= now() OR account_rate_state.slow_mode_trigger = 'insights_denied'`,
          [tenantId(), String(igUserId)],
        );
        return;
      }
      await db.query(
        `UPDATE account_rate_state SET slow_mode_until = now(), updated_at = now()
         WHERE tenant_id = $1 AND channel = 'instagram' AND account_id = $2 AND slow_mode_trigger = 'insights_denied' AND slow_mode_until IS NULL`,
        [tenantId(), String(igUserId)],
      );
    },

    /**
     * Takes one refresh attempt for this token version by moving the due time on. A second worker, or a sweep that overlaps this
     * one, finds it no longer due: Meta may end the old token at each refresh, so two refreshes must never race.
     */
    async claimRefresh(igUserId, tokenVersion, { dueBy, leaseUntil }) {
      const [row] = await db.query(
        `UPDATE ig_accounts SET next_refresh_at = $5::timestamptz
         WHERE tenant_id = $1 AND ig_user_id = $2 AND token_version = $3 AND status = 'active' AND next_refresh_at <= $4::timestamptz RETURNING ig_user_id`,
        [tenantId(), String(igUserId), tokenVersion, dueBy, leaseUntil],
      );
      return Boolean(row);
    },

    /**
     * The refreshed token replaces the old one only if the version is still the one read (PRD 4.2). Returns the new version, or
     * null when something else changed the token first, and then this token is simply dropped.
     */
    async swapToken(igUserId, expectedVersion, { token, expiresAt = null, nextRefreshAt = null }) {
      const id = String(igUserId);
      if (!token) throw new ValidationError('An access token is required');
      const encrypted = secrets.encrypt(token);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE ig_accounts SET access_token_enc = $4, token_version = token_version + 1, token_updated_at = now(), token_issued_at = now(),
             token_expires_at = $5::timestamptz, refresh_failures = 0, last_refresh_at = now(), next_refresh_at = $6::timestamptz
           WHERE tenant_id = $1 AND ig_user_id = $2 AND token_version = $3 AND status = 'active' AND access_token_enc <> '' RETURNING token_version`,
          [tenantId(), id, expectedVersion, encrypted, expiresAt, nextRefreshAt],
        );
        if (!row) return null;
        await logDecision(t, { decision: 'token.refreshed', details: { igUserId: id, tokenVersion: row.token_version } });
        return row.token_version;
      });
    },

    /** A refresh that failed: every 6 hours for 3 days, then daily (PRD 4.2). Returns the failure count. */
    async refreshFailed(igUserId, expectedVersion, { at, details = {} }) {
      const id = String(igUserId);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE ig_accounts SET refresh_failures = refresh_failures + 1,
             next_refresh_at = $4::timestamptz + CASE WHEN refresh_failures + 1 <= 12 THEN interval '6 hours' ELSE interval '24 hours' END
           WHERE tenant_id = $1 AND ig_user_id = $2 AND token_version = $3 AND status = 'active' RETURNING refresh_failures`,
          [tenantId(), id, expectedVersion, at],
        );
        if (!row) return null;
        await logDecision(t, { decision: 'token.refresh_failed', details: { igUserId: id, failures: row.refresh_failures, ...details } });
        return row.refresh_failures;
      });
    },

    /**
     * A working token stopped working: Meta refused it, it expired, or the owner removed the app (`decision` is token.rejected or
     * token.deauthorized). The token goes, jobs wait for a reconnect, and the log and the alerts land in the same transaction.
     * False when there was no token to lose, so a repeat changes nothing and alerts nobody.
     *
     * Pass expectedVersion when the news is about one particular token, so an old refusal can't end a newer token.
     */
    async loseToken(igUserId, decision, { expectedVersion = null, actor = 'system', details = {} } = {}) {
      const loss = LOSSES[decision];
      if (!loss) throw new Error(`Unknown token loss: ${decision}`);
      const id = String(igUserId);
      return db.tx(async (t) => {
        const [row] = await removeToken(t, id, loss.status, decision, expectedVersion);
        if (!row) return false;
        const held = await holdJobs(t, id);
        const facts = { tokenVersion: row.token_version, jobsHeld: held.length, ...details };
        await logDecision(t, { decision, details: { igUserId: id, ...facts } });
        await writeAudit(t, { actor, action: `instagram.${decision}`, target: targetOf(id), details: facts });
        await t.query(
          `INSERT INTO token_alerts (tenant_id, channel, account_id, kind, token_version) VALUES ($1, 'instagram', $2, $3, $4) ON CONFLICT DO NOTHING`,
          [tenantId(), id, loss.tokenAlert, row.token_version],
        );
        for (const audience of loss.audiences) {
          await raiseAlert(t, { kind: decision, severity: 'critical', message: loss.message, target: targetOf(id), audience, dedupeKey: `${decision}:${id}:${row.token_version}` });
        }
        return true;
      });
    },

    /** One expiry warning, the first time this token reaches `days` left (PRD 4.2). True when it was raised now. */
    async warnExpiry(igUserId, tokenVersion, days) {
      const id = String(igUserId);
      return db.tx(async (t) => {
        const [fresh] = await t.query(
          `INSERT INTO token_alerts (tenant_id, channel, account_id, kind, token_version) VALUES ($1, 'instagram', $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId(), id, `expiry_${days}d`, tokenVersion],
        );
        if (!fresh) return false;
        await raiseAlert(t, {
          kind: 'token.expiring',
          severity: days <= 3 ? 'critical' : 'warning',
          message: `Your Instagram connection ends in ${days === 1 ? '1 day' : `${days} days`}. Reconnect Instagram to keep your DMs running.`,
          target: targetOf(id),
          dedupeKey: `expiry_${days}d:${id}:${tokenVersion}`,
        });
        return true;
      });
    },

    /** The seller ended this connection. The token goes and nothing waits for it: the row stays, as "not connected", so the inbox survives. */
    async disconnect(igUserId, { actor }) {
      const id = String(igUserId);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE ig_accounts SET access_token_enc = '', status = 'deauthorized', status_reason = $3, status_changed_at = now(), token_updated_at = now(),
             granted_scopes = '{}', subscribed_fields = '{}', subscribed_at = NULL, next_refresh_at = NULL
           WHERE tenant_id = $1 AND ig_user_id = $2 RETURNING token_version`,
          [tenantId(), id, DISCONNECTED_BY_OWNER],
        );
        if (!row) return false;
        const cancelled = await cancelJobs(t, id);
        await logDecision(t, { decision: 'token.deauthorized', details: { igUserId: id, source: 'owner', jobsCancelled: cancelled.length } });
        await writeAudit(t, { actor, action: 'instagram.disconnected', target: targetOf(id), details: { jobsCancelled: cancelled.length } });
        return true;
      });
    },

    /**
     * The first half of a deletion request (PRD 4.14), done before Meta gets its answer: the token is gone, nothing queued will
     * send, and the business's Instagram automations stop. eraseAccount removes the data.
     */
    async stopForDeletion(igUserId) {
      const id = String(igUserId);
      return db.tx(async (t) => {
        await removeToken(t, id, 'deauthorized', DELETION_REQUESTED);
        const cancelled = await cancelJobs(t, id);
        const stopped = await t.query(
          `UPDATE automations SET state = 'paused', paused_reason = $2, updated_at = now()
           WHERE tenant_id = $1 AND state IN ('live', 'test')
             AND id IN (SELECT automation_id FROM automation_triggers WHERE tenant_id = $1 AND channel = 'instagram') RETURNING id`,
          [tenantId(), DELETION_REQUESTED],
        );
        const facts = { jobsCancelled: cancelled.length, automationsStopped: stopped.length };
        await logDecision(t, { kind: 'data', decision: DELETION_REQUESTED, details: { igUserId: id, ...facts } });
        await writeAudit(t, { actor: 'meta:deletion', action: 'instagram.deletion_requested', target: targetOf(id), details: facts });
        await raiseAlert(t, {
          kind: DELETION_REQUESTED,
          severity: 'critical',
          message: 'Your Instagram data is being deleted, as requested through Meta. Your Instagram automations have stopped.',
          target: targetOf(id),
          dedupeKey: `${DELETION_REQUESTED}:${id}:${new Date().toISOString().slice(0, 10)}`,
        });
        return facts;
      });
    },

    /**
     * Removes everything that came from Instagram for this account (PRD 4.14). Tables with no account column hold one business's
     * Instagram data as a whole, so those go whole. What stays: the opt-out list, which must outlive this, the logs that hold no
     * personal data, and the media id on a store page, which is the key of the seller's own page. If the seller reconnected
     * in the meantime, the new connection is kept and only the old data goes.
     */
    async eraseAccount(igUserId) {
      const id = String(igUserId);
      const business = tenantId();
      return db.tx(async (t) => {
        const threads = `(SELECT id FROM inbox_threads WHERE tenant_id = $1 AND ig_user_id = $2)`;
        const jobs = `(SELECT id FROM outbound_jobs WHERE tenant_id = $1 AND ig_user_id = $2)`;
        await t.query(
          `DELETE FROM needs_human_items WHERE tenant_id = $1 AND channel = 'instagram'
             AND (thread_id IN ${threads} OR job_id IN ${jobs} OR (thread_id IS NULL AND job_id IS NULL))`,
          [business, id],
        );
        await t.query(`DELETE FROM inbox_threads WHERE tenant_id = $1 AND ig_user_id = $2`, [business, id]);
        await t.query(`DELETE FROM outbound_jobs WHERE tenant_id = $1 AND ig_user_id = $2`, [business, id]);
        await t.query(`DELETE FROM inbound_events WHERE tenant_id = $1 AND channel = 'instagram' AND account_id = $2`, [business, id]);
        await t.query(`DELETE FROM account_rate_state WHERE tenant_id = $1 AND channel = 'instagram' AND account_id = $2`, [business, id]);
        await t.query(`DELETE FROM send_budgets WHERE tenant_id = $1 AND channel = 'instagram' AND account_id = $2`, [business, id]);
        await t.query(`DELETE FROM token_alerts WHERE tenant_id = $1 AND channel = 'instagram' AND account_id = $2`, [business, id]);
        await t.query(`DELETE FROM link_taps WHERE tenant_id = $1 AND channel = 'instagram'`, [business]);
        await t.query(`DELETE FROM cap_claims WHERE tenant_id = $1 AND channel = 'instagram'`, [business]);
        await t.query(`DELETE FROM activity WHERE tenant_id = $1`, [business]);
        await t.query(`DELETE FROM automation_triggers WHERE tenant_id = $1 AND channel = 'instagram' AND media_id <> ''`, [business]);
        await t.query(`UPDATE automation_triggers SET active = false, permalink = '', thumbnail_url = '', caption = '' WHERE tenant_id = $1 AND channel = 'instagram'`, [business]);
        await t.query(`UPDATE reels SET active = false, permalink = '', thumbnail_url = '', video_url = '', caption = '' WHERE tenant_id = $1`, [business]);
        await t.query(`DELETE FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2 AND access_token_enc = ''`, [business, id]);
        await logDecision(t, { kind: 'data', decision: 'deletion.completed', details: { igUserId: id } });
        await writeAudit(t, { actor: 'meta:deletion', action: 'instagram.deletion_completed', target: targetOf(id) });
      });
    },
  };
}

export const igAccounts = {
  name: 'ig-accounts',
  repos: (db, { secrets }) => ({ igAccounts: igAccountsRepo(db, { secrets }) }),
};
