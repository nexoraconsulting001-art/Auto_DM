import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';

/**
 * The current business's Instagram accounts and their tokens. A token is decrypted only when it is about
 * to be used, and goes to src/instagram.js with each call. An account is { igUserId, username, token }.
 */
export function igAccountsRepo(db, { secrets }) {
  const toAccount = (row) => ({
    igUserId: row.ig_user_id,
    username: row.username,
    token: row.access_token_enc ? secrets.decrypt(row.access_token_enc) : '',
  });

  return {
    /** Stores a token for an account this business has linked (tenants.linkIgAccount). */
    async setToken(igUserId, token) {
      const value = String(token ?? '').trim();
      if (!value) throw new ValidationError('An access token is required');
      const rows = await db.query(
        `UPDATE ig_accounts SET access_token_enc = $3, token_updated_at = now() WHERE tenant_id = $1 AND ig_user_id = $2 RETURNING ig_user_id`,
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
        `SELECT * FROM ig_accounts WHERE tenant_id = $1 AND access_token_enc <> '' ORDER BY token_updated_at DESC NULLS LAST LIMIT 1`,
        [tenantId()],
      );
      return row ? toAccount(row) : null;
    },
  };
}

export const igAccounts = {
  name: 'ig-accounts',
  repos: (db, { secrets }) => ({ igAccounts: igAccountsRepo(db, { secrets }) }),
};
