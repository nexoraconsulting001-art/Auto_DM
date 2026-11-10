import { createMetaClient } from './client.js';
import { createConversions } from './conversions.js';
import { createFacebookLogin, createLoginAdapter } from './login.js';

export { DEFAULT_GRAPH_VERSION, createMetaClient, wireMessage } from './client.js';
export { createConversions, hashedUserData } from './conversions.js';
export { MetaApiError, MetaHostBlockedError, classifyGraphError } from './errors.js';
export { InsightsDeferredError, createInsightsReader, isInsightsDenied } from './insights.js';
export { META_HOSTS, metaUrls } from './hosts.js';
export { DEFAULT_TIMEOUT_MS, parseUsage } from './http.js';
export { FACEBOOK_SCOPES, INSTAGRAM_SCOPES, createFacebookLogin, createInstagramLogin, createLoginAdapter, createUnifiedLogin } from './login.js';
export { verifyHubSignature, verifySignedRequest } from './signatures.js';

/**
 * Everything that talks to Meta, built from config. Throws at start-up on a bad address: a simulator in production,
 * or a host that is not Meta's. Modules get this as ctx.meta: { client, login, facebookLogin, conversions }.
 */
export function createMetaAdapters(config = {}, options = {}) {
  return {
    client: createMetaClient(config, options),
    login: createLoginAdapter(config, options),
    facebookLogin: createFacebookLogin(config, options),
    conversions: createConversions(config, options),
  };
}
