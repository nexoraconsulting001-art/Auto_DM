/**
 * Instagram and Meta, as Graph API for Instagram Login. One server plays www.instagram.com, api.instagram.com and
 * graph.instagram.com; point GRAPH_BASE_URL at it. Control routes are listed in control.mjs and base.mjs.
 *
 * Enforced: token lifetimes and refresh rules, one private reply per comment, the 7-day and 24-hour windows, button
 * and text limits, per-account budgets, the BUC bucket, per-account isolation, and signed webhooks and callbacks.
 */
import { createSim } from '../base.mjs';
import { controlRoutes } from './control.mjs';
import { ERRORS, graphError, metaFaultBody } from './constants.mjs';
import { graphRoutes } from './graph.mjs';
import { oauthRoutes } from './oauth.mjs';
import { freshState, graphHeaders } from './state.mjs';

export { DEFAULT_SCOPES, ERRORS, LIMITS, SCOPES } from './constants.mjs';
export { hubSignature, signedRequest } from './webhooks.mjs';

/** options: { app: { id, secret, verifyToken, webhookUrl, ... }, limits: { ...LIMITS } } */
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
      graphRoutes(on, ctx);
    },
    controls: (on) => controlRoutes(on, ctx),
  });
  ctx.clock = sim.clock;
  ctx.sim = sim;
  return sim;
}
