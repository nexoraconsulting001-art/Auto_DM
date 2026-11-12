import { ApiError, isReadMethod, operatorRefusal, routes } from '../../contracts/api/index.js';
import { serviceFeature } from '../../contracts/services.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * Sessions Bhava's team opened inside a business (PRD 5.10 impersonation, 5.17 managed services). Such a session is the
 * owner's account plus a reference to what it was opened for (req.session.operatorRef, from migration 730's two columns
 * on sessions). Everything here runs in the API router, before any handler, so no module can forget a rule:
 *
 *   - the impersonation or the service session is read on every request: ended, timed out, or (for a service) lapsed
 *     for the business, and the request is 401 or 403 at once
 *   - the rules of src/contracts/api/access.js are applied: read-only, IMPERSONATION_BLOCKED, the route's `service`
 *   - an impersonated request is on the audit log with the operator's id and the owner's
 *   - a service operator's write is recorded with what it changed before and after, or kept as a draft
 */

/** Loads req.session.operator, or refuses. A session of theirs never works in another business, whatever X-Tenant-Id asks. */
export function operatorSession({ repos }) {
  return async (req, _res, next) => {
    const ref = req.session?.operatorRef;
    if (!ref) return next();
    const wanted = req.get('x-tenant-id');
    if (wanted !== undefined && wanted !== String(tenantId())) throw new ApiError('forbidden');
    const operator = ref.impersonationId !== null && ref.impersonationId !== undefined
      ? await repos.impersonation?.live(ref.impersonationId)
      : await repos.serviceSessions?.live(ref.serviceSessionId);
    if (!operator || !req.user || (operator.kind === 'impersonation' && operator.ownerId !== req.user.id)) {
      log.warn('api.operator_session_ended', { impersonationId: ref.impersonationId ?? null, serviceSessionId: ref.serviceSessionId ?? null });
      throw new ApiError('unauthorized', 'This session has ended. Go back to the console to start another.');
    }
    req.session.operator = operator;
    return next();
  };
}

/** Throws the refusal for this route and this operator, if there is one. Before access, the plan and the input. */
export async function checkOperator(route, req, { repos }) {
  const operator = req.session?.operator;
  if (!operator) return;
  const refusal = operatorRefusal(route, operator);
  if (refusal) {
    log.warn('api.operator_refused', { route: route.id, code: refusal.code, operatorId: operator.operatorId, kind: operator.kind });
    throw new ApiError(refusal.code, refusal.message);
  }
  // The service is paid for month by month: without its entitlement today, nothing of it may be done (F-92).
  if (operator.kind === 'service' && route.service && repos.entitlements && !(await repos.entitlements.can(serviceFeature(operator.service)))) throw new ApiError('service.ended');
}

/** One audit row for an impersonated request, with both ids (PRD 5.10). Never fails the request it describes. */
export async function auditImpersonated(route, req, status, { repos }) {
  const operator = req.session?.operator;
  if (operator?.kind !== 'impersonation') return;
  const target = /^\d{1,40}$/.test(req.params?.id ?? '') ? req.params.id : undefined;
  await repos.audit
    .record({ actor: `platform:${operator.operatorId}`, action: 'impersonation.request', target: route.id, details: { impersonationId: operator.id, operatorId: operator.operatorId, ownerId: operator.ownerId, mode: operator.mode, method: route.method, status, id: target } })
    .catch((err) => reportError(err, { msg: 'impersonation.audit_failed', route: route.id }));
}

const parsed = (schema, value) => {
  if (!schema) return {};
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
};

/**
 * What a write changes, through the route its `reads` names: called with the write's own path values, and with the
 * read route's query taken from the write's query and body. null when there is nothing there (a create, something
 * already removed) or the read route is not built.
 */
async function readThing(route, handlers, { pathValues, query, body, user, req, res }) {
  const reads = routes[route.reads];
  const read = handlers.get(route.reads);
  if (!reads || !read) return null;
  const params = parsed(reads.params, pathValues);
  if (params === null) return null;
  const readQuery = parsed(reads.query, { ...query, ...body }) ?? parsed(reads.query, {}) ?? {};
  try {
    const result = await read({ params, query: readQuery, body: {}, user, req, res });
    if (result === null || result === undefined) return null;
    const output = reads.response.safeParse(result);
    return output.success ? output.data : null;
  } catch (err) {
    if (err?.code === 'not_found') return null;
    throw err;
  }
}

/**
 * A service operator's write (PRD 5.17). `apply()` runs the route's handler and answers its parsed output.
 *   approve_first  nothing runs: the request is kept as a draft with the thing as it stands, and the answer is 202 { draft, changeId }
 *   direct         before is read, the handler runs, after is read, and the change is recorded as applied
 * Either way the audit log gets a row naming the operator, the service, the task and the change.
 * Returns { draft, changeId, output }.
 */
export async function serviceWrite(route, handlers, ctx, { params, query, body, user, req, res }, apply) {
  const { repos } = ctx;
  const operator = req.session.operator;
  const reading = { query, body, user, req, res };
  const before = await readThing(route, handlers, { ...reading, pathValues: req.params });
  const target = params.id !== undefined ? String(params.id) : '';
  const request = { params, query, body };
  const audit = (changeId, state) => repos.audit.record({ actor: `platform:${operator.operatorId}`, action: 'service.change', target: route.id, details: { changeId, state, operatorId: operator.operatorId, service: operator.service, taskRef: operator.taskRef, sessionId: operator.id, id: target || undefined } });

  if (operator.mode === 'approve_first') {
    const changeId = await repos.serviceChanges.record({ operator, routeId: route.id, target, request, before, after: null, state: 'draft' });
    await audit(changeId, 'draft');
    return { draft: true, changeId, output: null };
  }

  const output = await apply();
  let after = null;
  if (route.method !== 'DELETE') {
    const made = output && typeof output === 'object' && output.id !== undefined ? { id: String(output.id) } : null;
    after = (await readThing(route, handlers, { ...reading, pathValues: Object.keys(req.params).length ? req.params : made ?? {} })) ?? output ?? null;
  }
  const changeId = await repos.serviceChanges.record({ operator, routeId: route.id, target: target || (output?.id !== undefined ? String(output.id) : ''), request, before, after, state: 'applied' });
  await audit(changeId, 'applied');
  return { draft: false, changeId, output };
}

export const isOperatorWrite = (route, req) => req.session?.operator?.kind === 'service' && !isReadMethod(route.method) && Boolean(route.service);
