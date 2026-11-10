import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { DAY, expiryWarning, nextRefreshAt } from './rules.js';

const REFRESH_LEASE_MS = 10 * 60_000;
const ACTOR = 'system:token-keeper';

/**
 * Keeps every business's Instagram token alive (PRD 4.2). sweep() runs every minute, which is what makes "within 1 minute" true for an
 * expired token. A token is only touched when it is due, so the refresh itself still happens about once a month per account.
 *
 * Handles one token at a time inside its own business. One bad account never stops the others.
 */
export function createTokenKeeper({ db, repos, meta, now = Date.now, batch = 200 }) {
  const platform = db.platform;

  async function forEachAccount(rows, work, tally) {
    for (const row of rows) {
      try {
        const outcome = await withTenant(row.tenant_id, () => work(row));
        if (outcome) tally[outcome] = (tally[outcome] ?? 0) + 1;
      } catch (err) {
        reportError(err, { msg: 'ig_token.sweep_failed', igUserId: row.ig_user_id });
      }
    }
  }

  /** Reached its expiry with no successful refresh (PRD 4.2). */
  async function expireTokens(at, tally) {
    const rows = await platform.query(
      `SELECT tenant_id, ig_user_id, token_version FROM ig_accounts WHERE access_token_enc <> '' AND status = 'active' AND token_expires_at <= $1::timestamptz LIMIT $2`,
      [at, batch],
    );
    await forEachAccount(rows, async (row) => {
      const lost = await repos.igAccounts.loseToken(row.ig_user_id, 'token.rejected', { expectedVersion: row.token_version, actor: ACTOR, details: { cause: 'expired' } });
      return lost ? 'expired' : null;
    }, tally);
  }

  async function refreshAccount(row, nowMs) {
    const id = row.ig_user_id;
    const version = row.token_version;
    const claimed = await repos.igAccounts.claimRefresh(id, version, { dueBy: new Date(nowMs), leaseUntil: new Date(nowMs + REFRESH_LEASE_MS) });
    if (!claimed) return null;

    const failed = async (details) => {
      await repos.igAccounts.refreshFailed(id, version, { at: new Date(nowMs), details });
      log.warn('ig_token.refresh_failed', { igUserId: id, ...details });
      return 'failed';
    };

    const account = await repos.igAccounts.get(id);
    // A token this server can't decrypt is a key problem here, not a refusal from Meta, so the connection is kept.
    if (!account?.token) return failed({ kind: 'undecryptable' });

    let fresh;
    try {
      fresh = await meta.login.refresh(account.token);
    } catch (err) {
      if (err.kind === 'token_invalid') {
        await repos.igAccounts.loseToken(id, 'token.rejected', { expectedVersion: version, actor: ACTOR, details: { cause: 'refresh_refused', code: err.code ?? null, subcode: err.subcode ?? null } });
        return 'rejected';
      }
      return failed({ kind: err.kind ?? 'error', status: err.status ?? null, code: err.code ?? null, subcode: err.subcode ?? null });
    }
    if (!fresh?.token) return failed({ kind: 'malformed' });

    const swapped = await repos.igAccounts.swapToken(id, version, { token: fresh.token, expiresAt: fresh.expiresAt, nextRefreshAt: nextRefreshAt(nowMs, fresh.expiresAt) });
    return swapped === null ? 'superseded' : 'refreshed';
  }

  async function refreshDue(nowMs, tally) {
    const rows = await platform.query(
      `SELECT tenant_id, ig_user_id, token_version FROM ig_accounts
       WHERE access_token_enc <> '' AND status = 'active' AND next_refresh_at <= $1::timestamptz ORDER BY next_refresh_at LIMIT $2`,
      [new Date(nowMs), batch],
    );
    await forEachAccount(rows, (row) => refreshAccount(row, nowMs), tally);
  }

  /** After refreshing, so a token that was just fixed isn't warned about. A working token never gets this close. */
  async function warnExpiring(nowMs, tally) {
    const rows = await platform.query(
      `SELECT tenant_id, ig_user_id, token_version, token_expires_at FROM ig_accounts
       WHERE access_token_enc <> '' AND status = 'active' AND token_expires_at > $1::timestamptz AND token_expires_at <= $2::timestamptz LIMIT 2000`,
      [new Date(nowMs), new Date(nowMs + 14 * DAY)],
    );
    await forEachAccount(rows, async (row) => {
      const days = expiryWarning(row.token_expires_at, nowMs);
      if (!days) return null;
      return (await repos.igAccounts.warnExpiry(row.ig_user_id, row.token_version, days)) ? 'warned' : null;
    }, tally);
  }

  return {
    /** Returns how many tokens ended up each way: { expired, refreshed, failed, rejected, superseded, warned }. */
    async sweep() {
      const nowMs = now();
      const tally = {};
      await expireTokens(new Date(nowMs), tally);
      await refreshDue(nowMs, tally);
      await warnExpiring(nowMs, tally);
      return tally;
    },
  };
}
