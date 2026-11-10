/**
 * Instagram and Meta, as Graph API for Instagram Login, plus Facebook Login and Pages (facebook.mjs). One server plays
 * www.instagram.com, api.instagram.com, graph.instagram.com, www.facebook.com and graph.facebook.com; point GRAPH_BASE_URL
 * at it. Control routes are listed in control.mjs, facebook.mjs and base.mjs.
 *
 * Enforced: token lifetimes and refresh rules, one private reply per comment, the 7-day and 24-hour windows, button
 * and text limits, per-account budgets, the BUC bucket, per-account isolation, signed webhooks and callbacks, what
 * insights may be asked and for how long Meta keeps them (insights.mjs), and the Conversions API (conversions.mjs).
 */
import { createSim } from '../base.mjs';
import { controlRoutes } from './control.mjs';
import { conversionControls, conversionRoutes } from './conversions.mjs';
import { ERRORS, graphError, metaFaultBody } from './constants.mjs';
import { facebookControls, facebookRoutes, withPages } from './facebook.mjs';
import { graphRoutes } from './graph.mjs';
import { insightControls } from './insights.mjs';
import { oauthRoutes } from './oauth.mjs';
import { freshState, graphHeaders } from './state.mjs';

export { DEFAULT_SCOPES, ERRORS, LIMITS, SCOPES } from './constants.mjs';
export { hubSignature, signedRequest } from './webhooks.mjs';

/** options: { app: { id, secret, verifyToken, webhookUrl, ... }, facebookApp: { id, secret, webhookUrl, ... }, limits: { ...LIMITS } } */
export function createMeta(options = {}) {
  const ctx = { s: freshState(options), clock: null, sim: null };
  const sim = createSim({
    name: 'meta',
    rewritePath: (path) => path.replace(/^\/v\d+\.\d+(?=\/|$)/, '') || '/',
    errorBody: metaFaultBody,
    decorate: (req, fault) => graphHeaders(ctx, req, fault),
    notFound: (req) => {
      throw graphError(ERRORS.UNKNOWN_PATH, `Unknown path components: ${req.path}`);
    },
    reset: () => {
      ctx.s = freshState(options);
    },
    routes: (on) => {
      oauthRoutes(on, ctx);
      facebookRoutes(on, ctx);
      conversionRoutes(on, ctx);
      graphRoutes(withPages(on, ctx), ctx);
    },
    controls: (on) => {
      controlRoutes(on, ctx);
      insightControls(on, ctx);
      conversionControls(on, ctx);
      facebookControls(on, ctx);
    },
  });
  ctx.clock = sim.clock;
  ctx.sim = sim;
  return sim;
}
