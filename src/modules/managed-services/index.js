import { OPS_ROUTE_OWNERS } from '../../contracts/api/ops.js';
import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { maskSecrets } from '../../contracts/services.js';
import { tenantId } from '../../tenancy.js';
import { notBuilt, platformNotBuilt } from '../not-built.js';

const API = OPS_ROUTE_OWNERS['managed-services'];
const PLATFORM = OPS_PLATFORM_OWNERS['managed-services'];

/** What the API router asks on every request of a service operator's session (PRD 5.17). */
export function serviceSessionsRepo(db) {
  return {
    /**
     * The live session with this id in the current business, as req.session.operator, or null: ended, timed out, or the
     * business no longer has the service active (F-92: access ends at once, because this is read on every request).
     */
    async live(id) {
      const [row] = await db.query(
        `SELECT s.id, s.operator_id, s.operator_name, s.service, s.task_ref, s.expires_at, e.mode
         FROM service_sessions s
         JOIN service_engagements e ON e.tenant_id = s.tenant_id AND e.service = s.service
         WHERE s.tenant_id = $1 AND s.id = $2 AND s.ended_at IS NULL AND s.expires_at > now()
           AND e.active_from <= now() AND (e.active_to IS NULL OR e.active_to > now())`,
        [tenantId(), Number(id)],
      );
      if (!row) return null;
      return { kind: 'service', id: Number(row.id), operatorId: row.operator_id, operatorName: row.operator_name || 'Bhava team', service: row.service, taskRef: row.task_ref, mode: row.mode, expiresAt: row.expires_at };
    },
  };
}

/** The record of what Bhava's team changed. The router writes a row around every operator write; the feed and the console read them. */
export function serviceChangesRepo(db) {
  return {
    /**
     * One change by `operator` (req.session.operator). `before`, `after` and `request` are masked here whatever the caller
     * did, so a secret cannot reach the table. `runner` is a transaction when the row has to land with something else.
     * Returns the new id.
     */
    async record({ operator, routeId, target = '', request = {}, before = null, after = null, state }, runner = db) {
      if (!['applied', 'draft'].includes(state)) throw new Error('A new change is applied or a draft');
      const json = (value) => (value === null || value === undefined ? null : JSON.stringify(maskSecrets(value)));
      const [row] = await runner.query(
        `INSERT INTO service_changes (tenant_id, session_id, service, operator_id, task_ref, route_id, target, request, before, after, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [tenantId(), operator.id, operator.service, operator.operatorId, operator.taskRef, String(routeId), String(target).slice(0, 200), json(request) ?? '{}', json(before), json(after), state],
      );
      return Number(row.id);
    },
  };
}

/**
 * Managed services (PRD 5.17, F-90 to F-95): reel management, the backlog, merchandising, catalog management and the
 * monthly report, worked by service operators from the Platform Console. Which seller routes each service may call is
 * the route table's `service` field (SERVICE_ROUTES in src/contracts/api/ops.js); the API router refuses the rest and
 * records every write through serviceChanges. This module owns the engagements, sessions and changes, the seller's
 * "Done by Bhava team" feed with undo and approve, and the console's workspace.
 */
export const managedServices = {
  name: 'managed-services',
  owns: {
    migrations: [],
    tables: ['service_engagements', 'service_sessions', 'service_changes'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: [],
  },
  repos: (db) => ({ serviceSessions: serviceSessionsRepo(db), serviceChanges: serviceChangesRepo(db) }),
  api: () => notBuilt(...API),
  platformRoutes: (router) => platformNotBuilt(router, ...PLATFORM),
};
