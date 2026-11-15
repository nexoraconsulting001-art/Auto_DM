/**
 * After traffic: was every webhook the app answered 200 stored, was each handled, and did any message go out twice.
 * Read from the database (as the platform) and from the Meta simulator's own record of what it received.
 */
import { sleep } from './http.mjs';

const CHUNK = 4000;

/** Waits until nothing is waiting to be handled (for the businesses in `tenantIds`, or all), or `ms` passes. Answers true when it drained. */
export async function waitDrained(world, { ms = 90_000, tenantIds = null, sends = true } = {}) {
  const end = Date.now() + ms;
  const own = tenantIds ? 'AND tenant_id = ANY($1::int[])' : '';
  const params = tenantIds ? [tenantIds] : [];
  for (;;) {
    const [{ n }] = await world.db.platform.query(
      `SELECT (SELECT count(*) FROM inbound_events WHERE status IN ('stored', 'processing') ${own})
            + ${sends ? `(SELECT count(*) FROM outbound_jobs WHERE status IN ('queued', 'sending') ${own})` : '0'} AS n`,
      params,
    );
    if (Number(n) === 0) return true;
    if (Date.now() > end) return false;
    await sleep(500);
  }
}

/**
 * `accepted` is [{ id, field, tenantId }]: what was answered 200. Answers
 *   { accepted, stored, lost, unhandled, duplicateSends, sentByPrivateReply, ... }
 * lost: answered 200 but no stored row. unhandled: stored but not done after the wait. duplicateSends: a comment (or message)
 * that Meta's simulator recorded as delivered more than once, plus any comment with two sent jobs.
 */
export async function verifyWebhooks(world, accepted) {
  const platform = world.db.platform;
  const found = new Map();
  for (let i = 0; i < accepted.length; i += CHUNK) {
    const ids = accepted.slice(i, i + CHUNK).map((a) => a.id);
    const rows = await platform.query('SELECT tenant_id, field, object_id, status FROM inbound_events WHERE object_id = ANY($1::text[])', [ids]);
    for (const row of rows) found.set(`${row.tenant_id}|${row.field}|${row.object_id}`, row.status);
  }
  let lost = 0;
  let unhandled = 0;
  const lostSample = [];
  const unhandledByStatus = {};
  for (const a of accepted) {
    const status = found.get(`${a.tenantId}|${a.field}|${a.id}`);
    if (status === undefined) {
      lost++;
      if (lostSample.length < 5) lostSample.push(a.id);
    } else if (status !== 'done') {
      unhandled++;
      unhandledByStatus[status] = (unhandledByStatus[status] ?? 0) + 1;
    }
  }
  const { sent } = await world.meta.get('/sent');
  const perComment = new Map();
  for (const m of sent) {
    if (!m.commentId) continue;
    const key = `${m.igUserId}|${m.commentId}|${m.kind}`;
    perComment.set(key, (perComment.get(key) ?? 0) + 1);
  }
  const twiceAtMeta = [...perComment.values()].filter((n) => n > 1).length;
  const [{ twice }] = await platform.query(
    `SELECT count(*)::int AS twice FROM (SELECT 1 FROM outbound_jobs WHERE comment_id <> '' AND kind = 'private_reply' AND status IN ('sent', 'sent_fallback') GROUP BY tenant_id, comment_id HAVING count(*) > 1) x`,
  );
  const statuses = await platform.query(`SELECT status, count(*)::int AS n FROM outbound_jobs GROUP BY status ORDER BY status`);
  return {
    accepted: accepted.length,
    stored: accepted.length - lost,
    lost,
    lostSample,
    unhandled,
    unhandledByStatus,
    duplicateSends: twiceAtMeta + twice,
    sentAtMeta: sent.length,
    jobStatuses: Object.fromEntries(statuses.map((r) => [r.status, r.n])),
  };
}

/** Seconds from a comment's arrival to its DM, for the DMs of `tenantIds` whose comment arrived at or after `since` (a Date). */
export async function sendDelays(world, { tenantIds, since }) {
  const rows = await world.db.platform.query(
    `SELECT EXTRACT(EPOCH FROM (j.sent_at - e.received_at))::float AS delay
       FROM outbound_jobs j JOIN inbound_events e ON e.tenant_id = j.tenant_id AND e.field = 'comments' AND e.object_id = j.comment_id
      WHERE j.tenant_id = ANY($1::int[]) AND j.kind = 'private_reply' AND j.status IN ('sent', 'sent_fallback') AND j.sent_at IS NOT NULL AND e.received_at >= $2`,
    [tenantIds, since],
  );
  return rows.map((r) => Number(r.delay));
}

/** How many of the worker's own jobs (insights polls and the rest) finished, by queue: shows the background work ran under load. */
export async function backgroundJobs(world) {
  const rows = await world.db.platform.query(`SELECT queue, status, count(*)::int AS n FROM jobs GROUP BY queue, status ORDER BY queue, status`);
  const out = {};
  for (const r of rows) (out[r.queue] ??= {})[r.status] = r.n;
  return out;
}
