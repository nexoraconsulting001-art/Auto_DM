import crypto from 'node:crypto';
import { isSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { DEFAULT_TIMEOUT_MS, ProviderError, createHttp, providerUrl } from '../http.js';

/**
 * The two stores, as far as the server reads them (PRD 10.9, 10.14): whether our access to the business's own developer
 * account is enough, and where its app stands in review. ctx.appStores = { appStoreConnect, googlePlay }, in the app and the
 * worker.
 *
 *   appStoreConnect.forKey({ keyId, issuerId, privateKey }) -> {
 *     checkAccess({ bundleId }) -> { status: 'ok' | 'role_too_low' | 'invalid' | 'unreachable', roleFound, roleNeeded }
 *     reviewState({ bundleId }) -> { state: 'none' | 'in_review' | 'rejected' | 'approved' | 'live', version, buildNumber, storeUrl,
 *                                   sellerName, rejection: { key, guideline, message } | null } }
 *     The token is ES256, signed here with the business's own key: iss issuerId, kid keyId, aud 'appstoreconnect-v1', 20 minutes
 *     at most. APPSTORE_BASE_URL points it at tools/sim/appstore.
 *   googlePlay.configured, googlePlay.serviceAccountEmail      our one service account (PLAY_SERVICE_ACCOUNT), which the business invites
 *   googlePlay.checkAccess({ packageName }) -> { status, roleFound, roleNeeded }
 *   googlePlay.trackState({ packageName, track = 'production' }) -> { state, versionName, versionCode, storeUrl, sellerName, rejection }
 *     The token is our service account's JWT swapped at Google's token address. PLAY_BASE_URL serves both the API and the token
 *     exchange in tools/sim/play.
 *
 * checkAccess never throws for the provider's answer: 401 is invalid, 403 role_too_low (roleNeeded from config.appStoreRoleNeeded
 * or config.playPermissionNeeded), a timeout, a 5xx or junk is unreachable. When the answer lists the key's roles or our
 * permissions, ROLE_ORDER (App Store Connect) or the permission list (Play) decides "too low". reviewState and trackState throw
 * ProviderError: the poll that reads them treats a failure as "nothing new".
 *
 * Where the stores' public APIs give no review detail (a rejection's guideline, the seller name), the wire reads the fields the
 * simulators serve; reading them from the real services is not verified (Phase 6 contract, open points). Nothing here logs a
 * key, a token or a name.
 */
export const ASC_ORIGIN = 'https://api.appstoreconnect.apple.com';
export const PLAY_ORIGIN = 'https://androidpublisher.googleapis.com';
export const GOOGLE_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
export const ROLE_ORDER = Object.freeze(['DEVELOPER', 'APP_MANAGER', 'ADMIN']);
export const REVIEW_STATES = Object.freeze(['none', 'in_review', 'rejected', 'approved', 'live']);
const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const ASC_AUDIENCE = 'appstoreconnect-v1';
const TOKEN_SECONDS = 20 * 60;
const b64url = (value) => Buffer.from(value).toString('base64url');
const seg = (value) => encodeURIComponent(String(value));

/** The rank of an App Store Connect role; the account holder is above every role. -1 for an unknown one. */
export const roleRank = (role) => (String(role).toUpperCase() === 'ACCOUNT_HOLDER' ? ROLE_ORDER.length : ROLE_ORDER.indexOf(String(role).toUpperCase()));

/** App Store Connect's own words for a version's state, to ours. */
const ASC_STATES = Object.freeze({
  WAITING_FOR_REVIEW: 'in_review', IN_REVIEW: 'in_review', READY_FOR_REVIEW: 'in_review',
  REJECTED: 'rejected', METADATA_REJECTED: 'rejected', INVALID_BINARY: 'rejected',
  PENDING_DEVELOPER_RELEASE: 'approved', PENDING_APPLE_RELEASE: 'approved', PROCESSING_FOR_APP_STORE: 'approved',
  READY_FOR_SALE: 'live', READY_FOR_DISTRIBUTION: 'live',
});

/** What a failed access check means, from the provider's error. */
function accessFailure(err, roleNeeded) {
  if (err instanceof ProviderError && err.status === 401) return { status: 'invalid', roleFound: '', roleNeeded };
  if (err instanceof ProviderError && err.status === 403) return { status: 'role_too_low', roleFound: '', roleNeeded };
  if (err instanceof ProviderError && err.status === 404) return { status: 'invalid', roleFound: '', roleNeeded };
  return { status: 'unreachable', roleFound: '', roleNeeded };
}

const rejectionOf = (raw, fallbackKey) => (raw && typeof raw === 'object'
  ? { key: String(raw.key ?? fallbackKey).slice(0, 120), guideline: String(raw.guideline ?? '').slice(0, 40), message: String(raw.message ?? '').slice(0, 4000) }
  : { key: String(fallbackKey).slice(0, 120), guideline: '', message: '' });

export function createAppStoreConnect(config = {}, { env = process.env } = {}) {
  const baseUrl = providerUrl({ value: config.appStoreBaseUrl, real: ASC_ORIGIN, name: 'APPSTORE_BASE_URL', env });
  const roleNeeded = String(config.appStoreRoleNeeded || 'APP_MANAGER').toUpperCase();
  const request = createHttp({ provider: 'appstore', baseUrl, timeoutMs: config.providerTimeoutMs || DEFAULT_TIMEOUT_MS, codeOf: (body) => body?.errors?.[0]?.code ?? '' });

  return {
    roleNeeded,
    forKey({ keyId, issuerId, privateKey } = {}) {
      function bearer() {
        if (!/^[A-Z0-9]{10}$/.test(String(keyId)) || !/^[0-9a-f-]{36}$/.test(String(issuerId))) throw new ProviderError({ provider: 'appstore', kind: 'auth', status: 401, code: 'bad_key', delivery: 'none' });
        let key;
        try {
          key = crypto.createPrivateKey(String(privateKey ?? ''));
        } catch {
          throw new ProviderError({ provider: 'appstore', kind: 'auth', status: 401, code: 'bad_key', delivery: 'none' });
        }
        const now = Math.floor(Date.now() / 1000);
        const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
        const claims = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + TOKEN_SECONDS, aud: ASC_AUDIENCE }));
        let signature;
        try {
          signature = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        } catch {
          throw new ProviderError({ provider: 'appstore', kind: 'auth', status: 401, code: 'bad_key', delivery: 'none' });
        }
        return `Bearer ${head}.${claims}.${signature}`;
      }
      const get = async (path, query) => {
        const { body } = await request('GET', path, { headers: { authorization: bearer() }, query, retries: 1 });
        if (!body || typeof body !== 'object' || !Array.isArray(body.data)) throw new ProviderError({ provider: 'appstore', kind: 'malformed', delivery: 'none' });
        return body;
      };

      return {
        async checkAccess({ bundleId }) {
          let body;
          try {
            body = await get('/v1/apps', { 'filter[bundleId]': bundleId, limit: 1 });
          } catch (err) {
            return accessFailure(err, roleNeeded);
          }
          const roles = Array.isArray(body.meta?.apiKey?.roles) ? body.meta.apiKey.roles.map((r) => String(r).toUpperCase()) : null;
          if (!roles) return { status: 'ok', roleFound: '', roleNeeded };
          const best = roles.reduce((top, r) => (roleRank(r) > roleRank(top) ? r : top), roles[0] ?? '');
          return { status: roleRank(best) >= roleRank(roleNeeded) ? 'ok' : 'role_too_low', roleFound: best.slice(0, 60), roleNeeded };
        },

        async reviewState({ bundleId }) {
          const body = await get('/v1/apps', { 'filter[bundleId]': bundleId, include: 'appStoreVersions', limit: 1 });
          const app = body.data[0];
          if (!app) return { state: 'none', version: '', buildNumber: null, storeUrl: '', sellerName: '', rejection: null };
          const versions = (Array.isArray(body.included) ? body.included : []).filter((item) => item?.type === 'appStoreVersions');
          const version = versions.sort((a, b) => String(b.attributes?.createdDate ?? '').localeCompare(String(a.attributes?.createdDate ?? '')))[0];
          const state = ASC_STATES[version?.attributes?.appStoreState] ?? 'none';
          return {
            state,
            version: String(version?.attributes?.versionString ?? ''),
            buildNumber: Number(version?.attributes?.buildNumber) || null,
            storeUrl: state === 'live' && /^\d+$/.test(String(app.id)) ? `https://apps.apple.com/app/id${app.id}` : '',
            sellerName: String(app.attributes?.sellerName ?? ''),
            rejection: state === 'rejected' ? rejectionOf(version?.attributes?.rejection, `asc:${version?.id ?? app.id}`) : null,
          };
        },
      };
    },
  };
}

/** The service account as JSON text or its base64. Throws without naming any of its contents. */
export function readPlayServiceAccount(value) {
  let account = value;
  if (typeof value === 'string') {
    const text = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
    try {
      account = JSON.parse(text);
    } catch {
      throw new Error('PLAY_SERVICE_ACCOUNT is not the service account JSON, or its base64');
    }
  }
  if (!account?.client_email || !account?.private_key) throw new Error('PLAY_SERVICE_ACCOUNT needs client_email and private_key');
  return { clientEmail: String(account.client_email), privateKey: String(account.private_key).replace(/\\n/g, '\n') };
}

export function createGooglePlay(config = {}, { env = process.env } = {}) {
  const baseUrl = providerUrl({ value: config.playBaseUrl, real: PLAY_ORIGIN, name: 'PLAY_BASE_URL', env });
  const tokenBase = isSimulatorUrl(baseUrl) ? baseUrl : GOOGLE_TOKEN_ORIGIN;
  const timeoutMs = config.providerTimeoutMs || DEFAULT_TIMEOUT_MS;
  const account = config.playServiceAccount ? readPlayServiceAccount(config.playServiceAccount) : null;
  const permissionNeeded = String(config.playPermissionNeeded || 'RELEASE_TO_PRODUCTION').toUpperCase();
  const codeOf = (body) => body?.error?.status ?? body?.error ?? '';
  const api = createHttp({ provider: 'play', baseUrl, timeoutMs, codeOf });
  const tokens = createHttp({ provider: 'play', baseUrl: tokenBase, timeoutMs, codeOf });
  let access = null; // { token, until }
  let fetching = null;

  async function newAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: account.clientEmail, scope: PLAY_SCOPE, aud: `${tokenBase}/token`, iat: now, exp: now + 3600 }));
    let signature;
    try {
      signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.privateKey).toString('base64url');
    } catch {
      throw new ProviderError({ provider: 'play', kind: 'auth', status: 401, code: 'bad_service_account', delivery: 'none' });
    }
    let body;
    try {
      ({ body } = await tokens('POST', '/token', { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }, retries: 1 }));
    } catch (err) {
      // Google refuses a bad service account with 400 invalid_grant: that is our credential, not the business's app.
      if (err instanceof ProviderError && (err.status === 400 || err.status === 401)) throw new ProviderError({ provider: 'play', kind: 'auth', status: 401, code: 'invalid_grant', delivery: 'none' });
      throw err;
    }
    if (typeof body?.access_token !== 'string') throw new ProviderError({ provider: 'play', kind: 'malformed', delivery: 'none' });
    return { token: body.access_token, until: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 60_000 };
  }

  async function bearer() {
    if (!account) throw new ProviderError({ provider: 'play', kind: 'not_configured', delivery: 'none' });
    if (access && access.until > Date.now()) return `Bearer ${access.token}`;
    fetching ??= newAccessToken().finally(() => { fetching = null; });
    access = await fetching;
    return `Bearer ${access.token}`;
  }

  const call = async (method, path, options = {}) => (await api(method, path, { ...options, headers: { authorization: await bearer() } })).body;
  const editsPath = (packageName) => `/androidpublisher/v3/applications/${seg(packageName)}/edits`;
  /** Runs fn inside a throwaway edit, and always deletes the edit afterwards. */
  async function inEdit(packageName, fn) {
    const edit = await call('POST', editsPath(packageName));
    if (!edit || typeof edit.id !== 'string') throw new ProviderError({ provider: 'play', kind: 'malformed', delivery: 'none' });
    try {
      return await fn(edit);
    } finally {
      await call('DELETE', `${editsPath(packageName)}/${seg(edit.id)}`).catch(() => {});
    }
  }

  return {
    get configured() {
      return Boolean(account);
    },
    get serviceAccountEmail() {
      return account?.clientEmail ?? '';
    },
    permissionNeeded,

    async checkAccess({ packageName }) {
      if (!account) return { status: 'unreachable', roleFound: '', roleNeeded: permissionNeeded };
      try {
        return await inEdit(packageName, async (edit) => {
          const granted = Array.isArray(edit.grantedPermissions) ? edit.grantedPermissions.map((p) => String(p).toUpperCase()) : null;
          if (!granted) return { status: 'ok', roleFound: '', roleNeeded: permissionNeeded };
          const enough = granted.includes(permissionNeeded) || granted.includes('ADMIN');
          return { status: enough ? 'ok' : 'role_too_low', roleFound: (enough ? permissionNeeded : granted[0] ?? '').slice(0, 60), roleNeeded: permissionNeeded };
        });
      } catch (err) {
        return accessFailure(err, permissionNeeded);
      }
    },

    async trackState({ packageName, track = 'production' }) {
      return inEdit(packageName, async (edit) => {
        const body = await call('GET', `${editsPath(packageName)}/${seg(edit.id)}/tracks/${seg(track)}`, { retries: 1 });
        if (!body || typeof body !== 'object' || !Array.isArray(body.releases)) throw new ProviderError({ provider: 'play', kind: 'malformed', delivery: 'none' });
        const release = body.releases[0] ?? null;
        const fromRelease = release?.status === 'completed' || release?.status === 'inProgress' ? 'live' : 'none';
        const state = REVIEW_STATES.includes(body.review?.state) ? body.review.state : fromRelease;
        return {
          state,
          versionName: String(release?.name ?? ''),
          versionCode: Number(release?.versionCodes?.[0]) || null,
          storeUrl: state === 'live' ? `https://play.google.com/store/apps/details?id=${seg(packageName)}` : '',
          sellerName: String(body.developerName ?? ''),
          rejection: state === 'rejected' ? rejectionOf(body.review?.rejection, `play:${packageName}:${release?.versionCodes?.[0] ?? ''}`) : null,
        };
      });
    },
  };
}

/** Both stores, built from config. Throws at start-up on a bad address or a broken PLAY_SERVICE_ACCOUNT. */
export function createAppStores(config = {}, options = {}) {
  return { appStoreConnect: createAppStoreConnect(config, options), googlePlay: createGooglePlay(config, options) };
}
