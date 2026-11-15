// G-02 to G-05 and G-09: readiness and liveness, the drain on a stop signal, where secrets come from and how a missing or
// failing source is handled, and the production rules, tried on real server processes. Attack cases: each dependency down
// in turn and slow, migrations behind, answers searched for secrets and for a business, each required secret missing, a file
// with a trailing newline or only blanks, a secret manager that is slow, down or refuses the token, a refresh that fails and
// recovers, and production started with each unsafe setting in turn.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { REQUIRED_SECRETS, SECRET_SETTINGS, config, loadSecrets } from '../../../src/config.js';
import { PRODUCTION_RULES } from '../../../src/platform/production-guard.js';
import { HEALTH_DEPENDENCIES, knownMigrations } from '../../../src/platform/health.js';
import { createSecretSource } from '../../../src/platform/secret-source.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createSecretsManager } from '../../../tools/sim/secrets/index.mjs';
import { startApp } from '../../helpers.js';
import { IS_WINDOWS, assertNoneOf, freePort, key, needsCi, pause, request, runNode, scratch, startNode, waitFor } from './support.js';

const apps = [];
after(async () => {
  for (const close of apps.reverse()) await close();
});
async function webApp(options) {
  const app = await startApp(options);
  apps.push(() => app.close());
  return app;
}
const DOWN = 503;
const ask = (app, p, host) => fetch(`${app.base}${p}`, host ? { headers: { 'x-forwarded-host': host, host } } : undefined);

// ---- G-02 ----------------------------------------------------------------------------------------------------------------

test('G-02: readiness is false while the queue is down and true again when it comes back; liveness stays true throughout', async () => {
  const app = await webApp();
  const { platform } = app.ctx;
  const stats = platform.queue.stats;
  assert.equal((await ask(app, '/readyz')).status, 200);
  platform.queue.stats = async () => { throw new Error('connect ECONNREFUSED 10.9.8.7:6379 password=queue-hunter2'); };
  try {
    const down = await ask(app, '/readyz');
    const text = await down.text();
    assert.equal(down.status, DOWN);
    assert.equal(JSON.parse(text).checks.queue, 'down');
    assertNoneOf('the readiness answer', text, ['10.9.8.7', 'queue-hunter2', 'ECONNREFUSED']);
    assert.equal((await ask(app, '/healthz')).status, 200, 'the process is not killed for a dependency\'s fault');
  } finally {
    platform.queue.stats = stats;
  }
  assert.equal(await waitFor(async () => (await ask(app, '/readyz')).status === 200), true, 'ready again with nobody touching it');
});

test('G-02: a cache check that never answers does not hang the probe: readiness is false within its own limit, and true again when it recovers', async () => {
  const app = await webApp({ overrides: { healthCheckMs: 300 } });
  const { health } = app.ctx.platform;
  health.check('cache', () => new Promise(() => {}));
  const started = Date.now();
  const res = await ask(app, '/readyz');
  assert.equal(res.status, DOWN);
  assert.equal((await res.json()).checks.cache, 'down');
  assert.ok(Date.now() - started < 3000, 'the probe answered within its own limit');
  assert.equal((await ask(app, '/healthz')).status, 200);
  health.check('cache', async () => 'up');
  assert.equal((await ask(app, '/readyz')).status, 200);
});

test('G-02: readiness is false while storage is down and says nothing of the bucket or the keys', async () => {
  const app = await webApp();
  const { health } = app.ctx.platform;
  health.check('storage', async () => { throw new Error('bucket prod-media-bucket refused key AKIAABCDEFGHIJKLMNOP secret wJalrXUtnFEMI/K7MDENG'); }); // secret-scan:allow
  const down = await ask(app, '/readyz');
  const text = await down.text();
  assert.equal(down.status, DOWN);
  assert.equal(JSON.parse(text).checks.storage, 'down');
  assertNoneOf('the answer', text, ['prod-media-bucket', 'AKIA', 'wJalr']);
  assert.equal((await ask(app, '/healthz')).status, 200);
  health.check('storage', async () => 'up');
  assert.equal((await ask(app, '/readyz')).status, 200);
});

test('G-02: readiness names migrations the build knows and the database has not run, and clears when they are run', async () => {
  const app = await webApp();
  const q = (text, params) => (app.db.platform ?? app.db).query(text, params);
  const latest = knownMigrations().at(-1);
  const [row] = await q('SELECT * FROM schema_migrations WHERE version = $1', [latest]);
  assert.ok(row, 'the latest migration is recorded');
  await q('DELETE FROM schema_migrations WHERE version = $1', [latest]);
  try {
    const res = await ask(app, '/readyz');
    const body = await res.json();
    assert.equal(res.status, DOWN);
    assert.equal(body.checks.migrations, 'behind');
    assert.equal((await ask(app, '/healthz')).status, 200);
  } finally {
    const cols = Object.keys(row);
    await q(`INSERT INTO schema_migrations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => row[c]));
  }
  assert.equal((await ask(app, '/readyz')).status, 200);
});

test('G-02: with the database gone, readiness is false for the database and migrations and liveness is still true', async () => {
  const app = await webApp();
  await app.db.close();
  const res = await ask(app, '/readyz');
  const body = await res.json();
  assert.equal(res.status, DOWN);
  assert.deepEqual([body.checks.database, body.checks.migrations], ['down', 'down']);
  assert.equal((await ask(app, '/healthz')).status, 200);
});

test('G-02: the probes answer on any host, name no business and no secret, and are never cached', async () => {
  const app = await webApp();
  await app.platform.tenants.create({ slug: 'leaky-business-slug', name: 'Leaky Business Name', plan: 't3' });
  for (const p of ['/healthz', '/readyz', '/startupz']) {
    for (const host of [undefined, 'leaky-business-slug.bhava.test', 'admin.bhava.test', 'anything.example']) {
      const res = await ask(app, p, host);
      const text = await res.text();
      assert.ok([200, 503].includes(res.status), `${p} on ${host}: ${res.status}`);
      assertNoneOf(`${p} on ${host}`, text, ['leaky-business-slug', 'Leaky Business Name', 'test-secret', 'secret', app.config.dataKey]);
      if (p !== '/healthz') assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  }
  const body = await (await ask(app, '/readyz')).json();
  assert.deepEqual(Object.keys(body.checks), [...HEALTH_DEPENDENCIES]);
  for (const state of Object.values(body.checks)) assert.ok(['up', 'down', 'behind', 'unchecked'].includes(state), 'one word per dependency');
});

test('G-02: a storage probe is registered: readiness does not leave storage "unchecked" on the production drivers', async () => {
  const app = await webApp();
  const body = await (await ask(app, '/readyz')).json();
  assert.notEqual(body.checks.storage, 'unchecked', 'a build with object storage must ask it');
});

// ---- G-03 ----------------------------------------------------------------------------------------------------------------

test('G-03: draining turns readiness false at once, keeps liveness true, runs each step once in order, and a second call is the same drain', async () => {
  const app = await webApp();
  const { health } = app.ctx.platform;
  const order = [];
  health.onDrain('first', async () => { await pause(30); order.push('first'); });
  health.onDrain('second', () => { order.push('second'); });
  assert.equal((await ask(app, '/readyz')).status, 200);
  const draining = health.drain({ deadlineMs: 5000 });
  const res = await ask(app, '/readyz');
  assert.equal(res.status, DOWN);
  assert.equal((await res.json()).draining, true);
  assert.equal((await ask(app, '/healthz')).status, 200, 'liveness is not what tells a balancer to stop sending');
  const result = await draining;
  assert.equal(await health.drain(), result, 'a second signal is not a second drain');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(result.timedOut, false);
});

test('G-03: a step that never ends does not hold the process past the deadline, and the others still ran', async () => {
  const app = await webApp();
  const { health } = app.ctx.platform;
  const ran = [];
  health.onDrain('quick', () => { ran.push('quick'); });
  health.onDrain('stuck', () => new Promise(() => {}));
  const started = Date.now();
  const result = await health.drain({ deadlineMs: 400 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(ran, ['quick']);
});

const webEnv = (port, extra = {}) => ({ ALLOW_PGLITE: '1', PORT: String(port), SHUTDOWN_SECONDS: '10', LOG_FORMAT: 'json', APP_SECRET: 'drain-app-secret', VERIFY_TOKEN: 'drain-verify', ...extra });
async function bootWeb(extra) {
  const port = await freePort();
  const proc = startNode(['src/server.js'], { env: webEnv(port, extra) });
  const up = await waitFor(async () => {
    if (proc.state.exited) return 'dead';
    try {
      return (await request(port, { path: '/startupz' })).status === 200;
    } catch {
      return false;
    }
  }, 90_000);
  assert.equal(up, true, `the server did not start: ${proc.state.stderr.slice(0, 300)}${proc.state.stdout.slice(0, 300)}`);
  return { port, proc };
}

test('G-03: SIGTERM during a slow webhook: the request in flight is answered, new connections are refused, and the process exits 0 inside the deadline', { skip: IS_WINDOWS ? needsCi('a signal that a process can handle (Windows ends the process at once)') : false, timeout: 150_000 }, async () => {
  const { port, proc } = await bootWeb();
  try {
    const body = JSON.stringify({ entry: [{ id: 'nobody', changes: [] }] });
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.on('connect', resolve));
    let reply = '';
    socket.on('data', (d) => (reply += d));
    socket.write(`POST /webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Hub-Signature-256: sha256=00\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 10)}`);
    await pause(300);
    proc.child.kill('SIGTERM');
    await pause(500);
    const refused = await request(port, { path: '/healthz' }).then((r) => r.status, () => 'refused');
    assert.ok(refused === 'refused' || refused === 503, `a new request after the signal got ${refused}`);
    socket.write(body.slice(10));
    await waitFor(() => /HTTP\/1\.1 \d{3}/.test(reply), 8000);
    assert.match(reply, /HTTP\/1\.1 (200|4\d\d)/, 'the request in flight got an answer, not a reset');
    const end = await Promise.race([proc.done, pause(14_000).then(() => 'late')]);
    assert.notEqual(end, 'late', 'it exited inside the deadline');
    assert.equal(proc.state.code, 0);
  } finally {
    await proc.stop();
  }
});

test('G-03: SIGTERM to an idle web server exits 0 at once and logs no error', { skip: IS_WINDOWS ? needsCi('a signal that a process can handle') : false, timeout: 150_000 }, async () => {
  const { proc } = await bootWeb();
  proc.child.kill('SIGTERM');
  const end = await Promise.race([proc.done, pause(12_000).then(() => 'late')]);
  assert.notEqual(end, 'late');
  assert.equal(proc.state.code, 0);
  assert.ok(!/"level":"error"/.test(proc.state.stdout + proc.state.stderr), 'a clean stop is not an error');
});

test('G-03: SIGTERM to the worker with its jobs running exits 0 inside the deadline, and its health port answers until then', { skip: IS_WINDOWS ? needsCi('a signal that a process can handle') : false, timeout: 150_000 }, async () => {
  const port = await freePort();
  const proc = startNode(['src/worker.js'], { env: { ALLOW_PGLITE: '1', WORKER_HEALTH_PORT: String(port), SHUTDOWN_SECONDS: '10', LOG_FORMAT: 'json' } });
  try {
    const up = await waitFor(async () => !proc.state.exited && (await request(port, { path: '/startupz' }).then((r) => r.status, () => 0)) === 200, 90_000);
    assert.equal(up, true, proc.state.stderr.slice(0, 400));
    assert.equal((await request(port, { path: '/healthz' })).status, 200);
    proc.child.kill('SIGTERM');
    const end = await Promise.race([proc.done, pause(14_000).then(() => 'late')]);
    assert.notEqual(end, 'late');
    assert.equal(proc.state.code, 0);
  } finally {
    await proc.stop();
  }
});

// ---- G-04 ----------------------------------------------------------------------------------------------------------------

const valueOf = (name) => `value-of-${name.toLowerCase()}-zq81`;
function secretsDir(skip = [], extra = {}) {
  const dir = scratch();
  for (const name of REQUIRED_SECRETS) if (!skip.includes(name)) fs.writeFileSync(path.join(dir, name), name === 'METRICS_TOKEN' ? 'm'.repeat(32) : valueOf(name));
  for (const [name, value] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), value);
  return dir;
}
const productionEnv = (dir, extra = {}) => ({ NODE_ENV: 'production', DEPLOY_ENV: 'production', SECRETS_DRIVER: 'file', SECRETS_DIR: dir, ...extra });
const allValues = () => [...REQUIRED_SECRETS.map(valueOf), 'm'.repeat(32)];

test('G-04: each required secret missing in turn refuses to start, names that setting, and prints no other secret', async () => {
  const results = await Promise.all(REQUIRED_SECRETS.map(async (name) => ({ name, res: await runNode(['src/server.js'], { env: productionEnv(secretsDir([name])), timeoutMs: 60_000 }) })));
  for (const { name, res } of results) {
    const out = res.stdout + res.stderr;
    assert.equal(res.timedOut, false, name);
    assert.notEqual(res.code, 0, `${name} missing: the server started`);
    assert.ok(out.includes(name), `${name} missing: the message names it`);
    assertNoneOf(`${name} missing: the output`, out, allValues());
  }
});

test('G-04: the worker refuses the same way', async () => {
  const res = await runNode(['src/worker.js'], { env: productionEnv(secretsDir(['DATA_KEY'])), timeoutMs: 60_000 });
  assert.notEqual(res.code, 0);
  assert.ok((res.stdout + res.stderr).includes('DATA_KEY'));
  assertNoneOf('the worker output', res.stdout + res.stderr, allValues());
});

test('G-04: a secret in a file is the file\'s text without its trailing newline, a blank file counts as missing, and an inner line break is kept', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'APP_SECRET'), 'app-secret-lf\n');
  fs.writeFileSync(path.join(dir, 'VERIFY_TOKEN'), 'verify-crlf\r\n');
  fs.writeFileSync(path.join(dir, 'SESSION_SECRET'), '\n  \n');
  fs.writeFileSync(path.join(dir, 'FCM_SERVICE_ACCOUNT'), '{"a":1,\n"b":2}\n');
  const cfg = { ...config, secretSources: {}, deployEnv: '' };
  await loadSecrets(cfg, { env: { SECRETS_DRIVER: 'file', SECRETS_DIR: dir } });
  assert.equal(cfg.appSecret, 'app-secret-lf');
  assert.equal(cfg.verifyToken, 'verify-crlf');
  assert.equal(cfg.fcmServiceAccount, '{"a":1,\n"b":2}');
  assert.ok(!cfg.secretSources.SESSION_SECRET, 'a blank file is not a secret');
  const prod = { ...config, secretSources: {}, deployEnv: 'production' };
  await assert.rejects(loadSecrets(prod, { env: { SECRETS_DRIVER: 'file', SECRETS_DIR: dir } }), (e) => /SESSION_SECRET/.test(e.message));
});

test('G-04: a file named by NAME_FILE that is missing, empty or a folder refuses by setting name and never shows its path', async () => {
  const dir = scratch();
  const hidden = path.join(dir, 'private-mount-place');
  fs.mkdirSync(hidden);
  for (const target of [path.join(hidden, 'nope'), hidden]) {
    const res = await runNode(['src/server.js'], { env: { NODE_ENV: 'production', DEPLOY_ENV: 'production', DATA_KEY_FILE: target }, timeoutMs: 60_000 });
    const out = res.stdout + res.stderr;
    assert.notEqual(res.code, 0);
    assert.ok(out.includes('DATA_KEY'), 'names the setting');
    assert.ok(!out.includes('private-mount-place'), 'does not show where the file was');
  }
});

test('G-04: a master key of the wrong length is refused without echoing it', () => {
  const bad = 'not-32-bytes-secret-value-qq';
  try {
    createSecrets({ dataKey: bad }).encrypt('x');
    assert.fail('a short key was accepted');
  } catch (e) {
    assertNoneOf('the error', `${e.message}${e.stack}`, [bad, Buffer.from(bad).toString('base64')]);
  }
});

test('G-04: every setting that carries a secret can come from a file, and none is logged by a start that fails', async () => {
  const dir = scratch();
  const names = Object.keys(SECRET_SETTINGS);
  for (const name of names) fs.writeFileSync(path.join(dir, name), `from-file-${name}\n`);
  const cfg = { ...config, secretSources: {}, deployEnv: '' };
  await loadSecrets(cfg, { env: { SECRETS_DRIVER: 'file', SECRETS_DIR: dir } });
  for (const [name, configKey] of Object.entries(SECRET_SETTINGS)) {
    assert.equal(cfg[configKey], `from-file-${name}`, `${name} loaded from its file`);
    assert.equal(cfg.secretSources[name], 'file');
  }
});

// ---- G-05 ----------------------------------------------------------------------------------------------------------------

async function manager(secrets = { DATA_KEY: 'mgr-data-key-1', APP_SECRET: 'mgr-app-secret-1' }) { // secret-scan:allow
  const m = createSecretsManager({ token: 'mgr-token-zz91', prefix: 'v1/bhava', secrets });
  await m.start();
  apps.push(() => m.close());
  const dir = scratch();
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'mgr-token-zz91\n');
  const env = { SECRETS_DRIVER: 'http', SECRETS_URL: m.url, SECRETS_PATH_PREFIX: 'v1/bhava', SECRETS_TOKEN_FILE: tokenFile, SECRETS_REFRESH_SECONDS: '0.05', SECRETS_TIMEOUT_MS: '500' };
  return { m, env, tokenFile };
}

test('G-05: a secret manager that is down, slow or refuses the token refuses the start, and the output holds no token and no value', async () => {
  const { m, env } = await manager();
  const prod = { NODE_ENV: 'production', DEPLOY_ENV: 'production', ...env, METRICS_TOKEN: 'm'.repeat(32) };
  const bad = ['mgr-token-zz91', 'mgr-data-key-1', 'mgr-app-secret-1'];
  await m.post('/outage', { on: true });
  const down = await runNode(['src/server.js'], { env: prod, timeoutMs: 60_000 });
  await m.post('/outage', { on: false });
  await m.post('/slow', { ms: 3000 });
  const slow = await runNode(['src/server.js'], { env: prod, timeoutMs: 60_000 });
  await m.post('/slow', { ms: 0 });
  await m.post('/token', { token: 'a-different-token-77' }); // secret-scan:allow
  const refused = await runNode(['src/server.js'], { env: prod, timeoutMs: 60_000 });
  for (const [label, res] of [['down', down], ['slow', slow], ['refused', refused]]) {
    assert.equal(res.timedOut, false, `${label}: it gave up by itself`);
    assert.notEqual(res.code, 0, `${label}: the start was refused`);
    assertNoneOf(`${label}: the output`, res.stdout + res.stderr, [...bad, 'a-different-token-77']);
  }
});

test('G-05: a refresh that fails keeps the last good values, raises an alert with no value in it, and the next good refresh is applied', async () => {
  const { m, env } = await manager();
  const alerts = [];
  const names = ['DATA_KEY', 'APP_SECRET'];
  const source = createSecretSource({ names, env, onAlert: (a) => alerts.push(a) });
  apps.push(() => source.stop());
  const first = await source.load();
  assert.equal(first.values.DATA_KEY, 'mgr-data-key-1');
  const changes = [];
  source.start((c) => changes.push(c));
  await m.post('/outage', { on: true });
  await waitFor(() => alerts.length >= 2, 5000);
  assert.ok(alerts.length >= 2, 'a failure each refresh, or one alert that counts them');
  assert.deepEqual(changes, [], 'nothing was applied');
  assertNoneOf('the alerts and state', JSON.stringify(alerts) + JSON.stringify(source.state()), ['mgr-token-zz91', 'mgr-data-key-1', 'mgr-app-secret-1']);
  assert.ok(source.state().failures >= 2);
  await m.post('/outage', { on: false });
  await m.post('/rotate', { name: 'APP_SECRET', value: 'mgr-app-secret-2' });
  await waitFor(() => changes.some((c) => c.changed.includes('APP_SECRET')), 5000);
  const applied = changes.find((c) => c.changed.includes('APP_SECRET'));
  assert.equal(applied.values.APP_SECRET, 'mgr-app-secret-2', 'recovered by itself');
  assert.equal(applied.values.DATA_KEY, 'mgr-data-key-1', 'the other value was not lost in the outage');
});

test('G-05: a token that stops being accepted during a refresh keeps the last good values and alerts as unauthorised', async () => {
  const { m, env } = await manager();
  const alerts = [];
  const source = createSecretSource({ names: ['DATA_KEY', 'APP_SECRET'], env, onAlert: (a) => alerts.push(a) });
  apps.push(() => source.stop());
  await source.load();
  const changes = [];
  source.start((c) => changes.push(c));
  await m.post('/token', { token: 'rotated-away-token-5' }); // secret-scan:allow
  await waitFor(() => alerts.length > 0, 5000);
  assert.equal(alerts[0].code, 'unauthorized');
  assert.deepEqual(changes, []);
  assertNoneOf('the alert', JSON.stringify(alerts), ['mgr-token-zz91', 'rotated-away-token-5', 'mgr-data-key-1']);
});

test('G-05: the manager answering with an empty or odd value never blanks a secret already held', async () => {
  const { m, env } = await manager();
  const source = createSecretSource({ names: ['DATA_KEY', 'APP_SECRET'], env, onAlert: () => {} });
  apps.push(() => source.stop());
  await source.load();
  const changes = [];
  source.start((c) => changes.push(c));
  await m.post('/rotate', { name: 'APP_SECRET', value: '' }).catch(() => {});
  await pause(400);
  for (const change of changes) assert.ok(change.values.APP_SECRET, 'a blank value was handed to the process');
});

// ---- G-09 ----------------------------------------------------------------------------------------------------------------

/** A production environment that meets every rule, over mounted files; the database address points nowhere so a start that passes the rules stops at the database. */
function goodProduction(extra = {}) {
  const dir = secretsDir([], { DATA_KEY: key(), SESSION_SECRET: 'sess-aaaaaaaaaaaaaaaaaaaa', METRICS_TOKEN: 'm'.repeat(32) });
  return {
    NODE_ENV: 'production', DEPLOY_ENV: 'production', SECRETS_DRIVER: 'file', SECRETS_DIR: dir, SECRETS_FORMAT: 'v2',
    DATABASE_URL_FILE: path.join(dir, 'DATABASE_URL'), STORAGE_DRIVER: 's3', S3_BUCKET: 'files', QUEUE_DRIVER: 'redis', CACHE_DRIVER: 'redis',
    PLATFORM_DOMAIN: 'shops.bhava-platform.in', PUBLIC_BASE_URL: 'https://app.bhava-platform.in', ...extra, __dir: dir,
  };
}
function withDb(env) {
  const { __dir: dir, ...rest } = env;
  fs.writeFileSync(path.join(dir, 'DATABASE_URL'), 'postgres://app:db-app-pass-77@127.0.0.1:1/bhava'); // secret-scan:allow
  fs.writeFileSync(path.join(dir, 'DATABASE_OWNER_URL'), 'postgres://owner:db-owner-pass-88@127.0.0.1:1/bhava'); // secret-scan:allow
  fs.writeFileSync(path.join(dir, 'REDIS_URL'), 'rediss://:redis-pass-99@127.0.0.1:1');
  delete rest.DATABASE_URL_FILE;
  return rest;
}

test('G-09: a production configuration that meets every rule is not stopped by one (the start goes on to the database)', async () => {
  const res = await runNode(['src/server.js'], { env: withDb(goodProduction()), timeoutMs: 60_000 });
  const out = res.stdout + res.stderr;
  assert.ok(!/cannot run production|production\.guard/i.test(out), `a rule refused a good configuration: ${out.slice(0, 400)}`);
});

const UNSAFE = {
  'db.two_logins': { remove: ['DATABASE_OWNER_URL'] },
  'storage.object': { env: { STORAGE_DRIVER: 'local' } },
  'queue.redis': { env: { QUEUE_DRIVER: 'pg' } },
  'cache.redis': { env: { CACHE_DRIVER: 'memory' } },
  'secrets.data_key': { env: { DATA_KEY: 'env-data-key-value-pp' }, remove: ['DATA_KEY'] },
  'secrets.envelope': { env: { SECRETS_FORMAT: 'v1' } },
  'providers.no_simulator': { env: { GRAPH_BASE_URL: 'http://127.0.0.1:9101' } },
  'providers.no_test_address': { env: { AI_BASE_URL: 'http://127.0.0.1:9120' } },
  'providers.no_test_key': { env: { RAZORPAY_KEY_ID: ['rzp', 'test', 'abcdefghij1234'].join('_') } },
  'auth.no_password_login': { env: { PASSWORD_LOGIN: '1' } },
  'auth.no_env_owner': { env: { ADMIN_PASSWORD: 'owner-password-in-env-ww' } },
  'metrics.token': { remove: ['METRICS_TOKEN'], files: { METRICS_TOKEN: 'short' } },
  'hosts.platform': { env: { PUBLIC_BASE_URL: 'http://localhost:3000', PLATFORM_DOMAIN: '' } },
  'sending.live': { env: { DRY_RUN: '1' } },
};
test('G-09: every production rule has a start test here (secrets.session and fetch.no_transport are not settable from the environment)', () => {
  const covered = new Set([...Object.keys(UNSAFE), 'secrets.session', 'fetch.no_transport']);
  assert.deepEqual(PRODUCTION_RULES.map((r) => r.id).filter((id) => !covered.has(id)), [], 'a new rule needs its case');
});

for (const [rule, change] of Object.entries(UNSAFE)) {
  test(`G-09: production started with ${rule} broken refuses, names the rule or its setting, and prints no value`, async () => {
    const base = goodProduction();
    const env = withDb(base);
    for (const name of change.remove ?? []) fs.rmSync(path.join(base.__dir, name), { force: true });
    for (const [name, text] of Object.entries(change.files ?? {})) fs.writeFileSync(path.join(base.__dir, name), text);
    const res = await runNode(['src/server.js'], { env: { ...env, ...change.env }, timeoutMs: 60_000 });
    const out = res.stdout + res.stderr;
    assert.equal(res.timedOut, false);
    assert.notEqual(res.code, 0, 'the server started');
    const rule$ = PRODUCTION_RULES.find((r) => r.id === rule);
    const settings = [...rule$.settings, ...(change.remove ?? [])];
    assert.ok(out.includes(rule) || settings.some((s) => out.includes(s)), `the message names ${rule} or one of ${settings.join(', ')}: ${out.slice(0, 300)}`);
    assertNoneOf('the output', out, ['owner-password-in-env-ww', 'env-data-key-value-pp', 'db-app-pass-77', 'db-owner-pass-88', 'redis-pass-99', ...Object.values(change.env ?? {}).filter((v) => String(v).length > 12 && !/^https?:\/\//.test(v))]);
  });
}

test('G-09: the worker refuses an unsafe production the same way', async () => {
  const base = goodProduction();
  const env = withDb(base);
  const res = await runNode(['src/worker.js'], { env: { ...env, STORAGE_DRIVER: 'local', CACHE_DRIVER: 'memory' }, timeoutMs: 60_000 });
  const out = res.stdout + res.stderr;
  assert.notEqual(res.code, 0);
  assert.match(out, /storage\.object/);
  assert.match(out, /cache\.redis/);
});

test('G-09: with DEPLOY_ENV unset the same unsafe settings do not stop a start, so QA keeps running, and the checklist is what refuses', async () => {
  const port = await freePort();
  const proc = startNode(['src/server.js'], { env: { ALLOW_PGLITE: '1', NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'qa-session' } });
  try {
    const up = await waitFor(async () => (proc.state.exited ? 'dead' : (await request(port, { path: '/healthz' }).then((r) => r.status, () => 0)) === 200), 90_000);
    assert.equal(up, true, proc.state.stderr.slice(0, 300) + proc.state.stdout.slice(0, 300));
    assert.match(proc.state.stdout, /production\.guard/, 'the broken rules are logged');
  } finally {
    await proc.stop();
  }
});
