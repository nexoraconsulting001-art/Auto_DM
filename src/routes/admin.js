import express from 'express';
import { adminConsole } from '../modules/admin-console/index.js';
import { currentTenant } from '../tenancy.js';

/** Public address of the current business. PUBLIC_BASE_URL applies to the default business only. */
export const baseUrlFor = (req, config) => {
  const t = currentTenant();
  if (config.publicBaseUrl && (!t?.slug || !config.defaultTenant || t.slug === config.defaultTenant)) return config.publicBaseUrl;
  return `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
};

/** Public address of a business when there is no request from its own site (e.g. in a webhook). */
export const tenantBaseUrl = (tenant, config) => {
  if (tenant.slug === config.defaultTenant && config.publicBaseUrl) return config.publicBaseUrl;
  return config.platformDomain ? `https://${tenant.slug}.${config.platformDomain}` : config.publicBaseUrl;
};

/**
 * The server-rendered admin is gone: /admin is the seller console, whatever ADMIN_UI says. The console module
 * mounts itself for ADMIN_UI=console, and the server mounts this for anything else, so both end up the same.
 */
export function adminRoutes({ config }) {
  const router = express.Router();
  adminConsole.routes({ use: (_path, consoleRouter) => router.use(consoleRouter) }, { config: { ...config, adminUi: 'console' } });
  return router;
}
