import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { asBusiness, mountPlatform } from '../app-config/index.js';
import { writeAudit } from '../audit/index.js';
import { engagementsFor } from './engagements.js';
import { ENTRY_PATH, businessOrigin, entryToken } from './entry.js';

/**
 * The Platform Console's managed-services workspace (PRD 5.17): the engagements, the sessions and every change the team
 * made, across businesses. A session needs a task reference and a service the business has today; it opens the
 * business's console through a one-time address (entry.js). Ending it ends the seller session it opened at once.
 */
const operatorIdOf = (actor) => Number(String(actor).split(':')[1]) || 0;
const cursorOf = (query) => (query.cursor && /^\d{1,18}$/.test(query.cursor) ? query.cursor : null);
const pageOf = (rows, limit, map) => {
  const items = rows.slice(0, limit).map(map);
  return { items, nextCursor: rows.length > limit ? String(items[items.length - 1].id ?? items[items.length - 1].tenantId) : null };
};

const toSession = (r) => ({
  id: Number(r.id), tenantId: Number(r.tenant_id), tenantName: r.tenant_name ?? '', operatorId: Number(r.operator_id), operatorName: r.operator_name || 'Bhava team',
  service: r.service, taskRef: r.task_ref, mode: r.mode ?? 'direct', startedAt: r.started_at, expiresAt: r.expires_at, endedAt: r.ended_at ?? null,
});

export function serviceConsoleRoutes(router, ctx) {
  const platformDb = ctx.db.platform ?? ctx.db;

  mountPlatform(router, 'platform.services', async ({ query }) => {
    const values = [];
    const where = ['true'];
    if (query.service) where.push(`e.service = $${values.push(query.service)}`);
    if (query.tenantId) where.push(`e.tenant_id = $${values.push(query.tenantId)}`);
    if (query.active === 'true') where.push('e.active_from <= now() AND (e.active_to IS NULL OR e.active_to > now())');
    if (query.active === 'false') where.push('NOT (e.active_from <= now() AND (e.active_to IS NULL OR e.active_to > now()))');
    const cursor = cursorOf(query);
    if (cursor) where.push(`e.id < $${values.push(cursor)}`);
    const rows = await platformDb.query(
      `SELECT e.*, t.name AS tenant_name, (e.active_from <= now() AND (e.active_to IS NULL OR e.active_to > now())) AS active,
         (SELECT count(*)::int FROM service_changes c WHERE c.tenant_id = e.tenant_id AND c.service = e.service AND c.created_at >= date_trunc('month', now())) AS changes
       FROM service_engagements e JOIN tenants t ON t.id = e.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ${query.limit + 1}`,
      values,
    );
    const page = pageOf(rows, query.limit, (r) => ({ id: Number(r.id), tenantId: Number(r.tenant_id), tenantName: r.tenant_name, service: r.service, mode: r.mode, active: r.active, activeFrom: r.active_from, activeTo: r.active_to, changesThisMonth: r.changes }));
    return { items: page.items.map(({ id: _id, ...rest }) => rest), nextCursor: page.nextCursor };
  });

  const sessionSelect = `SELECT s.*, t.name AS tenant_name, e.mode FROM service_sessions s JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN service_engagements e ON e.tenant_id = s.tenant_id AND e.service = s.service`;

  mountPlatform(router, 'platform.serviceSessions', async ({ query }) => {
    const values = [];
    const where = ['true'];
    if (query.service) where.push(`s.service = $${values.push(query.service)}`);
    if (query.tenantId) where.push(`s.tenant_id = $${values.push(query.tenantId)}`);
    if (query.active === 'true') where.push('s.ended_at IS NULL AND s.expires_at > now()');
    if (query.active === 'false') where.push('(s.ended_at IS NOT NULL OR s.expires_at <= now())');
    const cursor = cursorOf(query);
    if (cursor) where.push(`s.id < $${values.push(cursor)}`);
    const rows = await platformDb.query(`${sessionSelect} WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ${query.limit + 1}`, values);
    return pageOf(rows, query.limit, toSession);
  });

  mountPlatform(router, 'platform.startServiceSession', async ({ params, body, actor }) => asBusiness(ctx, params.id, async (tenant) => {
    const operatorId = operatorIdOf(actor);
    const engagements = engagementsFor(ctx);
    const { active } = await engagements.sync(body.service);
    if (!active) {
      log.warn('services.session_refused', { tenantId: tenantId(), operatorId, service: body.service });
      throw new ApiError('service.ended');
    }
    const [operator] = await platformDb.query('SELECT name FROM platform_users WHERE id = $1', [operatorId]);
    const [owner] = await platformDb.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [tenantId()]);
    if (!owner) throw new ApiError('conflict', 'This business has no owner account to work in.');
    const session = await platformDb.tx(async (t) => {
      const [row] = await t.query(
        `INSERT INTO service_sessions (tenant_id, operator_id, operator_name, service, task_ref) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [tenantId(), operatorId, String(operator?.name || 'Bhava team').slice(0, 80), body.service, body.taskRef.trim()],
      );
      await writeAudit(t, { actor, action: 'service.session_started', target: body.service, details: { serviceSessionId: Number(row.id), operatorId, service: body.service, taskRef: row.task_ref } });
      return row;
    });
    const [full] = await platformDb.query(`${sessionSelect} WHERE s.id = $1`, [session.id]);
    const origin = await businessOrigin(platformDb, tenant, ctx.config);
    log.info('services.session_started', { tenantId: tenantId(), serviceSessionId: Number(session.id), operatorId, service: body.service });
    return { url: `${origin}${ENTRY_PATH}?t=${entryToken(ctx.config, session.id)}`, session: toSession(full) };
  }));

  mountPlatform(router, 'platform.endServiceSession', async ({ params, actor }) => {
    const operatorId = operatorIdOf(actor);
    const [me] = await platformDb.query('SELECT role FROM platform_users WHERE id = $1', [operatorId]);
    const [found] = await platformDb.query('SELECT tenant_id, operator_id FROM service_sessions WHERE id = $1', [params.id]);
    if (!found) return null;
    // An operator ends their own sessions; a super admin any.
    if (Number(found.operator_id) !== operatorId && me?.role !== 'super_admin') throw new ApiError('forbidden');
    await platformDb.tx(async (t) => {
      const [ended] = await t.query('UPDATE service_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING id', [params.id]);
      await t.query('UPDATE sessions SET expires_at = now() WHERE tenant_id = $1 AND service_session_id = $2 AND expires_at > now()', [found.tenant_id, params.id]);
      if (ended) {
        await t.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [found.tenant_id, actor, 'service.session_ended', 'service_session', JSON.stringify({ serviceSessionId: Number(params.id), operatorId })]);
      }
    });
    const [row] = await platformDb.query(`${sessionSelect} WHERE s.id = $1`, [params.id]);
    return toSession(row);
  });

  mountPlatform(router, 'platform.serviceChanges', async ({ query }) => {
    const values = [];
    const where = ['true'];
    if (query.service) where.push(`c.service = $${values.push(query.service)}`);
    if (query.tenantId) where.push(`c.tenant_id = $${values.push(query.tenantId)}`);
    if (query.sessionId) where.push(`c.session_id = $${values.push(query.sessionId)}`);
    if (query.state) where.push(`c.state = $${values.push(query.state)}`);
    if (query.month) where.push(`c.created_at >= ($${values.push(`${query.month}-01`)})::date AND c.created_at < ($${values.length})::date + interval '1 month'`);
    const cursor = cursorOf(query);
    if (cursor) where.push(`c.id < $${values.push(cursor)}`);
    const rows = await platformDb.query(
      `SELECT c.*, s.operator_name FROM service_changes c JOIN service_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
       WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ${query.limit + 1}`,
      values,
    );
    return pageOf(rows, query.limit, (r) => ({
      id: Number(r.id), tenantId: Number(r.tenant_id), sessionId: Number(r.session_id), service: r.service, operatorName: r.operator_name || 'Bhava team', taskRef: r.task_ref,
      routeId: r.route_id, target: r.target, before: r.before ?? null, after: r.after ?? null, state: r.state, undoneBy: r.undone_by ?? '', createdAt: r.created_at,
    }));
  });
}
