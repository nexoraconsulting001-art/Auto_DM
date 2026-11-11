import crypto from 'node:crypto';
import http2 from 'node:http2';
import { DEFAULT_TIMEOUT_MS, providerUrl } from '../http.js';
import { PushError } from './error.js';

/**
 * Apple Push Notification service over HTTP/2: POST /3/device/<token> with a provider token (an ES256 JWT made from the
 * .p8 key, its key id and the team id, renewed every 50 minutes as Apple asks) and the app's bundle id as the topic.
 * One connection is kept open and opened again when it drops. Pointed at tools/sim/push, it speaks the same HTTP/2 in
 * the clear.
 */
export const APNS_HOSTS = Object.freeze({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
const PROVIDER_TOKEN_MS = 50 * 60_000;
const b64url = (value) => Buffer.from(value).toString('base64url');

/** The .p8 key as PEM text, PEM with \n written out, or the base64 of either. Throws without quoting it. */
export function readApnsKey(value) {
  let pem = String(value ?? '').trim().replace(/\\n/g, '\n');
  if (pem && !pem.includes('-----BEGIN')) pem = Buffer.from(pem, 'base64').toString('utf8').trim();
  try {
    return crypto.createPrivateKey(pem);
  } catch {
    throw new Error('APNS_KEY is not a .p8 private key, or its base64');
  }
}

function kindOf(status, reason) {
  if (status === 410 || reason === 'Unregistered') return 'unregistered';
  if (['BadDeviceToken', 'DeviceTokenNotForTopic', 'MissingDeviceToken'].includes(reason)) return 'invalid_token';
  if (status === 429 || reason === 'TooManyRequests' || reason === 'TooManyProviderTokenUpdates') return 'throttled';
  return 'unavailable';
}

export function createApns({ keyId, teamId, key, topic, env: apnsEnv = 'production' } = {}, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, apnsBaseUrl = '' } = {}) {
  if (!keyId || !teamId || !topic) throw new Error('APNs needs APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC');
  const privateKey = readApnsKey(key);
  const which = String(apnsEnv || 'production').toLowerCase();
  if (!APNS_HOSTS[which]) throw new Error('APNS_ENV is production or sandbox');
  const baseUrl = providerUrl({ value: apnsBaseUrl, real: APNS_HOSTS[which], name: 'APNS_BASE_URL', env });
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  let provider = null; // { token, until }
  let session = null;

  function providerToken() {
    if (provider && provider.until > Date.now()) return provider.token;
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
    const signature = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    provider = { token: `${head}.${claims}.${signature}`, until: Date.now() + PROVIDER_TOKEN_MS };
    return provider.token;
  }

  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    const opened = http2.connect(baseUrl);
    opened.unref(); // an idle connection never keeps the process alive
    const forget = () => { if (session === opened) session = null; };
    opened.on('error', forget);
    opened.on('close', forget);
    opened.on('goaway', forget);
    session = opened;
    return opened;
  }

  function post(path, headers, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      let request;
      const timer = setTimeout(() => {
        request?.close(http2.constants.NGHTTP2_CANCEL);
        done(reject, new PushError({ provider: 'apns', kind: 'timeout' }));
      }, timeout);
      try {
        request = connection().request({ ':method': 'POST', ':path': path, ...headers });
      } catch {
        return done(reject, new PushError({ provider: 'apns', kind: 'unavailable', code: 'network' }));
      }
      let status = 0;
      let apnsId = '';
      let retryAfter = null;
      const chunks = [];
      request.on('response', (answer) => {
        status = Number(answer[':status']) || 0;
        apnsId = String(answer['apns-id'] ?? '');
        retryAfter = Number(answer['retry-after']) || null;
      });
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => done(resolve, { status, apnsId, retryAfter, text: Buffer.concat(chunks).toString('utf8') }));
      request.on('error', () => done(reject, new PushError({ provider: 'apns', kind: 'unavailable', code: 'network' })));
      // A connection that drops takes its requests with it, sometimes with no error on the request itself.
      request.on('close', () => done(reject, new PushError({ provider: 'apns', kind: 'unavailable', code: 'network' })));
      request.end(payload);
    });
  }

  return {
    async send({ token, title, body, data, collapseKey, ttl }) {
      const payload = JSON.stringify({ ...data, aps: { alert: { title, body }, sound: 'default' } });
      const answer = await post(`/3/device/${encodeURIComponent(token)}`, {
        authorization: `bearer ${providerToken()}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0),
        ...(collapseKey ? { 'apns-collapse-id': collapseKey } : {}),
        'content-type': 'application/json',
      }, payload);
      if (answer.status === 200) return { id: answer.apnsId };
      let reason = '';
      try {
        reason = String(JSON.parse(answer.text)?.reason ?? '');
      } catch {
        reason = 'malformed';
      }
      if (answer.status === 403) provider = null; // the next send signs a new provider token
      throw new PushError({ provider: 'apns', kind: kindOf(answer.status, reason), status: answer.status, code: reason, retryAfter: answer.retryAfter });
    },
    close() {
      session?.close();
      session = null;
    },
  };
}
