import { APPS, APP_PLATFORMS, APP_VERSION } from '../contracts/accounts.js';
import { ValidationError } from '../util.js';

/**
 * The oldest app version the API still answers (PRD 10.2), from app_min_versions. Platform-level: the owner app's
 * rows belong to no business, and the check runs before anyone is signed in. The API router asks `minimum` on every
 * request that names an app, and answers 426 `update_required` with the store link when the app is older.
 */
export function appVersionsRepo(handle) {
  const db = handle.platform ?? handle;
  const shape = (row) => ({ app: row.app, tenantId: row.tenant_id, platform: row.platform, minVersion: row.min_version, storeUrl: row.store_url });

  return {
    /** { minVersion, storeUrl } for this app on this platform, or null when no minimum is set. The owner app has no tenantId; a shopper app needs its business's. */
    async minimum({ app, platform, tenantId = null }) {
      if (!APPS.includes(app) || !APP_PLATFORMS.includes(platform)) return null;
      if (app === 'shopper' && !tenantId) return null;
      const [row] = await db.query(
        'SELECT app, tenant_id, platform, min_version, store_url FROM app_min_versions WHERE app = $1 AND platform = $2 AND COALESCE(tenant_id, 0) = $3',
        [app, platform, app === 'owner' ? 0 : Number(tenantId)],
      );
      return row ? shape(row) : null;
    },
    /** Sets the minimum, replacing the one before. Our team does this when a release makes older versions unusable. */
    async set({ app, platform, tenantId = null, minVersion, storeUrl }) {
      if (!APPS.includes(app)) throw new ValidationError('The app is owner or shopper');
      if (!APP_PLATFORMS.includes(platform)) throw new ValidationError('The platform is android or ios');
      if ((app === 'owner') !== (tenantId === null || tenantId === undefined)) throw new ValidationError('The owner app has no business; a shopper app needs one');
      if (!APP_VERSION.test(String(minVersion))) throw new ValidationError('Use a version like 1.2.0');
      if (!/^https:\/\/\S+$/.test(String(storeUrl))) throw new ValidationError('The store link must start with https://');
      const [row] = await db.query(
        `INSERT INTO app_min_versions (app, tenant_id, platform, min_version, store_url) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app, COALESCE(tenant_id, 0), platform) DO UPDATE SET min_version = EXCLUDED.min_version, store_url = EXCLUDED.store_url, updated_at = now()
         RETURNING app, tenant_id, platform, min_version, store_url`,
        [app, app === 'owner' ? null : Number(tenantId), platform, String(minVersion), String(storeUrl)],
      );
      return shape(row);
    },
    async list() {
      return (await db.query('SELECT app, tenant_id, platform, min_version, store_url FROM app_min_versions ORDER BY app, tenant_id NULLS FIRST, platform')).map(shape);
    },
  };
}
