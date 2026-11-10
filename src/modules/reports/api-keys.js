import crypto from 'node:crypto';
import { REPORTING_KEY_PREFIX, REPORTING_SCOPE } from '../../contracts/analytics.js';
import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';

/**
 * Reporting API keys (7.13): per business, made and revoked by the owner only, read-only (analytics:read), shown once and stored as a hash. A key is
 * 32 random bytes, so a plain SHA-256 is enough to look it up and can't be reversed.
 */
const KEY_BYTES = 32;
const SHOWN_PREFIX = REPORTING_KEY_PREFIX.length + 6;

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
/** A key as we would have issued it: the prefix and 43 base64url characters. Anything else is not looked up at all. */
export const looksLikeKey = (key) => typeof key === 'string' && key.length === REPORTING_KEY_PREFIX.length + 43 && key.startsWith(REPORTING_KEY_PREFIX) && /^[\w-]+$/.test(key.slice(REPORTING_KEY_PREFIX.length));

const toKey = (row) => ({ id: row.id, name: row.name, prefix: row.key_prefix, scope: row.scope, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });

export function createApiKeys({ db, repos }) {
  async function list({ cursor, limit }) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
    const rows = await db.query('SELECT * FROM reporting_api_keys WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [tenantId(), after, limit + 1]);
    const page = pageOfFetched(rows, limit, (row) => [row.id]);
    return { items: page.items.map(toKey), nextCursor: page.nextCursor };
  }

  async function create({ name }, user) {
    if (!(await repos.entitlements.can('reporting.api'))) throw new ApiError('forbidden', 'The reporting API is available from tier 2.');
    const key = `${REPORTING_KEY_PREFIX}${crypto.randomBytes(KEY_BYTES).toString('base64url')}`;
    const prefix = key.slice(0, SHOWN_PREFIX);
    const row = await db.tx(async (t) => {
      const [saved] = await t.query(
        `INSERT INTO reporting_api_keys (tenant_id, name, key_prefix, key_hash, scope, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId(), name, prefix, hashKey(key), REPORTING_SCOPE, user.id],
      );
      await writeAudit(t, { actor: `user:${user.id}`, action: 'reporting_key.created', target: `reporting_key:${saved.id}`, details: { keyId: saved.id, name, key: `${prefix}…`, scope: REPORTING_SCOPE } });
      return saved;
    });
    return { ...toKey(row), key };
  }

  /** Revoking takes effect on the next call. Revoking twice is harmless; another business's key is not found. */
  async function revoke(id, user) {
    return db.tx(async (t) => {
      const [row] = await t.query('SELECT id, key_prefix, revoked_at FROM reporting_api_keys WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
      if (!row) return false;
      if (row.revoked_at) return true;
      await t.query('UPDATE reporting_api_keys SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), id, user.id]);
      await writeAudit(t, { actor: `user:${user.id}`, action: 'reporting_key.revoked', target: `reporting_key:${id}`, details: { keyId: id, key: `${row.key_prefix}…` } });
      return true;
    });
  }

  return { list, create, revoke };
}

/** Finds a key by its hash, across businesses: the key is the only thing that says which business a reporting call is for. */
export async function findKey(db, key) {
  if (!looksLikeKey(key)) return null;
  const [row] = await db.platform.query(
    `SELECT k.id, k.tenant_id, k.revoked_at, t.slug, t.name, t.status, t.timezone FROM reporting_api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = $1`,
    [hashKey(key)],
  );
  return row ?? null;
}

/** Last used, kept to the minute so a busy key doesn't write on every call. A revoked key's is never touched. */
export const touchKey = (db, id) => db.platform.query(
  `UPDATE reporting_api_keys SET last_used_at = now() WHERE id = $1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
  [id],
);
