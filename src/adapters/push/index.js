import { log } from '../../platform/log.js';
import { createApns } from './apns.js';
import { createFcm } from './fcm.js';

export { PushError } from './error.js';

/**
 * Push to the owner app (PRD 10.5). One APNs key and one FCM project serve every business.
 *
 * NOTHING calls this except the notifications service (src/modules/notifications, ctx.notify), which checks the words,
 * the preferences and the membership first. A test keeps it so.
 *
 *   send({ platform, token, title, body, data, collapseKey, ttl }) -> { ok: true, id }
 *       platform     'android' (FCM HTTP v1, a service account) or 'ios' (APNs over HTTP/2, a .p8 key)
 *       data         a flat object; every value is sent as text. The service puts tenantId, kind and link there
 *       collapseKey  a later push with the same key replaces this one on the phone
 *       ttl          seconds the provider may keep trying to deliver it (default 6 hours)
 *     With no driver for that platform nothing is sent, the log says so, and the answer is
 *     { ok: false, reason: 'not_configured' }.
 *     Any refusal throws a PushError, which is a ProviderError (src/adapters/http.js) whose kind is one of:
 *       unregistered   the app was removed or the token retired: delete the token
 *       invalid_token  not a token of this app: delete the token
 *       throttled      too many; `retryAfter` (seconds) when the provider said
 *       unavailable    the provider is down, answered nonsense, or refused our own credentials (`code` says which)
 *       timeout        no answer inside the timeout
 *     `retryable` is true for the last three. Like every ProviderError it holds no token and no word of the push.
 *
 *   forCredentials(creds) -> { send, drivers }   a sender for another project and key: Phase 6 uses one per brand.
 *       creds: { fcm?: { projectId, serviceAccount }, apns?: { keyId, teamId, key, topic, env } }
 *
 * Settings: PUSH_DRIVER is `none` (the default), `fcm`, `apns` or `fcm,apns`. FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT (the
 * service account JSON, or its base64), FCM_BASE_URL; APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY (the .p8, or its base64),
 * APNS_TOPIC (the app's bundle id), APNS_ENV (`production` or `sandbox`), APNS_BASE_URL. The two base URLs point at
 * tools/sim/push and are refused when NODE_ENV=production. A driver that is named but not fully set up stops the start.
 */
export const PUSH_DRIVERS = Object.freeze(['fcm', 'apns']);
const DEFAULT_TTL_SECONDS = 6 * 3600;

function checked({ platform, token, title, body = '', data = {}, collapseKey = '', ttl = DEFAULT_TTL_SECONDS }) {
  if (platform !== 'android' && platform !== 'ios') throw new Error('A push names its platform: android or ios');
  if (typeof token !== 'string' || !token) throw new Error('A push needs a device token');
  if (typeof title !== 'string' || !title.trim()) throw new Error('A push needs a title');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Push data is a flat object');
  const text = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
  const seconds = Number.isFinite(Number(ttl)) && Number(ttl) >= 0 ? Math.floor(Number(ttl)) : DEFAULT_TTL_SECONDS;
  return { platform, token, title, body: String(body ?? ''), data: text, collapseKey: String(collapseKey ?? '').slice(0, 64), ttl: seconds };
}

function build({ fcm, apns }) {
  const byPlatform = { android: fcm ?? null, ios: apns ?? null };
  return {
    drivers: Object.entries({ fcm, apns }).filter(([, driver]) => driver).map(([name]) => name),
    driver: [fcm && 'fcm', apns && 'apns'].filter(Boolean).join(',') || 'none',
    configured: (platform) => Boolean(byPlatform[platform]),
    async send(message) {
      const push = checked(message);
      const driver = byPlatform[push.platform];
      if (!driver) {
        log.info('push.not_sent', { platform: push.platform, reason: 'not_configured' });
        return { ok: false, reason: 'not_configured' };
      }
      const { id } = await driver.send(push);
      return { ok: true, id };
    },
    /** Closes the APNs connection, if one is open. */
    close: () => apns?.close?.(),
  };
}

function driversFor(names, creds, options) {
  for (const name of names) if (!PUSH_DRIVERS.includes(name)) throw new Error(`Unknown PUSH_DRIVER "${name}" (use none, fcm, apns or fcm,apns)`);
  return {
    fcm: names.includes('fcm') ? createFcm(creds.fcm ?? {}, options) : null,
    apns: names.includes('apns') ? createApns(creds.apns ?? {}, options) : null,
  };
}

export function createPush(config = {}, { env = process.env } = {}) {
  const names = String(config.pushDriver || 'none').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name && name !== 'none');
  const options = { env, timeoutMs: config.providerTimeoutMs, fcmBaseUrl: config.fcmBaseUrl, apnsBaseUrl: config.apnsBaseUrl };
  const sender = build(driversFor(names, {
    fcm: { projectId: config.fcmProjectId, serviceAccount: config.fcmServiceAccount },
    apns: { keyId: config.apnsKeyId, teamId: config.apnsTeamId, key: config.apnsKey, topic: config.apnsTopic, env: config.apnsEnv },
  }, options));
  return {
    ...sender,
    /** A sender for another project and key, on the same base URLs and timeout. Only the drivers `creds` names; close() it when done. */
    forCredentials(creds = {}) {
      return build(driversFor(PUSH_DRIVERS.filter((name) => creds[name]), creds, options));
    },
  };
}
