// G-10 to G-12: the parts the three readiness checks are built from, tested on their own: the address guard and the scrubber, the
// report, the round-robin balancer, the suite comparison, and the data-move comparison.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CheckRefused, assertLocalServices, isAllowedHost, makeScrub } from '../../../tools/prod-checks/guard.mjs';
import { createCleanup } from '../../../tools/prod-checks/cleanup.mjs';
import { startProxy } from '../../../tools/prod-checks/proxy.mjs';
import { createReport } from '../../../tools/prod-checks/report.mjs';
import { compareRuns, counts, failures, gitState, sourceChanges } from '../../../tools/prod-checks/suite.mjs';
import { classifyDifference, compareSnapshots, configDifference } from '../../../tools/readiness/r07.mjs';

const SECRET = 'pw-zq81-secret';

// ---- the address guard -------------------------------------------------------------------------------------------------

test('the guard accepts this machine, and a CI service only in CI', () => {
  assert.doesNotThrow(() => assertLocalServices({ TEST_DATABASE_URL: `postgres://u:${SECRET}@127.0.0.1:5432/x`, REDIS_URL: 'redis://localhost:6379', CLICKHOUSE_URL: 'http://ci:ci@[::1]:8123', S3_ENDPOINT: 'http://127.0.0.1:9000' }));
  assert.equal(isAllowedHost('postgres', { GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isAllowedHost('postgres', {}), false, 'a service name means nothing outside CI');
  assert.throws(() => assertLocalServices({ REDIS_URL: 'redis://redis:6379' }), CheckRefused);
  assert.doesNotThrow(() => assertLocalServices({ REDIS_URL: 'redis://redis:6379', GITHUB_ACTIONS: 'true' }));
});

test('the guard refuses every address that is not local, naming the setting and never the address', () => {
  for (const [name, value] of [
    ['TEST_DATABASE_URL', `postgres://admin:${SECRET}@db.prod-cluster.example.com:5432/bhava`],
    ['REDIS_URL', `rediss://:${SECRET}@10.0.0.5:6380`],
    ['CLICKHOUSE_URL', 'https://analytics.example.com:8443'],
    ['S3_ENDPOINT', 'https://s3.ap-south-1.amazonaws.com'],
    ['S3_ENDPOINT', 'http://127.0.0.1.nip.io:9000'],
    ['TEST_DATABASE_URL', 'not an address'],
  ]) {
    assert.throws(() => assertLocalServices({ [name]: value }), (err) => {
      assert.ok(err instanceof CheckRefused, value);
      assert.ok(err.message.includes(name));
      assert.equal(err.message.includes(SECRET), false);
      assert.equal(err.message.includes('example.com'), false);
      return true;
    }, value);
  }
  // A real address with a local-looking trick in its user part is still read by its host.
  assert.throws(() => assertLocalServices({ REDIS_URL: 'redis://localhost:x@evil.example.org:6379' }), CheckRefused);
});

test('the scrubber takes out addresses, passwords and keys, wherever they appear', () => {
  const env = { TEST_DATABASE_URL: `postgres://admin:${SECRET}@127.0.0.1:5432/bhava`, S3_SECRET_ACCESS_KEY: 'sk-abcdef12345', S3_ACCESS_KEY_ID: 'AKIA-ID-98765' };
  const scrub = makeScrub(env, ['made-up-run-secret']);
  const text = `connect ${env.TEST_DATABASE_URL} failed for ${SECRET} key sk-abcdef12345 id AKIA-ID-98765 and made-up-run-secret; other postgres://x:y@host/db`;
  const out = scrub(text);
  for (const secret of [SECRET, 'sk-abcdef12345', 'AKIA-ID-98765', 'made-up-run-secret', '127.0.0.1:5432', 'x:y@']) assert.equal(out.includes(secret), false, secret);
  assert.match(out, /failed for/);
});

// ---- the report --------------------------------------------------------------------------------------------------------

test('a report names every step in the order the list promises, with what differed, and a failed blocking step stops the rest', async () => {
  const report = createReport('rxx', { steps: ['a', 'b', 'c', 'd'], scrub: (t) => t.replace(SECRET, '***') });
  await report.step('b', async () => `fine ${SECRET}`);
  await report.step('a', async () => ({ problems: ['table orders: 3 rows in the old database, 2 in the new one', 'sequence x differs'] }), { blocking: true });
  await report.step('c', async () => 'never runs');
  const out = report.finish();
  assert.deepEqual(out.steps.map((s) => s.name), ['a', 'b', 'c', 'd']);
  assert.equal(out.ok, false);
  assert.equal(out.steps[0].detail, 'table orders: 3 rows in the old database, 2 in the new one; sequence x differs');
  assert.equal(out.steps[1].detail, 'fine ***');
  assert.deepEqual(out.steps.slice(2).map((s) => [s.ok, s.detail]), [[false, 'not run: a failed'], [false, 'not run: a failed']]);
  assert.match(out.startedAt, /^\d{4}-/);
});

test('a step that throws fails with its first line, and a skipped step is ok but marked', async () => {
  const report = createReport('rxx', { steps: ['x', 'y'] });
  await report.step('x', async () => { throw new Error('the first line\nsecond line with detail'); });
  await report.step('y', async () => ({ ok: true, skipped: true, detail: 'skipped: no docker' }));
  const out = report.finish();
  assert.deepEqual(out.steps[0], { name: 'x', ok: false, detail: 'the first line' });
  assert.deepEqual(out.steps[1], { name: 'y', ok: true, detail: 'skipped: no docker', skipped: true });
  assert.equal(out.ok, false);
  assert.equal(createReport('rxx', { steps: ['q'] }).finish().steps[0].detail, 'not run', 'a step nothing ran is never passed');
});

test('cleanup runs the closers in reverse, skips data under --keep, and reports a closer that failed', async () => {
  const order = [];
  const cleanup = createCleanup({ keep: true, signals: false });
  cleanup.add('db', async () => order.push('db'), { data: true });
  cleanup.add('proc', async () => order.push('proc'));
  cleanup.add('bad', async () => { throw new Error('x'); });
  assert.deepEqual(await cleanup.run(), ['bad']);
  assert.deepEqual(order, ['proc'], 'the process is stopped, the data is kept');
  const again = createCleanup({ signals: false });
  again.add('db', async () => order.push('db2'), { data: true });
  await again.run();
  await again.run();
  assert.equal(order.filter((o) => o === 'db2').length, 1, 'a second run does nothing');
});

// ---- the balancer ------------------------------------------------------------------------------------------------------

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const get = (port, p = '/') => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
  }).on('error', () => resolve({ status: 0, text: '' }));
});

test('the balancer sends requests to the servers in turn, with no stickiness, whoever asks', async () => {
  const a = await listen((req, res) => res.end('A'));
  const b = await listen((req, res) => res.end('B'));
  const lb = await startProxy({ upstreams: [a.port, b.port] });
  try {
    const seen = [];
    for (let i = 0; i < 8; i++) seen.push((await get(lb.port, `/r${i}`)).text);
    assert.deepEqual(seen, ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
    assert.deepEqual(lb.counts(), [4, 4]);
    assert.ok(lb.log.every((entry) => Object.keys(entry).sort().join() === 'method,server,status'), 'only the server, method and status are kept');
  } finally {
    await lb.close();
    a.server.close();
    b.server.close();
  }
});

test('the balancer retries a refused connection and a draining 503 on the other server, takes it out, and brings it back when /readyz answers', async () => {
  let draining = true;
  const a = await listen((req, res) => {
    if (req.url === '/readyz') { res.statusCode = draining ? 503 : 200; return res.end(); }
    res.statusCode = draining ? 503 : 200;
    res.end('A');
  });
  const b = await listen((req, res) => res.end('B'));
  const lb = await startProxy({ upstreams: [a.port, b.port], probeMs: 50 });
  try {
    for (let i = 0; i < 4; i++) assert.deepEqual(await get(lb.port), { status: 200, text: 'B' });
    assert.deepEqual(lb.failures(), [], 'a draining server never made a request fail');
    assert.equal(lb.isUp(0), false);
    draining = false;
    const end = Date.now() + 3000;
    while (!lb.isUp(0) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(lb.isUp(0), true, 'back in the rotation when ready again');
    const texts = new Set();
    for (let i = 0; i < 4; i++) texts.add((await get(lb.port)).text);
    assert.deepEqual([...texts].sort(), ['A', 'B']);
    // A server that is gone: connection refused. The request goes to the other one.
    await new Promise((resolve) => a.server.close(resolve));
    for (let i = 0; i < 4; i++) assert.equal((await get(lb.port)).text, 'B');
    assert.deepEqual(lb.failures(), []);
    // Both gone: the request fails and is counted, never silently dropped.
    await new Promise((resolve) => b.server.close(resolve));
    assert.equal((await get(lb.port)).status, 502);
    assert.equal(lb.failures().length, 1);
  } finally {
    await lb.close();
  }
});

// ---- the suite comparison ----------------------------------------------------------------------------------------------

const row = (over) => ({ file: 'test/a.test.js', line: 1, column: 1, name: 't', nesting: 1, ok: true, suite: false, ...over });

test('a test that passes on the simple drivers and fails on the production ones is named; one that fails on both is told apart', () => {
  const production = [row({ name: 'one', ok: false, error: 'boom' }), row({ name: 'two', line: 2, ok: false }), row({ name: 'ok', line: 3 }), row({ name: 'suite', suite: true, ok: false, nesting: 0 })];
  const simple = [row({ name: 'one' }), row({ name: 'two', line: 2, ok: false })];
  assert.deepEqual(failures(production).map((f) => f.name), ['one', 'two']);
  const { onlyHere, onBoth } = compareRuns(production, simple);
  assert.deepEqual(onlyHere.map((f) => f.name), ['one']);
  assert.deepEqual(onBoth.map((f) => f.name), ['two']);
  assert.deepEqual(counts(production), { passed: 1, skipped: 0, failed: 2, files: 1 });
  // A file that crashed before any test ran is one failure, named by the file.
  assert.deepEqual(failures([row({ name: 'test/b.test.js', file: 'test/b.test.js', nesting: 0, ok: false, suite: false })]).map((f) => f.name), ['test/b.test.js']);
  // A skipped test is neither passed nor failed.
  assert.deepEqual(counts([row({ skipped: true }), row({ name: 'b', line: 5 })]), { passed: 1, skipped: 1, failed: 0, files: 1 });
});

test('the git state sees a changed file, a new file under src and a moved commit, and names them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-git-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one');
    git('add', '.');
    git('commit', '-qm', 'one');
    const before = gitState(dir);
    assert.deepEqual(sourceChanges(before, gitState(dir)), []);
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'two');
    fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'x');
    const changes = sourceChanges(before, gitState(dir));
    assert.deepEqual(changes.sort(), ['src/a.js was added or changed', 'src/new.js was added or changed']);
    git('commit', '-qam', 'two');
    assert.ok(sourceChanges(before, gitState(dir)).includes('the commit moved'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the data-move comparison ------------------------------------------------------------------------------------------

const snap = (rows, checksum, tenants = { 1: { rows: 2, checksum: 'a' } }) => ({
  tables: { orders: { keys: ['id'], tenantColumn: 'tenant_id', whole: { rows, checksum }, tenants } },
  tenantIds: [1], sequences: {}, grants: [], security: { tables: [], policies: [] },
});

test('a count difference and a checksum difference are named by table and business, and sorted into their own steps', () => {
  assert.deepEqual(compareSnapshots(snap(2, 'x'), snap(2, 'x')), { counts: [], checksums: [] });
  const moved = compareSnapshots(snap(2, 'x'), snap(1, 'x', { 1: { rows: 1, checksum: 'a' } }));
  assert.deepEqual(moved.checksums, []);
  assert.deepEqual(moved.counts, ['table orders: 2 rows in the old database, 1 in the new database', 'table orders, business 1: 2 rows in the old database, 1 in the new database']);
  const changed = compareSnapshots(snap(2, 'x'), snap(2, 'y', { 1: { rows: 2, checksum: 'b' } }));
  assert.deepEqual(changed.counts, []);
  assert.equal(changed.checksums.length, 2);
  assert.ok(changed.checksums.every((l) => /orders/.test(l) && /different checksum/.test(l)));
  assert.equal(classifyDifference('files, business 3: a.png is in the source but was never copied'), 'files');
  assert.equal(classifyDifference('sequence orders_id_seq: 5 in the source, 4 after restore'), 'counts');
});

test('only configuration may differ between the old and the new setup: a secret or a domain that changed is named', () => {
  const old = { DATABASE_URL: 'a', PORT: '1', STORAGE_DRIVER: 'local', STORAGE_DIR: '/x', DATA_KEY: 'k', PLATFORM_DOMAIN: 'shops.example', SESSION_SECRET: 's' };
  const moved = { ...old, DATABASE_URL: 'b', PORT: '2', STORAGE_DRIVER: 's3', S3_BUCKET: 'nb', QUEUE_DRIVER: 'redis', REDIS_URL: 'r' };
  delete moved.STORAGE_DIR;
  const ok = configDifference(old, moved);
  assert.deepEqual(ok.unexpected, []);
  assert.ok(ok.changed.includes('S3_BUCKET') && ok.changed.includes('STORAGE_DIR'));
  const bad = configDifference(old, { ...moved, DATA_KEY: 'other', PLATFORM_DOMAIN: 'x.example', NEW_FEATURE: '1' });
  assert.deepEqual(bad.unexpected, ['DATA_KEY', 'NEW_FEATURE', 'PLATFORM_DOMAIN']);
  assert.equal(JSON.stringify(bad).includes('other'), false, 'names only, never a value');
});

test('the steps each check reports are the steps the list in tools/readiness/index.mjs promises, in the same order', async () => {
  const { STEPS } = await import('../../../tools/prod-checks/steps.mjs');
  const { READINESS_CHECKS } = await import('../../../tools/readiness/index.mjs');
  for (const [name, spec] of Object.entries(READINESS_CHECKS)) assert.deepEqual([...STEPS[name]], [...spec.steps], name);
});
