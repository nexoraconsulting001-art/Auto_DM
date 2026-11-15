import crypto from 'node:crypto';

/**
 * Encrypts tokens and keys before they are stored (PRD 5.15): Instagram and Page tokens, gateway, courier and Shopify
 * keys, push credentials, TOTP secrets, store keys. Every column that holds one is listed in src/contracts/secrets.js.
 *
 * Envelope encryption. Each stored value has its own data key (32 random bytes), which encrypts the value with
 * AES-256-GCM; the data key is itself encrypted ("wrapped") with a master key that lives outside the database. Rotating
 * the master key re-wraps the small data key and never touches the value's own ciphertext (rewrap()).
 *
 * The master keys are a keyring: the current one (DATA_KEY) and the older ones still needed to read (DATA_KEY_OLD, a
 * comma-separated list). Each is 32 random bytes, base64:
 *   node -p "require('crypto').randomBytes(32).toString('base64')"
 * A key's id is the first 8 characters of its SHA-256, so the id says nothing about the key.
 *
 * Stored forms (base64url parts, joined by dots):
 *   v2.<master key id>.<wrap iv>.<wrap tag>.<wrapped data key>.<iv>.<tag>.<ciphertext>     envelope
 *   v1.<master key id>.<iv>.<tag>.<ciphertext>                                             the master key encrypts the value itself
 * Both always decrypt. SECRETS_FORMAT says which one encrypt() writes: v1 (the default, as before) or v2, which production
 * requires (src/platform/production-guard.js). The re-wrap job (src/modules/secret-rotation) moves v1 rows to v2 and old
 * key ids to the current one.
 */
export const SECRET_FORMATS = Object.freeze(['v1', 'v2']);
const b64 = (buf) => buf.toString('base64url');
const raw = (text) => Buffer.from(String(text), 'base64url');

/** The id of a master key: 8 characters of its hash. */
export const keyIdOf = (key) => crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);

/**
 * The master keys by id: { currentId, ids, get(id), has(id) }. `current` and each of `older` are base64 of 32 bytes.
 * With no current key nothing can be encrypted, and values written under the older keys still read.
 */
export function createKeyring({ current = '', older = [] } = {}) {
  const keys = new Map();
  const add = (text) => {
    const key = Buffer.from(String(text), 'base64');
    if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded');
    const id = keyIdOf(key);
    keys.set(id, key);
    return id;
  };
  const currentId = current ? add(current) : null;
  for (const text of older) if (text) add(text);
  return { currentId, ids: [...keys.keys()], get: (id) => keys.get(id) ?? null, has: (id) => keys.has(id) };
}

const olderKeys = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((item) => String(item).trim()).filter(Boolean);

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [b64(iv), b64(cipher.getAuthTag()), b64(ct)];
}

function open(key, [iv, tag, ct], aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw(iv));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw(tag));
  return Buffer.concat([decipher.update(raw(ct)), decipher.final()]);
}

/** { version, keyId } of a stored value, or null when it is not one. Reads the text only: no key is needed. */
export function describeStored(stored) {
  const parts = String(stored ?? '').split('.');
  if (parts[0] === 'v1' && parts.length === 5 && parts[4]) return { version: 'v1', keyId: parts[1] };
  if (parts[0] === 'v2' && parts.length === 8 && parts[7]) return { version: 'v2', keyId: parts[1] };
  return null;
}

/**
 * @param {object} options the config, or its parts
 * @param {string} [options.dataKey] the current master key
 * @param {string|string[]} [options.dataKeyOld] older master keys, still read
 * @param {'v1'|'v2'} [options.secretsFormat] what encrypt() writes
 * @param {ReturnType<typeof createKeyring>} [options.keyring] replaces dataKey and dataKeyOld
 */
export function createSecrets({ dataKey, dataKeyOld, secretsFormat = 'v1', keyring } = {}) {
  if (!SECRET_FORMATS.includes(secretsFormat)) throw new Error(`Unknown SECRETS_FORMAT "${secretsFormat}" (use v1 or v2)`);
  const ring = keyring ?? createKeyring({ current: dataKey, older: olderKeys(dataKeyOld) });
  const currentId = ring.currentId;
  const masterFor = (id) => {
    const key = ring.get(id);
    if (!key) throw new Error('This value was encrypted with a key that is no longer configured');
    return key;
  };
  const needCurrent = () => {
    if (!currentId) throw new Error('DATA_KEY is not set, so secrets cannot be stored');
    return ring.get(currentId);
  };
  // The wrapped data key is bound to the master key's id, so a wrapped key cannot be moved under another id.
  const wrapAad = (id) => `v2.${id}`;

  function encryptAs(format, plaintext) {
    const master = needCurrent();
    const text = Buffer.from(String(plaintext), 'utf8');
    if (format === 'v1') return ['v1', currentId, ...seal(master, text)].join('.');
    const dataKeyBytes = crypto.randomBytes(32);
    return ['v2', currentId, ...seal(master, dataKeyBytes, wrapAad(currentId)), ...seal(dataKeyBytes, text, 'v2')].join('.');
  }

  function decrypt(stored) {
    const parts = String(stored).split('.');
    if (parts[0] === 'v2') {
      if (parts.length !== 8 || !parts[7]) throw new Error('Not an encrypted value');
      const dataKeyBytes = open(masterFor(parts[1]), parts.slice(2, 5), wrapAad(parts[1]));
      return open(dataKeyBytes, parts.slice(5), 'v2').toString('utf8');
    }
    if (parts[0] !== 'v1' || !parts[4]) throw new Error('Not an encrypted value');
    return open(masterFor(parts[1]), parts.slice(2, 5)).toString('utf8');
  }

  const needsRotation = (stored) => {
    const found = describeStored(stored);
    if (!found) return String(stored).split('.')[1] !== currentId;
    return found.keyId !== currentId || (secretsFormat === 'v2' && found.version === 'v1');
  };

  return {
    configured: Boolean(currentId),
    format: secretsFormat,
    currentKeyId: currentId,
    keyIds: ring.ids,
    encrypt: (plaintext) => encryptAs(secretsFormat, plaintext),
    decrypt,
    describe: describeStored,
    /** True when the value should be written again: an older master key, or the v1 form while v2 is what is written. */
    needsRotation,
    /**
     * The same secret under the current master key, in the format being written. A v2 value keeps its data key and its
     * ciphertext: only the wrapped key changes, so the plaintext is never held. A v1 value is decrypted and written anew.
     * Returns `stored` itself when there is nothing to do.
     */
    rewrap(stored) {
      const found = describeStored(stored);
      if (!found) throw new Error('Not an encrypted value');
      if (!needsRotation(stored)) return stored;
      const master = needCurrent();
      const parts = String(stored).split('.');
      if (found.version === 'v1') return encryptAs(secretsFormat, decrypt(stored));
      const dataKeyBytes = open(masterFor(parts[1]), parts.slice(2, 5), wrapAad(parts[1]));
      return ['v2', currentId, ...seal(master, dataKeyBytes, wrapAad(currentId)), ...parts.slice(5)].join('.');
    },
  };
}
