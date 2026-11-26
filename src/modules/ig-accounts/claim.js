import { withTenant } from '../../tenancy.js';
import { RELEASED_BY_OWNER, isFreeClaimTaken, isLiveAccountClash } from '../../repos/connections.js';
import { writeAudit } from '../audit/index.js';

/**
 * Putting an Instagram account or a Facebook Page on a business when its owner connects it (tenancy-1). One structure for both.
 *
 * An account sends for one business at a time, because webhooks route by its id alone. Each business keeps its own row, so
 * another business's row is never changed or removed: a row its owner released by disconnecting stays with that business,
 * and its inbox, send history and insights with it. Only a live row is routed to, and the database allows one per account
 * (migration 921).
 */
const KINDS = Object.freeze({
  instagram: {
    table: 'ig_accounts',
    id: 'ig_user_id',
    name: 'username',
    message: 'Your Instagram account was connected to another business. Your inbox, send history and insights here are kept as they were, and nothing sends from this business with it.',
  },
  facebook: {
    table: 'fb_pages',
    id: 'page_id',
    name: 'name',
    message: 'Your Facebook Page was connected to another business. Your inbox, send history and insights here are kept as they were, and nothing sends from this business with it.',
  },
});

/** A row its owner disconnected: no token, and released by them. Only such a row lets the account go to another business. */
export const isReleased = (row) => row.access_token_enc === '' && row.status_reason === RELEASED_BY_OWNER;

/**
 * Puts `accountId` on business `tenantId`. Null when another business still holds it. Otherwise { passedOver }: the
 * businesses whose released row stays behind, with when each released it. Runs on the platform connection, before
 * any business is chosen, and reads nothing of the other businesses but whether their row is live.
 */
export async function claimConnection(platformDb, channel, { tenantId, accountId, name = '' }) {
  const kind = KINDS[channel];
  try {
    return await platformDb.tx(async (t) => {
      const rows = await t.query(
        `SELECT tenant_id, access_token_enc, status_reason, status_changed_at FROM ${kind.table} WHERE ${kind.id} = $1 FOR UPDATE`,
        [accountId],
      );
      const others = rows.filter((row) => row.tenant_id !== tenantId);
      if (others.some((row) => !isReleased(row))) return null;
      await t.query(
        `INSERT INTO ${kind.table} (${kind.id}, tenant_id, ${kind.name}) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, ${kind.id}) DO NOTHING`,
        [accountId, tenantId, name],
      );
      return { passedOver: others.map((row) => ({ tenantId: row.tenant_id, releasedAt: row.status_changed_at })) };
    });
  } catch (err) {
    // Another business connected it at the same moment: the one-live-row index decides, and this one lost.
    if (isLiveAccountClash(err)) return null;
    // A Free business may not take an account another Free business has claimed, even after it let go (one Free plan per Instagram account).
    if (isFreeClaimTaken(err)) return null;
    throw err;
  }
}

/**
 * Tells each business that let the account go that another business has connected it: an alert and an audit row in that
 * business, once per release. Nothing about the other business is in either.
 */
export async function tellPassedOver({ db, repos }, channel, accountId, passedOver) {
  const target = `${channel}:${accountId}`;
  for (const { tenantId, releasedAt } of passedOver) {
    await withTenant(tenantId, async () => {
      const alert = await repos.alerts.raise({
        kind: `${channel}.connected_elsewhere`,
        message: KINDS[channel].message,
        target,
        dedupeKey: `connected_elsewhere:${target}:${releasedAt ? new Date(releasedAt).getTime() : 0}`,
      });
      if (alert) await db.tx((t) => writeAudit(t, { actor: `system:${channel}-connect`, action: `${channel}.connected_elsewhere`, target }));
    });
  }
}
