// D-6 (with tenancy-3): production has no fallback business. With DEFAULT_TENANT unset, a production start must not create a
// phantom "default" business that serves every unknown address and takes webhooks for accounts no business has; and a
// production deploy that sets it anyway refuses to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionGuardError, guardProduction, productionProblems } from '../../../src/platform/production-guard.js';
import { startApp } from '../../helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const good = () => ({
  databaseUrl: 'postgres://bhava_app:app-pass-123456@db.bhava-platform.in/bhava', databaseOwnerUrl: 'postgres://bhava_owner:owner-pass-123456@db.bhava-platform.in/bhava', // secret-scan:allow (made-up fixture)
  storageDriver: 's3', s3Bucket: 'files', s3Endpoint: '', queueDriver: 'redis', cacheDriver: 'redis', redisUrl: 'rediss://cache.bhava-platform.in',
  dataKey: crypto.randomBytes(32).toString('base64'), secretsFormat: 'v2', secretSources: { DATA_KEY: 'file', SESSION_SECRET: 'http' }, passwordLogin: false,
  adminPassword: '', metricsToken: 'm'.repeat(32), platformDomain: 'shops.bhava-platform.in', platformHost: '', publicBaseUrl: 'https://app.bhava-platform.in',
  dryRun: false, razorpayKeyId: 'rzp_live_abc', razorpayBillingKeyId: '', apnsEnv: 'production', aiBaseUrl: 'https://api.model-provider.com/v1', errorSinkUrl: '', emailBaseUrl: '', secretsUrl: '',
});
const ids = (config) => productionProblems(config).map((p) => p.id);

test('D-6: a production configuration with a fallback business breaks a rule; with none it does not', () => {
  assert.deepEqual(ids({ ...good(), defaultTenant: '' }), []);
  assert.deepEqual(ids({ ...good(), defaultTenant: undefined }), []);
  assert.deepEqual(ids({ ...good(), defaultTenant: 'default' }), ['tenancy.no_default']);
  assert.deepEqual(ids({ ...good(), defaultTenant: '  phantom-shop ' }), ['tenancy.no_default']);
  const rule = productionProblems({ ...good(), defaultTenant: 'default' })[0];
  assert.deepEqual(rule.settings, ['DEFAULT_TENANT']);
});

test('D-6: DEPLOY_ENV=production refuses to start with DEFAULT_TENANT set, naming the setting and never its value', () => {
  let err = null;
  try {
    guardProduction({ ...good(), defaultTenant: 'phantom-shop', deployEnv: 'production' }, { NODE_ENV: 'production' });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProductionGuardError, 'the start is refused');
  assert.match(err.message, /DEFAULT_TENANT/);
  assert.doesNotMatch(err.message, /phantom-shop/);
  assert.deepEqual(guardProduction({ ...good(), defaultTenant: '', deployEnv: 'production' }, { NODE_ENV: 'production' }), []);
});

/** config.defaultTenant as a fresh process with this environment sees it. */
function defaultTenantWith(env) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'COMSPEC', 'ComSpec'];
  const base = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config.js'); process.stdout.write(JSON.stringify(config.defaultTenant));"], {
    cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('D-6: with DEFAULT_TENANT unset, production has no fallback business; elsewhere it stays "default"', () => {
  assert.equal(defaultTenantWith({ NODE_ENV: 'production' }), '');
  assert.equal(defaultTenantWith({ DEPLOY_ENV: 'production' }), '', 'a production deploy that forgot NODE_ENV is still production');
  assert.equal(defaultTenantWith({ DEPLOY_ENV: 'prod' }), '');
  assert.equal(defaultTenantWith({ NODE_ENV: 'test' }), 'default');
  assert.equal(defaultTenantWith({ NODE_ENV: 'production', DEFAULT_TENANT: 'shop' }), 'shop', 'set on purpose it is kept, and the guard refuses it');
  assert.equal(defaultTenantWith({ NODE_ENV: 'production', DEFAULT_TENANT: '' }), '');
});

test('D-6: with no fallback business an address no business has is a 404, not some business\'s store', async () => {
  const app = await startApp({ overrides: { defaultTenant: '' } });
  try {
    for (const host of ['removed-domain.example', 'nobody.bhava.test']) {
      const res = await fetch(`${app.base}/`, { headers: { 'x-forwarded-host': host }, redirect: 'manual' });
      assert.equal(res.status, 404, host);
      assert.doesNotMatch(await res.text(), /Test store/, `${host} shows no business`);
    }
  } finally {
    app.close();
    await app.db.close();
  }
});
