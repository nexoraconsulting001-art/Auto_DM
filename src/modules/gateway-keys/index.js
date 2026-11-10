import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { writeAudit } from '../audit/index.js';

/** What the audit log may show of a key id: rzp_...1234. */
export const maskKeyId = (keyId) => `${String(keyId).startsWith('rzp_') ? 'rzp_' : ''}...${String(keyId).slice(-4)}`;

/** A business's own payment gateway keys. The secret is encrypted here and decrypted only when it is about to be used. */
export function gatewayKeysRepo(db, { secrets }) {
  return {
    /** Replaces the keys. The masked audit row is written in the same transaction, so no change goes unrecorded. */
    async save(provider, { keyId, keySecret }, actor) {
      if (!secrets.configured) throw new ValidationError('Payment keys can’t be stored yet. Please contact support.');
      const encrypted = secrets.encrypt(keySecret);
      await db.tx(async (t) => {
        const [before] = await t.query('SELECT key_id FROM gateway_keys WHERE tenant_id = $1 AND provider = $2 FOR UPDATE', [tenantId(), provider]);
        await t.query(
          `INSERT INTO gateway_keys (tenant_id, provider, key_id, key_secret_enc) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, provider) DO UPDATE SET key_id = EXCLUDED.key_id, key_secret_enc = EXCLUDED.key_secret_enc, updated_at = now()`,
          [tenantId(), provider, keyId, encrypted],
        );
        await writeAudit(t, {
          actor,
          action: 'payment_keys.change',
          target: provider,
          details: { from: before ? maskKeyId(before.key_id) : null, to: maskKeyId(keyId), secretChanged: true },
        });
      });
    },
    /** { keyId, keySecret }, or null when this business has not connected its own account. */
    async get(provider) {
      const [row] = await db.query('SELECT key_id, key_secret_enc FROM gateway_keys WHERE tenant_id = $1 AND provider = $2', [tenantId(), provider]);
      return row ? { keyId: row.key_id, keySecret: secrets.decrypt(row.key_secret_enc) } : null;
    },
  };
}

export const gatewayKeys = {
  name: 'gateway-keys',
  repos: (db, { secrets }) => ({ gatewayKeys: gatewayKeysRepo(db, { secrets }) }),
};
