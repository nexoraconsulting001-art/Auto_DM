import { createPush } from '../../adapters/push/index.js';
import { readApnsKey } from '../../adapters/push/apns.js';
import { readServiceAccount } from '../../adapters/push/fcm.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';

/**
 * The one sender of a push to a shopper (PRD 10.11). It asks the notifications module's push adapter for a sender built
 * with this business's own FCM project and APNs key (forCredentials), and with nothing else: the platform's own project and
 * key are never used for a shopper, so the base adapter is made with no driver at all. Close it after the batch.
 *
 *   senderFor(ctx) -> { send(message), configured(platform), close() }     inside withTenant, for that business only
 *   checkServiceAccount(text) -> { projectId, clientEmail }                  what saving a Firebase service account checks
 *   checkApnsKey(text)                                                       what saving a .p8 key checks
 *
 * A credential that cannot be decrypted or read leaves that platform not configured: nothing is sent there and the log
 * says which platform, never a word of the credential.
 */
export function checkServiceAccount(text) {
  let account;
  try {
    account = readServiceAccount(String(text ?? ''));
  } catch {
    throw Object.assign(new ValidationError('Upload the service account file from your Firebase project'), { fields: { 'fcm.serviceAccount': 'This isn’t a Firebase service account file' } });
  }
  let projectId = '';
  try {
    const raw = String(text).trim().startsWith('{') ? String(text) : Buffer.from(String(text), 'base64').toString('utf8');
    projectId = String(JSON.parse(raw).project_id ?? '');
  } catch {
    projectId = '';
  }
  if (!/^[a-z][a-z0-9-]{3,79}$/.test(projectId)) {
    throw Object.assign(new ValidationError('The service account file has no Firebase project id'), { fields: { 'fcm.serviceAccount': 'The file has no project id' } });
  }
  if (account.clientEmail.length > 254) throw Object.assign(new ValidationError('The service account’s email is too long'), { fields: { 'fcm.serviceAccount': 'The file’s email is too long' } });
  return { projectId, clientEmail: account.clientEmail };
}

export function checkApnsKey(text) {
  try {
    readApnsKey(text);
  } catch {
    throw Object.assign(new ValidationError('Upload the .p8 key from your Apple developer account'), { fields: { 'apns.key': 'This isn’t an APNs .p8 key' } });
  }
}

/** The business's own push credentials, decrypted, as forCredentials takes them; a platform that is not usable is left out. */
async function loadCredentials(ctx) {
  const [row] = await ctx.db.query('SELECT * FROM app_push_credentials WHERE tenant_id = $1', [tenantId()]);
  if (!row) return {};
  const [config] = await ctx.db.query('SELECT ios_bundle_id FROM app_configs WHERE tenant_id = $1', [tenantId()]);
  const creds = {};
  const decrypt = (value, platform) => {
    try {
      return ctx.platform.secrets.decrypt(value);
    } catch {
      log.warn('shopper_push.credentials_unreadable', { platform });
      return null;
    }
  };
  if (row.fcm_service_account_enc && row.fcm_status !== 'invalid' && row.fcm_project_id) {
    const serviceAccount = decrypt(row.fcm_service_account_enc, 'android');
    if (serviceAccount) creds.fcm = { projectId: row.fcm_project_id, serviceAccount };
  }
  const topic = config?.ios_bundle_id || row.apns_topic;
  if (row.apns_key_enc && row.apns_status !== 'invalid' && row.apns_key_id && row.apns_team_id && topic) {
    const key = decrypt(row.apns_key_enc, 'ios');
    if (key) creds.apns = { keyId: row.apns_key_id, teamId: row.apns_team_id, key, topic, env: row.apns_env };
  }
  return creds;
}

const EMPTY = Object.freeze({ configured: () => false, send: async () => ({ ok: false, reason: 'not_configured' }), close: () => {} });

function build(ctx, creds) {
  // No driver of its own: only the brand's credentials below ever send.
  const base = createPush({ ...ctx.config, pushDriver: 'none' });
  const usable = {};
  for (const [name, value] of Object.entries(creds)) {
    try {
      base.forCredentials({ [name]: value }).close?.();
      usable[name] = value;
    } catch {
      log.warn('shopper_push.credentials_unusable', { platform: name === 'fcm' ? 'android' : 'ios' });
    }
  }
  if (!Object.keys(usable).length) return EMPTY;
  return base.forCredentials(usable);
}

export async function senderFor(ctx) {
  const sender = build(ctx, await loadCredentials(ctx));
  return {
    configured: (platform) => sender.configured(platform),
    send: (message) => sender.send(message),
    close: () => {
      try {
        sender.close?.();
      } catch {
        /* closing a connection that already went is fine */
      }
    },
  };
}
