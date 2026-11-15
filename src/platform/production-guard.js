/**
 * What a production configuration must be (Phase 9; G-09). The rules are data: each has an id, the settings it reads
 * and one test of the config. src/server.js and src/worker.js call guardProduction() at start when NODE_ENV is production.
 *
 *   DEPLOY_ENV=production   a failing rule refuses to start, whatever NODE_ENV says (a production deploy that forgot
 *                           NODE_ENV is still production). The error lists rule ids and setting names, never a value.
 *   NODE_ENV=production     otherwise the failing rules are returned for the start-up log (`production.guard`), and the process
 *                           starts: QA on the shared VM and the tools that start the server with NODE_ENV=production run
 *                           the simple drivers on purpose. The go-live checklist treats this as not ready.
 *
 * The production templates in deploy/prod set DEPLOY_ENV=production; nothing else does.
 */
const text = (value) => String(value ?? '').trim();
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0(\.\d{1,3}){3}|\[::1?\]|::1?|host\.docker\.internal|gateway\.docker\.internal)$/i;
const TEST_HOST = /(^|\.)(test|localhost|example|invalid|local|internal|lan|home|localdomain)$/i;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
// IPv6 in brackets, as URL gives it: unique-local (fc00::/7), link-local (fe80::/10) and any IPv4-mapped address.
const PRIVATE_V6 = /^\[(f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:|::ffff:)/i;

/** Every setting that points an adapter at another address than the provider's own: empty in production. */
export const SIMULATOR_SETTINGS = Object.freeze({
  GRAPH_BASE_URL: 'graphBaseUrl', IG_DIALOG_BASE_URL: 'igDialogBaseUrl', IG_API_BASE_URL: 'igApiBaseUrl', FB_GRAPH_BASE_URL: 'fbGraphBaseUrl',
  FB_DIALOG_BASE_URL: 'fbDialogBaseUrl', GA4_BASE_URL: 'ga4BaseUrl', GOOGLE_KEYS_BASE_URL: 'googleKeysBaseUrl', APPLE_KEYS_BASE_URL: 'appleKeysBaseUrl',
  RAZORPAY_BASE_URL: 'razorpayBaseUrl', RAZORPAY_AUTH_BASE_URL: 'razorpayAuthBaseUrl', SHIPROCKET_BASE_URL: 'shiprocketBaseUrl', SHOPIFY_BASE_URL: 'shopifyBaseUrl',
  WHATSAPP_BASE_URL: 'whatsappBaseUrl', FCM_BASE_URL: 'fcmBaseUrl', APNS_BASE_URL: 'apnsBaseUrl', GOOGLE_OAUTH_BASE_URL: 'googleOauthBaseUrl',
  EAS_BASE_URL: 'easBaseUrl', APPSTORE_BASE_URL: 'appStoreBaseUrl', PLAY_BASE_URL: 'playBaseUrl',
});

/** Base URLs that are a provider of our choosing (no fixed provider address): set in production, but never a simulator. */
export const CHOSEN_PROVIDER_SETTINGS = Object.freeze({ AI_BASE_URL: 'aiBaseUrl', EMAIL_BASE_URL: 'emailBaseUrl', ERROR_SINK_URL: 'errorSinkUrl', SECRETS_URL: 'secretsUrl' });

/** True for an address no production service has: plain http, loopback, a private range or a reserved test name. */
export function looksLikeSimulator(url) {
  const value = text(url);
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  const host = parsed.hostname.replace(/\.+$/, '');
  if (parsed.protocol !== 'https:' || !host) return true;
  if (LOOPBACK.test(host) || TEST_HOST.test(host) || PRIVATE_V4.test(host) || PRIVATE_V6.test(host)) return true;
  // A one-word name ("sim", "secrets") is a container or a hosts-file entry, never a provider's public address.
  return !host.startsWith('[') && !host.includes('.');
}

/** A key or id the provider issues for its test mode. */
export const looksLikeTestKey = (value) => /^(rzp_test_|sk_test_|pk_test_)/i.test(text(value)) || /(^|[_-])(test|sandbox|sim|dummy|example)([_-]|$)/i.test(text(value));

const fromSecretSource = (config, name) => ['file', 'http'].includes(config.secretSources?.[name]);

/** The login (user name) of a database address, or '' when it has none or is not an address. */
export function loginOf(url) {
  try {
    return decodeURIComponent(new URL(text(url)).username);
  } catch {
    return '';
  }
}

/** Each rule: id, the settings to change, what must hold, and ok(config) -> boolean. */
export const PRODUCTION_RULES = Object.freeze([
  { id: 'db.two_logins', settings: ['DATABASE_URL', 'DATABASE_OWNER_URL'], must: 'two database logins: the restricted app role and the owner', ok: (c) => Boolean(loginOf(c.databaseUrl) && loginOf(c.databaseOwnerUrl) && loginOf(c.databaseUrl) !== loginOf(c.databaseOwnerUrl)) },
  { id: 'storage.object', settings: ['STORAGE_DRIVER', 'S3_BUCKET', 'S3_ENDPOINT'], must: 'object storage, not a local folder or a test endpoint', ok: (c) => c.storageDriver === 's3' && Boolean(text(c.s3Bucket)) && !looksLikeSimulator(c.s3Endpoint) },
  { id: 'queue.redis', settings: ['QUEUE_DRIVER', 'REDIS_URL'], must: 'the queue on Redis', ok: (c) => c.queueDriver === 'redis' && Boolean(text(c.redisUrl)) },
  { id: 'cache.redis', settings: ['CACHE_DRIVER', 'REDIS_URL'], must: 'the cache on Redis, not in memory', ok: (c) => c.cacheDriver === 'redis' && Boolean(text(c.redisUrl)) },
  { id: 'secrets.data_key', settings: ['DATA_KEY', 'SECRETS_DRIVER'], must: 'DATA_KEY from a mounted file or a secret manager', ok: (c) => Boolean(text(c.dataKey)) && fromSecretSource(c, 'DATA_KEY') },
  { id: 'secrets.envelope', settings: ['SECRETS_FORMAT'], must: 'envelope encryption (v2) for stored secrets', ok: (c) => c.secretsFormat === 'v2' },
  { id: 'secrets.session', settings: ['SESSION_SECRET'], must: 'a fixed session secret, the same on every server', ok: (c) => Boolean(c.secretSources?.SESSION_SECRET) },
  { id: 'providers.no_simulator', settings: Object.keys(SIMULATOR_SETTINGS), must: 'no provider address override', ok: (c) => Object.values(SIMULATOR_SETTINGS).every((key) => !text(c[key])) },
  { id: 'providers.no_test_address', settings: Object.keys(CHOSEN_PROVIDER_SETTINGS), must: 'https addresses of real services', ok: (c) => Object.values(CHOSEN_PROVIDER_SETTINGS).every((key) => !looksLikeSimulator(c[key])) },
  { id: 'providers.no_test_key', settings: ['RAZORPAY_KEY_ID', 'RAZORPAY_BILLING_KEY_ID', 'APNS_ENV'], must: 'live keys, not test-mode ones', ok: (c) => !looksLikeTestKey(c.razorpayKeyId) && !looksLikeTestKey(c.razorpayBillingKeyId) && c.apnsEnv !== 'sandbox' },
  { id: 'auth.no_password_login', settings: ['PASSWORD_LOGIN'], must: 'no password login', ok: (c) => !c.passwordLogin },
  { id: 'auth.no_env_owner', settings: ['ADMIN_PASSWORD'], must: 'no owner password in the configuration', ok: (c) => !text(c.adminPassword) },
  { id: 'metrics.token', settings: ['METRICS_TOKEN'], must: 'a metrics token of 24 characters or more', ok: (c) => text(c.metricsToken).length >= 24 },
  { id: 'hosts.platform', settings: ['PLATFORM_DOMAIN', 'PLATFORM_HOST', 'PUBLIC_BASE_URL'], must: 'the platform domain and host set, and an https public address', ok: (c) => Boolean(text(c.platformDomain)) && Boolean(text(c.platformHost) || text(c.platformDomain)) && /^https:\/\//.test(text(c.publicBaseUrl)) && !looksLikeSimulator(c.publicBaseUrl) },
  { id: 'sending.live', settings: ['DRY_RUN'], must: 'DRY_RUN off', ok: (c) => !c.dryRun },
  { id: 'fetch.no_transport', settings: [], must: 'no test transport on the fetcher', ok: (c) => !c.safeFetchTransport },
].map(Object.freeze));

/** The rules the config breaks: [{ id, settings, must }]. No value of any setting is in the answer. */
export function productionProblems(config, rules = PRODUCTION_RULES) {
  return rules.filter((rule) => {
    try {
      return !rule.ok(config);
    } catch {
      return true;
    }
  }).map(({ id, settings, must }) => ({ id, settings, must }));
}

export const isProduction = (env = process.env) => text(env.NODE_ENV).toLowerCase() === 'production';
export const deployEnvOf = (config, env = process.env) => {
  const value = text(config?.deployEnv || env.DEPLOY_ENV).toLowerCase();
  return value === 'prod' ? 'production' : value;
};

export class ProductionGuardError extends Error {
  constructor(problems) {
    super(`This configuration cannot run production. Fix: ${problems.map((p) => `${p.id} (${p.settings.join(', ') || 'configuration'}: ${p.must})`).join('; ')}`);
    this.name = 'ProductionGuardError';
    this.problems = problems;
  }
}

/**
 * Called at start. With DEPLOY_ENV=production (or prod) a broken rule throws ProductionGuardError, whatever NODE_ENV is.
 * Otherwise, under NODE_ENV=production, it answers the broken rules for the log; outside both it does nothing and answers [].
 */
export function guardProduction(config, env = process.env) {
  const enforced = deployEnvOf(config, env) === 'production';
  if (!enforced && !isProduction(env)) return [];
  const problems = productionProblems(config);
  if (problems.length && enforced) throw new ProductionGuardError(problems);
  return problems;
}
