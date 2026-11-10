/**
 * Waits for CI on the latest pushed commit of bhava/build, using the public GitHub API without a token.
 * Prints one JSON object: run URL, status, each job's conclusion, and the annotations of failed jobs.
 * Exit 0 all passed, 1 something failed, 2 still running (or no answer) when time ran out.
 *
 * Options: --once (one look, no waiting), --interval-ms, --max-ms, --api URL.
 * The unauthenticated limit is 60 requests an hour; a default wait uses about 16.
 */
const REPO = 'nexoraconsulting001-art/Auto_DM';
const BRANCH = 'bhava/build';
const PASSED = new Set(['success', 'skipped', 'neutral']);

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const api = option('api', 'https://api.github.com').replace(/\/+$/, '');
const once = process.argv.includes('--once');
const intervalMs = Number(option('interval-ms', 90_000));
const maxMs = once ? 0 : Number(option('max-ms', 9 * 60_000));

class RateLimited extends Error {}
class NotFound extends Error {}

async function get(pathname) {
  const res = await fetch(`${api}${pathname}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ci-wait' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new NotFound(`${pathname} not found`);
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) throw new RateLimited('GitHub API rate limit reached');
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${pathname}`);
  return res.json();
}

const latestSha = async () => (await get(`/repos/${REPO}/branches/${encodeURIComponent(BRANCH)}`)).commit.sha;

/** The newest run of each workflow for this commit, with its jobs. */
async function look(sha) {
  const { workflow_runs: all = [] } = await get(`/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=30`);
  const newest = new Map();
  for (const run of [...all].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) newest.set(run.workflow_id, run);
  const runs = [...newest.values()];
  const jobs = [];
  for (const run of runs) {
    const page = await get(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`);
    jobs.push(...(page.jobs ?? []).map((job) => ({ runId: run.id, ...job })));
  }
  return { runs, jobs };
}

const hasFailed = (job) => job.status === 'completed' && !PASSED.has(job.conclusion);

async function annotationsFor(job) {
  const id = String(job.check_run_url ?? '').split('/').pop() || job.id;
  try {
    const rows = await get(`/repos/${REPO}/check-runs/${id}/annotations?per_page=50`);
    return rows.map((a) => ({ file: a.path, line: a.start_line, level: a.annotation_level, title: a.title, message: a.message }));
  } catch (err) {
    return [{ level: 'unavailable', message: err.message }];
  }
}

async function main() {
  const report = { repo: REPO, branch: BRANCH, sha: null, runUrl: null, status: 'unknown', conclusion: null, jobs: [] };
  const finish = (code) => {
    console.log(JSON.stringify({ ...report, exitCode: code }, null, 2));
    process.exit(code);
  };

  const deadline = Date.now() + maxMs;
  const timeUp = () => Date.now() >= deadline;
  for (;;) {
    try {
      report.sha ??= await latestSha();
      const { runs, jobs } = await look(report.sha);
      delete report.lastError;
      if (!runs.length) {
        report.status = 'no-run-yet';
      } else {
        const running = runs.some((run) => run.status !== 'completed') || jobs.some((job) => job.status !== 'completed') || jobs.length === 0;
        report.runUrl = runs.at(-1).html_url;
        report.status = running ? 'in_progress' : 'completed';
        report.conclusion = running ? null : runs.every((run) => PASSED.has(run.conclusion)) ? 'success' : 'failure';
        report.jobs = jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion, url: job.html_url }));
        if (!running || timeUp()) {
          const failed = jobs.filter(hasFailed);
          for (const job of failed) report.jobs.find((j) => j.name === job.name).annotations = await annotationsFor(job);
          if (failed.length || (!running && report.conclusion !== 'success')) finish(1);
          finish(running ? 2 : 0);
        }
      }
    } catch (err) {
      report.lastError = err.message;
      if (err instanceof RateLimited || (err instanceof NotFound && !report.sha)) {
        report.status = err instanceof RateLimited ? 'rate-limited' : 'no-such-branch';
        finish(2);
      }
    }
    if (timeUp()) finish(2);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
  }
}

await main();
