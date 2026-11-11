import { DELETION_GRACE_DAYS } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { dropPushDevices, revokeFamilies } from './tokens.js';
import { platformOf } from './shared.js';

export const DELETION_JOB = 'accounts.deletions';

/**
 * "Delete my account" (PRD 10.6, Apple 5.1.1(v); P-26). The request is a row due in DELETION_GRACE_DAYS, an audit row
 * in every business the person works at, an alert to ops in each, and the timeline in the answer. The person's
 * sessions end at once, on every device and business. Signing in again before the date cancels it. When it falls due,
 * carryOut() removes the person's identities and their accounts from every team; an account that is the only owner of
 * its business is left for ops, who were told when it was asked, because a business is never deleted here.
 */
export function deletionService(ctx) {
  const db = () => platformOf(ctx.db);

  async function businessesOf(t, personId) {
    return t.query(
      `SELECT u.tenant_id, u.id AS user_id, u.role,
         (u.role = 'owner' AND NOT EXISTS (SELECT 1 FROM users o WHERE o.tenant_id = u.tenant_id AND o.id <> u.id AND o.role = 'owner' AND o.removed_at IS NULL)) AS sole_owner
       FROM users u WHERE u.person_id = $1 AND u.role = ANY($2) AND u.removed_at IS NULL ORDER BY u.tenant_id`,
      [personId, SELLER_ROLES],
    );
  }

  async function request({ user }) {
    const personId = user.person_id;
    if (!personId) throw new ApiError('conflict', 'Sign in with a WhatsApp code or Google first, then ask again.');
    const { asked, accounts } = await db().tx(async (t) => {
      const [made] = await t.query(
        `INSERT INTO account_deletion_requests (person_id, due_at) VALUES ($1, now() + make_interval(days => $2::int))
         ON CONFLICT (person_id) WHERE status = 'requested' DO NOTHING RETURNING id, status, requested_at, due_at`,
        [personId, DELETION_GRACE_DAYS],
      );
      const [open] = made ? [made] : await t.query(`SELECT id, status, requested_at, due_at FROM account_deletion_requests WHERE person_id = $1 AND status = 'requested'`, [personId]);
      return { asked: open, accounts: await businessesOf(t, personId) };
    });
    const requestId = Number(asked.id);
    for (const account of accounts) {
      await withTenant(account.tenant_id, async () => {
        await ctx.db.tx((t) => writeAudit(t, {
          actor: `user:${account.user_id}`, action: 'account.deletion_requested', target: `user:${account.user_id}`,
          details: { requestId, dueAt: new Date(asked.due_at).toISOString(), soleOwner: account.sole_owner },
        }));
        await ctx.repos.alerts.raise({
          kind: 'account.deletion_requested',
          audience: 'ops',
          severity: account.sole_owner ? 'critical' : 'warning',
          message: account.sole_owner
            ? 'The only owner of this business asked to delete their account. Decide what happens to the business before the due date.'
            : 'A team member asked to delete their account. It is removed from the team on the due date.',
          target: `user:${account.user_id}`,
          dedupeKey: `account-deletion:${requestId}`,
        });
        // The person is told too, on the security channels (email, WhatsApp, in-app), in every business they work at.
        await ctx.notify?.emit({
          event: 'account.deletion_requested', tenantId: account.tenant_id, audience: { userId: Number(account.user_id) },
          key: `account-deletion:${requestId}`, data: { days: DELETION_GRACE_DAYS },
        });
      });
    }
    await db().tx(async (t) => {
      await revokeFamilies(t, { personId, reason: 'account_deleted' });
      await t.query(
        'UPDATE sessions s SET revoked_at = now() FROM users u WHERE u.tenant_id = s.tenant_id AND u.id = s.user_id AND u.person_id = $1 AND s.revoked_at IS NULL',
        [personId],
      );
      await dropPushDevices(t, { personId, reason: 'account_deleted' });
    });
    log.info('accounts.deletion_requested', { personId, requestId, businesses: accounts.length });
    return { status: asked.status, requestedAt: asked.requested_at, dueAt: asked.due_at };
  }

  /** Carries out the requests that are due. Returns how many. */
  async function carryOut({ limit = 20 } = {}) {
    let done = 0;
    for (let i = 0; i < limit; i++) {
      const finished = await db().tx(async (t) => {
        const [due] = await t.query(
          `SELECT id, person_id FROM account_deletion_requests WHERE status = 'requested' AND due_at <= now() ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (!due) return null;
        const personId = Number(due.person_id);
        const accounts = await businessesOf(t, personId);
        for (const account of accounts.filter((a) => !a.sole_owner)) {
          await t.query(
            `UPDATE users SET removed_at = now(), name = 'Deleted account', email = '', phone = $3 WHERE tenant_id = $1 AND id = $2`,
            [account.tenant_id, account.user_id, `deleted:${account.user_id}`],
          );
          await t.query('DELETE FROM memberships WHERE (tenant_id = $1 AND user_id = $2) OR (member_tenant_id = $1 AND member_user_id = $2)', [account.tenant_id, account.user_id]);
        }
        await revokeFamilies(t, { personId, reason: 'account_deleted' });
        await dropPushDevices(t, { personId, reason: 'account_deleted' });
        await t.query('DELETE FROM person_identities WHERE person_id = $1', [personId]);
        await t.query('DELETE FROM auth_devices WHERE person_id = $1', [personId]);
        await t.query(`UPDATE people SET name = '', deleted_at = now() WHERE id = $1`, [personId]);
        await t.query(`UPDATE account_deletion_requests SET status = 'completed', completed_at = now() WHERE id = $1`, [due.id]);
        return { requestId: Number(due.id), personId, accounts };
      });
      if (!finished) break;
      for (const account of finished.accounts) {
        await withTenant(account.tenant_id, () => ctx.db.tx((t) => writeAudit(t, {
          actor: 'system:accounts', action: account.sole_owner ? 'account.deletion_owner_kept' : 'account.deleted', target: `user:${account.user_id}`,
          details: { requestId: finished.requestId },
        })));
      }
      log.info('accounts.deletion_completed', { requestId: finished.requestId, personId: finished.personId });
      done++;
    }
    return done;
  }

  return { request, carryOut };
}
