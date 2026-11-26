import { z } from 'zod';

/**
 * The secrets store's contract (PRD 5.15; Phase 9). The cipher is src/platform/secrets.js; where platform secrets come
 * from is src/platform/secret-source.js; the re-wrap job is src/modules/secret-rotation.
 *
 * SECRET_COLUMNS lists every column that holds a value written by platform.secrets.encrypt(). The contract test reads
 * the schema and fails when a column ending `_enc` is missing here, so a new encrypted column joins the list in the
 * migration that adds it. `key` is the table's primary key, in order: the re-wrap job walks a table by it and keeps
 * the last key it finished in secret_rewraps.last_id (the parts joined by a comma). `tenant` says whether the table is a
 * business's (walked on the platform path all the same: the job belongs to no business). An empty string in a column
 * means "no value" and is skipped, as NULL is.
 *
 * `kind` groups them for the checklist and the runbook, and for nothing else.
 *
 * `bind` is the row's identity a value is sealed to (R2-SEC-1): its columns' values, with the table and the column, make
 * the record binding (secretBinding()) every caller passes to platform.secrets.encrypt() and decrypt(), and the re-wrap job
 * reads them with each row. By default it is the primary key, with tenant_id first for a business's table; a row whose id
 * is not known when its value is written is bound to a natural key that is (push_devices, store_access). A value copied
 * to another business's row, another row or another column does not open there.
 */
export const SECRET_KINDS = Object.freeze(['token', 'gateway', 'courier', 'shopify', 'push', 'totp', 'store_key', 'tag', 'shopper']);

const column = (table, name, key, kind, tenant = true, bind = null) => {
  const sealedTo = bind ?? (tenant && !key.includes('tenant_id') ? ['tenant_id', ...key] : key);
  return Object.freeze({ table, column: name, key: Object.freeze(key), kind, tenant, bind: Object.freeze([...sealedTo]) });
};

export const SECRET_COLUMNS = Object.freeze([
  column('ig_accounts', 'access_token_enc', ['tenant_id', 'ig_user_id'], 'token'),
  column('fb_pages', 'access_token_enc', ['tenant_id', 'page_id'], 'token'),
  column('oauth_states', 'pending_login_enc', ['state_hash'], 'token'),
  column('whatsapp_accounts', 'access_token_enc', ['tenant_id'], 'token'),
  column('gateway_keys', 'key_secret_enc', ['tenant_id', 'provider'], 'gateway'),
  column('payment_settings', 'oauth_access_enc', ['tenant_id'], 'gateway'),
  column('payment_settings', 'oauth_refresh_enc', ['tenant_id'], 'gateway'),
  column('payment_settings', 'webhook_secret_enc', ['tenant_id'], 'gateway'),
  column('shipping_settings', 'own_password_enc', ['tenant_id'], 'courier'),
  column('shopify_connections', 'access_token_enc', ['tenant_id'], 'shopify'),
  column('shopify_connections', 'webhook_secret_enc', ['tenant_id'], 'shopify'),
  column('push_devices', 'token_enc', ['id'], 'push', false, ['person_id', 'device_id']),
  column('shopper_push_devices', 'token_enc', ['id'], 'push'),
  column('app_push_credentials', 'fcm_service_account_enc', ['tenant_id'], 'push'),
  column('app_push_credentials', 'apns_key_enc', ['tenant_id'], 'push'),
  column('platform_users', 'totp_secret_enc', ['id'], 'totp', false),
  column('store_access', 'key_enc', ['id'], 'store_key', true, ['tenant_id', 'platform']),
  column('tag_settings', 'meta_capi_token_enc', ['tenant_id'], 'tag'),
  column('tag_settings', 'ga4_api_secret_enc', ['tenant_id'], 'tag'),
  column('shared_profiles', 'phone_enc', ['id'], 'shopper', false),
  column('shared_profiles', 'name_enc', ['id'], 'shopper', false),
  column('shared_addresses', 'address_enc', ['id'], 'shopper', false, ['id', 'profile_id']),
]);

/** The SECRET_COLUMNS entry of a table's column, or an error: a value is sealed only to a listed column. */
export function secretColumn(table, columnName) {
  const found = SECRET_COLUMNS.find((c) => c.table === table && c.column === columnName);
  if (!found) throw new Error(`${table}.${columnName} is not in SECRET_COLUMNS`);
  return found;
}

/**
 * The record binding of a value in `table`.`column` of `row` (R2-SEC-1): a text naming the table, the column and the
 * values of the column's `bind` columns, read from `row` (an object with those columns as keys; a number and its text
 * are the same). Throws when one of them is missing, so a value is never sealed to half a record. It names ids only.
 */
export function secretBinding(table, columnName, row) {
  const def = secretColumn(table, columnName);
  const values = def.bind.map((name) => {
    const value = row?.[name];
    if (value === undefined || value === null || value === '') throw new Error(`${table}.${columnName} is sealed to ${name}, which is missing`);
    return [name, String(value)];
  });
  return JSON.stringify(['bhava.secret', def.table, def.column, values]);
}

/** secret_rewraps.status (migration 900). One row per column and target key: `done` once every row is under that key. */
export const REWRAP_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed']);

/** The job the secret-rotation module registers, and how many rows it takes per step (each step is its own transaction). */
export const REWRAP_JOB = 'secrets.rewrap';
export const REWRAP_BATCH = 200;

/** What the re-wrap job reports: per column, how far it is. Never a value, a key or a business. */
export const RewrapProgress = z.object({
  keyId: z.string(),
  format: z.enum(['v1', 'v2']),
  columns: z.array(z.object({ table: z.string(), column: z.string(), status: z.enum(REWRAP_STATUSES), lastId: z.string(), done: z.number().int().min(0) })),
  finished: z.boolean(),
});

/**
 * An old master key may be dropped from DATA_KEY_OLD only when every column is `done` for the current key and format
 * (F-66): the runbook and the go-live checklist both ask this, and it answers false for an empty or partial list.
 * `rows` are secret_rewraps rows as { table, column, keyId, format, status }.
 */
export function oldKeysRetirable(rows, { keyId, format = 'v2' }) {
  const done = new Set(rows.filter((r) => r.keyId === keyId && r.format === format && r.status === 'done').map((r) => `${r.table}.${r.column}`));
  return SECRET_COLUMNS.every((c) => done.has(`${c.table}.${c.column}`));
}

/** Addresses in errors and logs (F-67): the login and the query values replaced, and any bearer or basic credential. */
export function redactUrl(text) {
  return String(text ?? '')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&][^=&#\s]{1,64}=)[^&#\s]+/g, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]');
}
