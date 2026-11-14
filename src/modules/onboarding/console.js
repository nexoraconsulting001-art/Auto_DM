import { ApiError } from '../../contracts/api/index.js';
import { OPERATOR_STEPS, stepsFor } from '../../contracts/onboarding.js';
import { log } from '../../platform/log.js';
import { asBusiness, mountPlatform } from '../app-config/index.js';
import { createChecklist } from './checklist.js';
import { createInvites, inviteStateOf } from './invites.js';

/**
 * The Platform Console's onboarding workspace (PRD 5.6): the list of businesses being set up, one business's checklist,
 * invite and the operator's active time, and the invite itself. The checklist is the business's own, read inside it.
 *
 * Active time (F-31): the console reports each piece of work with its clock span. The server never counts more than the
 * span, and for one step never more than the union of its spans, so the same minutes reported twice, or an hour claimed for
 * a minute, are not counted.
 */
const operatorIdOf = (actor) => Number(String(actor).split(':')[1]) || 0;

/** Active ms per step: each row capped at its own span, then the step capped at the union of its spans. */
export function activeTimes(rows) {
  const byStep = new Map();
  for (const r of rows) {
    const start = new Date(r.started_at).getTime();
    const end = new Date(r.ended_at).getTime();
    const span = Math.max(0, end - start);
    const entry = byStep.get(r.step) ?? { claimed: 0, spans: [] };
    entry.claimed += Math.min(Number(r.active_ms) || 0, span);
    entry.spans.push([start, end]);
    byStep.set(r.step, entry);
  }
  const timings = [];
  for (const step of OPERATOR_STEPS) {
    const entry = byStep.get(step);
    if (!entry) continue;
    const spans = entry.spans.sort((a, b) => a[0] - b[0]);
    let union = 0;
    let [curStart, curEnd] = spans[0];
    for (const [s, e] of spans.slice(1)) {
      if (s <= curEnd) curEnd = Math.max(curEnd, e);
      else {
        union += curEnd - curStart;
        [curStart, curEnd] = [s, e];
      }
    }
    union += curEnd - curStart;
    timings.push({ step, activeMs: Math.min(entry.claimed, union) });
  }
  return { timings, activeMs: timings.reduce((sum, t) => sum + t.activeMs, 0) };
}

export function onboardingConsoleRoutes(router, ctx) {
  const platformDb = ctx.db.platform ?? ctx.db;
  const invites = createInvites(ctx);
  let checklist;
  const list = () => (checklist ??= createChecklist(ctx));

  const timingsOf = async (tenantIdValue) => activeTimes(await platformDb.query('SELECT step, active_ms, started_at, ended_at FROM onboarding_timings WHERE tenant_id = $1', [tenantIdValue]));

  async function workspace(tenant, { run = false } = {}) {
    if (run) await list().run();
    const view = await list().view();
    const invite = await invites.latest(tenant.id);
    const { timings, activeMs } = await timingsOf(tenant.id);
    return { tenantId: Number(tenant.id), tenantName: tenant.name, ...view, invite: invite ? invites.toInvite(invite) : null, timings, activeMs };
  }

  mountPlatform(router, 'platform.onboardingList', async ({ query }) => {
    // The businesses with onboarding under way or done: an invite, a checked step or logged time, or still being set up.
    const candidates = await platformDb.query(
      `SELECT t.id, t.name, t.plan FROM tenants t
       WHERE t.status = 'onboarding' OR EXISTS (SELECT 1 FROM onboarding_invites i WHERE i.tenant_id = t.id)
          OR EXISTS (SELECT 1 FROM onboarding_steps s WHERE s.tenant_id = t.id) OR EXISTS (SELECT 1 FROM onboarding_timings o WHERE o.tenant_id = t.id)
       ORDER BY t.id DESC LIMIT 1000`,
    );
    const ids = candidates.map((c) => c.id);
    const steps = ids.length ? await platformDb.query('SELECT tenant_id, step, status FROM onboarding_steps WHERE tenant_id = ANY($1::int[])', [ids]) : [];
    const timings = ids.length ? await platformDb.query('SELECT tenant_id, step, active_ms, started_at, ended_at FROM onboarding_timings WHERE tenant_id = ANY($1::int[])', [ids]) : [];
    const latest = ids.length ? await platformDb.query('SELECT DISTINCT ON (tenant_id) * FROM onboarding_invites WHERE tenant_id = ANY($1::int[]) ORDER BY tenant_id, id DESC', [ids]) : [];
    const items = candidates.map((c) => {
      const statuses = Object.fromEntries(steps.filter((s) => s.tenant_id === c.id).map((s) => [s.step, s.status]));
      const visible = stepsFor(c.plan);
      const required = visible.filter((s) => s.required);
      const doneCount = required.filter((s) => statuses[s.step] === 'done').length;
      return {
        tenantId: Number(c.id), tenantName: c.name, plan: c.plan, done: doneCount === required.length, stepsDone: doneCount, stepsRequired: required.length,
        inviteState: inviteStateOf(latest.find((i) => i.tenant_id === c.id)), activeMs: activeTimes(timings.filter((r) => r.tenant_id === c.id)).activeMs,
      };
    }).filter((i) => (query.done === undefined ? true : String(i.done) === query.done));
    const after = query.cursor && /^\d{1,10}$/.test(query.cursor) ? Number(query.cursor) : null;
    const from = after === null ? items : items.filter((i) => i.tenantId < after);
    const pageItems = from.slice(0, query.limit);
    return { items: pageItems, nextCursor: from.length > query.limit ? String(pageItems[pageItems.length - 1].tenantId) : null };
  });

  mountPlatform(router, 'platform.onboarding', ({ params }) => asBusiness(ctx, params.id, (tenant) => workspace(tenant)));

  mountPlatform(router, 'platform.checkOnboarding', ({ params }) => asBusiness(ctx, params.id, (tenant) => workspace(tenant, { run: true })));

  mountPlatform(router, 'platform.sendOnboardingInvite', ({ params, body, actor }) => asBusiness(ctx, params.id, async (tenant) => {
    if (['closed', 'killed'].includes(tenant.status)) throw new ApiError('conflict', 'This business is closed.');
    // The owner gets the address from the operator. Sending it by WhatsApp or email needs a notification event of its own,
    // which the notifications contract does not have yet; `via` is recorded.
    return invites.send(tenant, { operatorId: operatorIdOf(actor), actor, via: body.via ?? [] });
  }));

  mountPlatform(router, 'platform.revokeOnboardingInvite', ({ params, actor }) => asBusiness(ctx, params.id, (tenant) => invites.revoke(tenant, { actor })));

  mountPlatform(router, 'platform.recordOnboardingTime', ({ params, body, actor }) => asBusiness(ctx, params.id, async (tenant) => {
    const start = new Date(body.startedAt).getTime();
    const end = new Date(body.endedAt).getTime();
    if (!(end >= start)) throw new ApiError('validation_failed', 'The end must not be before the start.', { fields: { endedAt: 'The end must not be before the start' } });
    if (end > Date.now() + 60_000) throw new ApiError('validation_failed', 'That time is in the future.', { fields: { endedAt: 'That time is in the future' } });
    const activeMs = Math.min(body.activeMs, end - start);
    await platformDb.query(
      'INSERT INTO onboarding_timings (tenant_id, operator_id, step, active_ms, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [tenant.id, operatorIdOf(actor), body.step, activeMs, new Date(start), new Date(end)],
    );
    log.info('onboarding.time_logged', { tenantId: Number(tenant.id), step: body.step, activeMs });
  }));
}
