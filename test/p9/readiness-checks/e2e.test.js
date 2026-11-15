// G-10 and G-11 on this machine: R-05 and R-06 run for real against a Postgres and an S3-compatible store on this machine
// (READINESS_ALLOW_SIMPLE_DRIVERS=1: no Redis and no analytics database here, so these are reduced runs, marked as such in the
// report). What they prove: each check passes on a sound setup, fails and names exactly what differed on a broken one, and
// removes everything it made. What only CI proves (Redis, the analytics database, MinIO, the whole suite) is in prod.yml.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { run as runR05 } from '../../../tools/readiness/r05.mjs';
import { run as runR06 } from '../../../tools/readiness/r06.mjs';
import { READINESS_CHECKS } from '../../../tools/readiness/index.mjs';
import { ROOT, leftovers, startFakeS3, startPostgres } from './support.js';

const FIXTURE = 'test/p9/readiness-checks/fixtures/suite.fixture.js';
let pg;
let s3;
const envOf = (extra = {}) => ({
  TEST_DATABASE_URL: pg.url, S3_ENDPOINT: s3.url, S3_BUCKET: 'the-jobs-own-bucket',
  S3_ACCESS_KEY_ID: s3.keys.accessKeyId, S3_SECRET_ACCESS_KEY: s3.keys.secretAccessKey,
  READINESS_ALLOW_SIMPLE_DRIVERS: '1', ...extra,
});

before(async () => {
  pg = await startPostgres();
  s3 = await startFakeS3();
});
after(async () => {
  await s3?.close();
  await pg?.close();
});

const names = (report) => report.steps.map((s) => s.name);
const bad = (report) => report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
const nothingLeft = async () => {
  assert.deepEqual([...s3.buckets.keys()], [], 'no bucket is left behind');
  const left = await leftovers(pg.url);
  assert.deepEqual(left.databases.filter((d) => !/^bhava$/.test(d) && d !== 'postgres'), [], 'no database is left behind');
  assert.deepEqual(left.roles, [], 'no login is left behind');
};

test('R-05: the suite passes on the drivers, git shows no change, and everything the run made is removed', { timeout: 280_000 }, async () => {
  const lines = [];
  const report = await runR05({ env: envOf({ READINESS_TEST_FILES: FIXTURE, READINESS_PASS_MODE: 'ok' }), log: (l) => lines.push(l) });
  assert.deepEqual(names(report), [...READINESS_CHECKS.r05.steps]);
  assert.deepEqual(bad(report), []);
  assert.equal(report.ok, true);
  assert.equal(report.reduced, true, 'a run without Redis and the analytics database says so');
  const by = Object.fromEntries(report.steps.map((s) => [s.name, s.detail]));
  assert.match(by.drivers_are_production, /postgres, object storage answer; two logins.*storage=s3/);
  assert.match(by.suite_passes, /4 tests passed in 1 files .*1 skipped, 0 failed/);
  assert.match(by.no_source_change, /same checksums after the run/);
  const text = JSON.stringify(report) + lines.join('\n');
  for (const secret of [s3.keys.secretAccessKey, s3.keys.accessKeyId, pg.url]) assert.equal(text.includes(secret), false, 'no secret in the report or the log');
  await nothingLeft();
});

test('R-05: a test that passes on the simple drivers and fails on the production ones is named, with its file', { timeout: 280_000 }, async () => {
  const report = await runR05({ env: envOf({ READINESS_TEST_FILES: FIXTURE, READINESS_PASS_MODE: 'driver' }) });
  assert.equal(report.ok, false);
  const suite = report.steps.find((s) => s.name === 'suite_passes');
  assert.equal(suite.ok, false);
  assert.match(suite.detail, /1 tests pass on the simple drivers and fail on the production ones: test\/p9\/readiness-checks\/fixtures\/suite\.fixture\.js "behaves the same on object storage" \(an upload could not be read back\)/);
  assert.doesNotMatch(suite.detail, /fail on the simple drivers too/);
  assert.equal(report.steps.find((s) => s.name === 'no_source_change').ok, true, 'the other steps are still judged');
  await nothingLeft();
});

test('R-05: a test that fails on every driver is reported as a plain failure, not as a driver difference', { timeout: 280_000 }, async () => {
  const report = await runR05({ env: envOf({ READINESS_TEST_FILES: FIXTURE, READINESS_PASS_MODE: 'broken' }) });
  const suite = report.steps.find((s) => s.name === 'suite_passes');
  assert.equal(suite.ok, false);
  assert.match(suite.detail, /1 tests fail on the simple drivers too: .*"is correct on every driver"/);
  assert.doesNotMatch(suite.detail, /pass on the simple drivers and fail/);
  await nothingLeft();
});

test('R-05: a run that leaves a new file under src is caught, and the file is named', { timeout: 280_000 }, async () => {
  const leftover = path.join(ROOT, 'src', 'readiness-fixture-leftover.js');
  try {
    const report = await runR05({ env: envOf({ READINESS_TEST_FILES: FIXTURE, READINESS_PASS_MODE: 'touch' }) });
    assert.equal(report.ok, false);
    assert.equal(report.steps.find((s) => s.name === 'suite_passes').ok, true);
    const step = report.steps.find((s) => s.name === 'no_source_change');
    assert.equal(step.ok, false);
    assert.match(step.detail, /src\/readiness-fixture-leftover\.js was added or changed/);
  } finally {
    fs.rmSync(leftover, { force: true });
  }
  await nothingLeft();
});

test('R-05: without READINESS_ALLOW_SIMPLE_DRIVERS a missing production service fails every step and names it', async () => {
  const env = envOf();
  delete env.READINESS_ALLOW_SIMPLE_DRIVERS;
  const report = await runR05({ env: { ...env, READINESS_TEST_FILES: FIXTURE } });
  assert.equal(report.ok, false);
  assert.deepEqual(names(report), [...READINESS_CHECKS.r05.steps]);
  assert.ok(report.steps.every((s) => !s.ok && /QUEUE_DRIVER has no production service/.test(s.detail)), JSON.stringify(report.steps));
  await nothingLeft();
});

test('R-06: two servers and a worker behind a round-robin balancer: one session, one upload, each job and webhook once, and a server can stop', { timeout: 560_000 }, async () => {
  const lines = [];
  const report = await runR06({ env: envOf(), log: (l) => lines.push(l) });
  assert.deepEqual(names(report), [...READINESS_CHECKS.r06.steps]);
  assert.deepEqual(bad(report), []);
  assert.equal(report.ok, true);
  assert.equal(report.reduced, true);
  const by = Object.fromEntries(report.steps.map((s) => [s.name, s.detail]));
  assert.match(by.two_servers_ready, /requests alternate between the servers/);
  assert.match(by.session_survives_switch, /12 requests alternated across both servers and stayed signed in/);
  assert.match(by.upload_shows_on_both, /read, byte for byte, on the other and is in object storage/);
  assert.match(by.scheduled_job_runs_once, /ran once; 8 webhooks, each sent to both servers, were stored and processed once/);
  assert.match(by.drain_loses_nothing, /none failed, server B took over/);
  const text = JSON.stringify(report) + lines.join('\n');
  for (const secret of [s3.keys.secretAccessKey, s3.keys.accessKeyId, pg.url]) assert.equal(text.includes(secret), false, 'no secret in the report or the log');
  assert.equal(/\+91|9000\d{6}|fan_/.test(text), false, 'no phone number or username in the report');
  await nothingLeft();
});

test('R-06: servers that do not share their files are caught by the upload step, which names the server and the status', { timeout: 560_000 }, async () => {
  const report = await runR06({ env: envOf({ READINESS_INJECT_FAULT: 'split-storage' }) });
  assert.equal(report.ok, false);
  const failed = report.steps.filter((s) => !s.ok);
  assert.deepEqual(failed.map((s) => s.name), ['upload_shows_on_both']);
  assert.match(failed[0].detail, /an image uploaded through server A answered 404 on server B/);
  assert.match(failed[0].detail, /an image uploaded through server B answered 404 on server A/);
  await nothingLeft();
});
