import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 1 or 0 when set; otherwise on only under test: NODE_ENV=test, or inside node's own test runner. */
function passwordLoginFrom(env) {
  if (env.PASSWORD_LOGIN !== undefined && env.PASSWORD_LOGIN !== '') return env.PASSWORD_LOGIN === '1';
  return env.NODE_ENV === 'test' || (env.NODE_ENV !== 'production' && Boolean(env.NODE_TEST_CONTEXT));
}
const list = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
/** "a=b,c=d" as { a: 'b', c: 'd' }. */
const pairs = (value) => Object.fromEntries(list(value).map((item) => item.split('=').map((part) => part.trim())).filter(([key, to]) => key && to));

export const config = {
  rootDir,
  // Instagram / Meta
  appSecret: process.env.APP_SECRET || '',
  verifyToken: process.env.VERIFY_TOKEN || '',
  graphVersion: process.env.GRAPH_VERSION || 'v23.0',
  // Empty is Instagram itself. Tests and local runs point this at a simulator, and the Meta addresses below follow it.
  graphBaseUrl: process.env.GRAPH_BASE_URL || '',
  igDialogBaseUrl: process.env.IG_DIALOG_BASE_URL || '',
  igApiBaseUrl: process.env.IG_API_BASE_URL || '',
  fbGraphBaseUrl: process.env.FB_GRAPH_BASE_URL || '',
  fbDialogBaseUrl: process.env.FB_DIALOG_BASE_URL || '',
  metaTimeoutMs: Number(process.env.META_TIMEOUT_MS) || 10_000,
  // GA4 Measurement Protocol, for the seller's own property (PRD 7.14). Empty is Google itself; tests and local runs point it at a simulator.
  ga4BaseUrl: process.env.GA4_BASE_URL || '',
  // Ask Meta for read receipts (messaging_seen), which the funnel's Seen step needs. Off until the live check confirms it for Instagram Login (PRD 7.15).
  readReceipts: process.env.READ_RECEIPTS === '1',
  // The one address registered with Meta for login redirects and callbacks. Empty means PUBLIC_BASE_URL.
  metaCallbackBaseUrl: (process.env.META_CALLBACK_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  // Which login connects Instagram: 'instagram' (Instagram Login) or 'unified' (Facebook Login for Business).
  metaLogin: process.env.META_LOGIN || 'instagram',
  igAppId: process.env.IG_APP_ID || '',
  // Facebook Login is a separate Meta app. It is used for Facebook Pages, and for Instagram when META_LOGIN=unified.
  fbAppId: process.env.FB_APP_ID || '',
  fbAppSecret: process.env.FB_APP_SECRET || '',
  facebookPages: process.env.FACEBOOK_PAGES === '1',
  dryRun: process.env.DRY_RUN === '1',
  oneDmPerUser: process.env.ONE_DM_PER_USER === '1',
  // Web
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  // /admin is always the React app (build it with npm run build:console); the value only decides which code path mounts it.
  adminUi: process.env.ADMIN_UI || 'legacy',
  consoleDir: process.env.CONSOLE_DIR || path.join(rootDir, 'console', 'dist'),
  // The Platform Console's own build, served at /console on the platform host and nowhere else.
  platformConsoleDir: process.env.PLATFORM_CONSOLE_DIR || path.join(rootDir, 'console', 'dist-platform'),
  // Store owner: logs in on /login with this phone + password and gets the admin role.
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Without SESSION_SECRET, everyone is logged out when the server restarts.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // Database: Postgres connection string, required at runtime. Empty works only with NODE_ENV=test or
  // ALLOW_PGLITE=1, for quick local runs on the built-in database in data/pgdata (one process at a time).
  databaseUrl: process.env.DATABASE_URL || '',
  // With this set there are two logins: DATABASE_URL is the restricted app role (all business work) and this is the
  // owner of the tables (migrations, backups and the platform paths). Empty: DATABASE_URL is the owner and does both.
  databaseOwnerUrl: process.env.DATABASE_OWNER_URL || '',
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data', 'pgdata'),
  // Businesses (tenants). Each business is found from the web address:
  //   <slug>.PLATFORM_DOMAIN (e.g. mehtamart.shopsdomain.example), or a custom domain added for it.
  // DEFAULT_TENANT is the business served on any other address, and the one webhooks fall back to;
  // it is created on start if missing. Leave it empty once every business has its own address.
  platformDomain: (process.env.PLATFORM_DOMAIN || '').toLowerCase(),
  // Where Bhava's own team signs in. Empty means admin.PLATFORM_DOMAIN.
  platformHost: (process.env.PLATFORM_HOST || '').toLowerCase(),
  // Where sellers sign in: the owner app and the web sign-in page talk to /api/v1 here. It belongs to no business.
  // Empty means app.PLATFORM_DOMAIN (see platformAppHostOf).
  platformAppHost: (process.env.PLATFORM_APP_HOST || '').toLowerCase(),
  // Bhava's own website, where a new seller signs up: the Free plan's creator page badge links here with the business's
  // referral code (PRD 5.20, 8.14). Empty means https://<the sellers' host>/signup (see platformSiteUrlOf).
  platformSiteUrl: (process.env.PLATFORM_SITE_URL || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, ''),
  // Seller sign-in (PRD 5.11, 10.2). There are no passwords: PASSWORD_LOGIN keeps the Phase 0 phone-and-password login for
  // tests and local runs only. It defaults to on under test and off otherwise, and the server refuses to start with it in production.
  passwordLogin: passwordLoginFrom(process.env),
  accessTokenMinutes: positive(process.env.ACCESS_TOKEN_MINUTES, 15),
  refreshTokenDays: positive(process.env.REFRESH_TOKEN_DAYS, 60),
  // Google sign-in for sellers: its own OAuth client, apart from the shoppers' one below. GOOGLE_KEYS_BASE_URL points the
  // sign-in page, the code exchange and the signing keys at tools/sim/google; empty is Google itself.
  sellerGoogleClientId: process.env.SELLER_GOOGLE_CLIENT_ID || '',
  sellerGoogleClientSecret: process.env.SELLER_GOOGLE_CLIENT_SECRET || '',
  googleKeysBaseUrl: process.env.GOOGLE_KEYS_BASE_URL || '',
  // Sign in with Apple: the audiences an identity token may be for (the owner app's bundle id, and the Services ID for the web).
  // APPLE_KEYS_BASE_URL points the signing keys at tools/sim/apple; empty is Apple itself.
  appleSigninAudiences: list(process.env.APPLE_SIGNIN_AUDIENCES),
  appleKeysBaseUrl: process.env.APPLE_KEYS_BASE_URL || '',
  // App Review's fixed login (PRD 5.11, 10.6): the review number in E.164 and the hash of its code (codeHash in src/contracts/accounts.js, keyed with SESSION_SECRET).
  // Both empty turns it off. The code itself is never in the environment.
  reviewLoginPhone: process.env.REVIEW_LOGIN_PHONE || '',
  reviewLoginCodeHash: process.env.REVIEW_LOGIN_CODE_HASH || '',
  // Switchable modules (see src/platform/index.js). QA defaults shown; production changes these only.
  storageDriver: process.env.STORAGE_DRIVER || 'local',
  storageDir: process.env.STORAGE_DIR || path.join(rootDir, 'data', 'files'),
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || '',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
  queueDriver: process.env.QUEUE_DRIVER || 'pg',
  analyticsDriver: process.env.ANALYTICS_DRIVER || 'pg',
  cacheDriver: process.env.CACHE_DRIVER || 'memory',
  redisUrl: process.env.REDIS_URL || '',
  clickhouseUrl: process.env.CLICKHOUSE_URL || '',
  clickhouseDb: process.env.CLICKHOUSE_DB || 'bhava',
  // safeFetch (PRD 8.2): the gap between two requests to one outside host, across every business and process. Tests pass a
  // safeFetchTransport ({ lookup, dial } from tools/sim/sites) in config, never through the environment; it is refused in production.
  fetchHostGapMs: Number(process.env.FETCH_HOST_GAP_MS) || 1000,
  // Nightly database backup, stored off the server. Empty BACKUP_STORAGE_DRIVER turns backups off.
  backupStorageDriver: process.env.BACKUP_STORAGE_DRIVER || '',
  backupStorageDir: process.env.BACKUP_STORAGE_DIR || '',
  backupS3Bucket: process.env.BACKUP_S3_BUCKET || '',
  backupS3Region: process.env.BACKUP_S3_REGION || '',
  backupS3Endpoint: process.env.BACKUP_S3_ENDPOINT || '',
  backupS3AccessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
  backupS3SecretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
  workerHealthPort: Number(process.env.WORKER_HEALTH_PORT) || 3001,
  // Encrypts stored tokens and keys (see src/platform/secrets.js).
  dataKey: process.env.DATA_KEY || '',
  dataKeyOld: process.env.DATA_KEY_OLD || '',
  // /metrics is served only with this token (Authorization: Bearer <token>).
  metricsToken: process.env.METRICS_TOKEN || '',
  // The store's outside services (PRD 9, src/adapters/store.js). An empty base URL is the provider itself; tests and local runs point each
  // at its simulator in tools/sim, which is refused when NODE_ENV=production. Every call times out after PROVIDER_TIMEOUT_MS.
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS) || 10_000,
  // Razorpay. PAYMENT_MODE is the default for a business that has not chosen: 'managed' (Bhava's account with Route) or 'own'.
  paymentMode: process.env.PAYMENT_MODE === 'own' ? 'own' : 'managed',
  razorpayBaseUrl: process.env.RAZORPAY_BASE_URL || '',
  razorpayAuthBaseUrl: process.env.RAZORPAY_AUTH_BASE_URL || '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  razorpayPartnerClientId: process.env.RAZORPAY_PARTNER_CLIENT_ID || '',
  razorpayPartnerClientSecret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET || '',
  // Bhava's own billing (PRD 5.12): Razorpay Subscriptions on Bhava's account. The keys default to the two above; the webhook has
  // its own address (/webhooks/billing/razorpay) and its own secret, and without the secret every billing webhook is refused.
  razorpayBillingKeyId: process.env.RAZORPAY_BILLING_KEY_ID || '',
  razorpayBillingKeySecret: process.env.RAZORPAY_BILLING_KEY_SECRET || '',
  razorpayBillingWebhookSecret: process.env.RAZORPAY_BILLING_WEBHOOK_SECRET || '',
  // Where the provider sends the payer back after its hosted page. Empty means the business's own console (/admin/settings/plan).
  billingReturnUrl: (process.env.BILLING_RETURN_URL || '').replace(/\/+$/, ''),
  // Self-serve sign-up (PRD 5.20). The mode itself is a row (signup_settings, set in the Platform Console); this only says where
  // a new business's fallback address is made: <slug>.<SIGNUP_HOST_SUFFIX>. Empty means PLATFORM_DOMAIN.
  signupHostSuffix: (process.env.SIGNUP_HOST_SUFFIX || '').toLowerCase(),
  // Shiprocket: Bhava's master account, and the token its tracking webhook carries.
  shiprocketBaseUrl: process.env.SHIPROCKET_BASE_URL || '',
  shiprocketEmail: process.env.SHIPROCKET_EMAIL || '',
  shiprocketPassword: process.env.SHIPROCKET_PASSWORD || '',
  shiprocketWebhookToken: process.env.SHIPROCKET_WEBHOOK_TOKEN || '',
  // Shopify: each business brings its own shop and token; this only sends every shop to the simulator.
  shopifyBaseUrl: process.env.SHOPIFY_BASE_URL || '',
  // WhatsApp Cloud API: each business brings its own account; the app secret signs its webhooks.
  whatsappBaseUrl: process.env.WHATSAPP_BASE_URL || '',
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || '',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  // The WhatsApp add-on (PRD 6.12): Meta's embedded signup, by which a business connects its own number. The app id and the
  // signup configuration id go to the browser; the code it hands back is exchanged with WHATSAPP_APP_SECRET.
  whatsappAppId: process.env.WHATSAPP_APP_ID || '',
  whatsappSignupConfigId: process.env.WHATSAPP_SIGNUP_CONFIG_ID || '',
  // AI replies (PRD 6.11): 'none' until a model provider is chosen, and then nothing is sent to any provider. Otherwise the
  // wire format ('chat_completions'; 'http' means the same), with the provider's base URL (https), key and model.
  aiDriver: process.env.AI_DRIVER || 'none',
  aiBaseUrl: process.env.AI_BASE_URL || '',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  // Email to shoppers: 'none' until a provider is chosen (PRD 5.4), or 'http'. EMAIL_HOSTS lists the provider origins allowed.
  emailDriver: process.env.EMAIL_DRIVER || 'none',
  emailBaseUrl: process.env.EMAIL_BASE_URL || '',
  emailHosts: process.env.EMAIL_HOSTS || '',
  emailApiKey: process.env.EMAIL_API_KEY || '',
  // The neutral sending domain for a business with no verified domain of its own. Never one with the platform's name in it.
  emailNeutralDomain: (process.env.EMAIL_NEUTRAL_DOMAIN || '').toLowerCase(),
  // Messages to sellers (PRD 5.13), which come from Bhava itself and never reach a shopper. Each channel with nothing set
  // reports not_configured and the others still deliver.
  // WhatsApp: Bhava's own verified number (login codes, alerts). PLATFORM_WHATSAPP_TEMPLATES renames templates, as
  // "login_code=bhava_code_v2,bhava_order_new=order_new_v3", when the approved names differ from the contract's.
  platformWhatsappPhoneId: process.env.PLATFORM_WHATSAPP_PHONE_ID || '',
  platformWhatsappToken: process.env.PLATFORM_WHATSAPP_TOKEN || '',
  platformWhatsappTemplates: pairs(process.env.PLATFORM_WHATSAPP_TEMPLATES),
  platformWhatsappLanguage: process.env.PLATFORM_WHATSAPP_LANGUAGE || 'en',
  // Email: Bhava's sender, over EMAIL_DRIVER above.
  platformEmailFrom: (process.env.PLATFORM_EMAIL_FROM || '').toLowerCase(),
  platformEmailFromName: process.env.PLATFORM_EMAIL_FROM_NAME || 'Bhava',
  // Push to the owner app (PRD 10.5, src/adapters/push): none (nothing is sent), fcm, apns, or fcm,apns. One FCM project
  // and one APNs key serve every business. The base URLs point at tools/sim/push and are refused in production.
  pushDriver: process.env.PUSH_DRIVER || 'none',
  fcmProjectId: process.env.FCM_PROJECT_ID || '',
  fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT || '',
  fcmBaseUrl: process.env.FCM_BASE_URL || '',
  apnsKeyId: process.env.APNS_KEY_ID || '',
  apnsTeamId: process.env.APNS_TEAM_ID || '',
  apnsKey: process.env.APNS_KEY || '',
  apnsTopic: process.env.APNS_TOPIC || '',
  apnsBaseUrl: process.env.APNS_BASE_URL || '',
  apnsEnv: process.env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production',
  // How often the worker hands notifications out and sends what is due.
  notifyPollMs: Number(process.env.NOTIFY_POLL_MS) || 5000,
  // Google sign-in for shoppers (PRD 9.3).
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleOauthBaseUrl: process.env.GOOGLE_OAUTH_BASE_URL || '',
  // How often the worker hands new order events to their listeners.
  orderEventsPollMs: Number(process.env.ORDER_EVENTS_POLL_MS) || 2000,
  // The branded shopper apps (PRD 10.7 to 10.14). Each base URL points its adapter at a simulator in tools/sim, which is refused
  // when NODE_ENV=production; any other host that is not the provider's throws at start. Empty is the provider itself.
  // EAS (src/adapters/eas): builds, store submits and over-the-air updates. Empty EXPO_TOKEN: the eas driver reports not_configured.
  expoToken: process.env.EXPO_TOKEN || '',
  easBaseUrl: process.env.EAS_BASE_URL || '',
  easAccount: process.env.EAS_ACCOUNT || '',
  // The stores (src/adapters/appstores). PLAY_BASE_URL serves both the Play API and its token exchange in a simulator.
  appStoreBaseUrl: process.env.APPSTORE_BASE_URL || '',
  playBaseUrl: process.env.PLAY_BASE_URL || '',
  // Our one Play service account (its JSON, or the base64 of it) that each business invites in its own Play Console.
  playServiceAccount: process.env.PLAY_SERVICE_ACCOUNT || '',
  // The lowest App Store Connect role and the Play permission that may submit (the PRD marks both to confirm).
  appStoreRoleNeeded: process.env.APP_STORE_ROLE_NEEDED || 'APP_MANAGER',
  playPermissionNeeded: process.env.PLAY_PERMISSION_NEEDED || 'RELEASE_TO_PRODUCTION',
  // 'local' builds on our own runner, 'eas' on EAS.
  appBuildDriver: process.env.APP_BUILD_DRIVER === 'eas' ? 'eas' : 'local',
  appBuildPollMs: positive(process.env.APP_BUILD_POLL_MS, 15_000),
  storeReviewPollMs: positive(process.env.STORE_REVIEW_POLL_MS, 900_000),
  // A shopper app's short access token and its rotating refresh token, apart from the sellers' (ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS).
  shopperAccessTokenMinutes: positive(process.env.SHOPPER_ACCESS_TOKEN_MINUTES, 15),
  shopperRefreshTokenDays: positive(process.env.SHOPPER_REFRESH_TOKEN_DAYS, 90),
  // Offers plus new-reel pushes per shopper per week (order updates are never capped).
  shopperPushWeeklyCap: positive(process.env.SHOPPER_PUSH_WEEKLY_CAP, 2),
  shopperPushPollMs: positive(process.env.SHOPPER_PUSH_POLL_MS, 5000),
  // Over-the-air roll back: when the crash rate reaches OTA_CRASH_MULTIPLIER times the baseline and at least OTA_CRASH_FLOOR,
  // after OTA_MIN_LAUNCHES launches in OTA_WINDOW_MINUTES. OTA_BASELINE_CRASH_RATE is used when a runtime has no earlier release.
  otaCrashMultiplier: positive(process.env.OTA_CRASH_MULTIPLIER, 2),
  otaCrashFloor: positive(process.env.OTA_CRASH_FLOOR, 0.01),
  otaMinLaunches: positive(process.env.OTA_MIN_LAUNCHES, 50),
  otaWindowMinutes: positive(process.env.OTA_WINDOW_MINUTES, 60),
  otaBaselineCrashRate: positive(process.env.OTA_BASELINE_CRASH_RATE, 0.005),
  defaultTenant: process.env.DEFAULT_TENANT ?? 'default',
  defaultTenantName: process.env.DEFAULT_TENANT_NAME || 'My store',
};

/** The host where sellers sign in, which belongs to no business: PLATFORM_APP_HOST, or app.PLATFORM_DOMAIN. Empty when neither is set. */
export function platformAppHostOf(cfg = config) {
  if (cfg.platformAppHost) return String(cfg.platformAppHost).toLowerCase();
  return cfg.platformDomain ? `app.${String(cfg.platformDomain).toLowerCase()}` : '';
}

/** The https address of the sign-up page that referral links point at: PLATFORM_SITE_URL, or /signup on the sellers' host. '' when unknown. */
export function platformSiteUrlOf(cfg = config) {
  const set = String(cfg.platformSiteUrl ?? '');
  if (/^https:\/\/[^\s"'<>\\?#]+$/i.test(set)) return set;
  const host = platformAppHostOf(cfg);
  return /^[a-z0-9.-]+(:\d+)?$/.test(host) ? `https://${host}/signup` : '';
}

/** Settings a production server must not start with. Throws with the name of the setting. */
export function assertStartable(cfg = config, env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') return;
  if (cfg.passwordLogin) throw new Error('PASSWORD_LOGIN is on. Sellers sign in without passwords: remove it before starting in production.');
}
