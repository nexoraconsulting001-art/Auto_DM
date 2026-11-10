import { activityRoutes } from './activity.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { brandKitRoutes } from './brand-kit.js';
import { categoryRoutes } from './categories.js';
import { customerRoutes } from './customers.js';
import { mediaRoutes } from './media.js';
import { orderRoutes } from './orders.js';
import { productRoutes } from './products.js';
import { reelRoutes } from './reels.js';
import { settingRoutes } from './settings.js';
import { statRoutes } from './stats.js';

/**
 * The seller API at /api/v1, as data. The router (src/modules/api-v1) is built from this table, the shared
 * client (shared/api-client) mirrors it, and a test keeps the two in step. Each route is:
 *
 *   id        'group.action', the key below; a module's api() answers routes by this id
 *   method    GET, POST, PUT, PATCH or DELETE
 *   path      under /api/v1, with :params
 *   access    who may call it: see access.js
 *   params    zod schema for the path. Not matching it is a 404
 *   query     zod schema for the query string
 *   body      zod schema for a JSON body
 *   upload    { field, maxBytes, mimeTypes } for a multipart file, instead of body
 *   status    the success status, 200 unless given
 *   response  zod schema for the result, or null for no body. Results are parsed through it, so unknown
 *             fields never leave the server
 *
 * Lists take ListQuery and answer with page(item). Failures use the format in errors.js.
 */
export const routes = Object.freeze({
  ...authRoutes,
  ...productRoutes,
  ...categoryRoutes,
  ...reelRoutes,
  ...orderRoutes,
  ...customerRoutes,
  ...settingRoutes,
  ...brandKitRoutes,
  ...activityRoutes,
  ...statRoutes,
  ...mediaRoutes,
  ...auditRoutes,
});

export const routeList = Object.freeze(Object.entries(routes).map(([id, route]) => Object.freeze({ id, ...route })));

export * from './access.js';
export * from './activity.js';
export * from './audit.js';
export * from './auth.js';
export * from './brand-kit.js';
export * from './categories.js';
export * from './common.js';
export * from './customers.js';
export * from './errors.js';
export * from './media.js';
export * from './orders.js';
export * from './products.js';
export * from './reels.js';
export * from './settings.js';
export * from './stats.js';
