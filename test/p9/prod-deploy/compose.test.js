// G-08: the production compose file. Its structure is read here; `docker compose config -q` runs when Docker is on
// this machine and otherwise in the prod workflow's templates job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SECRET_SETTINGS } from '../../../src/config.js';
import { ROOT, hasTool, read, yamlDoc } from './support.js';

const DIR = 'deploy/prod/compose';
const compose = yamlDoc(`${DIR}/compose.yaml`);
const APP = ['web-1', 'web-2', 'worker'];
const envOf = (service) => compose.services[service].environment;

test('G-08 two web servers behind a load balancer, one worker, Redis and the analytics database; Postgres and object storage outside', () => {
  assert.deepEqual(Object.keys(compose.services).sort(), ['analytics', 'lb', 'redis', 'web-1', 'web-2', 'worker']);
  assert.equal(compose.services['web-1'].command.join(' '), 'node src/server.js');
  assert.equal(compose.services['web-2'].command.join(' '), 'node src/server.js');
  assert.equal(compose.services.worker.command.join(' '), 'node src/worker.js');
  const caddy = read(`${DIR}/Caddyfile`);
  assert.match(caddy, /reverse_proxy web-1:3000 web-2:3000/);
  assert.match(caddy, /lb_policy round_robin/);
  assert.match(caddy, /health_uri \/readyz/);
  assert.doesNotMatch(caddy, /lb_policy (cookie|ip_hash|client_ip|header)|sticky/i, 'no session stickiness');
  assert.match(caddy, /on_demand_tls \{\s*ask http:\/\/127\.0\.0\.1:8081\/tls\/ask/, "a seller's domain gets a certificate only when the app's /tls/ask approves it");
  for (const service of APP) {
    const env = envOf(service);
    for (const name of ['DATABASE_URL', 'DATABASE_OWNER_URL', 'REDIS_URL', 'CLICKHOUSE_URL']) assert.equal(env[name], undefined, `${service}: ${name} is a mounted secret, not an environment value`);
    assert.equal(env.STORAGE_DRIVER, 's3');
    assert.match(env.S3_ENDPOINT, /^\$\{S3_ENDPOINT/, 'object storage is an outside address');
    assert.equal(env.QUEUE_DRIVER, 'redis');
    assert.equal(env.CACHE_DRIVER, 'redis');
    assert.equal(env.ANALYTICS_DRIVER, 'clickhouse');
  }
  assert.equal(compose.networks.data.internal, true, 'Redis and the analytics database have no way out');
  assert.deepEqual(compose.services.redis.networks, ['data']);
  assert.deepEqual(compose.services.analytics.networks, ['data']);
  assert.equal(compose.services.redis.ports, undefined);
  assert.equal(compose.services.analytics.ports, undefined);
  assert.deepEqual(Object.keys(compose.services).filter((s) => compose.services[s].ports), ['lb'], 'only the load balancer is published');
});

test('G-01 G-04 every app container: read-only, /tmp writable, non-root, no capabilities, drains in time, secrets as files', () => {
  for (const service of APP) {
    const s = compose.services[service];
    assert.equal(s.read_only, true, service);
    assert.ok(s.tmpfs.some((t) => t.startsWith('/tmp')), service);
    assert.equal(s.user, 'node', service);
    assert.deepEqual(s.cap_drop, ['ALL'], service);
    assert.ok(s.security_opt.includes('no-new-privileges:true'), service);
    assert.ok(Number.parseInt(s.stop_grace_period, 10) > Number(envOf(service).SHUTDOWN_SECONDS), `${service}: the grace period outlasts SHUTDOWN_SECONDS`);
    assert.ok(s.deploy.resources.limits.memory, `${service}: a memory limit`);
    assert.match(s.healthcheck.test.join(' '), /\/readyz/, service);
    const env = envOf(service);
    assert.equal(env.DEPLOY_ENV, 'production');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.SECRETS_DRIVER, 'file');
    assert.equal(env.SECRETS_DIR, '/run/secrets');
    assert.equal(env.SECRETS_FORMAT, 'v2');
    const mount = s.volumes.find((v) => v.target === '/run/secrets');
    assert.equal(mount.read_only, true, `${service}: the secrets folder is mounted read-only`);
    assert.match(mount.source, /^\$\{SECRETS_HOST_DIR/);
    for (const name of Object.keys(SECRET_SETTINGS)) assert.equal(env[name], undefined, `${service} names no secret in its environment: ${name}`);
  }
  assert.equal(envOf('worker').WORKER_HEALTH_PORT, '3001');
  assert.match(compose.services.worker.healthcheck.test.join(' '), /127\.0\.0\.1:3001\/readyz/);
});

test('G-08 every variable the file reads is in .env.example, and the example holds no secret', () => {
  const used = new Set([...read(`${DIR}/compose.yaml`).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]));
  for (const m of read(`${DIR}/Caddyfile`).matchAll(/\{\$([A-Z0-9_]+)\}/g)) used.add(m[1]);
  const example = Object.fromEntries(read(`${DIR}/.env.example`).split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual([...used].filter((name) => !(name in example)), [], 'a variable compose.yaml reads is missing from .env.example');
  assert.deepEqual(Object.keys(example).filter((name) => name in SECRET_SETTINGS), [], 'no secret setting is an environment value');
  for (const [name, value] of Object.entries(example)) assert.match(value, /example\.com|set-me|^bhava|^0$|^\/srv\/|^192\.0\.2\./, `${name} is a placeholder`);
  const ci = yamlDoc(`${DIR}/compose.ci.yaml`);
  assert.deepEqual(Object.keys(ci.services).filter((s) => !APP.includes(s)).sort(), ['objects', 'postgres'], 'the CI override adds only the two outside services');
});

test('G-08 the QA compose file in deploy/bhava is left as it was', () => {
  const r = spawnSync('git', ['diff', '--quiet', 'bhava/build', '--', 'deploy/bhava'], { cwd: ROOT });
  assert.equal(r.status, 0, 'deploy/bhava differs from bhava/build');
});

test('G-08 docker compose config accepts the file (needs Docker)', (t) => {
  if (!hasTool('docker', ['compose', 'version'])) return t.skip('Docker Compose is not available here: the prod workflow\'s templates job runs it');
  const cwd = path.join(ROOT, DIR);
  for (const files of [['-f', 'compose.yaml'], ['-f', 'compose.yaml', '-f', 'compose.ci.yaml']]) {
    const r = spawnSync('docker', ['compose', '--env-file', '.env.example', ...files, 'config', '-q'], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
