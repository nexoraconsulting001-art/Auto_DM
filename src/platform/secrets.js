import crypto from 'node:crypto';

/**
 * Encrypts tokens and keys before they are stored (Instagram tokens, gateway, Shiprocket and Shopify
 * keys). AES-256-GCM with DATA_KEY: 32 random bytes, base64. Generate one with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * To rotate, move the old key to DATA_KEY_OLD and set a new DATA_KEY; old values still decrypt and
 * are re-encrypted with the new key when next saved.
 *
 * Stored form: "v1.<key id>.<iv>.<tag>.<ciphertext>" (base64url parts).
 */
export function createSecrets({ dataKey, dataKeyOld } = {}) {
  const keys = new Map();
  const add = (b64) => {
    const key = Buffer.from(String(b64), 'base64');
    if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded');
    const id = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);
    keys.set(id, key);
    return id;
  };
  const currentId = dataKey ? add(dataKey) : null;
  if (dataKeyOld) add(dataKeyOld);

  return {
    configured: Boolean(currentId),
    encrypt(plaintext) {
      if (!currentId) throw new Error('DATA_KEY is not set, so secrets cannot be stored');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(currentId), iv);
      const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', currentId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(stored) {
      const [v, id, iv, tag, ct] = String(stored).split('.');
      if (v !== 'v1' || !ct) throw new Error('Not an encrypted value');
      const key = keys.get(id);
      if (!key) throw new Error('This value was encrypted with a key that is no longer configured');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    },
    /** True when the value was encrypted with an older key and should be re-saved. */
    needsRotation(stored) {
      return String(stored).split('.')[1] !== currentId;
    },
  };
}
