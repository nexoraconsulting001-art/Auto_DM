/**
 * Started by tools/gate.mjs. If the gate is killed outright, nothing in it can run its cleanup, so this
 * process stops what the gate started (listed in <scratch>/pids.json) and removes the scratch folder.
 * It exits by itself once the gate has finished normally and removed that folder.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [parent, scratch] = [Number(process.argv[2]), process.argv[3]];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function stop(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

const timer = setInterval(() => {
  if (!fs.existsSync(scratch)) process.exit(0);
  if (alive(parent)) return;
  clearInterval(timer);
  let pids = [];
  try {
    pids = JSON.parse(fs.readFileSync(path.join(scratch, 'pids.json'), 'utf8'));
  } catch {
    // Nothing was started yet.
  }
  pids.forEach(stop);
  setTimeout(() => {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    process.exit(0);
  }, 2000);
}, 2000);
