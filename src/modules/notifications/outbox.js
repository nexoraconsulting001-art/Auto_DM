import { NOTIFY_AUDIENCES, NOTIFY_CHANNELS, NOTIFY_EVENTS, NOTIFY_RULES, dataProblem, isLinkPath, isReservedKind, linkFor } from '../../contracts/notifications.js';
import { currentTenant } from '../../tenancy.js';

/**
 * The outbox row, and the checks every caller of emit() is held to. Shared by emit() and by the sources the module drains
 * (alerts, report deliveries), so both write the same row the same way.
 */

/** Throws on a kind, audience, key, data or link that breaks the rules: those are bugs in the caller, not events to drop quietly. */
export function checkEvent({ event, tenantId: forTenant, audience, key, data = {}, link, channels }, { anyBusiness = false } = {}) {
  const spec = NOTIFY_EVENTS[event];
  if (!spec) throw new Error(isReservedKind(event) ? `"${event}" is kept for a later phase: add its row to NOTIFY_EVENTS first` : `"${event}" is not a notification kind (src/contracts/notifications.js)`);
  if (!Number.isInteger(forTenant) || forTenant <= 0) throw new Error('emit() names the business: tenantId');
  const current = anyBusiness ? null : currentTenant()?.id;
  if (current && current !== forTenant) throw new Error('emit() can only notify the current business');
  const to = audience ?? spec.audience;
  const one = typeof to === 'object' && to !== null && Object.keys(to).length === 1 && Number.isInteger(to.userId) && to.userId > 0;
  if (!one && !NOTIFY_AUDIENCES.includes(to)) throw new Error(`An audience is one of ${NOTIFY_AUDIENCES.join(', ')}, or { userId }`);
  if (typeof key !== 'string' || !key || key.length > 120) throw new Error('emit() needs a key that says what happened, such as "order:12"');
  const problem = dataProblem(data);
  if (problem) throw new Error(`Notification data is ids and numbers only: ${problem}`);
  const path = link ?? linkFor(event, data);
  if (!isLinkPath(path)) throw new Error('A notification link is a path, such as /orders/12');
  if (channels !== undefined && (!Array.isArray(channels) || !channels.length || !channels.every((c) => NOTIFY_CHANNELS.includes(c)))) throw new Error(`channels is a list from ${NOTIFY_CHANNELS.join(', ')}`);
  return { kind: event, forTenant, audience: to, key, data, path, channels: channels ? [...new Set(channels)] : null };
}

/**
 * Writes one outbox row on `q` (a transaction or a handle). Returns its id, or null for a repeat inside dedupeMs.
 * A key older than the window is freed first: what happened then is done, and this is something new. Two writers racing on
 * one key meet at the partial unique index, so exactly one row is live whatever the timing.
 */
export async function writeEvent(q, event) {
  await q.query(
    `UPDATE notification_events SET live = false WHERE tenant_id = $1 AND kind = $2 AND event_key = $3 AND live AND created_at < now() - make_interval(secs => $4::float)`,
    [event.forTenant, event.kind, event.key, NOTIFY_RULES.dedupeMs / 1000],
  );
  const [row] = await q.query(
    `INSERT INTO notification_events (tenant_id, kind, event_key, audience, channels, data, link) VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6::jsonb, $7)
     ON CONFLICT (tenant_id, kind, event_key) WHERE live DO NOTHING RETURNING id`,
    [event.forTenant, event.kind, event.key, JSON.stringify(event.audience), event.channels, JSON.stringify(event.data), event.path],
  );
  return row ? Number(row.id) : null;
}
