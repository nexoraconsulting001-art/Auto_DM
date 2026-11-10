import { activityRoutes } from './activity.js';
import { alertRoutes } from './alerts.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { automationRoutes } from './automations.js';
import { brandKitRoutes } from './brand-kit.js';
import { categoryRoutes } from './categories.js';
import { complianceRoutes } from './compliance.js';
import { customerRoutes } from './customers.js';
import { domainRoutes } from './domains.js';
import { facebookRoutes } from './facebook.js';
import { inboxRoutes } from './inbox.js';
import { insightRoutes } from './insights.js';
import { instagramRoutes } from './instagram.js';
import { linkRoutes } from './links.js';
import { mediaRoutes } from './media.js';
import { orderRoutes } from './orders.js';
import { productRoutes } from './products.js';
import { reachGuardRoutes } from './reach-guard.js';
import { reelRoutes } from './reels.js';
import { reportRoutes } from './reports.js';
import { settingRoutes } from './settings.js';
import { statRoutes } from './stats.js';
import { trafficRoutes } from './traffic.js';

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
  ...instagramRoutes,
  ...complianceRoutes,
  ...automationRoutes,
  ...inboxRoutes,
  ...linkRoutes,
  ...facebookRoutes,
  ...domainRoutes,
  ...alertRoutes,
  ...reportRoutes,
  ...insightRoutes,
  ...reachGuardRoutes,
  ...trafficRoutes,
});

export const routeList = Object.freeze(Object.entries(routes).map(([id, route]) => Object.freeze({ id, ...route })));

export * from './access.js';
export * from './activity.js';
export * from './alerts.js';
export * from './audit.js';
export * from './auth.js';
export * from './automations.js';
export * from './brand-kit.js';
export * from './categories.js';
export * from './common.js';
export * from './compliance.js';
export * from './customers.js';
export * from './domains.js';
export * from './errors.js';
export * from './facebook.js';
export * from './inbox.js';
export * from './insights.js';
export * from './instagram.js';
export * from './links.js';
export * from './media.js';
export * from './orders.js';
export * from './platform.js';
export * from './provider.js';
export * from './products.js';
export * from './reach-guard.js';
export * from './reels.js';
export * from './reports.js';
export * from './settings.js';
export * from './stats.js';
export * from './traffic.js';
