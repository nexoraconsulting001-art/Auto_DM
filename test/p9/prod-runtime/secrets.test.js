// Envelope encryption under attack (PRD 5.15, F-64, F-65, F-67): a value is ciphertext only, a record's data key opens
// that record and no other, a changed or cut value fails closed with no key in the error, and text that echoes a secret
// is scrubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SecretsError, createKeyring, createRedactor, createSecrets, describeStored } from '../../../src/platform/secrets.js';

const key = () => crypto.randomBytes(32).toString('base64');
const caught = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
};
/** Nothing that could help an attacker: no key (either encoding), no data key, no plaintext. */
const holdsNothing = (err, ...secrets) => {
  const text = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
  for (const s of secrets) assert.ok(!text.includes(s), 'the error holds no secret');
};

test('a stored value is ciphertext only: no plaintext, no master key, no data key, and two equal secrets look unrelated', () => {
  const k1 = key();
  const v2 = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const plain = 'EAAB-business-one-token-0123456789';
  const a = v2.encrypt(plain);
  const b = v2.encrypt(plain);
  for (const stored of [a, b]) {
    assert.ok(!stored.includes(plain) && !stored.includes(k1) && !stored.includes(Buffer.from(k1, 'base64').toString('base64url')));
    assert.ok(!stored.includes(Buffer.from(plain).toString('base64url')));
  }
  assert.notEqual(a, b);
  assert.deepEqual(new Set(a.split('.').slice(2)).size, 6, 'every part differs');
  assert.ok(a.split('.').slice(2).every((p) => !b.split('.').includes(p)), 'no part is shared between two values');
  assert.equal(v2.decrypt(a), plain);
});

test('one record’s data key opens that record only: splicing two businesses’ values fails closed', () => {
  const v2 = createSecrets({ dataKey: key(), secretsFormat: 'v2' });
  const one = v2.encrypt('token-of-business-one').split('.');
  const two = v2.encrypt('token-of-business-two').split('.');
  // Business two's wrapped data key with business one's ciphertext, and the other way round.
  for (const spliced of [[...two.slice(0, 5), ...one.slice(5)], [...one.slice(0, 5), ...two.slice(5)], [...one.slice(0, 4), two[4], ...one.slice(5)]]) {
    const err = caught(() => v2.decrypt(spliced.join('.')));
    assert.ok(err instanceof SecretsError);
    assert.equal(err.code, 'tampered');
    holdsNothing(err, 'token-of-business-one', 'token-of-business-two');
  }
  // A data key unwrapped from one value cannot be carried to another: the wrap is bound to its master key id.
  const otherRing = createSecrets({ dataKey: key(), secretsFormat: 'v2' });
  assert.equal(caught(() => otherRing.decrypt(one.join('.'))).code, 'unknown_key');
  assert.equal(caught(() => otherRing.decrypt(['v2', otherRing.currentKeyId, ...one.slice(2)].join('.'))).code, 'tampered');
});

test('a tampered or truncated value fails closed, with an error that holds no key material', () => {
  const k1 = key();
  const v2 = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const v1 = createSecrets({ dataKey: k1 });
  const plain = 'gateway-secret-abcdefghijklmnop';
  const s2 = v2.encrypt(plain);
  const s1 = v1.encrypt(plain);
  const p2 = s2.split('.');
  const p1 = s1.split('.');
  const flip = (text) => (text[0] === 'A' ? `B${text.slice(1)}` : `A${text.slice(1)}`);
  const cases = [
    // Every part changed in turn.
    ...p2.slice(2).map((_, i) => p2.map((p, j) => (j === i + 2 ? flip(p) : p)).join('.')),
    ...p1.slice(2).map((_, i) => p1.map((p, j) => (j === i + 2 ? flip(p) : p)).join('.')),
    // Cut short: the tag (a short tag must not be accepted as a weaker one), the wrapped key, the iv, the ciphertext.
    p2.map((p, j) => (j === 6 ? p.slice(0, 6) : p)).join('.'),
    p2.map((p, j) => (j === 3 ? p.slice(0, 11) : p)).join('.'),
    p2.map((p, j) => (j === 4 ? p.slice(0, 20) : p)).join('.'),
    p2.map((p, j) => (j === 2 ? p.slice(0, 8) : p)).join('.'),
    p2.map((p, j) => (j === 7 ? p.slice(0, -3) : p)).join('.'),
    p1.map((p, j) => (j === 3 ? p.slice(0, 5) : p)).join('.'),
    // Not base64url, a padded form, a key id of the wrong shape, extra parts.
    p2.map((p, j) => (j === 5 ? `${p.slice(0, -1)}+` : p)).join('.'),
    p2.map((p, j) => (j === 7 ? `${p}==` : p)).join('.'),
    ['v2', 'short', ...p2.slice(2)].join('.'),
    `${s2}.extra`,
    s2.slice(0, -10),
  ];
  for (const stored of cases) {
    const err = caught(() => v2.decrypt(stored));
    assert.ok(err instanceof SecretsError, `refused: ${stored.slice(0, 30)}`);
    assert.ok(['tampered', 'not_encrypted'].includes(err.code), err.code);
    holdsNothing(err, plain, k1, Buffer.from(k1, 'base64').toString('base64url'));
    // rewrap() refuses the same value, so the job never writes a broken one under the new key.
    assert.throws(() => v2.rewrap(stored), SecretsError);
  }
  assert.equal(caught(() => v2.decrypt('')).code, 'not_encrypted');
  assert.equal(caught(() => v2.decrypt(null)).code, 'not_encrypted');
  assert.equal(caught(() => createKeyring({ current: 'not-32-bytes' })).message.includes('not-32-bytes'), false);
});

test('rewrap keeps the ciphertext, proves the data key first, and refuses a value it cannot read', () => {
  const k1 = key();
  const k2 = key();
  const before = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const value = before.encrypt('shopify-token-xyz');
  const after = createSecrets({ dataKey: k2, dataKeyOld: k1, secretsFormat: 'v2' });
  const moved = after.rewrap(value);
  assert.deepEqual(describeStored(moved), { version: 'v2', keyId: after.currentKeyId });
  assert.deepEqual(moved.split('.').slice(5), value.split('.').slice(5));
  assert.equal(createSecrets({ dataKey: k2, secretsFormat: 'v2' }).decrypt(moved), 'shopify-token-xyz');
  // A value whose body was changed is refused although its wrap still opens: no new form is made for it.
  const p = value.split('.');
  const broken = [...p.slice(0, 7), `${p[7].slice(0, -2)}${p[7].endsWith('AA') ? 'BB' : 'AA'}`].join('.');
  assert.equal(caught(() => after.rewrap(broken)).code, 'tampered');
  // A value under a key no longer configured cannot be moved.
  assert.equal(caught(() => createSecrets({ dataKey: k2, secretsFormat: 'v2' }).rewrap(value)).code, 'unknown_key');
  // Something that is not a stored value at all is due for attention, and cannot be re-wrapped.
  assert.equal(after.needsRotation('plain-text'), true);
  assert.equal(caught(() => after.rewrap('plain-text')).code, 'not_encrypted');
});

test('the redactor scrubs known secrets from a provider error that echoes the request, in every encoding', () => {
  const token = 'EAABsecretToken0123456789'; // secret-scan:allow (made-up fixture)
  const appSecret = 'app-secret-value-42'; // secret-scan:allow (made-up fixture)
  const redact = createRedactor([token, appSecret, 'short', '', null]);
  const echoes = [
    `Graph error 400: Invalid OAuth access token: ${token}`,
    `GET https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}&appsecret_proof=abc failed`,
    `{"error":{"message":"bad","request":{"headers":{"Authorization":"Bearer ${token}"}}}}`,
    `request body: client_secret=${appSecret}&grant_type=x`,
    `basic auth: ${Buffer.from(appSecret).toString('base64')}`,
    `payload ${Buffer.from(token).toString('base64url')}`,
    `postgres://bhava:${appSecret}@db.internal:5432/bhava refused`,
    `{"password": "something-else-entirely", "api_key":"k-1234567890"}`,
  ];
  for (const text of echoes) {
    const out = redact(text);
    assert.ok(!out.includes(token) && !out.includes(appSecret), out);
    assert.ok(!out.includes(Buffer.from(appSecret).toString('base64')) && !out.includes(Buffer.from(token).toString('base64url')), out);
    assert.match(out, /\[redacted\]/);
  }
  assert.ok(!redact(echoes.at(-1)).includes('something-else-entirely') && !redact(echoes.at(-1)).includes('k-1234567890'));
  assert.equal(redact('order 42 shipped'), 'order 42 shipped', 'ordinary text is left alone');
  assert.equal(typeof redact(undefined), 'string');
  // A value with characters that mean something in a pattern is matched literally.
  assert.equal(createRedactor(['a.b*c+d?e(f)']).call(null, 'x a.b*c+d?e(f) y'), 'x [redacted] y');
});
