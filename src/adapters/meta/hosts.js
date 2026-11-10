import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { MetaHostBlockedError } from './errors.js';

/** Meta's real addresses (PRD 4.1). Anything else throws api.host_blocked, except a simulator outside production. */
export const META_HOSTS = Object.freeze({
  graph: 'https://graph.instagram.com',
  instagramDialog: 'https://www.instagram.com',
  instagramApi: 'https://api.instagram.com',
  facebookGraph: 'https://graph.facebook.com',
  facebookDialog: 'https://www.facebook.com',
});

const ALLOWED = new Set(Object.values(META_HOSTS));

function checked(value, name, env) {
  const raw = String(value).trim().replace(/\/+$/, '');
  refuseSimulatorUrl(raw, { env, name });
  if (isSimulatorUrl(raw)) return raw;
  let origin = '';
  try {
    const url = new URL(raw);
    if (!url.username && !url.password && url.pathname === '/') origin = url.origin;
  } catch {
    // Not a URL at all, so not one of Meta's.
  }
  if (!ALLOWED.has(origin)) throw new MetaHostBlockedError(name);
  return origin;
}

/**
 * The base URL of each Meta service. GRAPH_BASE_URL alone points all of them at one simulator, and each can be set on
 * its own. Every value is checked: a simulator is refused when NODE_ENV=production, anything else not Meta's always.
 */
export function metaUrls(config = {}, env = process.env) {
  const sim = config.graphBaseUrl || '';
  const pick = (key, real, name) => checked(config[key] || sim || real, name, env);
  return Object.freeze({
    graph: pick('graphBaseUrl', META_HOSTS.graph, 'GRAPH_BASE_URL'),
    instagramDialog: pick('igDialogBaseUrl', META_HOSTS.instagramDialog, 'IG_DIALOG_BASE_URL'),
    instagramApi: pick('igApiBaseUrl', META_HOSTS.instagramApi, 'IG_API_BASE_URL'),
    facebookGraph: pick('fbGraphBaseUrl', META_HOSTS.facebookGraph, 'FB_GRAPH_BASE_URL'),
    facebookDialog: pick('fbDialogBaseUrl', META_HOSTS.facebookDialog, 'FB_DIALOG_BASE_URL'),
  });
}
