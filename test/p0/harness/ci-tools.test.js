import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import ciAnnotate, { annotation } from '../../../tools/ci-annotate.mjs';
import { repoRoot } from '../../../tools/gate-lib.mjs';

const collect = async (generator) => {
  const out = [];
  for await (const line of generator) out.push(line);
  return out;
};
const failed = (name, extra = {}) => ({ type: 'test:fail', data: { name, file: path.join(process.cwd(), 'test', 'a.test.js'), line: 7, details: { error: { message: 'boom' } }, ...extra } });

test('an annotation carries the file, line, test name and message, safely escaped', () => {
  const line = annotation({ file: path.join(process.cwd(), 'test', 'x, y.test.js'), line: 12, name: 'adds: 1, 2', message: '100% wrong\nsecond line' });
  assert.equal(line, '::error file=test/x%2C y.test.js,line=12,title=adds%3A 1%2C 2::100%25 wrong%0Asecond line\n');
});

test('only the first failures are annotated, and real failures rather than their parents', async () => {
  const events = async function* () {
    yield { type: 'test:pass', data: { name: 'fine' } };
    yield failed('parent', { details: { error: { failureType: 'subtestsFailed', message: 'x' } } });
    for (let i = 0; i < 13; i++) yield failed(`t${i}`);
  };
  const lines = await collect(ciAnnotate(events()));
  assert.equal(lines.length, 11);
  assert.ok(lines.slice(0, 10).every((l, i) => l.startsWith('::error file=test/a.test.js,line=7,title=t') && l.includes(`t${i}::boom`)));
  assert.match(lines[10], /3 more failing test/);
});

test('a file that crashes on import shows what it printed to stderr', async () => {
  const events = async function* () {
    yield { type: 'test:stderr', data: { file: 'test/b.test.js', message: 'node:internal/modules/esm/resolve:275\n' } };
    yield { type: 'test:stderr', data: { file: 'test/b.test.js', message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\n" } };
    yield failed('test/b.test.js', { file: path.join(process.cwd(), 'test', 'b.test.js'), details: { error: { message: 'test failed' } } });
  };
  const [line] = await collect(ciAnnotate(events()));
  assert.match(line, /::Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module 'x'/);
});

/** A local stand-in for the GitHub API. `state` says what the runs look like. */
async function fakeGitHub(state) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (body, status = 200, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (state.rateLimited) return send({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' });
    if (req.url.includes('/branches/')) return state.noBranch ? send({}, 404) : send({ commit: { sha: 'abc123' } });
    if (req.url.includes('/actions/runs?')) {
      const runs = state.runs;
      state.afterRuns?.();
      return send({ workflow_runs: runs });
    }
    if (req.url.includes('/jobs')) return send({ jobs: state.jobs });
    if (req.url.includes('/annotations')) return send([{ path: 'test/a.test.js', start_line: 3, annotation_level: 'failure', title: 'adds', message: 'expected 2' }]);
    return send({}, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function ciWait(api, extra = ['--once']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/ci-wait.mjs', '--api', api, ...extra], { cwd: repoRoot });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.once('close', (code) => resolve({ code, report: JSON.parse(out) }));
  });
}

const run = (status, conclusion = null) => ({ id: 9, workflow_id: 1, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.test/run/9', status, conclusion });
const job = (name, status, conclusion = null, id = 55) => ({ id, name, status, conclusion, html_url: `https://github.test/job/${name}`, check_run_url: `https://api.test/check-runs/${id}` });

test('ci-wait exits 0 when every job passed', async () => {
  const api = await fakeGitHub({ runs: [run('completed', 'success')], jobs: [job('Tests', 'completed', 'success'), job('Docker', 'completed', 'skipped')] });
  try {
    const { code, report } = await ciWait(api.url);
    assert.equal(code, 0);
    assert.equal(report.runUrl, 'https://github.test/run/9');
    assert.equal(report.sha, 'abc123');
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.jobs.map((j) => j.conclusion), ['success', 'skipped']);
    assert.ok(api.seen.some((u) => u.includes('/branches/bhava%2Fbuild')));
    assert.ok(!api.seen.some((u) => u.includes('/annotations')), 'passing jobs need no annotations');
  } finally {
    api.close();
  }
});

test('ci-wait exits 1 with the annotations of failed jobs', async () => {
  const api = await fakeGitHub({ runs: [run('completed', 'failure')], jobs: [job('Tests', 'completed', 'success', 54), job('Postgres', 'completed', 'failure', 55)] });
  try {
    const { code, report } = await ciWait(api.url);
    assert.equal(code, 1);
    assert.equal(report.conclusion, 'failure');
    assert.equal(report.jobs[0].annotations, undefined);
    assert.deepEqual(report.jobs[1].annotations, [{ file: 'test/a.test.js', line: 3, level: 'failure', title: 'adds', message: 'expected 2' }]);
    assert.ok(api.seen.some((u) => u.includes('/check-runs/55/annotations')));
  } finally {
    api.close();
  }
});

test('ci-wait exits 2 while a run is going or has not appeared, and 1 once a job has already failed', async () => {
  const running = await fakeGitHub({ runs: [run('in_progress')], jobs: [job('Tests', 'in_progress')] });
  const none = await fakeGitHub({ runs: [], jobs: [] });
  const partly = await fakeGitHub({ runs: [run('in_progress')], jobs: [job('Tests', 'completed', 'failure'), job('Docker', 'in_progress')] });
  try {
    const first = await ciWait(running.url);
    assert.equal(first.code, 2);
    assert.equal(first.report.status, 'in_progress');
    const second = await ciWait(none.url);
    assert.equal(second.code, 2);
    assert.equal(second.report.status, 'no-run-yet');
    assert.equal((await ciWait(partly.url)).code, 1);
  } finally {
    running.close();
    none.close();
    partly.close();
  }
});

test('ci-wait polls until the run finishes', async () => {
  const state = {
    runs: [run('in_progress')],
    jobs: [job('Tests', 'in_progress')],
    afterRuns: () => Object.assign(state, { runs: [run('completed', 'success')], jobs: [job('Tests', 'completed', 'success')] }),
  };
  const api = await fakeGitHub(state);
  try {
    const { code } = await ciWait(api.url, ['--interval-ms', '50', '--max-ms', '20000']);
    assert.equal(code, 0);
    assert.equal(api.seen.filter((u) => u.includes('/actions/runs?')).length, 2);
  } finally {
    api.close();
  }
});

test('ci-wait reports a rate limit or missing branch instead of hanging', async () => {
  const limited = await fakeGitHub({ rateLimited: true });
  const missing = await fakeGitHub({ noBranch: true });
  try {
    const a = await ciWait(limited.url, ['--interval-ms', '50', '--max-ms', '20000']);
    assert.deepEqual([a.code, a.report.status], [2, 'rate-limited']);
    const b = await ciWait(missing.url, ['--interval-ms', '50', '--max-ms', '20000']);
    assert.deepEqual([b.code, b.report.status], [2, 'no-such-branch']);
  } finally {
    limited.close();
    missing.close();
  }
});
