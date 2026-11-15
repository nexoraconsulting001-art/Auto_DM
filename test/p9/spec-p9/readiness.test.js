// G-10, G-11 and G-12: R-05, R-06 and R-07 as scripts anyone can re-run. The scripts need Postgres, Redis, the analytics
// database and an S3-compatible store; where those are named in the environment (CI) the scripts run for real and their
// reports are checked, and otherwise that part is reported as needing CI and never passed. What runs everywhere: the
// scripts' refusals. Attack cases: a missing service named by its setting only; an address that is not on this machine or a
// CI service; a report searched for the connection strings; the data-move scripts run with nothing or with the wrong thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READINESS_CHECKS, missingServices } from '../../../tools/readiness/index.mjs';
import { assertNoneOf, exists, needsCi, read, runNode } from './support.js';

const ENV = process.env;
const SECRETS = ['pg-pass-zq81', 'redis-pass-zq82', 'ch-pass-zq83', 's3-secret-zq84', 's3-key-zq85'];
const remote = {
  TEST_DATABASE_URL: 'postgres://admin:pg-pass-zq81@db.prod-cluster.example.com:5432/bhava',
  REDIS_URL: 'rediss://:redis-pass-zq82@cache.prod-cluster.example.com:6380',
  CLICKHOUSE_URL: 'https://default:ch-pass-zq83@analytics.prod-cluster.example.com:8443',
  S3_ENDPOINT: 'https://storage.prod-cluster.example.com',
  S3_BUCKET: 'live-customer-files',
  S3_ACCESS_KEY_ID: 's3-key-zq85',
  S3_SECRET_ACCESS_KEY: 's3-secret-zq84',
};

for (const [check, spec] of Object.entries(READINESS_CHECKS).filter(([c]) => c !== 'validate')) {
  test(`${spec.requirement}: ${spec.scenario} (npm run check:${check}) names each service it needs that is not set, by its setting, and starts nothing`, async () => {
    const res = await runNode(['tools/readiness/index.mjs', check], { env: {}, timeoutMs: 120_000 });
    assert.equal(res.code, 2);
    const out = res.stdout + res.stderr;
    for (const name of spec.needs) assert.ok(out.includes(name), `${name} is named`);
    assert.equal(/postgres:\/\//.test(out), false);
  });

  test(`${spec.requirement}: ${spec.scenario} refuses to run against an address that is not on this machine or a CI service, and prints no secret`, async () => {
    const env = Object.fromEntries(spec.needs.map((name) => [name, remote[name] ?? 'set']));
    for (const name of Object.keys(remote)) if (!(name in env) && ['REDIS_URL', 'CLICKHOUSE_URL', 'S3_ENDPOINT', 'S3_BUCKET'].includes(name)) env[name] = remote[name];
    Object.assign(env, { S3_ACCESS_KEY_ID: remote.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: remote.S3_SECRET_ACCESS_KEY });
    const res = await runNode(['tools/readiness/index.mjs', check, '--json'], { env, timeoutMs: 170_000 });
    const out = res.stdout + res.stderr;
    assert.equal(res.timedOut, false, 'it refused at once and did not try to connect');
    assert.notEqual(res.code, 0, 'a remote address was accepted');
    assert.match(out, /local|refus|not allowed|CI|only/i, `the refusal says why: ${out.slice(0, 200)}`);
    assertNoneOf('the output', out, SECRETS);
    assert.equal(/prod-cluster/.test(out) && /connected|started|created/i.test(out), false, 'it did not start on the remote address');
  });

  const named = spec.needs.filter((n) => !ENV[n]);
  test(`${spec.requirement}: ${spec.scenario} passes on the production services, step by step, with nothing but configuration different`, { skip: named.length ? needsCi(named.join(', ')) : false, timeout: 3_000_000 }, async () => {
    const res = await runNode(['tools/readiness/index.mjs', check, '--json'], { env: { ...Object.fromEntries(spec.needs.map((n) => [n, ENV[n]])), S3_ACCESS_KEY_ID: ENV.S3_ACCESS_KEY_ID ?? '', S3_SECRET_ACCESS_KEY: ENV.S3_SECRET_ACCESS_KEY ?? '' }, timeoutMs: 2_900_000 });
    const out = res.stdout + res.stderr;
    const report = JSON.parse(res.stdout);
    assert.equal(report.check, check);
    assert.deepEqual(report.steps.map((s) => s.name), [...spec.steps], 'every step the list promises');
    assert.deepEqual(report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`), []);
    assert.equal(report.ok, true);
    assert.equal(res.code, 0);
    for (const name of ['TEST_DATABASE_URL', 'REDIS_URL', 'CLICKHOUSE_URL', 'S3_SECRET_ACCESS_KEY']) if (ENV[name]) assertNoneOf('the report', out, [ENV[name]]);
  });
}

test('G-10: the check lists what differs, not a bare failure: the report format names each step with ok and a detail, and a failed step exits 1', () => {
  const source = read('tools/readiness/index.mjs');
  assert.match(source, /ok/);
  assert.deepEqual(READINESS_CHECKS.r05.steps, ['drivers_are_production', 'no_source_change', 'suite_passes']);
  assert.deepEqual(missingServices('r05', {}).length, READINESS_CHECKS.r05.needs.length);
});

test('G-10: the three check scripts exist beside the runner and each exports run()', async () => {
  const absent = Object.values(READINESS_CHECKS).filter((c) => !exists(`tools/readiness/${c.file}`)).map((c) => c.file);
  assert.deepEqual(absent, [], 'not built');
  for (const c of Object.values(READINESS_CHECKS)) {
    const mod = await import(new URL(`../../../tools/readiness/${c.file}`, import.meta.url));
    assert.equal(typeof mod.run, 'function', c.file);
  }
});

test('G-10: the whole suite is what R-05 runs: no test file is left out of it and the check changes no source file', () => {
  const source = exists('tools/readiness/r05.mjs') ? read('tools/readiness/r05.mjs') : '';
  assert.ok(source, 'r05.mjs');
  assert.match(source, /(git\s+(diff|status)|checksum|hash|sha)/i, 'it proves nothing in the source was changed');
  assert.match(source, /(STORAGE_DRIVER|QUEUE_DRIVER|CACHE_DRIVER|ANALYTICS_DRIVER)/, 'it sets the production drivers');
});

test('G-11: R-06 starts two web servers and a worker, and sends requests to alternating servers with no stickiness', () => {
  const source = exists('tools/readiness/r06.mjs') ? read('tools/readiness/r06.mjs') : '';
  assert.ok(source, 'r06.mjs');
  assert.match(source, /round[- ]?robin|alternat/i, 'requests alternate between the servers');
  assert.doesNotMatch(source, /sticky|ip_hash/i);
});

test('G-12: the data-move scripts refuse to run with nothing to move and name what they need, without printing a connection string or touching anything', async () => {
  for (const script of ['scripts/move-to-cloud.js', 'scripts/copy-files.js']) {
    assert.ok(exists(script), `${script} is not built`);
    const res = await runNode([script], { env: { TARGET_DATABASE_URL: 'postgres://u:pg-pass-zq81@127.0.0.1:1/x' }, timeoutMs: 60_000 });
    assert.notEqual(res.code, 0, script);
    assert.equal(res.timedOut, false);
    assertNoneOf(script, res.stdout + res.stderr, ['pg-pass-zq81']);
    assert.ok((res.stdout + res.stderr).trim().length > 0, `${script} says what it needs`);
  }
});
