import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { tenantId } from '../../tenancy.js';
import { platformNotBuilt } from '../not-built.js';

const PLATFORM = OPS_PLATFORM_OWNERS.impersonation;

/**
 * What the API router asks on every request of an impersonated session (PRD 5.10). Read inside the business: the row is
 * fenced, and business code can only read it. Starting, confirming write mode and ending are the platform's, through
 * db.platform, in the Platform Console routes this module mounts.
 */
export function impersonationRepo(db) {
  return {
    /** The live session with this id in the current business, as req.session.operator, or null once it ended or its 30 minutes are up. */
    async live(id) {
      const [row] = await db.query(
        `SELECT i.id, i.operator_id, i.operator_name, i.owner_user_id, i.mode, i.expires_at
         FROM impersonation_sessions i
         WHERE i.tenant_id = $1 AND i.id = $2 AND i.ended_at IS NULL AND i.expires_at > now()`,
        [tenantId(), Number(id)],
      );
      if (!row) return null;
      return { kind: 'impersonation', id: Number(row.id), operatorId: row.operator_id, operatorName: row.operator_name || 'Bhava support', ownerId: row.owner_user_id, mode: row.mode, service: null, taskRef: null, expiresAt: row.expires_at };
    },
  };
}

/**
 * Impersonation (PRD 5.10, F-42 to F-45): support opens a business as its owner, read-only unless confirmed, for at most
 * 30 minutes, with every request on the audit log under both ids. The rules are data (IMPERSONATION_BLOCKED,
 * SHOPPER_CONTACT_FIELDS and operatorRefusal in src/contracts/api/access.js) and the API router applies them; this
 * module owns the table, the console routes and the address that opens the session on the business's host.
 */
export const impersonation = {
  name: 'impersonation',
  owns: {
    migrations: [],
    tables: ['impersonation_sessions'],
    api: [],
    store: [],
    platform: PLATFORM,
    jobs: [],
  },
  repos: (db) => ({ impersonation: impersonationRepo(db) }),
  platformRoutes: (router) => platformNotBuilt(router, ...PLATFORM),
};
