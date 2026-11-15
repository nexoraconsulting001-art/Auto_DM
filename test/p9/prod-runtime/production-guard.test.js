// The production guard under attack (G-09): an unsafe production configuration refuses to start, naming rules and
// settings only. Simulator addresses in every disguise, test keys, one database login, local storage, an in-memory
// cache and PASSWORD_LOGIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ProductionGuardError, guardProduction, loginOf, looksLikeSimulator, looksLikeTestKey, productionProblems } from '../../../src/platform/production-guard.js';

const good = () => ({
  databaseUrl: 'postgres://bhava_app:app-pass-123456@db.bhava-platform.in/bhava', databaseOwnerUrl: 'postgres://bhava_owner:owner-pass-123456@db.bhava-platform.in/bhava', // secret-scan:allow (made-up fixture)
  storageDriver: 's3', s3Bucket: 'files', s3Endpoint: '', queueDriver: 'redis', cacheDriver: 'redis', redisUrl: 'rediss://cache.bhava-platform.in',
  dataKey: crypto.randomBytes(32).toString('base64'), secretsFormat: 'v2', secretSources: { DATA_KEY: 'file', SESSION_SECRET: 'http' }, passwordLogin: false,
  adminPassword: '', metricsToken: 'm'.repeat(32), platformDomain: 'shops.bhava-platform.in', platformHost: '', publicBaseUrl: 'https://app.bhava-platform.in',
  dryRun: false, razorpayKeyId: 'rzp_live_abc', razorpayBillingKeyId: '', apnsEnv: 'production', aiBaseUrl: 'https://api.model-provider.com/v1', errorSinkUrl: '', emailBaseUrl: '', secretsUrl: '',
});
const ids = (config) => productionProblems(config).map((p) => p.id);
const PROD = { NODE_ENV: 'production', DEPLOY_ENV: 'production' };

test('a simulator address is refused in every disguise', () => {
  const disguised = [
    'http://127.0.0.1:9101', 'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://0.0.0.0', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'https://[fd12:3456::1]', 'https://[fe80::1]', 'https://localhost', 'https://localhost.', 'https://LOCALHOST', 'https://api.localhost', 'https://sim', 'https://secrets:8443',
    'https://graph.test', 'https://graph.example', 'https://host.docker.internal', 'https://10.0.0.5', 'https://172.20.1.1', 'https://192.168.1.10', 'https://169.254.169.254',
    'https://100.64.0.1', 'http://graph.facebook.com', 'ftp://graph.facebook.com', 'not an address',
  ];
  for (const url of disguised) {
    assert.equal(looksLikeSimulator(url), true, url);
    assert.deepEqual(ids({ ...good(), graphBaseUrl: url }), ['providers.no_simulator'], url);
    assert.deepEqual(ids({ ...good(), aiBaseUrl: url }), ['providers.no_test_address'], url);
  }
  for (const url of ['https://graph.facebook.com', 'https://api.razorpay.com/v1', 'https://172.32.0.1', 'https://[2606:4700::1111]']) assert.equal(looksLikeSimulator(url), false, url);
  // Any override of a provider address is refused, a real-looking one too: the adapters know the providers' own.
  assert.deepEqual(ids({ ...good(), razorpayBaseUrl: 'https://api.razorpay.com' }), ['providers.no_simulator']);
  // Object storage at a test endpoint (a local MinIO) is local storage by another name.
  assert.deepEqual(ids({ ...good(), s3Endpoint: 'http://127.0.0.1:9000' }), ['storage.object']);
  assert.deepEqual(ids({ ...good(), s3Endpoint: 'https://objectstorage.ap-mumbai-1.oraclecloud.com' }), []);
});

test('test keys, one database login, local storage, an in-memory cache and PASSWORD_LOGIN are each refused', () => {
  const testKey = ['rzp', 'test', 'Abcdefghij1234'].join('_');
  assert.equal(looksLikeTestKey(testKey), true);
  assert.equal(looksLikeTestKey('rzp_live_Abcdefghij1234'), false); // secret-scan:allow (made-up fixture)
  const cases = {
    'providers.no_test_key': [{ razorpayKeyId: testKey }, { razorpayBillingKeyId: testKey }, { apnsEnv: 'sandbox' }, { razorpayKeyId: 'key-sandbox-1' }],
    'db.two_logins': [
      { databaseOwnerUrl: '' },
      { databaseOwnerUrl: good().databaseUrl },
      // The same login on another host name, port or database is still one login.
      { databaseOwnerUrl: 'postgres://bhava_app:other@db.bhava-platform.in:5432/bhava' },
      { databaseOwnerUrl: 'postgresql://bhava_app@replica.bhava-platform.in/other' },
      // An address with no login at all cannot show two.
      { databaseUrl: 'postgres://db.bhava-platform.in/bhava' },
      { databaseUrl: 'not a url' },
    ],
    'storage.object': [{ storageDriver: 'local' }, { storageDriver: 'memory' }, { s3Bucket: '' }],
    'cache.redis': [{ cacheDriver: 'memory' }],
    'queue.redis': [{ queueDriver: 'pg' }],
    'auth.no_password_login': [{ passwordLogin: true }],
  };
  for (const [id, changes] of Object.entries(cases)) for (const change of changes) assert.deepEqual(ids({ ...good(), ...change }), [id], `${id}: ${JSON.stringify(change)}`);
  assert.equal(loginOf('postgres://bhava%5Fapp:x@db/bhava'), 'bhava_app');
  assert.equal(loginOf(''), '');
});

test('DEPLOY_ENV=production refuses whatever NODE_ENV says, and the error names rules and settings, never a value', () => {
  const ownerPass = 'owner-pass-secret-value';
  const bad = { ...good(), storageDriver: 'local', cacheDriver: 'memory', passwordLogin: true, adminPassword: ownerPass, graphBaseUrl: 'http://127.0.0.1:9101', databaseOwnerUrl: good().databaseUrl };
  for (const env of [PROD, { DEPLOY_ENV: 'production' }, { DEPLOY_ENV: 'production', NODE_ENV: 'development' }, { DEPLOY_ENV: 'PROD ' }]) {
    let err = null;
    try {
      guardProduction(bad, env);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ProductionGuardError, JSON.stringify(env));
    const text = `${err.message} ${JSON.stringify(err.problems)}`;
    for (const value of [ownerPass, 'app-pass-123456', '127.0.0.1', bad.dataKey]) assert.ok(!text.includes(value), `no value: ${value}`);
    assert.deepEqual(err.problems.map((p) => p.id).sort(), ['auth.no_env_owner', 'auth.no_password_login', 'cache.redis', 'db.two_logins', 'providers.no_simulator', 'storage.object']);
    assert.match(err.message, /PASSWORD_LOGIN/);
  }
  assert.throws(() => guardProduction({ ...bad, deployEnv: 'production' }, {}), ProductionGuardError, 'the config’s own DEPLOY_ENV counts');
  assert.deepEqual(guardProduction(bad, { NODE_ENV: 'test' }), []);
  assert.equal(guardProduction(bad, { NODE_ENV: 'production', DEPLOY_ENV: 'qa' }).length, 6, 'QA in production mode is reported, not refused');
  assert.deepEqual(guardProduction(good(), PROD), []);
  // A rule that throws on a strange config counts as broken, never as passed.
  assert.ok(ids({ ...good(), secretSources: null }).includes('secrets.data_key'));
});
