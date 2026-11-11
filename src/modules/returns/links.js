import { tenantId } from '../../tenancy.js';

/**
 * Which return a refund is for (PRD 9.17, 9.8). The owner refunds a return through refunds.create with `returnId`; the
 * refunds table has no column for it, and the refunds service keeps it only in the refund's audit row
 * ('refund.request', details.returnId). So a refund is matched to its return here, in one place, by:
 *   1. the return that already names it (returns.refund_id), else
 *   2. the returnId in the refund's own audit row, when that return is of the same order and names no other live refund.
 * Anything else is no return: a refund the owner made from the order alone.
 *
 *   returnForRefund(t, refund) -> the return row or null       (refund: { id, order_id, created_at })
 */
export async function returnForRefund(t, refund) {
  const tid = tenantId();
  const [linked] = await t.query('SELECT * FROM returns WHERE tenant_id = $1 AND refund_id = $2 ORDER BY id LIMIT 1', [tid, refund.id]);
  if (linked) return linked;
  const wanted = await returnIdFromAudit(t, refund);
  if (!wanted) return null;
  const [ret] = await t.query('SELECT * FROM returns WHERE tenant_id = $1 AND id = $2 AND order_id = $3', [tid, wanted, refund.order_id]);
  if (!ret) return null;
  if (ret.refund_id && Number(ret.refund_id) !== Number(refund.id)) {
    const [other] = await t.query('SELECT status FROM refunds WHERE tenant_id = $1 AND id = $2', [tid, ret.refund_id]);
    if (other && other.status !== 'failed') return null;
  }
  return ret;
}

/** The returnId the owner gave with this refund, from its audit row (written in the refund's own transaction), or null. */
async function returnIdFromAudit(t, refund) {
  const rows = await t.query(
    `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'refund.request' AND target = $2
       AND created_at >= $3::timestamptz - interval '1 day' AND created_at <= $3::timestamptz + interval '1 day'
     ORDER BY id`,
    [tenantId(), `order:${refund.order_id}`, refund.created_at],
  );
  for (const { details } of rows) {
    if (Number(details?.refundId) !== Number(refund.id)) continue;
    const id = Number(details?.returnId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  return null;
}
