/**
 * The test ledger (tools/gate-ledger.json). Each checkpoint locks a phase's test files and counts, after
 * which the gate fails if any of them changes or the counts fall.
 *
 *   npm run ledger -- lock N [--reason "why a locked file had to change"]   needs a passing `npm run gate -- N`
 *   npm run ledger -- status
 *
 * Commit tools/gate-ledger.json after locking.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findHome, hashFile, LEDGER_PATH, lockPhase, parsePhase, readJson, readLedger, repoRoot } from './gate-lib.mjs';

function usage(message) {
  console.error(`${message}\nUsage: npm run ledger -- lock N [--reason "..."]  |  npm run ledger -- status`);
  process.exit(2);
}

function lock(args) {
  const reasonAt = args.indexOf('--reason');
  if (reasonAt >= 0 && !args[reasonAt + 1]) usage('--reason needs a value');
  const n = parsePhase(args[0]);
  const summary = readJson(path.join(findHome(), 'logs', `gate-p${n}.json`));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const next = lockPhase({ root: repoRoot, ledger: readLedger(), n, summary, commit, reason: reasonAt >= 0 ? args[reasonAt + 1] : '' });
  fs.writeFileSync(path.join(repoRoot, LEDGER_PATH), `${JSON.stringify(next, null, 2)}\n`);
  const entry = next.phases[n];
  console.log(JSON.stringify({ phase: n, locked: true, files: Object.keys(entry.files).length, counts: entry.counts, commit }));
}

function status() {
  const { phases } = readLedger();
  const report = Object.entries(phases).map(([phase, entry]) => ({
    phase: Number(phase),
    lockedAt: entry.lockedAt,
    counts: entry.counts,
    files: Object.keys(entry.files).length,
    changed: Object.entries(entry.files).filter(([f, h]) => !fs.existsSync(path.join(repoRoot, f)) || hashFile(path.join(repoRoot, f)) !== h).map(([f]) => f),
  }));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.some((r) => r.changed.length) ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'lock') lock(rest);
  else if (command === 'status') status();
  else usage(`Unknown command "${command ?? ''}"`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
