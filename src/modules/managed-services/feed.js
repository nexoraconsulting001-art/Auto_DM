import { ApiError, isAllowed, planOff, routes } from '../../contracts/api/index.js';
import { MASKED, SERVICES, SERVICE_SCOPES, canMoveChange, canUndoChange, maskSecrets, serviceFeature } from '../../contracts/services.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { runRoute } from '../api-v1/index.js';
import { writeAudit } from '../audit/index.js';
import { engagementsFor } from './engagements.js';

/**
 * The seller's side of managed services (PRD 5.17): the "Done by Bhava team" feed, undo, approve and reject, and the
 * per-service choice of direct or approve-first.
 *
 * Undo and approve run the change's route again as the seller, through runRoute, so every check the route makes runs at
 * that moment (the Compliance Engine for an automation, the plan, the thing still existing). The change is claimed in one
 * statement before its route runs: two undos, or an approve racing a reject, settle on one. If the route refuses, the
 * claim is put back, nothing is marked and the refusal is the answer.
 */

const toChange = (row) => ({
  id: Number(row.id),
  service: row.service,
  taskRef: row.task_ref,
  routeId: row.route_id,
  target: row.target ?? '',
  before: row.before ?? null,
  after: row.after ?? null,
  state: row.state,
  canUndo: canUndoChange(row) && !holdsMasked(row.before),
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? null,
  undoneAt: row.undone_at ?? null,
});

/** True when a value has a masked secret anywhere in it: such a value is never written back. */
function holdsMasked(value, depth = 0) {
  if (depth > 12) return true;
  if (value === MASKED) return true;
  if (Array.isArray(value)) return value.some((v) => holdsMasked(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).some((v) => holdsMasked(v, depth + 1));
  return false;
}

/** Path values as the router receives them: text. */
const asPath = (params) => Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]));

/**
 * What writes `before` back through `targetId`. A whole reel order is written as the order it was; any other route gets
 * the fields the operator's request set, at their values before it, so only what the team changed is put back.
 */
export function undoInput(change, targetId) {
  const before = change.before;
  if (!before || typeof before !== 'object') return null;
  if (targetId === 'categories.setReels') {
    if (!Array.isArray(before.items)) return null;
    const pinned = before.items.filter((i) => i.pinned).sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0)).map((i) => i.pageId);
    const order = before.items.filter((i) => !i.pinned).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((i) => i.pageId);
    return { pinned, order };
  }
  const sent = change.request?.body;
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return null;
  const body = {};
  for (const key of Object.keys(sent)) if (Object.hasOwn(before, key)) body[key] = before[key];
  return Object.keys(body).length ? body : null;
}

const decided = () => new ApiError('conflict', 'This change was already decided.');
const cannotUndo = (message) => new ApiError('service.cannot_undo', message);

export function teamFeedApi(ctx) {
  const db = () => ctx.db;
  const engagements = () => engagementsFor(ctx);

  /** The thing a write changes, through its `reads` route, as the seller. Null when there is none (removed, not built). */
  async function readThing(readsId, { params, query = {}, body = {} }, call) {
    const reads = readsId ? routes[readsId] : null;
    if (!reads) return null;
    let readQuery = {};
    if (reads.query) {
      const parsed = reads.query.safeParse({ ...query, ...body });
      readQuery = parsed.success ? parsed.data : {};
    }
    try {
      return await runRoute(ctx, readsId, { params: asPath(params), query: readQuery, body: {}, ...call });
    } catch (err) {
      if (['not_found', 'not_implemented', 'validation_failed'].includes(err?.code)) return null;
      throw err;
    }
  }

  /** The seller may do this route themselves: who they are, and the plan. runRoute checks neither. */
  async function sellerMay(route, user) {
    if (!route) throw cannotUndo('This change can’t be applied from here.');
    if (!isAllowed(user, route.access)) throw new ApiError('forbidden', route.access?.denied);
    if (route.feature) {
      let on = false;
      for (const name of [route.feature].flat()) on ||= await ctx.repos.entitlements.can(name);
      if (!on) throw planOff([route.feature].flat()[0]);
    }
  }

  async function findChange(id) {
    const [row] = await db().query('SELECT * FROM service_changes WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id)]);
    if (!row) throw new ApiError('not_found');
    return row;
  }

  /**
   * Moves a change from one of `from` to `to` in one statement and answers the row as it was, or null when somebody else
   * moved it first. The claim comes before the route runs, so two undos, or an approve racing a reject, settle on one, and
   * no route runs twice. No transaction is held open while the route runs (the route writes through its own connection).
   */
  async function claim(id, from, set, values) {
    const [row] = await db().query(
      `UPDATE service_changes SET ${set} WHERE tenant_id = $1 AND id = $2 AND state = ANY($3::text[]) RETURNING *`,
      [tenantId(), Number(id), from, ...values],
    );
    return row ?? null;
  }

  /** Puts a claimed change back as it was when its route refused: the refusal is the answer and nothing is marked. */
  async function release(id, row, set) {
    await db().query(`UPDATE service_changes SET ${set} WHERE tenant_id = $1 AND id = $2`, [tenantId(), Number(id), row.state]);
  }

  async function list(query) {
    const values = [tenantId()];
    const where = ['tenant_id = $1'];
    if (query.service) where.push(`service = $${values.push(query.service)}`);
    if (query.state) where.push(`state = $${values.push(query.state)}`);
    if (query.cursor && /^\d{1,18}$/.test(query.cursor)) where.push(`id < $${values.push(query.cursor)}`);
    const limit = query.limit ?? 25;
    const rows = await db().query(`SELECT * FROM service_changes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit + 1}`, values);
    const items = rows.slice(0, limit).map(toChange);
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  async function undo(id, call) {
    const { user } = call;
    const row = await findChange(id);
    if (!canMoveChange(row.state, 'undone')) throw cannotUndo(row.state === 'undone' ? 'This change was already undone.' : 'Only a change that was made can be undone.');
    if (!canUndoChange(row) || holdsMasked(row.before)) throw cannotUndo('Something the team created or removed is put right by hand.');
    const made = routes[row.route_id];
    const targetId = made?.undo ?? row.route_id;
    const target = routes[targetId];
    const input = undoInput(row, targetId);
    if (!input) throw cannotUndo('This change can’t be undone from here.');
    await sellerMay(target, user);
    const claimed = await claim(id, [row.state], `state = 'undone', undone_at = now(), undone_by = $4`, [`user:${user.id}`]);
    if (!claimed) throw cannotUndo('This change was already undone.');
    try {
      await runRoute(ctx, targetId, { params: asPath(row.request?.params), query: {}, body: input, ...call });
    } catch (err) {
      await release(id, row, `state = $3, undone_at = NULL, undone_by = ''`);
      throw err;
    }
    const after = await findChange(id);
    await writeAudit(db(), { actor: `user:${user.id}`, action: 'service.undo', target: row.route_id, details: { changeId: Number(row.id), service: row.service, routeId: row.route_id, via: targetId, id: row.target || undefined } });
    log.info('services.change_undone', { tenantId: tenantId(), changeId: Number(row.id), routeId: row.route_id });
    return toChange(after);
  }

  async function approve(id, call) {
    const { user } = call;
    const row = await findChange(id);
    if (!canMoveChange(row.state, 'approved')) throw decided();
    // A draft is applied only while the service still runs: one the seller approves after it lapsed is not applied.
    if (!(await ctx.repos.entitlements.can(serviceFeature(row.service)))) throw new ApiError('service.ended');
    const route = routes[row.route_id];
    await sellerMay(route, user);
    const claimed = await claim(id, ['draft'], `state = 'approved', decided_by = $4, decided_at = now()`, [`user:${user.id}`]);
    if (!claimed) throw decided();
    const request = row.request ?? {};
    const params = request.params ?? {};
    let before = null;
    let after = null;
    let output;
    try {
      // `before` is the thing just before it is applied now, so an undo afterwards puts back exactly that. The route runs
      // now, as the seller: every check it makes (the Compliance Engine for an automation) judges it as it is applied.
      before = await readThing(route.reads, { params, query: request.query, body: request.body }, call);
      output = await runRoute(ctx, row.route_id, { params: asPath(params), query: request.query ?? {}, body: request.body ?? {}, ...call });
    } catch (err) {
      await release(id, row, `state = $3, decided_by = '', decided_at = NULL`);
      throw err;
    }
    if (route.method !== 'DELETE') {
      const readParams = Object.keys(params).length ? params : output && typeof output === 'object' && output.id !== undefined ? { id: output.id } : {};
      after = (await readThing(route.reads, { params: readParams, query: request.query, body: request.body }, call).catch(() => null)) ?? output ?? null;
    }
    const json = (v) => (v === null || v === undefined ? null : JSON.stringify(maskSecrets(v)));
    const [saved] = await db().query(
      `UPDATE service_changes SET before = $3, after = $4, target = CASE WHEN target = '' THEN $5 ELSE target END
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId(), Number(id), json(before), json(after), output?.id !== undefined ? String(output.id).slice(0, 200) : ''],
    );
    await writeAudit(db(), { actor: `user:${user.id}`, action: 'service.approve', target: row.route_id, details: { changeId: Number(row.id), service: row.service, routeId: row.route_id } });
    return toChange(saved);
  }

  async function reject(id, { user }) {
    const row = await findChange(id);
    if (!canMoveChange(row.state, 'rejected')) throw decided();
    const saved = await claim(id, ['draft'], `state = 'rejected', decided_by = $4, decided_at = now()`, [`user:${user.id}`]);
    if (!saved) throw decided();
    await writeAudit(db(), { actor: `user:${user.id}`, action: 'service.reject', target: row.route_id, details: { changeId: Number(row.id), service: row.service, routeId: row.route_id } });
    return toChange(saved);
  }

  async function settings() {
    const e = engagements();
    const items = [];
    for (const service of SERVICES) {
      const on = await e.entitled(service);
      let row = await e.current(service);
      if (on !== e.isActive(row) && (on || row)) row = (await e.sync(service)).row;
      items.push({ service, scope: SERVICE_SCOPES[service], active: on && e.isActive(row), mode: row?.mode ?? 'direct', activeFrom: row?.active_from ?? null, activeTo: row?.active_to ?? null });
    }
    return { items };
  }

  async function saveSettings(body, user) {
    const e = engagements();
    if (!(await e.entitled(body.service))) throw new ApiError('service.ended', 'This service isn’t active for your business.');
    await e.sync(body.service);
    const before = await e.current(body.service);
    await e.setMode(body.service, body.mode);
    if (before?.mode !== body.mode) await writeAudit(db(), { actor: `user:${user.id}`, action: 'service.mode_changed', target: body.service, details: { service: body.service, from: before?.mode ?? 'direct', to: body.mode } });
    return settings();
  }

  return {
    'teamFeed.list': ({ query }) => list(query),
    'teamFeed.undo': ({ params, user, req, res }) => undo(params.id, { user, req, res }),
    'teamFeed.approve': ({ params, user, req, res }) => approve(params.id, { user, req, res }),
    'teamFeed.reject': ({ params, user }) => reject(params.id, { user }),
    'services.settings': () => settings(),
    'services.saveSettings': ({ body, user }) => saveSettings(body, user),
  };
}
