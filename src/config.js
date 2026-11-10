import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rootDir,
  // Instagram / Meta
  appSecret: process.env.APP_SECRET || '',
  verifyToken: process.env.VERIFY_TOKEN || '',
  graphVersion: process.env.GRAPH_VERSION || 'v23.0',
  // Empty is Instagram itself. Tests and local runs point this at a simulator.
  graphBaseUrl: process.env.GRAPH_BASE_URL || '',
  dryRun: process.env.DRY_RUN === '1',
  oneDmPerUser: process.env.ONE_DM_PER_USER === '1',
  // Web
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  // What /admin serves: 'console' is the React app (build it with npm run build:console); anything else, the old server-rendered pages.
  adminUi: process.env.ADMIN_UI || 'legacy',
  consoleDir: process.env.CONSOLE_DIR || path.join(rootDir, 'console', 'dist'),
  // Store owner: logs in on /login with this phone + password and gets the admin role.
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Without SESSION_SECRET, everyone is logged out when the server restarts.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // Database: Postgres connection string, required at runtime. Empty works only with NODE_ENV=test or
  // ALLOW_PGLITE=1, for quick local runs on the built-in database in data/pgdata (one process at a time).
  databaseUrl: process.env.DATABASE_URL || '',
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data', 'pgdata'),
  // Businesses (tenants). Each business is found from the web address:
  //   <slug>.PLATFORM_DOMAIN (e.g. mehtamart.bhavahq.com), or a custom domain added for it.
  // DEFAULT_TENANT is the business served on any other address, and the one webhooks fall back to;
  // it is created on start if missing. Leave it empty once every business has its own address.
  platformDomain: (process.env.PLATFORM_DOMAIN || '').toLowerCase(),
  // Where Bhava's own team signs in. Empty means admin.PLATFORM_DOMAIN.
  platformHost: (process.env.PLATFORM_HOST || '').toLowerCase(),
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
  defaultTenant: process.env.DEFAULT_TENANT ?? 'default',
  defaultTenantName: process.env.DEFAULT_TENANT_NAME || 'My store',
};
