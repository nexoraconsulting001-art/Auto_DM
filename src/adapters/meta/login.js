import { DEFAULT_GRAPH_VERSION } from './client.js';
import { MetaApiError } from './errors.js';
import { metaUrls } from './hosts.js';
import { createMetaHttp } from './http.js';

/** What every Instagram connection asks for (PRD 4.2). Never content publishing. These are the names the gates use. */
export const INSTAGRAM_SCOPES = Object.freeze([
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
]);

/** Unified Login's names for the same permissions. */
const UNIFIED_TO_CANONICAL = Object.freeze({
  instagram_basic: 'instagram_business_basic',
  instagram_manage_messages: 'instagram_business_manage_messages',
  instagram_manage_comments: 'instagram_business_manage_comments',
  instagram_manage_insights: 'instagram_business_manage_insights',
});
const UNIFIED_SCOPES = Object.freeze([...Object.keys(UNIFIED_TO_CANONICAL), 'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'business_management']);

/** Facebook Pages (PRD 6.10). Permission names are to confirm at App Review. */
export const FACEBOOK_SCOPES = Object.freeze(['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'pages_read_engagement', 'pages_manage_engagement']);

const splitScopes = (value) => (Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/).filter(Boolean));
const expiry = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);
/** A code copied from a redirect can carry Instagram's trailing #_. */
const cleanCode = (code) => String(code ?? '').replace(/#_?$/, '');

function dialogUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function requireApp(appId, secret, name) {
  if (!appId || !secret) throw new Error(`${name} needs its app id and app secret in the environment`);
}

/**
 * The login adapter's interface, whichever login is configured:
 *
 *   kind                                           'instagram' | 'unified'
 *   scopes                                         what the consent screen asks for
 *   authorizeUrl({ state, redirectUri })           the consent screen's address
 *   connect({ code, redirectUri, igUserId? })      -> { igUserId, appScopedId, username, token, expiresAt, scopes, loginKind, pageId }
 *   refresh(token)                                 -> { token, expiresAt }   expiresAt null: Meta gave none
 *
 * `scopes` in a result always use the Instagram Login names, so the release gates (PRD 4.15) check one set of names.
 */
export function createInstagramLogin(config = {}, { env = process.env, onCall } = {}) {
  const urls = metaUrls(config, env);
  const call = createMetaHttp({ timeoutMs: config.metaTimeoutMs, onCall });
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION;
  const appId = config.igAppId;
  const secret = config.appSecret;

  return {
    kind: 'instagram',
    scopes: INSTAGRAM_SCOPES,

    authorizeUrl({ state, redirectUri }) {
      requireApp(appId, secret, 'Instagram Login');
      return dialogUrl(`${urls.instagramDialog}/oauth/authorize`, { force_reauth: 'true', client_id: appId, redirect_uri: redirectUri, response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state });
    },

    async connect({ code, redirectUri }) {
      requireApp(appId, secret, 'Instagram Login');
      const { data: exchanged } = await call({
        base: urls.instagramApi, method: 'POST', pathname: 'oauth/access_token',
        form: { client_id: appId, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: cleanCode(code) },
      });
      // Instagram's docs wrap this answer in data[]; field reports show it flat.
      const short = Array.isArray(exchanged.data) ? exchanged.data[0] : exchanged;
      if (!short?.access_token) throw new MetaApiError({ method: 'POST', pathname: 'oauth/access_token', status: 200, kind: 'malformed', delivery: 'none', detail: 'no access token in the answer' });
      // The token goes in a header here too. Meta's docs show it in the query: a live check must confirm the header works.
      const { data: long } = await call({ base: urls.graph, method: 'GET', pathname: 'access_token', query: { grant_type: 'ig_exchange_token', client_secret: secret }, token: short.access_token });
      const { data: me } = await call({ base: urls.graph, version, method: 'GET', pathname: 'me', query: { fields: 'id,user_id,username,account_type' }, token: long.access_token });
      return {
        igUserId: String(me.user_id),
        appScopedId: String(me.id ?? short.user_id ?? ''),
        username: String(me.username ?? ''),
        token: long.access_token,
        expiresAt: expiry(long.expires_in),
        scopes: splitScopes(short.permissions),
        loginKind: 'instagram',
        pageId: '',
      };
    },

    async refresh(token) {
      const { data } = await call({ base: urls.graph, method: 'GET', pathname: 'refresh_access_token', query: { grant_type: 'ig_refresh_token' }, token });
      return { token: data.access_token, expiresAt: expiry(data.expires_in) };
    },
  };
}

/** The Facebook Login exchange both Unified Login and Facebook Pages use. Secrets and tokens go in the POST body, not a URL. */
function facebookOAuth(config, { env, onCall }) {
  const urls = metaUrls(config, env);
  const call = createMetaHttp({ timeoutMs: config.metaTimeoutMs, onCall });
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION;
  const appId = config.fbAppId;
  const secret = config.fbAppSecret;

  async function userToken({ code, redirectUri }) {
    requireApp(appId, secret, 'Facebook Login');
    const { data: short } = await call({ base: urls.facebookGraph, version, method: 'POST', pathname: 'oauth/access_token', form: { client_id: appId, client_secret: secret, redirect_uri: redirectUri, code: cleanCode(code) } });
    const { data: long } = await call({ base: urls.facebookGraph, version, method: 'POST', pathname: 'oauth/access_token', form: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: short.access_token } });
    return long;
  }

  return {
    authorizeUrl({ state, redirectUri, scopes }) {
      requireApp(appId, secret, 'Facebook Login');
      return dialogUrl(`${urls.facebookDialog}/${version}/dialog/oauth`, { client_id: appId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(','), state });
    },
    async pagesFor({ code, redirectUri }) {
      const long = await userToken({ code, redirectUri });
      const graph = (pathname, query) => call({ base: urls.facebookGraph, version, method: 'GET', pathname, query, token: long.access_token });
      const [{ data: accounts }, { data: permissions }] = await Promise.all([
        graph('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}' }),
        graph('me/permissions'),
      ]);
      const granted = (permissions.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
      return { pages: accounts.data ?? [], granted, expiresAt: expiry(long.expires_in) };
    },
  };
}

/** The same interface over Facebook Login for Business. The account's token is its Page's, so it does not expire on its own. */
export function createUnifiedLogin(config = {}, { env = process.env, onCall } = {}) {
  const oauth = facebookOAuth(config, { env, onCall });
  return {
    kind: 'unified',
    scopes: INSTAGRAM_SCOPES,
    authorizeUrl: ({ state, redirectUri }) => oauth.authorizeUrl({ state, redirectUri, scopes: UNIFIED_SCOPES }),

    async connect({ code, redirectUri, igUserId }) {
      const { pages, granted } = await oauth.pagesFor({ code, redirectUri });
      const linked = pages.filter((p) => p.instagram_business_account?.id);
      const page = igUserId ? linked.find((p) => String(p.instagram_business_account.id) === String(igUserId)) : linked[0];
      if (!page) throw new Error('No Facebook Page with an Instagram professional account was shared');
      return {
        igUserId: String(page.instagram_business_account.id),
        appScopedId: '',
        username: String(page.instagram_business_account.username ?? ''),
        token: page.access_token,
        expiresAt: null,
        scopes: granted.map((name) => UNIFIED_TO_CANONICAL[name]).filter(Boolean),
        loginKind: 'unified',
        pageId: String(page.id),
      };
    },

    refresh: async (token) => ({ token, expiresAt: null }),
  };
}

/** Facebook Pages, a separate connection and a separate Meta app (PRD 6.10). connect() -> { pages: [{ pageId, name, token, igUserId }], scopes, expiresAt }. */
export function createFacebookLogin(config = {}, { env = process.env, onCall } = {}) {
  const oauth = facebookOAuth(config, { env, onCall });
  return {
    kind: 'facebook',
    scopes: FACEBOOK_SCOPES,
    authorizeUrl: ({ state, redirectUri }) => oauth.authorizeUrl({ state, redirectUri, scopes: FACEBOOK_SCOPES }),
    async connect({ code, redirectUri }) {
      const { pages, granted, expiresAt } = await oauth.pagesFor({ code, redirectUri });
      return {
        pages: pages.map((p) => ({ pageId: String(p.id), name: String(p.name ?? ''), token: p.access_token, igUserId: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : '' })),
        scopes: granted,
        expiresAt,
      };
    },
  };
}

/** Picks the login from META_LOGIN. The decision between the two is still open, so either has to work. */
export function createLoginAdapter(config = {}, options = {}) {
  const kind = config.metaLogin || 'instagram';
  if (kind === 'instagram') return createInstagramLogin(config, options);
  if (kind === 'unified') return createUnifiedLogin(config, options);
  throw new Error(`META_LOGIN must be instagram or unified, got "${kind}"`);
}
