// Run node tests with a hard time limit and a guaranteed process-tree kill.
// Usage: node tools/run-test.mjs [--timeout-min N] [--min-free-gb G] [--max-wait-min M] <test files> [-- extra node --test args]
// Why: `timeout` on Windows ends only the launcher; the worker node process is orphaned and keeps memory.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const argv = process.argv.slice(2);
let timeoutMin = 10, minFreeGb = 2, maxWaitMin = 5;
const files = [], extra = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { extra.push(...argv.slice(i + 1)); break; }
  else if (a === '--timeout-min') timeoutMin = Number(argv[++i]);
  else if (a === '--min-free-gb') minFreeGb = Number(argv[++i]);
  else if (a === '--max-wait-min') maxWaitMin = Number(argv[++i]);
  else files.push(a);
}
if (!files.length || [timeoutMin, minFreeGb, maxWaitMin].some((n) => !Number.isFinite(n))) {
  console.error('usage: node tools/run-test.mjs [--timeout-min N] [--min-free-gb G] [--max-wait-min M] <test file(s)> [-- extra node --test args]');
  process.exit(2);
}

const freeGb = () => os.freemem() / 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitStart = Date.now();
while (freeGb() < minFreeGb) {
  const waited = (Date.now() - waitStart) / 1000;
  if (waited >= maxWaitMin * 60) {
    console.error(`[run-test] WARNING: still only ${freeGb().toFixed(2)} GB free after ${maxWaitMin} min wait (wanted ${minFreeGb} GB); starting anyway`);
    break;
  }
  console.error(`[run-test] waiting for free memory: ${freeGb().toFixed(2)} GB free, need ${minFreeGb} GB (waited ${Math.round(waited)}s of ${maxWaitMin * 60}s)`);
  await sleep(5000);
}

const win = process.platform === 'win32';
const child = spawn(process.execPath, ['--import', './tools/net-guard.mjs', '--test', '--test-force-exit', '--test-concurrency=1', ...files, ...extra], {
  stdio: 'inherit',
  detached: !win, // own process group on POSIX
});

let killed = false;
function killTree() {
  if (killed || !child.pid) return;
  killed = true;
  if (win) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[run-test] TIMED OUT after ${timeoutMin} min - killing process tree (pid ${child.pid})`);
  killTree();
}, timeoutMin * 60_000);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { killTree(); process.exit(130); });
}

child.on('error', (e) => { console.error('[run-test] spawn failed:', e.message); clearTimeout(timer); process.exit(1); });
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  killTree(); // clean up any leftover worker
  if (timedOut) process.exit(124);
  process.exit(code ?? (signal ? 1 : 0));
});
