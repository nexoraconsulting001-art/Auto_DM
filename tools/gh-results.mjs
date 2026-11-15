/**
 * `node tools/gh-results.mjs [sha] [--out file] [--max-minutes N] [--interval-s N] [--repo owner/name]`
 *
 * Waits until every GitHub Actions run for one commit (default HEAD) has finished, then writes a Markdown report
 * (default C:/bhava/tmp/ci-<sha7>.md): each job's name, conclusion and duration; the tests each job counted; and for a
 * failed job its failing tests with a short excerpt of the error, read from the job's log. It also writes the
 * per-file times the node:test shards printed (tools/ci-timing.mjs) beside the report, as <report>-timings.json, so
 * tools/ci-timings.json can be refreshed from a real run.
 *
 * Sign-in: the token comes from Git Credential Manager at run time (`git credential fill` for github.com). It stays in
 * memory and is sent only in the Authorization header to api.github.com; a log download's redirect is followed
 * without it. With no token the public API is used, which cannot read job logs: the report says so.
 *
 * Exit 0 all runs passed, 1 something failed, 2 still running (or never started) when time ran out.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const PASSED = new Set(['success', 'skipped', 'neutral']);

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const positional = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));

const repo = option('repo', 'nexoraconsulting001-art/Auto_DM');
const maxMinutes = Number(option('max-minutes', 180));
const intervalMs = Number(option('interval-s', 60)) * 1000;
const sha = execFileSync('git', ['rev-parse', positional[0] ?? 'HEAD'], { encoding: 'utf8' }).trim();
const out = path.resolve(option('out', `C:/bhava/tmp/ci-${sha.slice(0, 7)}.md`));

/** The account named in the origin remote's URL (https://user@github.com/...), so GCM can pick its saved sign-in. */
function originUser() {
  try {
    const url = new URL(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
    return url.hostname === 'github.com' && url.username ? decodeURIComponent(url.username) : null;
  } catch {
    return null;
  }
}

/** The saved github.com sign-in, or null. Never printed and never written anywhere. */
function readToken() {
  // With several saved accounts GCM needs the user name; without one it would ask, which it may not do here.
  const users = [...new Set([option('user', null), originUser(), null])];
  for (const user of users) {
    const res = spawnSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=github.com\n${user ? `username=${user}\n` : ''}\n`,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      timeout: 60_000,
      windowsHide: true,
    });
    const line = res.status === 0 ? String(res.stdout).split(/\r?\n/).find((l) => l.startsWith('password=')) : null;
    if (line && line.length > 'password='.length) return line.slice('password='.length);
  }
  return null;
}

const token = readToken();
const headers = (withToken = true) => ({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'ci-results',
  ...(withToken && token ? { authorization: `Bearer ${token}` } : {}),
});

async function get(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${pathname.split('?')[0]}`);
  return res.json();
}

async function getAll(pathname, key) {
  const rows = [];
  for (let page = 1; page < 20; page++) {
    const body = await get(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    rows.push(...(body[key] ?? []));
    if ((body[key] ?? []).length < 100) break;
  }
  return rows;
}

/** A job's log as text, or null. The redirect goes to a signed storage URL, fetched without the token. */
async function jobLog(id) {
  if (!token) return null;
  const first = await fetch(`${API}/repos/${repo}/actions/jobs/${id}/logs`, { headers: headers(), redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (!location) return null;
    res = await fetch(location, { headers: { 'user-agent': 'ci-results' }, signal: AbortSignal.timeout(120_000) });
  }
  if (!res.ok) return null;
  return (await res.text()).split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')).join('\n');
}

async function annotations(job) {
  const id = String(job.check_run_url ?? '').split('/').pop() || job.id;
  try {
    return await get(`/repos/${repo}/check-runs/${id}/annotations?per_page=50`);
  } catch {
    return [];
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const clip = (s, n = 300) => {
  const t = String(s).replace(ANSI, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a job's log says: node:test counts, jest and Playwright counts, failing tests, per-file times. */
function readLog(text) {
  const lines = text.replace(ANSI, '').split('\n');
  const counts = {};
  const failures = [];
  const timings = {};
  const shardFiles = [];
  // node:test spec reporter summary lines: "ℹ tests 120", "ℹ pass 118" ... (one block per node --test run)
  for (const line of lines) {
    const m = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line.trim());
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + Number(m[2]);
    const t = /^ci-timing (\d+) (\S+)$/.exec(line.trim());
    if (t) timings[t[2]] = Number(t[1]);
    const s = /^ci-shard: (\w+) shard (\d+)\/(\d+): (\d+) files?/.exec(line.trim());
    if (s) shardFiles.push({ suite: s[1], files: Number(s[4]) });
    // jest: "Tests:       2 failed, 310 passed, 312 total"
    const j = /^Tests:\s+(.*\d+ total)/.exec(line.trim());
    if (j) for (const part of j[1].split(',')) {
      const [, num, kind] = /(\d+) (\w+)/.exec(part.trim()) ?? [];
      if (num) counts[`jest ${kind}`] = (counts[`jest ${kind}`] ?? 0) + Number(num);
    }
    // Playwright list reporter: "  12 passed (3.4m)", "  2 failed"
    const p = /^\s*(\d+) (passed|failed|flaky|skipped|did not run)( \(.*\))?$/.exec(line);
    if (p) counts[`e2e ${p[2]}`] = (counts[`e2e ${p[2]}`] ?? 0) + Number(p[1]);
  }
  // node:test: the "✖ failing tests:" section, blocks of "test at file:line:col", "✖ name (ms)", error lines.
  const start = lines.findIndex((l) => /✖ failing tests:/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const at = /^\s*test at (\S+)/.exec(lines[i]);
      if (!at) continue;
      const name = /^\s*✖ (.*?)(?: \([\d.]+m?s\))?$/.exec(lines[i + 1] ?? '')?.[1] ?? '(unnamed)';
      const error = [];
      for (let k = i + 2; k < lines.length && error.length < 4 && !/^\s*test at /.test(lines[k]); k++) if (lines[k].trim()) error.push(lines[k].trim());
      failures.push({ file: at[1].replace(/:\d+:\d+$/, ''), name, error: clip(error.join(' ')) });
    }
  }
  // jest: "● Suite › test" headings, each followed by its error.
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*● (.+)$/.exec(lines[i]);
    if (!m || /^Console\b/.test(m[1])) continue;
    const error = [];
    for (let k = i + 1; k < lines.length && error.length < 3 && !/^\s*● /.test(lines[k]); k++) if (lines[k].trim()) error.push(lines[k].trim());
    failures.push({ file: '', name: m[1].trim(), error: clip(error.join(' ')) });
  }
  for (const line of lines) {
    const f = /^\s*FAIL (\S+\.test\.jsx?)/.exec(line);
    if (f) failures.push({ file: f[1], name: '(jest file failed)', error: '' });
  }
  // Playwright: the numbered failure headings "  1) [phone] › e2e/p0/x.spec.js:12:3 › title".
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s+\d+\) \[[^\]]+\] › (\S+?):\d+:\d+ › (.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const error = [];
    for (let k = i + 1; k < lines.length && error.length < 3 && !/^\s+\d+\) \[/.test(lines[k]); k++) if (lines[k].trim() && !/^─+$/.test(lines[k].trim())) error.push(lines[k].trim());
    failures.push({ file: m[1], name: m[2], error: clip(error.join(' ')) });
  }
  // The lines before each step error, for a job that failed outside a test (setup, a check, a timeout).
  const errors = [];
  for (let i = 0; i < lines.length && errors.length < 3; i++) {
    if (!lines[i].includes('##[error]')) continue;
    const before = [];
    for (let k = i - 1; k >= 0 && before.length < 12 && !lines[k].startsWith('##[group]'); k--) if (lines[k].trim() && !lines[k].startsWith('##[endgroup]')) before.unshift(lines[k].slice(0, 240));
    errors.push([...before, lines[i].slice(0, 240)].join('\n'));
  }
  const seen = new Set();
  return { counts, timings, shardFiles, errors, failures: failures.filter((f) => !seen.has(`${f.file}|${f.name}`) && seen.add(`${f.file}|${f.name}`)) };
}

const minutes = (ms) => (ms == null || Number.isNaN(ms) ? '-' : `${(ms / 60000).toFixed(1)} min`);
const span = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
/** "Tests (real Postgres) [3/12]" belongs to "Tests (real Postgres)". */
const groupOf = (name) => name.replace(/\s*\[\d+\/\d+\]\s*$/, '');

async function look() {
  const all = await getAll(`/repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs');
  const newest = new Map();
  for (const run of [...all].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) newest.set(run.workflow_id, run);
  const runs = [...newest.values()];
  for (const run of runs) run.jobs = await getAll(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
  return runs;
}

async function main() {
  const deadline = Date.now() + maxMinutes * 60_000;
  let runs = [];
  for (;;) {
    try {
      runs = await look();
    } catch (err) {
      console.error(`Could not read the runs yet: ${err.message}`);
    }
    const running = !runs.length || runs.some((r) => r.status !== 'completed' || r.jobs.some((j) => j.status !== 'completed'));
    const done = runs.reduce((n, r) => n + r.jobs.filter((j) => j.status === 'completed').length, 0);
    const total = runs.reduce((n, r) => n + r.jobs.length, 0);
    console.log(`${new Date().toISOString()} ${runs.length} run(s), ${done}/${total} job(s) finished`);
    if (!running || Date.now() + intervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const stillRunning = !runs.length || runs.some((r) => r.status !== 'completed');

  const md = [`# CI results for ${sha.slice(0, 7)}`, '', `Commit ${sha} in ${repo}. Written ${new Date().toISOString()}.`, ''];
  if (!token) md.push('**No GitHub sign-in was found, so the public API was used: job logs (failing test names, test counts) could not be read.**', '');
  if (stillRunning) md.push(`**Gave up after ${maxMinutes} minutes: some runs had not finished.**`, '');
  const allTimings = {};
  const groups = new Map();
  for (const run of runs) {
    const started = run.run_started_at ?? run.created_at;
    const ended = run.jobs.map((j) => j.completed_at).filter(Boolean).sort().at(-1);
    md.push(`## ${run.name}: ${run.conclusion ?? run.status}`, '', `${run.html_url}  `, `Wall clock ${minutes(span(started, ended))} (run start to last job end).`, '');
    md.push('| Job | Conclusion | Duration | Tests |', '|---|---|---|---|');
    const details = [];
    for (const job of run.jobs) {
      const log = job.status === 'completed' ? await jobLog(job.id).catch(() => null) : null;
      const info = log ? readLog(log) : { counts: {}, timings: {}, shardFiles: [], errors: [], failures: [] };
      Object.assign(allTimings, ...Object.entries(info.timings).map(([f, ms]) => ({ [f]: Math.max(ms, allTimings[f] ?? 0) })));
      const duration = span(job.started_at, job.completed_at);
      const c = info.counts;
      const tests = [
        c.tests != null ? `node ${c.tests} (pass ${c.pass ?? 0}, fail ${c.fail ?? 0}, cancelled ${c.cancelled ?? 0}, skipped ${(c.skipped ?? 0) + (c.todo ?? 0)})` : '',
        c['jest total'] != null ? `jest ${c['jest total']} (fail ${c['jest failed'] ?? 0})` : '',
        Object.keys(c).some((k) => k.startsWith('e2e ')) ? `e2e pass ${c['e2e passed'] ?? 0}, fail ${c['e2e failed'] ?? 0}, flaky ${c['e2e flaky'] ?? 0}, skipped ${c['e2e skipped'] ?? 0}, not run ${c['e2e did not run'] ?? 0}` : '',
      ].filter(Boolean).join('; ');
      md.push(`| ${job.name} | ${job.conclusion ?? job.status} | ${minutes(duration)} | ${tests || '-'} |`);
      const group = groups.get(groupOf(job.name)) ?? { jobs: 0, failed: 0, longest: 0, longestName: '', tests: 0, pass: 0, fail: 0, files: 0, e2e: 0, jest: 0 };
      group.jobs++;
      if (job.status === 'completed' && !PASSED.has(job.conclusion)) group.failed++;
      if ((duration ?? 0) > group.longest) Object.assign(group, { longest: duration, longestName: job.name });
      group.tests += c.tests ?? 0;
      group.pass += c.pass ?? 0;
      group.fail += c.fail ?? 0;
      group.e2e += (c['e2e passed'] ?? 0) + (c['e2e failed'] ?? 0) + (c['e2e flaky'] ?? 0) + (c['e2e skipped'] ?? 0) + (c['e2e did not run'] ?? 0);
      group.jest += c['jest total'] ?? 0;
      group.files += info.shardFiles.reduce((n, s) => n + s.files, 0);
      groups.set(groupOf(job.name), group);
      if (job.status === 'completed' && !PASSED.has(job.conclusion)) {
        const notes = (await annotations(job)).filter((a) => a.annotation_level === 'failure' && !info.failures.length);
        details.push(`### ${job.name}: ${job.conclusion}`, '', job.html_url, '');
        const steps = (job.steps ?? []).filter((st) => st.conclusion === 'failure' || st.conclusion === 'cancelled').map((st) => `${st.name} (${st.conclusion})`);
        if (steps.length) details.push(`Failed step: ${steps.join(', ')}`, '');
        for (const f of info.failures) details.push(`- ${f.file ? `\`${f.file}\` ` : ''}${f.name}${f.error ? `: ${f.error}` : ''}`);
        for (const a of notes) details.push(`- ${a.path && a.path !== '.github' ? `\`${a.path}\` ` : ''}${a.title ? `${a.title}: ` : ''}${clip(a.message)}`);
        if (!info.failures.length && info.errors.length) details.push('', 'Log before the error:', '', '```', ...info.errors.flatMap((e) => [e, '']), '```');
        else if (!info.failures.length && !notes.length) details.push(log ? '- No failing test found in the log; see the job.' : '- The log could not be read.');
        details.push('');
      }
    }
    md.push('', ...details);
  }
  md.push('## Totals by job', '', '| Job | Jobs | Failed jobs | Files | node tests (pass/fail) | e2e tests | jest tests | Longest |', '|---|---|---|---|---|---|---|---|');
  for (const [name, g] of groups) md.push(`| ${name} | ${g.jobs} | ${g.failed} | ${g.files || '-'} | ${g.tests ? `${g.tests} (${g.pass}/${g.fail})` : '-'} | ${g.e2e || '-'} | ${g.jest || '-'} | ${minutes(g.longest)} ${g.longestName !== name ? g.longestName.slice(name.length).trim() : ''} |`);
  md.push('');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${md.join('\n')}\n`);
  if (Object.keys(allTimings).length) fs.writeFileSync(out.replace(/\.md$/, '') + '-timings.json', `${JSON.stringify(Object.fromEntries(Object.entries(allTimings).sort()), null, 1)}\n`);
  console.log(`Wrote ${out}${token ? '' : ' (no sign-in: no logs read)'}`);
  if (stillRunning) return 2;
  return runs.every((r) => PASSED.has(r.conclusion)) ? 0 : 1;
}

process.exitCode = await main();
