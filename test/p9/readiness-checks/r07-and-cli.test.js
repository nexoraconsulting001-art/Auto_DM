// G-12 on this machine, and the command line of all three checks. R-07 needs pg_dump and pg_restore: where they are missing the
// check must fail on its first step and say so (and clean up); where they are present it can run for real against a Postgres and an
// S3-compatible store on this machine (READINESS_E2E_R07=1; CI proves it with the production services in prod.yml).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgTools } from '../../../tools/drill/backup-check.mjs';
import { READINESS_CHECKS } from '../../../tools/readiness/index.mjs';
import { run as runR07 } from '../../../tools/readiness/r07.mjs';
import { exists, leftovers, read, runNode, startFakeS3, startPostgres } from './support.js';

const tools = await pgTools(process.env);

test('R-07 without the backup tools fails on its first step, names the tool, runs nothing after it, and leaves nothing behind', { skip: tools.missing ? false : 'pg_dump is here: the real run below covers it', timeout: 200_000 }, async () => {
  const pg = await startPostgres();
  const s3 = await startFakeS3();
  try {
    const report = await runR07({ env: { TEST_DATABASE_URL: pg.url, S3_ENDPOINT: s3.url, S3_BUCKET: 'jobs-own', S3_ACCESS_KEY_ID: s3.keys.accessKeyId, S3_SECRET_ACCESS_KEY: s3.keys.secretAccessKey } });
    assert.equal(report.ok, false);
    assert.deepEqual(report.steps.map((s) => s.name), [...READINESS_CHECKS.r07.steps]);
    assert.match(report.steps[0].detail, new RegExp(`^${tools.missing} is not on this machine: install the PostgreSQL 16 client tools`));
    assert.ok(report.steps.slice(1).every((s) => !s.ok && s.detail === 'not run: source_seeded failed'), 'a step that did not run is never passed');
    assert.deepEqual([...s3.buckets.keys()], []);
    const left = await leftovers(pg.url);
    assert.deepEqual(left.databases.filter((d) => d.startsWith('bhava_r07')), []);
    assert.deepEqual(left.roles.filter((r) => r.startsWith('bhava_r07')), []);
  } finally {
    await s3.close();
    await pg.close();
  }
});

test('R-07 end to end: a seeded single server moves to a new database and bucket and nothing differs but configuration', { skip: !tools.missing && process.env.READINESS_E2E_R07 === '1' ? false : 'needs pg_dump and READINESS_E2E_R07=1 (CI runs npm run check:r07)', timeout: 900_000 }, async () => {
  const pg = await startPostgres();
  const s3 = await startFakeS3();
  try {
    const report = await runR07({ env: { TEST_DATABASE_URL: pg.url, S3_ENDPOINT: s3.url, S3_BUCKET: 'jobs-own', S3_ACCESS_KEY_ID: s3.keys.accessKeyId, S3_SECRET_ACCESS_KEY: s3.keys.secretAccessKey, READINESS_ALLOW_SIMPLE_DRIVERS: '1' } });
    assert.deepEqual(report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`), []);
    assert.equal(report.ok, true);
  } finally {
    await s3.close();
    await pg.close();
  }
});

for (const check of ['r05', 'r06', 'r07']) {
  const spec = READINESS_CHECKS[check];

  test(`${spec.scenario}: an address that is not on this machine or a CI service is refused at once, exit 2, with the setting named and no secret printed`, async () => {
    const env = {
      TEST_DATABASE_URL: 'postgres://admin:pg-pass-zq81@127.0.0.1:1/x', REDIS_URL: 'rediss://:redis-pass-zq82@cache.prod-cluster.invalid:6380', CLICKHOUSE_URL: 'http://ch:ch-pass-zq83@127.0.0.1:1', // secret-scan:allow
      S3_ENDPOINT: 'http://127.0.0.1:1', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'key-zq85', S3_SECRET_ACCESS_KEY: 'secret-zq84',
    };
    const res = await runNode(['tools/readiness/index.mjs', check, '--json'], { env, timeoutMs: 60_000 });
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 2);
    const out = res.stdout + res.stderr;
    assert.match(out, /REDIS_URL is not on this machine or a CI service, so it is refused/);
    for (const secret of ['pg-pass-zq81', 'redis-pass-zq82', 'ch-pass-zq83', 'secret-zq84', 'key-zq85', 'prod-cluster']) assert.equal(out.includes(secret), false, secret);
    assert.equal(res.stdout.trim(), '', 'no report is printed for a refused run');
  });

  test(`${spec.scenario}: a local service that is named but is not there fails with the step it broke, not with a stack trace`, async () => {
    const env = {
      TEST_DATABASE_URL: 'postgres://admin:pg-pass-zq81@127.0.0.1:1/x', REDIS_URL: 'redis://127.0.0.1:1', CLICKHOUSE_URL: 'http://127.0.0.1:1', // secret-scan:allow
      S3_ENDPOINT: 'http://127.0.0.1:1', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'key-zq85', S3_SECRET_ACCESS_KEY: 'secret-zq84',
    };
    const res = await runNode(['tools/readiness/index.mjs', check, '--json'], { env, timeoutMs: 120_000 });
    const out = res.stdout + res.stderr;
    assert.equal(res.timedOut, false);
    assert.notEqual(res.code, 0);
    assert.equal(/\n\s+at /.test(out), false, 'no stack trace');
    for (const secret of ['pg-pass-zq81', 'secret-zq84', 'key-zq85']) assert.equal(out.includes(secret), false, secret);
    if (res.code === 1) {
      const report = JSON.parse(res.stdout);
      assert.deepEqual(report.steps.map((s) => s.name), [...spec.steps]);
      assert.ok(report.steps.every((s) => !s.ok), 'nothing is passed when no service answers');
    }
  });
}

test('the readiness scripts hold no address, key or password, ', () => {
  for (const file of ['tools/readiness/r05.mjs', 'tools/readiness/r06.mjs', 'tools/readiness/r07.mjs', 'tools/readiness/validate.mjs', 'tools/prod-checks/guard.mjs', 'tools/prod-checks/services.mjs', 'tools/prod-checks/stack.mjs', 'tools/prod-checks/proxy.mjs', 'tools/prod-checks/suite.mjs', '.github/workflows/prod.yml']) {
    assert.ok(exists(file), file);
    const text = read(file);
    const ips = [...text.matchAll(/\b(\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]).filter((ip) => !['127.0.0.1', '0.0.0.0', '127.0.0.0'].includes(ip));
    assert.deepEqual(ips, [], `${file} names an address`);
    assert.equal(/(password|secret|token)\s*[:=]\s*['"][^'"$\s{]{6,}['"]/i.test(text.replace(/minioci-secret|ci/g, '')), false, `${file} holds a secret`);
  }
});
