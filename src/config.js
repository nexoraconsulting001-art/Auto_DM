import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rootDir,
  // Instagram / Meta
  accessToken: process.env.IG_ACCESS_TOKEN || '',
  igUserId: process.env.IG_USER_ID || '',
  appSecret: process.env.APP_SECRET || '',
  verifyToken: process.env.VERIFY_TOKEN || '',
  graphVersion: process.env.GRAPH_VERSION || 'v23.0',
  dryRun: process.env.DRY_RUN === '1',
  oneDmPerUser: process.env.ONE_DM_PER_USER === '1',
  // Web
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  // Store owner: logs in on /login with this phone + password and gets the admin role.
  adminPhone: process.env.ADMIN_PHONE || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Without SESSION_SECRET, everyone is logged out when the server restarts.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // Sharing the Instagram account with another app (e.g. the Auto DM plugin for another brand):
  // comments on reels this store doesn't use are passed on, unchanged, to FORWARD_WEBHOOK_URL,
  // and /l/<slug> links in that app's DMs are redirected to PLUGIN_URL/r/<slug>.
  forwardWebhookUrl: process.env.FORWARD_WEBHOOK_URL || '',
  pluginUrl: (process.env.PLUGIN_URL || '').replace(/\/+$/, ''),
  // Database: Postgres connection string. Empty uses the built-in database in data/pgdata, which is only
  // for tests and quick local runs (one process at a time).
  databaseUrl: process.env.DATABASE_URL || '',
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data', 'pgdata'),
  // Businesses (tenants). Each business is found from the web address:
  //   <slug>.PLATFORM_DOMAIN (e.g. mehtamart.bhavahq.com), or a custom domain added for it.
  // DEFAULT_TENANT is the business served on any other address, and the one webhooks fall back to;
  // it is created on start if missing. Leave it empty once every business has its own address.
  platformDomain: (process.env.PLATFORM_DOMAIN || '').toLowerCase(),
  defaultTenant: process.env.DEFAULT_TENANT ?? 'default',
  defaultTenantName: process.env.DEFAULT_TENANT_NAME || 'My store',
};
