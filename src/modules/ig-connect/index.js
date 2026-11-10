import { notBuilt } from '../not-built.js';

/**
 * PRD 4.1, 4.2, 4.14, 4.15: connecting Instagram (ctx.meta.login), token refresh and alerts, subscribed_apps, the
 * deauthorize and deletion callbacks and the review login. Provider callbacks go in beforeTenant.
 */
export const igConnect = {
  name: 'ig-connect',
  api: () => notBuilt('instagram.connection', 'instagram.connect', 'instagram.disconnect', 'instagram.media'),
};
