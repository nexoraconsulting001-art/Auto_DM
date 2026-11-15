import crypto from 'node:crypto';
import { redactUrl } from '../contracts/secrets.js';

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
 *
 * Reading fails closed. Every part is checked for its exact size before any key is used (a 12-byte iv, a 16-byte tag, a
 * 32-byte data key), the tag length is pinned, and a value that was changed, cut short or spliced from two records
 * throws SecretsError: its message and code say what kind of failure it was and never hold a key, a data key or a value.
 *
 * createRedactor(values) is the other half of "a secret never leaves": it scrubs known secret values (and the address
 * forms redactUrl() knows) out of any text, such as a provider's error that echoes the request.
 */
export const SECRET_FORMATS = Object.freeze(['v1', 'v2']);
const b64 = (buf) => buf.toString('base64url');
const B64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[A-Za-z0-9_-]{8}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** A secret that cannot be read or written. `code`: not_encrypted, tampered, unknown_key, no_key, bad_key, bad_format. */
export class SecretsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecretsError';
    this.code = code;
  }
}
const notEncrypted = () => new SecretsError('Not an encrypted value', 'not_encrypted');
const tampered = () => new SecretsError('This value could not be decrypted: it was changed, cut short or put together from two values', 'tampered');

/** The id of a master key: 8 characters of its hash. */
export const keyIdOf = (key) => crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);

/**
 * The master keys by id: { currentId, ids, get(id), has(id) }. `current` and each of `older` are base64 of 32 bytes.
 * With no current key nothing can be encrypted, and values written under the older keys still read.
 */
export function createKeyring({ current = '', older = [] } = {}) {
  const keys = new Map();
  const add = (text) => {
    const key = Buffer.from(String(text).trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new SecretsError('DATA_KEY must be 32 bytes, base64-encoded', 'bad_key');
    const id = keyIdOf(key);
    keys.set(id, key);
    return id;
  };
  const currentId = current ? add(current) : null;
  for (const text of older) if (text) add(text);
  return { currentId, ids: [...keys.keys()], get: (id) => keys.get(id) ?? null, has: (id) => keys.has(id) };
}

const olderKeys = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((item) => String(item).trim()).filter(Boolean);

/** One base64url part, canonical and of the exact size when one is given; anything else is a changed value. */
function part(text, bytes = null) {
  if (typeof text !== 'string' || !B64URL.test(text)) throw tampered();
  const buf = Buffer.from(text, 'base64url');
  if (b64(buf) !== text) throw tampered();
  if (bytes !== null && buf.length !== bytes) throw tampered();
  return buf;
}

/** The parts of a stored value, every size checked, or SecretsError. Needs no key. */
function parse(stored) {
  const parts = String(stored ?? '').split('.');
  const version = parts[0];
  const shapeOk = version === 'v2' ? parts.length === 8 && Boolean(parts[7]) : version === 'v1' && parts.length === 5 && Boolean(parts[4]);
  if (!shapeOk) throw notEncrypted();
  if (!KEY_ID.test(parts[1])) throw tampered();
  if (version === 'v1') return { version, keyId: parts[1], body: [part(parts[2], IV_BYTES), part(parts[3], TAG_BYTES), part(parts[4])], parts };
  return {
    version,
    keyId: parts[1],
    wrap: [part(parts[2], IV_BYTES), part(parts[3], TAG_BYTES), part(parts[4], KEY_BYTES)],
    body: [part(parts[5], IV_BYTES), part(parts[6], TAG_BYTES), part(parts[7])],
    parts,
  };
}

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [b64(iv), b64(cipher.getAuthTag()), b64(ct)];
}

function open(key, [iv, tag, ct], aad) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Node's own message says nothing about the key, but it is replaced anyway so no crypto detail travels.
    throw tampered();
  }
}

/** { version, keyId } of a stored value, or null when it is not one. Reads the text only: no key is needed. */
export function describeStored(stored) {
  const parts = String(stored ?? '').split('.');
  if (parts[0] === 'v1' && parts.length === 5 && parts[4]) return { version: 'v1', keyId: parts[1] };
  if (parts[0] === 'v2' && parts.length === 8 && parts[7]) return { version: 'v2', keyId: parts[1] };
  return null;
}

const REDACTED = '[redacted]';
const NAMED_SECRET = /("?\b(?:access_?token|refresh_?token|id_?token|token|client_?secret|secret|password|passwd|api_?key|apikey|key_?secret|private_?key|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;"'}]+)/gi;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A function that removes secrets from text: every value in `values` (8 characters or more, also URL-encoded and
 * base64-encoded), a login or query in an address, a bearer or basic credential, and a value written after a name that
 * says token, secret, password or key. For error text and log lines; it never throws and always answers a string.
 */
export function createRedactor(values = []) {
  const forms = new Set();
  for (const value of values) {
    const text = typeof value === 'string' ? value : '';
    if (text.length < 8) continue;
    forms.add(text);
    forms.add(encodeURIComponent(text));
    forms.add(Buffer.from(text).toString('base64'));
    forms.add(Buffer.from(text).toString('base64url'));
  }
  const known = forms.size ? new RegExp([...forms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g') : null;
  return (input) => {
    try {
      let text = String(input ?? '');
      if (known) text = text.replace(known, REDACTED);
      return redactUrl(text).replace(NAMED_SECRET, `$1${REDACTED}`);
    } catch {
      return REDACTED;
    }
  };
}

/**
 * @param {object} options the config, or its parts
 * @param {string} [options.dataKey] the current master key
 * @param {string|string[]} [options.dataKeyOld] older master keys, still read
 * @param {'v1'|'v2'} [options.secretsFormat] what encrypt() writes
 * @param {ReturnType<typeof createKeyring>} [options.keyring] replaces dataKey and dataKeyOld
 */
export function createSecrets({ dataKey, dataKeyOld, secretsFormat = 'v1', keyring } = {}) {
  if (!SECRET_FORMATS.includes(secretsFormat)) throw new SecretsError(`Unknown SECRETS_FORMAT "${String(secretsFormat).slice(0, 10)}" (use v1 or v2)`, 'bad_format');
  const ring = keyring ?? createKeyring({ current: dataKey, older: olderKeys(dataKeyOld) });
  const currentId = ring.currentId;
  const masterFor = (id) => {
    const key = ring.get(id);
    if (!key) throw new SecretsError('This value was encrypted with a key that is no longer configured', 'unknown_key');
    return key;
  };
  const needCurrent = () => {
    if (!currentId) throw new SecretsError('DATA_KEY is not set, so secrets cannot be stored', 'no_key');
    return ring.get(currentId);
  };
  // The wrapped data key is bound to the master key's id, so a wrapped key cannot be moved under another id.
  const wrapAad = (id) => `v2.${id}`;

  function encryptAs(format, plaintext) {
    const master = needCurrent();
    const text = Buffer.from(String(plaintext), 'utf8');
    if (format === 'v1') return ['v1', currentId, ...seal(master, text)].join('.');
    const dataKeyBytes = crypto.randomBytes(KEY_BYTES);
    try {
      return ['v2', currentId, ...seal(master, dataKeyBytes, wrapAad(currentId)), ...seal(dataKeyBytes, text, 'v2')].join('.');
    } finally {
      dataKeyBytes.fill(0);
    }
  }

  /** The data key of a parsed v2 value, unwrapped by its master key. The caller zeroes it. */
  const unwrap = (found) => {
    const dataKeyBytes = open(masterFor(found.keyId), found.wrap, wrapAad(found.keyId));
    if (dataKeyBytes.length !== KEY_BYTES) throw tampered();
    return dataKeyBytes;
  };

  function decrypt(stored) {
    const found = parse(stored);
    if (found.version === 'v1') return open(masterFor(found.keyId), found.body).toString('utf8');
    const dataKeyBytes = unwrap(found);
    try {
      return open(dataKeyBytes, found.body, 'v2').toString('utf8');
    } finally {
      dataKeyBytes.fill(0);
    }
  }

  const needsRotation = (stored) => {
    const found = describeStored(stored);
    if (!found) return true;
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
    /** True when the value should be written again: an older master key, the v1 form while v2 is what is written, or not a stored value at all. */
    needsRotation,
    /**
     * The same secret under the current master key, in the format being written. A v2 value keeps its data key and its
     * ciphertext: only the wrapped key changes, so the plaintext is never held, and the data key is proved against the
     * value's own tag before the new form is answered. A v1 value is decrypted and written anew. Returns `stored` itself
     * when there is nothing to do; throws SecretsError (and nothing is to be written) when the value cannot be read.
     */
    rewrap(stored) {
      const found = parse(stored);
      if (!needsRotation(stored)) {
        // Still proves the value reads, so a job never counts a broken value as done.
        decrypt(stored);
        return stored;
      }
      const master = needCurrent();
      if (found.version === 'v1') return encryptAs(secretsFormat, decrypt(stored));
      const dataKeyBytes = unwrap(found);
      try {
        open(dataKeyBytes, found.body, 'v2');
        return ['v2', currentId, ...seal(master, dataKeyBytes, wrapAad(currentId)), ...found.parts.slice(5)].join('.');
      } finally {
        dataKeyBytes.fill(0);
      }
    },
  };
}
