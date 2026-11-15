// Q-05 to Q-07: the load test (tools/load). A short version of each part runs in the normal suite; the full version, with the
// budgets' own durations, runs with P8_FULL=1. Each is also run with a budget it cannot meet, and must fail loudly. Q-07 is
// also tested without the tool: webhooks that arrive while the worker is down are stored and each is handled once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PART_REQUIREMENTS, PARTS, loadBudgets, run as runLoad } from '../../../tools/load/index.mjs';
import { addShop, openWorld } from '../../p1/spec-p1/support.js';
import { FULL, filesUnder, json, read, repoRoot } from './support.js';

const budgets = () => structuredClone(loadBudgets());
let serial = 0;
const out = (part) => `p8-spec-${part}-${process.pid}-${++serial}`;
const reportOf = (name) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-results', name, 'report.json'), 'utf8'));
const checksOf = (report, id) => report.checks.filter((c) => c.id === id);
const failing = (report) => report.checks.filter((c) => !c.ok).map((c) => `${c.id ?? ''} ${c.name}: ${c.measured} vs ${c.limit}`);
const SECRET = /postgres(?:ql)?:\/\/[^\s"':@$]+:[^\s"'@$]+@|password["']?\s*[:=]\s*["'][^"'$]{6,}|sk_(test|live)_|Bearer [A-Za-z0-9._-]{16,}/i;

function assertReportFiles(name, report) {
  const dir = path.join(repoRoot, 'test-results', name);
  const onDisk = reportOf(name);
  assert.equal(onDisk.ok, report.ok, 'report.json says what run() answered');
  assert.ok(fs.existsSync(path.join(dir, 'report.md')), 'a report to read');
  const text = fs.readFileSync(path.join(dir, 'report.md'), 'utf8') + JSON.stringify(onDisk);
  assert.doesNotMatch(text, SECRET, 'a report never holds a database password or a token');
  assert.match(text, /PASS|FAIL/);
  assert.ok(Array.isArray(onDisk.checks) && onDisk.checks.length > 0);
  assert.ok(typeof onDisk.startedAt === 'string' && typeof onDisk.finishedAt === 'string');
}

// ---- the budgets are the QA server's ---------------------------------------------------------------------------------------------

test('Q-05: the limits are data and are the QA server\'s: memory, Postgres settings, ten businesses, a p95 for every class of traffic', () => {
  const b = loadBudgets();
  assert.deepEqual(b.memoryMb, { web: 512, worker: 384, postgres: 512 });
  assert.equal(b.businesses, 10);
  assert.equal(b.postgres.maxConnections, 40);
  assert.equal(b.failedRequests, 0, 'not one failed request');
  assert.deepEqual(b.mix.map((m) => m.class).sort(), Object.keys(b.p95Ms).sort(), 'a target for each class in the mix');
  assert.equal(b.mix.reduce((n, m) => n + m.weight, 0), 100);
  const compose = read('deploy/bhava/compose.yaml');
  for (const [name, mb] of Object.entries(b.memoryMb)) assert.match(compose, new RegExp(`${mb}\\s*[mM]`), `${name}: ${mb} MB is in compose.yaml`);
  assert.deepEqual(PARTS, ['mix', 'storm', 'restart']);
  assert.deepEqual(PART_REQUIREMENTS, { mix: 'Q-05', storm: 'Q-06', restart: 'Q-07' });
  for (const file of filesUnder('tools/load')) if (file.endsWith('.mjs') || file.endsWith('.json')) assert.doesNotMatch(read(file), SECRET, file);
});

test('Q-05: the command line refuses production and bad options before it starts anything', () => {
  const guard = pathToFileURL(path.join(repoRoot, 'tools/net-guard.mjs')).href;
  const cli = (args, env = {}) => spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'tools/load/index.mjs'), ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  const production = cli(['--part', 'mix', '--seconds', '5'], { NODE_ENV: 'production' });
  assert.notEqual(production.status, 0);
  assert.match(`${production.stdout}${production.stderr}`, /production/i);
  for (const args of [['--part', 'everything'], ['--seconds', '2'], ['--seconds', '99999'], ['--bogus']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`.slice(0, 300));
  }
});

// ---- Q-05 -------------------------------------------------------------------------------------------------------------------------

test('Q-05: ten businesses under the stated mix: no failed request, every p95 inside its target, web, worker and Postgres inside their memory limit', { timeout: FULL ? 1_800_000 : 900_000 }, async () => {
  const b = budgets();
  const name = out('mix');
  const report = await runLoad({ parts: ['mix'], seconds: FULL ? null : 10, out: name, budgets: b });
  assertReportFiles(name, report);
  const checks = checksOf(report, 'Q-05');
  assert.ok(checks.length >= 1 + Object.keys(b.p95Ms).length + 3, `a check for failed requests, each class and each process (got ${checks.length})`);
  assert.deepEqual(failing(report), [], 'every check passes');
  assert.equal(report.ok, true);
  const names = checks.map((c) => c.name).join('|');
  for (const cls of Object.keys(b.p95Ms)) assert.match(names, new RegExp(cls.replace('_', '[ _]'), 'i'), `a p95 check for ${cls}`);
  for (const process_ of ['web', 'worker', 'postgres']) assert.match(names, new RegExp(process_, 'i'), `a memory check for ${process_}`);
  const failedCheck = checks.find((c) => /fail/i.test(c.name) && /request/i.test(c.name));
  assert.ok(failedCheck, 'the failed requests check');
  assert.equal(Number(failedCheck.measured), 0);
  for (const c of checks.filter((x) => /memory|rss|resident/i.test(x.name))) assert.ok(Number(c.measured) > 0, `${c.name}: memory was actually read, not reported as zero`);
  if (!FULL) assert.match(JSON.stringify(report.notes), /short|seconds|not a pass of record/i, 'a short run says it is not a pass of record');
  assert.ok(report.summary.length > 0, 'the report says how many requests and businesses');
  assert.match(JSON.stringify(report.summary), /10|businesses/i);
});

test('Q-05: a budget the platform cannot meet makes the run fail loudly, and names the check', { timeout: 900_000 }, async () => {
  const b = budgets();
  b.p95Ms = Object.fromEntries(Object.keys(b.p95Ms).map((k) => [k, 0.001]));
  b.memoryMb = { web: 1, worker: 1, postgres: 1 };
  const name = out('mix-impossible');
  const report = await runLoad({ parts: ['mix'], seconds: 8, out: name, budgets: b });
  assertReportFiles(name, report);
  assert.equal(report.ok, false, 'the report is a failure');
  const bad = failing(report).join('\n');
  for (const cls of Object.keys(b.p95Ms)) assert.match(bad, new RegExp(cls.replace('_', '[ _]'), 'i'), `${cls} is named as failing`);
  for (const process_ of ['web', 'worker', 'postgres']) assert.match(bad, new RegExp(process_, 'i'), `${process_} memory is named as failing`);
  assert.match(fs.readFileSync(path.join(repoRoot, 'test-results', name, 'report.md'), 'utf8'), /FAIL/);
});

// ---- Q-06 -------------------------------------------------------------------------------------------------------------------------

test('Q-06: a comment storm on one business keeps another\'s sends and pages inside the bound', { timeout: FULL ? 1_800_000 : 900_000 }, async () => {
  const b = budgets();
  if (!FULL) b.storm = { ...b.storm, comments: 300, overSeconds: 10 };
  const name = out('storm');
  const report = await runLoad({ parts: ['storm'], seconds: FULL ? null : 20, out: name, budgets: b });
  assertReportFiles(name, report);
  const checks = checksOf(report, 'Q-06');
  assert.ok(checks.length >= 2, 'a check for the other business\'s send delay and one for its pages');
  assert.deepEqual(failing(report), []);
  assert.match(checks.map((c) => c.name).join('|'), /send/i);
  assert.match(checks.map((c) => c.name).join('|'), /page/i);
  const delay = checks.find((c) => /send/i.test(c.name));
  assert.ok(Number(delay.measured) <= b.storm.otherBusiness.sendDelayP95Seconds, `the other business's sends waited ${delay.measured} s at the 95th percentile`);
  assert.match(JSON.stringify(report.summary), new RegExp(String(b.storm.comments)), 'the report says how many comments the storm held');
});

test('Q-06: a bound the platform cannot meet fails the storm', { timeout: 900_000 }, async () => {
  const b = budgets();
  b.storm = { comments: 200, overSeconds: 8, otherBusiness: { sendDelayP95Seconds: 0.00001, pageP95Factor: 0.0001 } };
  const name = out('storm-impossible');
  const report = await runLoad({ parts: ['storm'], seconds: 15, out: name, budgets: b });
  assertReportFiles(name, report);
  assert.equal(report.ok, false);
  assert.ok(checksOf(report, 'Q-06').some((c) => !c.ok), 'a Q-06 check failed');
});

// ---- Q-07 -------------------------------------------------------------------------------------------------------------------------

test('Q-07: a restart in the middle of the load loses no webhook that was answered 200 and sends nothing twice', { timeout: FULL ? 1_800_000 : 900_000 }, async () => {
  const b = budgets();
  if (!FULL) b.restart = { ...b.restart, afterSeconds: 6 };
  const name = out('restart');
  const report = await runLoad({ parts: ['restart'], seconds: FULL ? null : 20, out: name, budgets: b });
  assertReportFiles(name, report);
  const checks = checksOf(report, 'Q-07');
  assert.ok(checks.length >= 3, `lost, duplicates and back-in-time are three checks (got ${checks.length})`);
  assert.deepEqual(failing(report), []);
  const lost = checks.find((c) => /lost/i.test(c.name));
  const twice = checks.find((c) => /duplic|twice|twin/i.test(c.name));
  const back = checks.find((c) => /back|restart|recover/i.test(c.name));
  assert.ok(lost && twice && back, checks.map((c) => c.name).join('; '));
  assert.equal(Number(lost.measured), 0);
  assert.equal(Number(twice.measured), 0);
  assert.match(JSON.stringify(report.summary), /webhook/i, 'the report says how many webhooks were answered');
});

test('Q-07: a restart that is slower than the budget fails the run', { timeout: 900_000 }, async () => {
  const b = budgets();
  b.restart = { afterSeconds: 5, lostWebhooks: 0, duplicateSends: 0, backWithinSeconds: 0.001 };
  const name = out('restart-impossible');
  const report = await runLoad({ parts: ['restart'], seconds: 15, out: name, budgets: b });
  assertReportFiles(name, report);
  assert.equal(report.ok, false);
  assert.ok(checksOf(report, 'Q-07').some((c) => !c.ok));
});

test('Q-07: webhooks that arrive while the worker is down are stored, and after it comes back each is handled once (R-02 without the tool)', { timeout: 600_000 }, async (t) => {
  const world = await openWorld();
  t.after(() => world.close());
  const shop = await addShop(world);
  const product = await shop.repos.products.create({ name: 'Queue item', price: '100', active: 'on' });
  const reelId = await shop.reel();
  await shop.repos.reels.save(reelId, { headline: 'Queue reel', keywords: 'LINK', productIds: [product.id], active: 'on' });
  const fans = Array.from({ length: 24 }, () => world.fan());
  for (const fan of fans.slice(0, 8)) await shop.comment(reelId, { from: fan, text: 'LINK' });
  await shop.settle({ ms: 20_000 });
  world.stopWorker();
  for (const fan of fans.slice(8, 16)) await shop.comment(reelId, { from: fan, text: 'LINK' });
  const stored = await shop.inbound();
  assert.ok(stored.length >= 16, `every webhook answered 200 is stored before the reply (${stored.length} of 16)`);
  world.startWorker();
  for (const fan of fans.slice(16)) await shop.comment(reelId, { from: fan, text: 'LINK' });
  const perFan = new Map();
  const tally = async () => {
    perFan.clear();
    for (const m of await shop.dms()) {
      const id = String(m.recipient?.id ?? m.to ?? m.recipientId);
      perFan.set(id, (perFan.get(id) ?? 0) + 1);
    }
  };
  // Sends are paced per account, so give the queue time: until every fan has a DM, or two minutes.
  const until = Date.now() + 120_000;
  do {
    await shop.settle({ ms: 15_000 });
    await tally();
  } while (Date.now() < until && fans.some((fan) => !perFan.has(String(fan.id))));
  const states = (await shop.jobs('true')).reduce((acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }), {});
  for (const fan of fans) assert.equal(perFan.get(String(fan.id)) ?? 0, 1, `fan ${fans.indexOf(fan)} got ${perFan.get(String(fan.id)) ?? 0} DMs: nothing lost, nothing twice (jobs by state: ${JSON.stringify(states)})`);
  const jobs = await shop.jobs(`status NOT IN ('sent', 'skipped', 'cancelled', 'failed', 'unknown')`);
  assert.deepEqual(jobs, [], 'nothing is left in flight');
  const doubled = await shop.jobs('true');
  const keys = doubled.map((j) => j.dedupe_key ?? j.idempotency_key).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, 'no two jobs share a key');
});

test('Q-05: the load tool never names a business, an address or a secret in what it prints or writes', () => {
  for (const file of ['tools/load/index.mjs', 'tools/load/stack.mjs', 'tools/drill/index.mjs']) assert.doesNotMatch(read(file), SECRET, file);
  assert.ok(json('tools/load/budgets.json').note.length > 0);
});
