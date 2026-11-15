// The Phase 9 contract (production readiness and the go-live kit): what the tracks build against. Requirement ids, envelope
// encryption and where secrets come from, migrations 900 and 910, health and shutdown, the production rules, the metric
// catalogue and the error sink, the go-live items, sign-up's guard, the deploy layout, the scripts and the workflow.
// Nothing here stands for a requirement: the tracks' tests carry the ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoliveArgError, formatStatus, parseArgs as goliveArgs, run as runGolive } from '../../../scripts/golive.js';
import { platformRoutesSource } from '../../../scripts/gen-platform-routes.mjs';
import { createPlatformClient } from '../../../shared/api-client/platform.js';
import { PLATFORM_ROUTES } from '../../../shared/api-client/platform-routes.js';
import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from '../../../src/adapters/meta/login.js';
import { REQUIRED_SECRETS, SECRET_SETTINGS, applySecrets, config, loadSecrets } from '../../../src/config.js';
import { PROD_PLATFORM_OWNERS, PlatformSignup, SignupModeSet, platformRoutes } from '../../../src/contracts/api/platform.js';
import {
  GOLIVE_ATTESTATIONS_FILE, GOLIVE_CHECK_KINDS, GOLIVE_DEPENDENCIES, GOLIVE_DETAILS, GOLIVE_ITEMS, GOLIVE_OWNERS, GOLIVE_PROBES, GoliveAttestations, GoliveStatus, META_PERMISSIONS,
  SignupGuardVerdict, blockingOpen, goliveExitCode, isTestValue,
} from '../../../src/contracts/golive.js';
import {
  BUSINESS_OPS_EVENTS, ERROR_EVENT_FIELDS, EXTERNAL_METRICS, ErrorEvent, FORBIDDEN_LABELS, LABEL_OVERRIDES, METRICS, METRIC_LABELS, METRIC_TYPES, UPTIME_SLO, metricProblem, metricSeriesNames,
} from '../../../src/contracts/metrics.js';
import { REWRAP_JOB, REWRAP_STATUSES, SECRET_COLUMNS, SECRET_KINDS, oldKeysRetirable, redactUrl } from '../../../src/contracts/secrets.js';
import { MODULES } from '../../../src/modules/index.js';
import { createGolive } from '../../../src/modules/golive/index.js';
import { createSecretRotation } from '../../../src/modules/secret-rotation/index.js';
import { createSignupGuard } from '../../../src/modules/signup/guard.js';
import { signupStore } from '../../../src/modules/signup/store.js';
import { createErrorSink, errorEvent } from '../../../src/platform/error-sink.js';
import { HEALTH_DEPENDENCIES, HEALTH_PATHS, createHealth, drainOnSignals, knownMigrations } from '../../../src/platform/health.js';
import { createMetrics } from '../../../src/platform/metrics.js';
import { PRODUCTION_RULES, ProductionGuardError, SIMULATOR_SETTINGS, guardProduction, looksLikeSimulator, productionProblems } from '../../../src/platform/production-guard.js';
import { SecretSourceError, createSecretSource, readLocalSecrets } from '../../../src/platform/secret-source.js';
import { createKeyring, createSecrets, describeStored } from '../../../src/platform/secrets.js';
import { withTenant } from '../../../src/tenancy.js';
import { checkRequirements, phaseFileHashes, repoRoot } from '../../../tools/gate-lib.mjs';
import { checkFolders } from '../../../tools/policy-check.mjs';
import { READINESS_CHECKS, ReadinessArgError, missingServices, parseArgs as readinessArgs, run as runReadiness } from '../../../tools/readiness/index.mjs';
import { createErrorTracker } from '../../../tools/sim/errors/index.mjs';
import { createSecretsManager } from '../../../tools/sim/secrets/index.mjs';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, onConsole, pause, startWorld, waitFor } from '../../p0/spec-p0/support.js';
import { refusal } from '../../p4/contract/support.js';

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));
const key = () => crypto.randomBytes(32).toString('base64');
const DENIED = /42501|permission denied/;
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p9-'));
const walk = (dir) => fs.readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && /\.(js|mjs)$/.test(e.name)).map((e) => path.relative(repoRoot, path.join(e.parentPath, e.name)).split(path.sep).join('/'));

test('the requirement list: twenty-four ids, short titles, none listed by an earlier phase, and the gate counts them', () => {
  const list = json('requirements/p9.json');
  assert.deepEqual(list.map((r) => r.id), ['F-64', 'F-65', 'F-66', 'F-67', ...Array.from({ length: 20 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`)]);
  assert.ok(list.every((r) => r.title.length <= 90));
  const earlier = new Set(fs.readdirSync(path.join(repoRoot, 'requirements')).filter((f) => f !== 'p9.json').flatMap((f) => json(`requirements/${f}`).map((r) => r.id)));
  assert.deepEqual(list.filter((r) => earlier.has(r.id)), []);
  for (const [id, scenario] of [['G-10', 'R-05'], ['G-11', 'R-06'], ['G-12', 'R-07']]) assert.ok(list.find((r) => r.id === id).title.includes(scenario), `${id} names ${scenario}`);
  const all = Array.from({ length: 10 }, (_, k) => json(`requirements/p${k}.json`)).flat();
  const checked = checkRequirements(repoRoot, 9, all.map((r) => `${r.id} stand-in`));
  assert.deepEqual(checked.problems.filter((p) => p.startsWith('requirements/p9')), []);
  assert.equal(checked.byPhase[9], 24);
  assert.deepEqual(checkRequirements(repoRoot, 9, []).missing.slice(-24), list.map((r) => r.id), 'with no test, all twenty-four are missing');
  const locked = Object.keys(phaseFileHashes(repoRoot, 9));
  for (const file of ['requirements/p9.json', 'test/p9/contract/contract.test.js']) assert.ok(locked.includes(file), file);
});

test('envelope encryption: v1 is still written by default and always read; v2 has a data key per value, wrapped by the master key', () => {
  const k1 = key();
  const k2 = key();
  const v1 = createSecrets({ dataKey: k1 });
  const stored1 = v1.encrypt('token-one');
  assert.equal(v1.format, 'v1');
  assert.deepEqual(describeStored(stored1), { version: 'v1', keyId: v1.currentKeyId });

  const v2 = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const a = v2.encrypt('token-one');
  const b = v2.encrypt('token-one');
  assert.match(a, /^v2\./);
  assert.equal(a.split('.').length, 8);
  assert.notEqual(a.split('.')[4], b.split('.')[4], 'each value has its own wrapped data key');
  assert.notEqual(a.split('.')[7], b.split('.')[7]);
  assert.ok(!a.includes('token-one') && !a.includes(k1));
  assert.equal(v2.decrypt(a), 'token-one');
  assert.equal(v2.decrypt(stored1), 'token-one', 'the v1 form still decrypts');
  assert.equal(v1.decrypt(a), 'token-one', 'and a v1 writer reads v2');
  assert.equal(v2.needsRotation(stored1), true, 'v1 is due for the envelope form');
  assert.equal(v2.needsRotation(a), false);
  assert.equal(v1.needsRotation(stored1), false);

  // Rotation: the new master key re-wraps the data key and leaves the value's own ciphertext alone.
  const rotated = createSecrets({ dataKey: k2, dataKeyOld: `${k1}, ${key()}`, secretsFormat: 'v2' });
  assert.equal(rotated.keyIds.length, 3, 'the keyring: the current key and the older ones');
  assert.equal(rotated.decrypt(a), 'token-one');
  assert.equal(rotated.needsRotation(a), true);
  const rewrapped = rotated.rewrap(a);
  assert.deepEqual(rewrapped.split('.').slice(5), a.split('.').slice(5), 'the ciphertext is untouched');
  assert.equal(rewrapped.split('.')[1], rotated.currentKeyId);
  assert.equal(rotated.rewrap(rewrapped), rewrapped, 'nothing to do the second time');
  assert.match(rotated.rewrap(stored1), /^v2\./, 'a v1 value becomes v2');
  assert.equal(rotated.decrypt(rotated.rewrap(stored1)), 'token-one');
  const retired = createSecrets({ dataKey: k2, secretsFormat: 'v2' });
  assert.equal(retired.decrypt(rewrapped), 'token-one', 'after the re-wrap the old key is not needed');
  assert.throws(() => retired.decrypt(a), /no longer configured/);

  // Tampering is refused, and a wrapped key cannot be passed off under another key id.
  const parts = a.split('.');
  assert.throws(() => v2.decrypt([...parts.slice(0, 7), `${parts[7].slice(0, -2)}AA`].join('.')));
  assert.throws(() => rotated.decrypt(['v2', rotated.currentKeyId, ...parts.slice(2)].join('.')));
  assert.throws(() => v2.decrypt('v2.short'), /Not an encrypted value/);
  assert.throws(() => v2.decrypt('plain'), /Not an encrypted value/);
  assert.throws(() => createSecrets({ dataKey: k1, secretsFormat: 'v3' }), /SECRETS_FORMAT/);
  assert.throws(() => createSecrets({}).encrypt('x'), /DATA_KEY is not set/);
  assert.throws(() => createKeyring({ current: 'short' }), /32 bytes/);
  assert.equal(describeStored('v1.gone'), null);
});

test('secret source: the environment, a directory of files and *_FILE; an unreadable file names the setting and nothing else', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'APP_SECRET'), 'from-dir\n');
  fs.writeFileSync(path.join(dir, 'pointed'), 'from-pointer\r\n');
  const names = ['APP_SECRET', 'DATA_KEY', 'VERIFY_TOKEN', 'METRICS_TOKEN'];

  assert.deepEqual(readLocalSecrets(names, { APP_SECRET: 'from-env' }), { values: { APP_SECRET: 'from-env' }, sources: { APP_SECRET: 'env' } });
  const filed = readLocalSecrets(names, { SECRETS_DRIVER: 'file', SECRETS_DIR: dir, APP_SECRET: 'from-env', VERIFY_TOKEN: 'env-token', DATA_KEY_FILE: path.join(dir, 'pointed') });
  assert.deepEqual(filed.values, { APP_SECRET: 'from-dir', DATA_KEY: 'from-pointer', VERIFY_TOKEN: 'env-token' });
  assert.deepEqual(filed.sources, { APP_SECRET: 'file', DATA_KEY: 'file', VERIFY_TOKEN: 'env' });
  assert.equal(readLocalSecrets(names, { DATA_KEY: 'env-key', DATA_KEY_FILE: path.join(dir, 'pointed') }).values.DATA_KEY, 'from-pointer', '*_FILE wins under the env driver too');

  const missing = path.join(dir, 'private-place', 'nope');
  const err = (() => {
    try {
      readLocalSecrets(names, { DATA_KEY_FILE: missing });
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof SecretSourceError);
  assert.equal(err.setting, 'DATA_KEY');
  assert.ok(!err.message.includes('private-place'), 'the path is not in the message');
  assert.throws(() => readLocalSecrets(names, { SECRETS_DRIVER: 'file' }), /SECRETS_DIR/);
  assert.throws(() => readLocalSecrets(names, { SECRETS_DRIVER: 'vault' }), /SECRETS_DRIVER/);
});

test('secret source over HTTP: versions, a wrong token, an outage at start, and a refresh that fails keeps the last good values', async (t) => {
  const manager = createSecretsManager({ token: 'sim-secrets-token', prefix: 'v1/bhava', secrets: { DATA_KEY: 'key-one', APP_SECRET: 'app-one' } });
  await manager.start();
  t.after(() => manager.close());
  const dir = scratch();
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'sim-secrets-token\n');
  const env = { SECRETS_DRIVER: 'http', SECRETS_URL: manager.url, SECRETS_PATH_PREFIX: 'v1/bhava', SECRETS_TOKEN_FILE: tokenFile, SECRETS_REFRESH_SECONDS: '0.05', SECRETS_TIMEOUT_MS: '500', VERIFY_TOKEN: 'from-env' };
  const names = ['DATA_KEY', 'APP_SECRET', 'VERIFY_TOKEN', 'METRICS_TOKEN'];
  const alerts = [];
  const source = createSecretSource({ names, env, onAlert: (alert) => alerts.push(alert) });
  t.after(() => source.stop());

  const first = await source.load();
  assert.deepEqual(first.values, { DATA_KEY: 'key-one', APP_SECRET: 'app-one', VERIFY_TOKEN: 'from-env' });
  assert.deepEqual(first.sources, { DATA_KEY: 'http', APP_SECRET: 'http', VERIFY_TOKEN: 'env' });
  assert.equal(first.versions.DATA_KEY, 1);

  // A rotation in the manager reaches the process at the next refresh, by name.
  const changes = [];
  source.start((change) => changes.push(change));
  await manager.post('/rotate', { name: 'APP_SECRET', value: 'app-two' });
  await waitFor(() => changes.length > 0);
  assert.deepEqual(changes[0].changed, ['APP_SECRET']);
  assert.equal(changes[0].values.APP_SECRET, 'app-two');

  // The manager goes away: the refresh fails, an alert is raised, nothing changes.
  await manager.post('/outage', { on: true });
  await waitFor(() => alerts.length > 0);
  assert.equal(alerts[0].code, 'unavailable');
  assert.equal(changes.length, 1, 'the last good values stay');
  assert.ok(source.state().failures >= 1);
  assert.ok(!JSON.stringify(source.state()).includes('app-two'), 'no value in the state');
  source.stop();

  // At start the same failures refuse to start, and say which setting without its value.
  await assert.rejects(createSecretSource({ names, env }).load(), (e) => e instanceof SecretSourceError && e.code === 'unavailable');
  await manager.post('/outage', { on: false });
  await manager.post('/token', { token: 'another' });
  await assert.rejects(createSecretSource({ names, env }).load(), (e) => e.code === 'unauthorized' && e.setting === 'SECRETS_TOKEN_FILE' && !e.message.includes('sim-secrets-token'));
  await manager.post('/token', { token: 'sim-secrets-token' });
  await manager.post('/slow', { ms: 1500 });
  await assert.rejects(createSecretSource({ names, env }).load(), (e) => e.code === 'unreachable');
  await manager.post('/slow', { ms: 0 });
  await assert.rejects(createSecretSource({ names, env: { ...env, SECRETS_URL: 'http://secrets.example.com' } }).load(), /https/);
  await assert.rejects(createSecretSource({ names, env: { ...env, SECRETS_TOKEN_FILE: '' } }).load(), /SECRETS_TOKEN_FILE/);
  const listed = await manager.get('/secrets');
  assert.ok(!JSON.stringify(listed).includes('app-two'), 'the simulator never lists a value');
});

test('config: every secret setting is marked, fills its config key from any source, and a missing required one is named', async () => {
  for (const [name, configKey] of Object.entries(SECRET_SETTINGS)) assert.ok(configKey in config, `${name} fills config.${configKey}`);
  // Any setting config.js reads whose name says it is a secret must be marked.
  const source = read('src/config.js');
  const readNames = [...new Set([...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
  const secretLike = readNames.filter((n) => /(SECRET|PASSWORD|_TOKEN|API_KEY|SERVICE_ACCOUNT|_ACCESS_KEY_ID|DATA_KEY(_OLD)?|APNS_KEY|_URL)$/.test(n) && !/_BASE_URL$|^PUBLIC_BASE_URL$|^(PLATFORM_SITE_URL|BILLING_RETURN_URL|ERROR_SINK_URL|SECRETS_URL)$/.test(n));
  assert.deepEqual(secretLike.filter((n) => !(n in SECRET_SETTINGS)), []);
  for (const name of REQUIRED_SECRETS) assert.ok(name in SECRET_SETTINGS, name);

  const cfg = { ...config, secretSources: {}, deployEnv: '' };
  applySecrets(cfg, { values: { APP_SECRET: 'a', DATA_KEY: '' }, sources: { APP_SECRET: 'file' } });
  assert.equal(cfg.appSecret, 'a');
  assert.deepEqual(cfg.secretSources, { APP_SECRET: 'file' });

  const dir = scratch();
  for (const name of REQUIRED_SECRETS.filter((n) => n !== 'METRICS_TOKEN')) fs.writeFileSync(path.join(dir, name), `value-of-${name}`);
  const env = { SECRETS_DRIVER: 'file', SECRETS_DIR: dir };
  const prod = { ...config, secretSources: {}, deployEnv: 'production' };
  await assert.rejects(loadSecrets(prod, { env }), (e) => /METRICS_TOKEN/.test(e.message) && !/value-of/.test(e.message));
  fs.writeFileSync(path.join(dir, 'METRICS_TOKEN'), 'm'.repeat(32));
  const loaded = { ...config, secretSources: {}, deployEnv: 'production' };
  const from = await loadSecrets(loaded, { env });
  assert.equal(from.driver, 'file');
  assert.equal(loaded.sessionSecret, 'value-of-SESSION_SECRET');
  assert.equal(loaded.secretSources.DATA_KEY, 'file');
  // Outside production nothing is required.
  await loadSecrets({ ...config, secretSources: {}, deployEnv: '' }, { env: {} });
});

test('migrations 900 and 910: the re-wrap table is the platform’s, every encrypted column is listed, v2 is accepted, sign-up has a daily cap', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'one', name: 'One' });
  const sql = (text, params) => (app.db.platform ?? app.db).query(text, params);

  assert.match(String(await refusal(withTenant(shop.tenant, () => app.db.query('SELECT * FROM secret_rewraps LIMIT 1')))), DENIED, 'out of reach of business code');
  const keyId = createSecrets({ dataKey: key() }).currentKeyId;
  const [row] = await sql(`INSERT INTO secret_rewraps (table_name, column_name, key_id) VALUES ('ig_accounts', 'access_token_enc', $1) RETURNING status, format, last_id, rows_done`, [keyId]);
  assert.deepEqual([row.status, row.format, row.last_id, Number(row.rows_done)], ['pending', 'v2', '', 0]);
  assert.ok(REWRAP_STATUSES.includes(row.status));
  await assert.rejects(sql(`INSERT INTO secret_rewraps (table_name, column_name, key_id) VALUES ('ig_accounts', 'access_token_enc', $1)`, [keyId]), /unique|duplicate/i);
  await assert.rejects(sql(`UPDATE secret_rewraps SET status = 'done' WHERE key_id = $1`, [keyId]), /check/i, 'done needs finished_at');
  await sql(`UPDATE secret_rewraps SET status = 'done', finished_at = now() WHERE key_id = $1`, [keyId]);
  await assert.rejects(sql(`INSERT INTO secret_rewraps (table_name, column_name, key_id) VALUES ('x', 'y', 'short')`), /check/i);

  // SECRET_COLUMNS is the schema's own list of encrypted columns, with each table's primary key.
  const found = await sql(`SELECT c.table_name, c.column_name,
      (SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey::int2[], a.attnum)) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ('public.' || c.table_name)::regclass AND i.indisprimary) AS pk,
      EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'tenant_id') AS tenant
    FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_enc' ORDER BY 1, 2`);
  const want = (list) => list.map((c) => `${c.table}.${c.column} [${c.key.join(',')}] ${c.tenant}`).sort();
  assert.deepEqual(want(SECRET_COLUMNS), found.map((r) => `${r.table_name}.${r.column_name} [${r.pk}] ${r.tenant}`).sort());
  assert.ok(SECRET_COLUMNS.every((c) => SECRET_KINDS.includes(c.kind)));
  assert.equal(new Set(SECRET_COLUMNS.map((c) => `${c.table}.${c.column}`)).size, SECRET_COLUMNS.length);

  // The columns that took only v1 take v2 too, and still nothing else.
  const checks = await sql(`SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%v1.%'`);
  assert.equal(checks.length, 4);
  for (const check of checks) assert.ok(check.def.includes("'v1.%'") && check.def.includes("'v2.%'"), `${check.table_name}: ${check.def}`);
  await assert.rejects(sql(`INSERT INTO shopper_push_devices (tenant_id, device_id, platform, token_enc, token_hash, permission) VALUES ($1, 'device-0123456789plain', 'android', 'plain-token', $2, 'granted')`, [shop.tenant.id, 'a'.repeat(64)]), /token_enc/);
  await sql(`INSERT INTO shopper_push_devices (tenant_id, device_id, platform, token_enc, token_hash, permission) VALUES ($1, 'device-0123456789abcdv2', 'android', 'v2.k.a.b.c.d.e.f', $2, 'granted')`, [shop.tenant.id, 'b'.repeat(64)]);

  assert.equal(oldKeysRetirable([], { keyId }), false);
  assert.equal(oldKeysRetirable(SECRET_COLUMNS.map((c) => ({ table: c.table, column: c.column, keyId, format: 'v2', status: 'done' })), { keyId }), true);
  assert.equal(oldKeysRetirable(SECRET_COLUMNS.slice(1).map((c) => ({ table: c.table, column: c.column, keyId, format: 'v2', status: 'done' })), { keyId }), false);

  // 910: the cap is NULL (none) until set, and the store answers it.
  const store = signupStore(app.db);
  assert.equal((await store.settings()).dailyCap, null);
  await store.setMode('invite', { actor: 'platform:1', reason: 'cap', dailyCap: 25 });
  assert.equal((await store.settings()).dailyCap, 25);
  await store.setMode('invite', { actor: 'platform:1', reason: 'mode only' });
  assert.equal((await store.settings()).dailyCap, 25, 'left out keeps it');
  await assert.rejects(sql('UPDATE signup_settings SET daily_cap = 0'), /check/i);
  assert.equal(await store.madeToday(), 0);

  assert.equal(redactUrl('GET https://user:pw123456@graph.example/v1/me?access_token=EAAB123&fields=id failed'), 'GET https://[redacted]@graph.example/v1/me?access_token=[redacted]&fields=[redacted] failed'); // secret-scan:allow
  assert.equal(redactUrl('Authorization: Bearer abcdefgh12345678'), 'Authorization: Bearer [redacted]');
});

test('health: liveness never looks at a dependency, readiness names each in one word, and nothing leaks', async () => {
  assert.deepEqual([...HEALTH_DEPENDENCIES], ['database', 'migrations', 'queue', 'storage', 'cache']);
  const applied = knownMigrations().map((version) => ({ version }));
  assert.ok(applied.some((m) => m.version === '900') && applied.some((m) => m.version === '910'));
  let dbUp = true;
  const db = { query: async (text) => {
    if (!dbUp) throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
    return /schema_migrations/.test(text) ? applied : [{ ok: 1 }];
  } };
  let cacheUp = true;
  const platform = { queue: { stats: async () => ({}) }, cache: { get: async () => { if (!cacheUp) throw new Error('redis down'); return null; } } };
  const health = createHealth({ db, platform, config: { healthCheckMs: 100, shutdownSeconds: 1 } });

  assert.deepEqual(health.live(), { ok: true });
  assert.deepEqual(await health.ready(), { ok: true, draining: false, checks: { database: 'up', migrations: 'up', queue: 'up', storage: 'unchecked', cache: 'up' } });
  assert.deepEqual(await health.startup(), { ok: false }, 'not started yet');
  health.markStarted();
  assert.deepEqual(await health.startup(), { ok: true });

  dbUp = false;
  const down = await health.ready();
  assert.equal(down.ok, false);
  assert.deepEqual([down.checks.database, down.checks.migrations], ['down', 'down']);
  assert.ok(!JSON.stringify(down).includes('hunter2') && !JSON.stringify(down).includes('10.1.2.3'), 'no error text in the answer');
  assert.deepEqual(health.live(), { ok: true }, 'liveness stays true');
  dbUp = true;
  cacheUp = false;
  assert.equal((await health.ready()).checks.cache, 'down');
  cacheUp = true;

  // Migrations behind: the build knows one the database has not run.
  applied.pop();
  assert.deepEqual([(await health.ready()).ok, (await health.ready()).checks.migrations], [false, 'behind']);
  applied.push({ version: knownMigrations().at(-1) });

  // A check a track adds: storage. A slow one counts as down; a made-up state counts as down.
  health.check('storage', async () => 'up');
  assert.equal((await health.ready()).checks.storage, 'up');
  health.check('storage', () => new Promise((resolve) => setTimeout(() => resolve('up'), 400)));
  assert.equal((await health.ready()).checks.storage, 'down');
  health.check('storage', async () => 'fine, on bucket prod-files');
  assert.equal((await health.ready()).checks.storage, 'down');
  health.check('storage', async () => 'up');
  assert.throws(() => health.check('Bad Name', async () => 'up'));

  // Drain: readiness is false at once, the steps run in order, each once, and a second call is the same drain.
  const order = [];
  health.onDrain('http', async () => { await pause(20); order.push('http'); });
  health.onDrain('queue', () => { order.push('queue'); });
  health.onDrain('broken', () => { throw new Error('boom'); });
  health.onDrain('database', () => { order.push('database'); });
  const draining = health.drain();
  assert.equal((await health.ready()).ok, false);
  assert.equal((await health.ready()).draining, true);
  const result = await draining;
  assert.equal(await health.drain(), result);
  assert.deepEqual(order, ['http', 'queue', 'database']);
  assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), [['http', true], ['queue', true], ['broken', false], ['database', true]]);
  assert.deepEqual([result.ok, result.timedOut], [false, false]);

  // The deadline: a step that never ends does not hold the process.
  const stuck = createHealth({ config: { shutdownSeconds: 1 } });
  stuck.onDrain('forever', () => new Promise(() => {}));
  assert.deepEqual(await stuck.drain({ deadlineMs: 50 }), { ok: false, timedOut: true, steps: [] });

  // Signals drain and exit: 0 when everything finished, 1 otherwise.
  const clean = createHealth({});
  const codes = [];
  const proc = { once: () => {} };
  await drainOnSignals(clean, { exit: (code) => codes.push(code), proc })('SIGTERM');
  await drainOnSignals(stuck, { exit: (code) => codes.push(code), proc })('SIGTERM');
  assert.deepEqual(codes, [0, 1]);
});

test('health over HTTP: /healthz, /readyz and /startupz on the web app, and the same three from the worker’s handler', async (t) => {
  const app = await startWorld(t);
  const get = (url) => fetch(`${app.base}${url}`);
  assert.equal(await (await get(HEALTH_PATHS.live)).text(), 'ok');
  const ready = await get(HEALTH_PATHS.ready);
  const body = await ready.json();
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body.checks), [...HEALTH_DEPENDENCIES]);
  assert.deepEqual([body.ok, body.checks.database, body.checks.migrations, body.checks.queue], [true, 'up', 'up', 'up']);
  assert.equal((await get(HEALTH_PATHS.startup)).status, 503, 'createApp alone has not started');
  app.ctx.platform.health.markStarted();
  assert.equal((await get(HEALTH_PATHS.startup)).status, 200);

  // A dependency down: 503 from readiness, 200 from liveness, and no detail.
  app.ctx.platform.health.check('storage', async () => { throw new Error('bucket prod-files: access key AKIAEXAMPLE refused'); });
  const down = await get(HEALTH_PATHS.ready);
  const text = await down.text();
  assert.equal(down.status, 503);
  assert.equal(JSON.parse(text).checks.storage, 'down');
  assert.ok(!/prod-files|AKIA/.test(text));
  assert.equal((await get(HEALTH_PATHS.live)).status, 200);

  // The worker serves the same paths from a plain http handler.
  const health = createHealth({});
  const answers = [];
  const res = () => ({ writeHead(status) { this.status = status; }, end(bodyText) { answers.push([this.status, bodyText]); } });
  assert.equal(health.serve({ method: 'GET', url: '/healthz' }, res()), true);
  assert.equal(health.serve({ method: 'GET', url: '/readyz?x=1' }, res()), true);
  assert.equal(health.serve({ method: 'GET', url: '/startupz' }, res()), true);
  assert.equal(health.serve({ method: 'GET', url: '/metrics' }, res()), false);
  assert.equal(health.serve({ method: 'POST', url: '/healthz' }, res()), false);
  await pause(20);
  assert.deepEqual(answers.map(([status]) => status).sort(), [200, 200, 503]);
  for (const file of ['src/server.js', 'src/worker.js']) {
    const source = read(file);
    assert.ok(/loadSecrets\(config/.test(source) && /guardProduction\(config\)/.test(source) && /drainOnSignals\(/.test(source), `${file} loads secrets, checks the rules and drains`);
    assert.ok(source.indexOf('loadSecrets(config') < source.indexOf('openRuntimeDb(config)'), `${file} loads secrets before the database opens`);
  }
});

test('the production rules: data, each refusing its own fault by setting name, enforced only with DEPLOY_ENV=production', () => {
  const good = {
    databaseUrl: 'postgres://app@db/bhava', databaseOwnerUrl: 'postgres://owner@db/bhava', storageDriver: 's3', s3Bucket: 'files', queueDriver: 'redis', cacheDriver: 'redis',
    redisUrl: 'rediss://cache', dataKey: key(), secretsFormat: 'v2', secretSources: { DATA_KEY: 'file', SESSION_SECRET: 'http' }, passwordLogin: false, adminPassword: '',
    metricsToken: 'm'.repeat(32), platformDomain: 'shops.bhava-platform.in', platformHost: '', publicBaseUrl: 'https://app.bhava-platform.in', dryRun: false,
    razorpayKeyId: 'rzp_live_abc', razorpayBillingKeyId: '', apnsEnv: 'production', aiBaseUrl: 'https://api.model-provider.com/v1', errorSinkUrl: '', emailBaseUrl: '', secretsUrl: '',
  };
  assert.deepEqual(productionProblems(good), []);
  assert.equal(new Set(PRODUCTION_RULES.map((r) => r.id)).size, PRODUCTION_RULES.length);
  for (const rule of PRODUCTION_RULES) assert.ok(/^[a-z_]+\.[a-z_]+$/.test(rule.id) && Array.isArray(rule.settings) && rule.must && typeof rule.ok === 'function', rule.id);

  const broken = {
    'db.two_logins': { databaseOwnerUrl: '' },
    'storage.object': { storageDriver: 'local' },
    'queue.redis': { queueDriver: 'pg' },
    'cache.redis': { cacheDriver: 'memory' },
    'secrets.data_key': { secretSources: { DATA_KEY: 'env', SESSION_SECRET: 'http' } },
    'secrets.envelope': { secretsFormat: 'v1' },
    'secrets.session': { secretSources: { DATA_KEY: 'file' } },
    'providers.no_simulator': { graphBaseUrl: 'http://127.0.0.1:9101' },
    'providers.no_test_address': { aiBaseUrl: 'http://127.0.0.1:9120' },
    'providers.no_test_key': { razorpayKeyId: ['rzp', 'test', 'abcdefghij'].join('_') },
    'auth.no_password_login': { passwordLogin: true },
    'auth.no_env_owner': { adminPassword: 'owner-pass' },
    'metrics.token': { metricsToken: 'short' },
    'hosts.platform': { publicBaseUrl: 'http://localhost:3000' },
    'sending.live': { dryRun: true },
    'fetch.no_transport': { safeFetchTransport: { dial: () => {} } },
  };
  assert.deepEqual(Object.keys(broken).sort(), PRODUCTION_RULES.map((r) => r.id).sort(), 'every rule has a case here');
  for (const [id, change] of Object.entries(broken)) assert.deepEqual(productionProblems({ ...good, ...change }).map((p) => p.id), [id], id);
  for (const configKey of Object.values(SIMULATOR_SETTINGS)) assert.ok(configKey in config, `config.${configKey}`);
  for (const [url, sim] of [['http://127.0.0.1:9101', true], ['https://sim.test', true], ['https://10.0.0.4', true], ['not a url', true], ['https://graph.instagram.com', false], ['', false]]) assert.equal(looksLikeSimulator(url), sim, url);

  // Outside production: nothing. In production: reported, and refused only when the deploy says it is production.
  const bad = { ...good, storageDriver: 'local', adminPassword: 'owner-pass-secret' };
  assert.deepEqual(guardProduction(bad, { NODE_ENV: 'test' }), []);
  assert.deepEqual(guardProduction(bad, { NODE_ENV: 'production' }).map((p) => p.id), ['storage.object', 'auth.no_env_owner']);
  assert.deepEqual(guardProduction({ ...bad, deployEnv: 'qa' }, { NODE_ENV: 'production' }).length, 2);
  const err = (() => {
    try {
      guardProduction({ ...bad, deployEnv: 'production' }, { NODE_ENV: 'production' });
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof ProductionGuardError);
  assert.match(err.message, /storage\.object \(STORAGE_DRIVER, S3_BUCKET/);
  assert.ok(!err.message.includes('owner-pass-secret'), 'never a value');
  assert.deepEqual(guardProduction({ ...good, deployEnv: 'production' }, { NODE_ENV: 'production' }), []);
});

test('the metric catalogue: the code emits nothing outside it, no label can name a business, and series names are known', async () => {
  const kinds = { inc: 'counter', observe: 'histogram', gauge: 'gauge' };
  const emitted = [];
  for (const file of walk('src')) {
    const source = read(file);
    for (const m of source.matchAll(/(?:\bmetrics\??|\bthis)\.(inc|observe|gauge)\(\s*(['"`]?)([A-Za-z0-9_${}.]*)\2/g)) emitted.push({ file, kind: kinds[m[1]], quoted: Boolean(m[2]), name: m[3] });
  }
  assert.ok(emitted.length >= 5);
  assert.deepEqual(emitted.filter((e) => !e.quoted || /[${}]/.test(e.name)), [], 'every metric name is a literal');
  assert.deepEqual(emitted.filter((e) => !METRICS[e.name] || METRICS[e.name].type !== e.kind), [], 'every emitted metric is catalogued with its type');
  assert.deepEqual([...new Set(emitted.map((e) => e.name))].filter((name) => METRICS[name].since !== 0), [], 'what is emitted today is marked since 0');

  for (const [name, def] of Object.entries(METRICS)) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(name) && METRIC_TYPES.includes(def.type) && def.help, name);
    if (def.type === 'counter') assert.ok(name.endsWith('_total'), `${name}: a counter ends _total`);
    for (const label of def.labels) {
      assert.ok(!FORBIDDEN_LABELS.includes(label), `${name}.${label}`);
      const rule = LABEL_OVERRIDES[name]?.[label] ?? METRIC_LABELS[label];
      assert.ok(rule && (Array.isArray(rule.values) || (rule.pattern instanceof RegExp && rule.max <= 100)), `${name}.${label} is bounded`);
    }
  }
  assert.equal(metricProblem('http_requests_total', { method: 'GET', group: 'home', status: '200' }), null);
  assert.equal(metricProblem('queue_jobs', { queue: 'dm', status: 'queued' }), null);
  assert.match(metricProblem('http_requests_total', { tenant: 'one' }), /label tenant/);
  assert.match(metricProblem('http_requests_total', { group: 'Some Shop Name' }), /outside its set/);
  assert.match(metricProblem('orders_total', {}), /not in the catalogue/);
  assert.match(metricProblem('sends_accepted_total', { channel: 'sms' }), /outside its set/);
  const series = metricSeriesNames();
  for (const name of ['http_request_seconds_bucket', 'http_request_seconds_count', 'queue_jobs', 'probe_success', ...EXTERNAL_METRICS]) assert.ok(series.has(name), name);
  assert.equal(series.has('http_request_seconds'), false);

  // What the running app serves is in the catalogue too.
  const metrics = createMetrics();
  metrics.inc('http_requests_total', { method: 'GET', group: 'home', status: '200' });
  for (const line of (await metrics.render()).split('\n').filter((l) => l.startsWith('# TYPE'))) assert.ok(METRICS[line.split(' ')[2]], line);

  // Per-business numbers are analytics events with class and number properties only; the objective is 99.5% over 30 days.
  for (const event of Object.values(BUSINESS_OPS_EVENTS)) {
    assert.match(event.name, /^ops\.[a-z_]+$/);
    assert.deepEqual(event.props.filter((p) => FORBIDDEN_LABELS.includes(p)), []);
  }
  assert.deepEqual([UPTIME_SLO.objective, UPTIME_SLO.windowDays, UPTIME_SLO.probes.length], [0.995, 30, 2]);
  assert.ok(UPTIME_SLO.burnAlerts.length >= 2 && UPTIME_SLO.burnAlerts.every((a) => ['page', 'ticket'].includes(a.severity) && a.burnRate > 0));
});

test('the error sink: one JSON document per error with ids only, never the message, and a broken sink never throws', async (t) => {
  const tracker = createErrorTracker({ token: 'sim-errors-token' });
  await tracker.start();
  t.after(() => tracker.close());
  const sink = createErrorSink({ errorSink: 'http', errorSinkUrl: `${tracker.url}/events`, errorSinkToken: 'sim-errors-token', release: 'abc1234', rootDir: repoRoot }, { service: 'worker' });
  const secretText = 'Asha wrote: call me on 9876543210';
  const err = Object.assign(new TypeError(secretText), { code: 'E_SAMPLE' });
  sink.report(err, { msg: 'http.error', requestId: 'abcdef123456', tenantId: 7, tenant: 'one', path: '/r/sale?phone=9876543210', route: 'orders.get' });
  await sink.flush();
  const { events } = await tracker.get('/events');
  assert.equal(events.length, 1);
  const { id, ...event } = events[0];
  assert.ok(id);
  assert.deepEqual(Object.keys(event), [...ERROR_EVENT_FIELDS]);
  ErrorEvent.parse(event);
  assert.deepEqual([event.service, event.release, event.event, event.errorClass, event.code, event.requestId, event.tenantId, event.route], ['worker', 'abc1234', 'http.error', 'TypeError', 'E_SAMPLE', 'abcdef123456', 7, 'orders.get']);
  assert.ok(event.frames.length > 0 && event.frames[0].file.startsWith('test/p9/contract/'), 'frames are repository-relative');
  assert.ok(!JSON.stringify(event).includes('9876543210') && !JSON.stringify(event).includes('Asha'), 'no message text, no path');
  assert.deepEqual(sink.stats(), { sent: 1, failed: 0, dropped: 0 });
  assert.deepEqual(Object.keys(errorEvent(new Error('x'), {})), [...ERROR_EVENT_FIELDS]);

  // A wrong token, or a sink that is not there, is counted and never thrown.
  const wrong = createErrorSink({ errorSink: 'http', errorSinkUrl: `${tracker.url}/events`, errorSinkToken: 'nope' });
  wrong.report(new Error('x'));
  const gone = createErrorSink({ errorSink: 'http', errorSinkUrl: 'http://127.0.0.1:9/events', errorSinkTimeoutMs: 300 });
  gone.report(new Error('x'));
  await Promise.all([wrong.flush(), gone.flush()]);
  assert.equal(wrong.stats().failed, 1);
  assert.equal(gone.stats().failed, 1);
  const none = createErrorSink({});
  assert.equal(none.driver, 'none');
  none.report(new Error('x'));
  assert.throws(() => createErrorSink({ errorSink: 'sentry' }), /ERROR_SINK/);
  assert.throws(() => createErrorSink({ errorSink: 'http' }), /ERROR_SINK_URL/);
});

test('the go-live items: one list as data, every dependency covered, each checked by a setting, a probe or a sign-off', () => {
  assert.equal(new Set(GOLIVE_ITEMS.map((i) => i.id)).size, GOLIVE_ITEMS.length);
  const envNames = new Set([...read('src/config.js').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  for (const item of GOLIVE_ITEMS) {
    assert.ok(/^[a-z_]+\.[a-z_]+$/.test(item.id) && item.title.length <= 120 && GOLIVE_OWNERS.includes(item.owner) && item.phase >= 0 && item.phase <= 5 && typeof item.blocks === 'boolean', item.id);
    assert.ok(GOLIVE_CHECK_KINDS.includes(item.check.kind), item.id);
    if (item.check.kind === 'probe') assert.ok(GOLIVE_PROBES.includes(item.check.probe), `${item.id}: ${item.check.probe}`);
    if (item.check.kind === 'setting') for (const name of [...item.check.all, ...item.check.any]) assert.ok(envNames.has(name), `${item.id}: ${name} is a setting`);
    if (item.check.kind === 'per_business') assert.equal(item.blocks, false, `${item.id} never blocks`);
    if (item.dependency) assert.ok(GOLIVE_DEPENDENCIES.includes(item.dependency), `${item.id}: ${item.dependency}`);
  }
  assert.deepEqual(GOLIVE_DEPENDENCIES.filter((d) => !GOLIVE_ITEMS.some((i) => i.dependency === d)), [], 'every row of the dependencies table has an item');
  assert.equal(GOLIVE_DEPENDENCIES.length, 21);
  assert.deepEqual(GOLIVE_PROBES.filter((p) => !GOLIVE_ITEMS.some((i) => i.check.probe === p)), [], 'every probe is used');
  for (const id of ['meta.app_live', 'meta.business_verification', 'meta.instagram_access', 'razorpay.route', 'shiprocket.account', 'whatsapp.sender', 'whatsapp.templates', 'google.signin', 'push.fcm', 'push.apns',
    'ai.provider', 'hosting.dns', 'hosting.tls', 'hosting.backups', 'hosting.monitoring', 'legal.payment_aggregator', 'stores.accounts', 'legal.trademark', 'legal.pages', 'showcase.signoff']) {
    assert.ok(GOLIVE_ITEMS.some((i) => i.id === id), id);
  }
  for (const id of ['legal.payment_aggregator', 'stores.accounts', 'legal.trademark', 'legal.pages', 'showcase.signoff']) assert.equal(GOLIVE_ITEMS.find((i) => i.id === id).check.kind, 'attestation', id);
  assert.deepEqual([...META_PERMISSIONS.instagram], [...INSTAGRAM_SCOPES], 'exactly the permissions the code asks for');
  assert.deepEqual([...META_PERMISSIONS.facebook], [...FACEBOOK_SCOPES]);

  // Test values are never ready.
  for (const value of ['http://127.0.0.1:9101', 'https://graph.test/v1', ['rzp', 'test', 'abcdefghij'].join('_'), 'changeme', 'sim-secret', 'https://api.example.com']) assert.equal(isTestValue(value), true, value);
  for (const value of ['', ['rzp', 'live', 'abcdefghij'].join('_'), 'https://graph.instagram.com', '1784201234567']) assert.equal(isTestValue(value), false, value);

  // The sign-off file parses and starts empty; an entry for an item that is not signed off is refused.
  assert.deepEqual(GoliveAttestations.parse(json(GOLIVE_ATTESTATIONS_FILE)), { version: 1, entries: [] });
  assert.equal(config.goliveAttestations, path.join(repoRoot, GOLIVE_ATTESTATIONS_FILE));
  assert.ok(GoliveAttestations.safeParse({ version: 1, entries: [{ id: 'legal.pages', signedOffBy: 'A Person', role: 'Counsel', date: '2027-01-15' }] }).success);
  assert.equal(GoliveAttestations.safeParse({ version: 1, entries: [{ id: 'meta.app_live', signedOffBy: 'A Person', role: 'Counsel', date: '2027-01-15' }] }).success, false);
  assert.equal(GoliveAttestations.safeParse({ version: 1, entries: [{ id: 'legal.pages', signedOffBy: 'A Person', role: 'Counsel', date: '2027-01-15', secret: 'x' }] }).success, false);

  // The status, its verdict and the exit code.
  const status = GoliveStatus.parse({ ready: false, blockingMissing: 2, checkedAt: new Date(), deployEnv: 'qa', items: [
    { id: 'meta.app_live', title: 'Live', owner: 'us', phase: 0, blocks: true, kind: 'probe', state: 'missing', detail: GOLIVE_DETAILS.developmentMode },
    { id: 'whatsapp.sender', title: 'Sender', owner: 'user', phase: 0, blocks: true, kind: 'probe', state: 'unknown', detail: GOLIVE_DETAILS.unreachable },
    { id: 'legal.trademark', title: 'Trademark', owner: 'user', phase: 0, blocks: false, kind: 'attestation', state: 'missing', detail: GOLIVE_DETAILS.notSignedOff },
    { id: 'hosting.tls', title: 'TLS', owner: 'us', phase: 0, blocks: true, kind: 'probe', state: 'ready', detail: GOLIVE_DETAILS.ok },
  ] });
  assert.deepEqual(blockingOpen(status.items).map((i) => i.id), ['meta.app_live', 'whatsapp.sender'], 'unknown counts as open');
  assert.equal(goliveExitCode(status), 1);
  assert.equal(goliveExitCode({ items: status.items.filter((i) => !i.blocks || i.state === 'ready') }), 0);
  const text = formatStatus(status);
  assert.match(text, /MISSING\s+blocks\s+us\s+meta\.app_live/);
  assert.match(text, /Not ready for go-live: 2 blocking items open\./);
  assert.equal(formatStatus(status, { owner: 'user' }).includes('meta.app_live'), false);
  assert.deepEqual(SignupGuardVerdict.parse({ ok: true }), { ok: true, missing: [] });
});

test('the go-live route, its client method, and the two modules that answer the new console routes', async (t) => {
  assert.deepEqual(PROD_PLATFORM_OWNERS, { golive: ['platform.goliveStatus'], 'business-ops': ['platform.businessOps'] });
  assert.deepEqual([platformRoutes['platform.goliveStatus'].method, platformRoutes['platform.goliveStatus'].path, [...platformRoutes['platform.goliveStatus'].platformRoles]], ['GET', '/golive', ['super_admin', 'support']]);
  assert.equal(platformRoutes['platform.goliveStatus'].response, GoliveStatus);
  assert.equal(read('shared/api-client/platform-routes.js'), platformRoutesSource(), 'run npm run gen:platform-routes');
  assert.ok(PLATFORM_ROUTES['platform.goliveStatus'] && PLATFORM_ROUTES['platform.businessOps']);
  const client = createPlatformClient({ fetch: async () => new Response('{}') });
  assert.equal(typeof client.goliveStatus, 'function');
  assert.equal(typeof client.businessOps, 'function');

  const names = MODULES.map((m) => m.name);
  assert.deepEqual(names.slice(names.indexOf('migration') + 1, names.indexOf('migration') + 4), ['secret-rotation', 'golive', 'business-ops']);
  const named = (name) => MODULES.find((m) => m.name === name);
  assert.deepEqual(named('secret-rotation').owns, { migrations: ['900_secrets_envelope.sql'], tables: ['secret_rewraps'], api: [], store: [], platform: [], jobs: [REWRAP_JOB] });
  assert.deepEqual(named('golive').owns, { migrations: ['910_signup_cap.sql'], tables: [], api: [], store: [], platform: ['platform.goliveStatus'], jobs: [] });
  assert.deepEqual(named('business-ops').owns, { migrations: [], tables: [], api: [], store: [], platform: ['platform.businessOps'], jobs: [] });
  for (const what of ['start', 'step', 'progress']) assert.throws(() => createSecretRotation({})[what](), (e) => e.code === 'not_implemented');
  await assert.rejects(createGolive({}).status(), (e) => e.code === 'not_implemented');
  assert.deepEqual(await createGolive({}).signupVerdict(), { ok: false, missing: ['golive.not_built'] });

  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'one', name: 'One' });
  const admin = await consoleUser(app);
  for (const url of ['/golive', `/tenants/${shop.tenant.id}/ops`]) {
    assert.equal((await hit(app, url, { host: CONSOLE_HOST })).status, 401, `${url} with nobody signed in`);
    const res = await onConsole(app, admin, url);
    assert.deepEqual([res.status, res.json().code], [501, 'not_implemented'], url);
  }
  assert.equal((await onConsole(app, await consoleUser(app, 'onboarding'), '/golive')).status, 403);
  assert.equal((await hit(app, '/golive', { host: shop.host })).status === 200, false, 'not on a business’s address');
});

test('sign-up’s guard: public waits for the checklist where it is enforced, force needs a second reason, and both are audited', async (t) => {
  // The body: force without its own reason is refused; the cap is optional.
  assert.equal(SignupModeSet.safeParse({ mode: 'public', reason: 'launch' }).data.force, false);
  assert.equal(SignupModeSet.safeParse({ mode: 'public', reason: 'launch', force: true }).success, false);
  assert.equal(SignupModeSet.safeParse({ mode: 'public', reason: 'launch', force: true, forceReason: '  ' }).success, false);
  assert.ok(SignupModeSet.safeParse({ mode: 'public', reason: 'launch', force: true, forceReason: 'counsel signed off by phone', dailyCap: 50 }).success);
  assert.equal(SignupModeSet.safeParse({ mode: 'invite', reason: 'cap', dailyCap: 0 }).success, false);
  assert.equal(PlatformSignup.parse({ mode: 'invite', freePerInstagram: 1, updatedAt: new Date() }).dailyCap, null);

  // The guard itself.
  const off = createSignupGuard({ enforce: false });
  off.use(async () => ({ ok: false, missing: ['meta.app_live'] }));
  assert.deepEqual(await off.check({ mode: 'public' }), { ok: true, missing: [], enforced: false });
  const none = createSignupGuard({ enforce: true });
  assert.deepEqual(await none.check({ mode: 'public' }), { ok: true, missing: [], enforced: false }, 'nothing registered');
  const on = createSignupGuard({ enforce: true });
  on.use(async () => ({ ok: false, missing: ['meta.app_live', 'not an id!', 'hosting.tls'] }));
  on.use(async () => { throw new Error('probe exploded with a secret'); });
  on.use(async () => ({ ok: true }));
  assert.deepEqual(await on.check({ mode: 'public' }), { ok: false, missing: ['meta.app_live', 'hosting.tls', 'guard.failed'], enforced: true });
  assert.deepEqual(await on.check({ mode: 'invite' }), { ok: true, missing: [], enforced: true });
  assert.deepEqual(await on.check({ mode: 'closed' }), { ok: true, missing: [], enforced: true });
  assert.throws(() => on.use('nope'));

  // Through the console, with the checklist enforced: the golive module's guard is registered and nothing is ready yet.
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  assert.equal(app.ctx.signupGuard.enforced, true);
  const admin = await consoleUser(app);
  const put = (body, who = admin) => onConsole(app, who, '/signup', { method: 'PUT', body });
  const refused = await put({ mode: 'public', reason: 'launch day' });
  assert.deepEqual([refused.status, refused.json().code, refused.json().fields], [409, 'conflict', { golive: 'golive.not_built' }]);
  assert.equal((await onConsole(app, admin, '/signup')).json().mode, 'invite', 'nothing changed');
  assert.equal((await put({ mode: 'public', reason: 'launch day', force: true })).status, 400, 'force needs its own reason');
  assert.equal((await put({ mode: 'public', reason: 'launch day', force: true, forceReason: 'approved by the founder' }, await consoleUser(app, 'support'))).status, 403, 'a super admin only');
  const forced = await put({ mode: 'public', reason: 'launch day', force: true, forceReason: 'approved by the founder', dailyCap: 40 });
  assert.deepEqual([forced.status, forced.json().mode, forced.json().dailyCap], [200, 'public', 40]);
  const closed = await put({ mode: 'closed', reason: 'pause', force: true, forceReason: 'not needed' });
  assert.deepEqual([closed.status, closed.json().mode, closed.json().dailyCap], [200, 'closed', 40]);
  const audit = await (app.db.platform ?? app.db).query(`SELECT details FROM audit_log WHERE action = 'signup.mode_set' ORDER BY id`);
  assert.deepEqual(audit.map((r) => r.details), [
    { mode: 'public', reason: 'launch day', dailyCap: 40, forced: true, forceReason: 'approved by the founder', missing: ['golive.not_built'] },
    { mode: 'closed', reason: 'pause' },
  ]);

  // Where it is not enforced (tests, local runs) the mode moves as it did in Phase 7.
  const plain = await startWorld(t);
  assert.equal(plain.ctx.signupGuard.enforced, false);
  const other = await consoleUser(plain);
  assert.deepEqual([(await onConsole(plain, other, '/signup', { method: 'PUT', body: { mode: 'public', reason: 'open' } })).json().mode], ['public']);
});

test('the scripts: arguments, the list of readiness checks, and "not built" until a track builds each', async () => {
  const scripts = json('package.json').scripts;
  assert.deepEqual([scripts.golive, scripts['check:r05'], scripts['check:r06'], scripts['check:r07'], scripts['prod:validate']],
    ['node scripts/golive.js', 'node tools/readiness/index.mjs r05', 'node tools/readiness/index.mjs r06', 'node tools/readiness/index.mjs r07', 'node tools/readiness/index.mjs validate']);

  assert.deepEqual(goliveArgs([]), { json: false, blocking: false, owner: null, offline: false });
  assert.deepEqual(goliveArgs(['--json', '--blocking', '--owner', 'user', '--offline']), { json: true, blocking: true, owner: 'user', offline: true });
  assert.throws(() => goliveArgs(['--owner', 'them']), GoliveArgError);
  assert.throws(() => goliveArgs(['--print-secrets']), GoliveArgError);
  await assert.rejects(runGolive({}), (e) => e.code === 'not_implemented');

  assert.deepEqual(Object.keys(READINESS_CHECKS), ['r05', 'r06', 'r07', 'validate']);
  assert.deepEqual(Object.values(READINESS_CHECKS).map((c) => [c.requirement, c.scenario]), [['G-10', 'R-05'], ['G-11', 'R-06'], ['G-12', 'R-07'], ['G-08', '']]);
  assert.deepEqual(readinessArgs(['r06', '--json', '--keep']), { check: 'r06', json: true, keep: true });
  assert.throws(() => readinessArgs([]), ReadinessArgError);
  assert.throws(() => readinessArgs(['r08']), ReadinessArgError);
  assert.throws(() => readinessArgs(['r05', '--fast']), ReadinessArgError);
  assert.deepEqual(missingServices('r05', { TEST_DATABASE_URL: 'x', REDIS_URL: 'x' }), ['CLICKHOUSE_URL', 'S3_ENDPOINT', 'S3_BUCKET']);
  await assert.rejects(runReadiness({ check: 'r07', env: {} }), (e) => e.code === 'missing_services' && e.missing.includes('TEST_DATABASE_URL'));
  for (const [check, spec] of Object.entries(READINESS_CHECKS)) {
    if (exists(`tools/readiness/${spec.file}`)) continue;
    const env = Object.fromEntries(spec.needs.map((name) => [name, 'set']));
    await assert.rejects(runReadiness({ check, env }), (e) => e.code === 'not_implemented', check);
  }
});

test('the deploy layout, the workflow, the settings and the handoff', () => {
  for (const folder of ['compose', 'k8s', 'terraform', 'monitoring', 'runbooks']) assert.ok(exists(`deploy/prod/${folder}/README.md`), folder);
  for (const file of ['deploy/prod/README.md', 'deploy/golive/README.md', 'console/src/platform/features/golive/README.md', 'tools/sim/secrets/index.mjs', 'tools/sim/errors/index.mjs']) assert.ok(exists(file), file);

  // One region variable, India only; nothing under deploy/prod names a region anywhere else, or a cloud provider's SDK.
  const regions = json('deploy/prod/regions.json');
  assert.equal(regions.variable, 'region');
  assert.ok(regions.india.length >= 8 && regions.india.every((r) => /^[a-z0-9-]+$/.test(r)));
  for (const outside of ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'eastus', 'europe-west1']) assert.equal(regions.india.includes(outside), false, outside);
  const deployFiles = fs.readdirSync(path.join(repoRoot, 'deploy/prod'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(repoRoot, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  for (const file of deployFiles.filter((f) => f !== 'deploy/prod/regions.json')) {
    const text = read(file);
    assert.deepEqual(regions.india.filter((r) => new RegExp(`(^|[^a-z0-9-])${r}([^a-z0-9-]|$)`).test(text)), [], `${file} names no region`);
    assert.equal(/\b(us|eu|ap|sa|ca|me|af)-(north|south|east|west|central|northeast|southeast)-\d\b/.test(text), false, `${file} names no region`);
  }
  const dependencies = Object.keys(json('package.json').dependencies);
  const before = ['@aws-sdk/client-s3', '@electric-sql/pglite', 'bullmq', 'dotenv', 'exceljs', 'express', 'ioredis', 'multer', 'pdfkit', 'pg', 'qrcode', 'sharp', 'zod'];
  assert.deepEqual(dependencies.filter((d) => !before.includes(d)), [], 'this phase adds no dependency: no cloud SDK');
  for (const file of ['src/platform/secret-source.js', 'src/platform/health.js', 'src/platform/production-guard.js', 'src/platform/error-sink.js', 'src/platform/secrets.js']) {
    const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports.filter((i) => !i.startsWith('node:') && !i.startsWith('.')), [], `${file} imports no package`);
  }

  // The workflow: the image on both architectures, the templates from public images, the three checks with service containers.
  const workflow = read('.github/workflows/prod.yml');
  for (const needle of ['amd64', 'arm64', '--read-only', 'docker compose', 'kustomize', 'kubeconform', 'hashicorp/terraform', 'init -backend=false', 'promtool', 'check rules', 'test rules',
    'check:r05', 'check:r06', 'check:r07', 'prod:validate', 'postgres:16-alpine', 'redis:7-alpine', 'clickhouse/clickhouse-server', 'minio', 'needs: [image, templates, readiness]']) {
    assert.ok(workflow.includes(needle), `prod.yml: ${needle}`);
  }
  assert.equal(/apt-get install[^\n]*(terraform|kubeconform|promtool|kustomize)/.test(workflow), false, 'no validation tool is installed by hand');
  assert.equal(/secrets\./.test(workflow), false, 'the workflow needs no repository secret');

  // Settings: in the config, in the example, and none of the example's new lines holds a value that is a secret.
  const example = read('.env.example');
  for (const name of ['SECRETS_DRIVER', 'SECRETS_DIR', 'SECRETS_URL', 'SECRETS_TOKEN_FILE', 'SECRETS_PATH_PREFIX', 'SECRETS_REFRESH_SECONDS', 'SECRETS_FORMAT', 'DATA_KEY_OLD', 'DEPLOY_ENV', 'RELEASE', 'SHUTDOWN_SECONDS',
    'HEALTH_CHECK_MS', 'WORKER_HEALTH_HOST', 'ERROR_SINK', 'ERROR_SINK_URL', 'ERROR_SINK_TOKEN', 'GOLIVE_ENFORCE', 'GOLIVE_ATTESTATIONS']) {
    assert.ok(example.includes(name), `.env.example: ${name}`);
  }
  assert.deepEqual([config.secretsFormat, config.secretsDriver, config.errorSink, config.shutdownSeconds, config.healthCheckMs, config.workerHealthHost, config.deployEnv, config.goliveEnforce],
    ['v1', 'env', 'none', 25, 2000, '127.0.0.1', '', false]);

  // No sample business is named in anything this phase adds, and the handoff says what the tracks build on.
  assert.equal(checkFolders(['src/modules/golive', 'src/modules/secret-rotation', 'src/modules/business-ops', 'src/contracts/golive.js', 'src/contracts/metrics.js', 'src/contracts/secrets.js', 'src/platform', 'tools/readiness', 'scripts/golive.js'], repoRoot).length, 0);
  const handoff = read('HANDOFF.md');
  for (const needle of ['Phase 9 contract', 'src/platform/health.js', 'src/platform/secret-source.js', 'src/platform/production-guard.js', 'src/contracts/metrics.js', 'src/contracts/golive.js', 'SECRET_COLUMNS', 'ctx.signupGuard', 'npm run golive', 'deploy/prod', 'DEPLOY_ENV']) {
    assert.ok(handoff.includes(needle), `HANDOFF.md: ${needle}`);
  }
});
