// The load test end to end, small: six businesses (the gate lets an account start one conversation a second, so fewer would pace their own DMs), a short run of all three parts, on a real Postgres with web and worker as
// separate processes. The budgets here are loosened on speed only (a test must not depend on how fast the machine is): the
// counts that must be exact (no failed request, no lost webhook, nothing sent twice, every checkout paid) are the real ones.
// How the real limits judge a run is in analyze.test.js; the same measured numbers are judged below against impossible limits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { judgeMemory, judgeMix } from '../../../tools/load/analyze.mjs';
import { loadBudgets, run } from '../../../tools/load/index.mjs';

const real = loadBudgets();
const easy = {
  ...real,
  businesses: 6,
  run: { ...real.run, requestsPerSecond: 15 },
  p95Ms: Object.fromEntries(Object.entries(real.p95Ms).map(([k, v]) => [k, v * 100])),
  storm: { comments: 40, overSeconds: 20, otherBusiness: { sendDelayP95Seconds: 300, pageP95Factor: 25 } },
  restart: { ...real.restart, afterSeconds: 8, backWithinSeconds: 120 },
};

test('Q-05, Q-06 and Q-07: a short run of all three parts passes, counts every accepted webhook, and writes a report with no secret in it', { timeout: 1_200_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-load-test-'));
  const lines = [];
  try {
    const report = await run({ budgets: easy, parts: [], seconds: 60, out: 'load', root, say: (m) => lines.push(m) });
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.name}: ${c.measured} (limit ${c.limit})`);
    assert.deepEqual(failed, [], 'every check passes');
    assert.equal(report.ok, true);
    assert.equal(report.ofRecord, false, 'a short run is not a pass of record');
    assert.match(report.title, /short run/);

    const ids = new Set(report.checks.map((c) => c.id));
    for (const id of ['Q-05', 'Q-06', 'Q-07']) assert.ok(ids.has(id), `${id} is in the report`);
    const names = report.checks.map((c) => c.name);
    for (const expected of ['failed requests', 'p95 buyer_page', 'p95 webhook', 'peak memory web', 'peak memory worker', 'peak memory postgres', 'no message sent twice', 'checkouts paid and confirmed by webhook', 'other businesses: send delay p95', 'lost webhooks (answered 200, not stored)', 'sends twice']) {
      assert.ok(names.some((n) => n.includes(expected)), `a check for "${expected}"`);
    }

    const { mix, storm, restart, peaks } = report.data;
    assert.ok(mix.verify.accepted >= 100 && mix.verify.lost === 0 && mix.verify.unhandled === 0 && mix.verify.duplicateSends === 0, JSON.stringify(mix.verify));
    assert.ok(mix.counts.paid >= 1 && mix.counts.paymentErrors === 0, 'checkouts were paid through the simulator and their webhooks arrived');
    assert.ok(Object.values(mix.byClass).every((c) => c.requests >= 20 && c.failed === 0));
    assert.ok(storm.stormBusiness.accepted.requests >= storm.comments && storm.stormBusiness.accepted.requests <= storm.comments + 1, `every storm comment was sent and answered: ${storm.stormBusiness.accepted.requests}`);
    assert.ok(storm.othersDms >= 20, `other businesses got DMs: ${storm.othersDms}`);
    assert.equal(restart.timing.backMs > 0, true);
    assert.ok(restart.verify.accepted >= 100 && restart.verify.lost === 0 && restart.verify.duplicateSends === 0, JSON.stringify(restart.verify));
    assert.ok(peaks.memoryMb.web > 50 && peaks.memoryMb.worker > 50 && peaks.memoryMb.postgres > 50, JSON.stringify(peaks.memoryMb));
    assert.ok(peaks.samples >= 5);
    assert.ok(Object.keys(report.data.background).length > 0, 'the worker ran its own jobs during the load');

    // The same numbers against limits nothing could meet fail, one by one: the tool fails loudly.
    const strict = { ...real, p95Ms: Object.fromEntries(Object.keys(real.p95Ms).map((k) => [k, 0.001])), memoryMb: { web: 1, worker: 1, postgres: 1 } };
    assert.ok(judgeMix({ budgets: strict, byClass: mix.byClass }).filter((c) => c.name.startsWith('p95')).every((c) => !c.ok));
    assert.ok(judgeMemory({ budgets: strict, peaks }).every((c) => !c.ok));

    const json = fs.readFileSync(path.join(root, 'test-results', 'load', 'report.json'), 'utf8');
    const md = fs.readFileSync(path.join(root, 'test-results', 'load', 'report.md'), 'utf8');
    assert.match(md, /^# Load test \(short run, not of record\)\n\nResult: \*\*PASS\*\*/);
    for (const text of [json, md, lines.join('\n')]) {
      assert.doesNotMatch(text, /postgres(ql)?:\/\//i, 'no database address');
      assert.doesNotMatch(text, /bearer\s+[A-Za-z0-9._-]{20,}/i, 'no token');
      assert.doesNotMatch(text, /x-hub-signature|sha256=[0-9a-f]{32,}/i, 'no signature');
      assert.doesNotMatch(text, /fan_[0-9]{6}|9000[0-9]{6}/, 'no made-up person either');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the load test refuses to run without the limits it judges against, and refuses a part it does not know', async () => {
  await assert.rejects(run({}), /needs options.budgets/);
  await assert.rejects(run({ budgets: easy, parts: ['everything'], root: os.tmpdir() }), /--part is one of mix, storm, restart/);
  await assert.rejects(run({ budgets: easy, seconds: 2, root: os.tmpdir() }), /--seconds is a whole number from 5 to 540/);
});
