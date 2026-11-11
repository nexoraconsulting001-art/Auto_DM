import crypto from 'node:crypto';
import { DEFAULT_TIMEOUT_MS, providerUrl } from '../http.js';
import { isSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { PushError } from './error.js';

/**
 * Firebase Cloud Messaging, HTTP v1: POST /v1/projects/<project>/messages:send with an OAuth access token made from the
 * service account (a signed JWT swapped at Google's token address, kept until shortly before it runs out).
 * Pointed at tools/sim/push, the token comes from the simulator's /token as well.
 */
export const FCM_HOST = 'https://fcm.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = (value) => Buffer.from(value).toString('base64url');

/** The service account as JSON text or its base64. Throws without naming any of its contents. */
export function readServiceAccount(value) {
  let account = value;
  if (typeof value === 'string') {
    const text = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
    try {
      account = JSON.parse(text);
    } catch {
      throw new Error('FCM_SERVICE_ACCOUNT is not the service account JSON, or its base64');
    }
  }
  if (!account?.client_email || !account?.private_key) throw new Error('FCM_SERVICE_ACCOUNT needs client_email and private_key');
  return { clientEmail: String(account.client_email), privateKey: String(account.private_key).replace(/\\n/g, '\n') };
}

function kindOf(status, code) {
  if (status === 404 || code === 'UNREGISTERED' || code === 'NOT_FOUND') return 'unregistered';
  if (code === 'INVALID_ARGUMENT' || code === 'SENDER_ID_MISMATCH') return 'invalid_token';
  if (status === 429 || code === 'QUOTA_EXCEEDED' || code === 'RESOURCE_EXHAUSTED') return 'throttled';
  return 'unavailable';
}

export function createFcm({ projectId, serviceAccount } = {}, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, fcmBaseUrl = '' } = {}) {
  if (!projectId) throw new Error('FCM needs FCM_PROJECT_ID');
  const account = readServiceAccount(serviceAccount);
  const baseUrl = providerUrl({ value: fcmBaseUrl, real: FCM_HOST, name: 'FCM_BASE_URL', env });
  const tokenUrl = isSimulatorUrl(baseUrl) ? `${baseUrl}/token` : GOOGLE_TOKEN_URL;
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  let access = null; // { token, until }
  let fetching = null;

  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new PushError({ provider: 'fcm', kind: err?.name === 'TimeoutError' ? 'timeout' : 'unavailable', code: err?.name === 'TimeoutError' ? '' : 'network' });
    }
    const text = await res.text().catch(() => '');
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined; // not JSON
    }
    return { res, body };
  }

  async function newAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 }));
    let signature;
    try {
      signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.privateKey).toString('base64url');
    } catch {
      throw new PushError({ provider: 'fcm', kind: 'unavailable', code: 'bad_service_account' });
    }
    const { res, body } = await call(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
    });
    if (!res.ok || !body?.access_token) throw new PushError({ provider: 'fcm', kind: res.status === 429 ? 'throttled' : 'unavailable', status: res.status, code: res.ok ? 'malformed' : String(body?.error ?? 'auth') });
    return { token: String(body.access_token), until: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 60_000 };
  }

  async function accessToken() {
    if (access && access.until > Date.now()) return access.token;
    fetching ??= newAccessToken().finally(() => { fetching = null; });
    access = await fetching;
    return access.token;
  }

  return {
    async send({ token, title, body, data, collapseKey, ttl }) {
      const message = {
        token,
        notification: { title, body },
        data,
        android: { priority: 'HIGH', ttl: `${ttl}s`, ...(collapseKey ? { collapse_key: collapseKey, notification: { tag: collapseKey } } : {}) },
      };
      const bearer = await accessToken();
      const { res, body: answer } = await call(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        if (typeof answer?.name !== 'string') throw new PushError({ provider: 'fcm', kind: 'unavailable', status: res.status, code: 'malformed' });
        return { id: answer.name };
      }
      if (res.status === 401) access = null; // the next send asks for a new one
      const code = String(answer?.error?.details?.find?.((d) => d?.errorCode)?.errorCode ?? answer?.error?.status ?? '');
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      throw new PushError({ provider: 'fcm', kind: kindOf(res.status, code), status: res.status, code, retryAfter });
    },
  };
}
