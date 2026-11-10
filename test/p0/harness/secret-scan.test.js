import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { scanText } from '../../../tools/secret-scan.mjs';

// Every "secret" below is assembled at run time, so this file does not trip the scan it is testing.
const rep = (c, n) => c.repeat(n);
const mixed = (n) => 'aZ3kQ9xW7mR2'.repeat(Math.ceil(n / 12)).slice(0, n);
const rules = (text, file = 'x.js', options) => scanText(file, text, options).map((f) => f.rule);

const SAMPLES = {
  'private key': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
  'AWS access key': `AKIA${rep('A1B2', 4)}`,
  'GitHub token': `gh${'p'}_${mixed(36)}`,
  'Slack token': `xo${'xb'}-123456789012-${mixed(20)}`,
  'Google API key': `AI${'za'}${mixed(35)}`,
  'Stripe key': `sk_${'live'}_${mixed(24)}`,
  'Razorpay key': `rzp_${'test'}_${mixed(14)}`,
  'Meta access token': `EA${'A'}${mixed(60)}`,
  'JSON web token': `ey${'J'}${mixed(20)}.ey${'J'}${mixed(20)}.${mixed(20)}`,
  'password in a URL': `postgres://admin:${mixed(12)}@db.internal/app`,
};

for (const [rule, sample] of Object.entries(SAMPLES)) {
  test(`finds a ${rule}`, () => {
    assert.ok(rules(`const value = "${sample}";`).includes(rule));
  });
}

test('finds a named secret with a random value, in the usual spellings', () => {
  for (const line of [`API_KEY=${mixed(32)}`, `password: "${mixed(20)}"`, `"access_token": "${mixed(40)}"`, `verify token \`${mixed(18)}\``]) {
    assert.deepEqual(rules(line), ['named secret with a random-looking value'], line);
  }
});

test('leaves placeholders, references and ordinary code alone', () => {
  for (const line of [
    'APP_SECRET=',
    'SESSION_SECRET=change-me-please-1234',
    'token: env.S3_ACCESS_KEY_ID,',
    's3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,',
    `const secret = crypto.randomBytes(32).toString('hex');`,
    "sessionSecret: 'test-secret'",
    '# DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require',
    'postgres://postgres:ci@localhost:5432/postgres',
    'postgres://bhava:${POSTGRES_PASSWORD}@postgres:5432/bhava',
    'Bearer <METRICS_TOKEN>',
    'The masked key is rzp_...1234',
  ]) {
    assert.deepEqual(rules(line), [], line);
  }
});

test('reports the place but never the value', () => {
  const secret = SAMPLES['GitHub token'];
  const [finding] = scanText('a/b.js', `one\ntwo ${secret}\n`);
  assert.deepEqual(finding, { file: 'a/b.js', line: 2, rule: 'GitHub token' });
  assert.ok(!JSON.stringify(finding).includes(secret));
});

test('the allow marker exempts made-up fixture tokens', () => {
  assert.deepEqual(rules(`const fixture = "${SAMPLES['Razorpay key']}"; // secret-scan:allow`), []);
});

test('the server address is caught dotted, dashed and in hosts, and the marker cannot excuse it', () => {
  const addressHashes = new Set([crypto.createHash('sha256').update('203.0.113.77').digest('hex')]);
  const check = (text) => rules(text, 'x.md', { addressHashes });
  for (const text of ['ssh ubuntu@203.0.113.77', 'https://shop.203-0-113-77.sslip.io/x', '203-0-113-77.sslip.io', 'see 10.203.0.113.77 here', 'secret-scan:allow 203.0.113.77']) {
    assert.deepEqual(check(text), ['VM address'], text);
  }
  for (const text of ['203.0.113.78', '1203.0.113.77', '203.0.113.770', '203-0.113.77']) assert.deepEqual(check(text), [], text);
  assert.deepEqual(rules('x', 'deploy/203-0-113-77.conf', { addressHashes }), ['VM address'], 'file names count too');
});

test('lock files get only the address check', () => {
  assert.deepEqual(rules(`"integrity": "${SAMPLES['GitHub token']}"`, 'package-lock.json'), []);
  assert.deepEqual(rules(`"integrity": "${SAMPLES['GitHub token']}"`, 'sub/package.json'), ['GitHub token']);
});
