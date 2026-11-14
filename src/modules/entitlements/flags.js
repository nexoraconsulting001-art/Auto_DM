import { ApiError } from '../../contracts/api/index.js';
import { flagOn } from '../../contracts/billing.js';
import { tenantId } from '../../tenancy.js';
import { mountPlatform } from '../app-config/index.js';

/**
 * Feature flags (PRD 5.7): apart from plans, off by default, staged by business or by percentage. A flag is a row of
 * feature_flags (its default and percentage); a business's own tenant_flags row wins over both. flagOn() in the billing
 * contract decides, with a stable bucket of the business's id, so a business gets the same answer every time and does
 * not flip in and out as the percentage grows.
 *
 *   await repos.flags.on('new_inbox')   true or false; an unknown flag is off
 *
 * Business code only reads (feature_flags is granted SELECT, tenant_flags is fenced SELECT). The Platform Console writes
 * them through db.platform, with an audit row each time.
 */
export function flagsRepo(db) {
  return {
    async on(key) {
      const [row] = await db.query(
        `SELECT f.enabled, f.percent, t.enabled AS own
         FROM feature_flags f LEFT JOIN tenant_flags t ON t.key = f.key AND t.tenant_id = $1
         WHERE f.key = $2`,
        [tenantId(), String(key)],
      );
      if (!row) return false;
      return flagOn({ enabled: row.enabled, percent: row.percent }, row.own ?? undefined, tenantId());
    },
  };
}

const toFlag = (row) => ({ key: row.key, description: row.description, enabled: row.enabled, percent: row.percent, businesses: Number(row.businesses ?? 0), updatedAt: row.updated_at });

/** platform.flags, saveFlag, tenantFlags and setTenantFlag (BILLING_PLATFORM_OWNERS.entitlements). */
export function flagRoutes(router, ctx) {
  const db = () => ctx.db.platform ?? ctx.db;
  const audit = (tenant, actor, action, target, details) =>
    db().query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [tenant, actor, action, target, JSON.stringify(details)]);

  async function flagOf(key) {
    const [row] = await db().query('SELECT f.*, (SELECT count(*) FROM tenant_flags t WHERE t.key = f.key)::int AS businesses FROM feature_flags f WHERE f.key = $1', [key]);
    return row ? toFlag(row) : null;
  }

  async function tenantFlags(id) {
    const [tenant] = await db().query('SELECT id FROM tenants WHERE id = $1', [Number(id)]);
    if (!tenant) throw new ApiError('not_found', 'There is no such business.');
    const rows = await db().query(
      `SELECT f.key, f.enabled, f.percent, t.enabled AS own FROM feature_flags f
       LEFT JOIN tenant_flags t ON t.key = f.key AND t.tenant_id = $1 ORDER BY f.key`,
      [tenant.id],
    );
    return { items: rows.map((r) => ({ key: r.key, on: flagOn({ enabled: r.enabled, percent: r.percent }, r.own ?? undefined, tenant.id), own: r.own ?? null })) };
  }

  mountPlatform(router, 'platform.flags', async () => {
    const rows = await db().query('SELECT f.*, (SELECT count(*) FROM tenant_flags t WHERE t.key = f.key)::int AS businesses FROM feature_flags f ORDER BY f.key');
    return { items: rows.map(toFlag) };
  });

  mountPlatform(router, 'platform.saveFlag', async ({ body, actor }) => {
    await db().tx(async (t) => {
      await t.query(
        `INSERT INTO feature_flags (key, description, enabled, percent, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled, percent = EXCLUDED.percent, updated_at = now()`,
        [body.key, body.description, body.enabled, body.percent],
      );
      await t.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, $2, $3, $4::jsonb)', [actor, 'flag.saved', `flag:${body.key}`, JSON.stringify({ enabled: body.enabled, percent: body.percent, reason: body.reason })]);
    });
    return flagOf(body.key);
  });

  mountPlatform(router, 'platform.tenantFlags', ({ params }) => tenantFlags(params.id));

  mountPlatform(router, 'platform.setTenantFlag', async ({ params, body, actor }) => {
    const current = await tenantFlags(params.id);
    if (!current.items.some((item) => item.key === body.key)) throw new ApiError('not_found', 'There is no such flag.');
    if (body.enabled === null) await db().query('DELETE FROM tenant_flags WHERE tenant_id = $1 AND key = $2', [Number(params.id), body.key]);
    else {
      await db().query(
        `INSERT INTO tenant_flags (tenant_id, key, enabled, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [Number(params.id), body.key, body.enabled],
      );
    }
    await audit(Number(params.id), actor, 'flag.tenant_set', `flag:${body.key}`, { enabled: body.enabled, reason: body.reason });
    return tenantFlags(params.id);
  });
}
