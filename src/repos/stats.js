import { tenantId } from '../tenancy.js';

const PAID = `('paid', 'shipped', 'delivered')`;

export function statsRepo(db) {
  return {
    async dashboard() {
      const [s] = await db.query(`
        SELECT
          (SELECT count(*)::int FROM activity WHERE tenant_id = $1 AND result = 'sent') AS dms,
          (SELECT count(*)::int FROM activity WHERE tenant_id = $1 AND result = 'sent' AND created_at >= date_trunc('day', now())) AS dms_today,
          (SELECT count(*)::int FROM visits WHERE tenant_id = $1) AS visits,
          (SELECT count(*)::int FROM visits WHERE tenant_id = $1 AND created_at >= date_trunc('day', now())) AS visits_today,
          (SELECT count(*)::int FROM orders WHERE tenant_id = $1 AND status <> 'cancelled') AS orders,
          (SELECT count(*)::int FROM orders WHERE tenant_id = $1 AND status <> 'cancelled' AND created_at >= date_trunc('day', now())) AS orders_today,
          (SELECT coalesce(sum(total_paise), 0)::bigint FROM orders WHERE tenant_id = $1 AND status IN ${PAID}) AS revenue,
          (SELECT count(*)::int FROM orders WHERE tenant_id = $1 AND status IN ('awaiting_payment', 'payment_submitted')) AS to_confirm,
          (SELECT count(*)::int FROM orders WHERE tenant_id = $1 AND status = 'paid') AS to_ship,
          (SELECT count(*)::int FROM products WHERE tenant_id = $1 AND active) AS products`, [tenantId()]);
      s.revenue = Number(s.revenue);
      return s;
    },
  };
}
