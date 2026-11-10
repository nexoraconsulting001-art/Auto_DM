import express from 'express';
import { adminConsole } from '../modules/admin-console/index.js';

// These moved to the admin-api module; src/server.js still imports them from here.
export { baseUrlFor, tenantBaseUrl } from '../modules/admin-api/urls.js';

/**
 * The server-rendered admin is gone: /admin is the seller console, whatever ADMIN_UI says. The console module
 * mounts itself for ADMIN_UI=console, and the server mounts this for anything else, so both end up the same.
 */
export function adminRoutes({ config }) {
  const router = express.Router();
  adminConsole.routes({ use: (_path, consoleRouter) => router.use(consoleRouter) }, { config: { ...config, adminUi: 'console' } });
  return router;
}
