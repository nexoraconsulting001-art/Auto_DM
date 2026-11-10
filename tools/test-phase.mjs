/**
 * `npm run test:phase -- N`: only phase N's tests (test/pN/** and test/attack/pN/**), on the in-memory
 * database. The quick check while building; `npm run gate -- N` is the real one.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeTestGlobs, parsePhase, repoRoot } from './gate-lib.mjs';

let n;
try {
  n = parsePhase(process.argv[2]);
} catch (err) {
  console.error(`${err.message}\nUsage: npm run test:phase -- N`);
  process.exit(2);
}

const globs = nodeTestGlobs(repoRoot, [n], { baseline: false });
if (!globs.length) {
  console.log(`Phase ${n} has no tests yet.`);
  process.exit(0);
}

const env = { ...process.env };
delete env.TEST_DATABASE_URL;
const guard = pathToFileURL(path.join(repoRoot, 'tools', 'net-guard.mjs')).href;
const run = spawnSync(process.execPath, ['--import', guard, '--test', '--test-concurrency=4', '--test-force-exit', ...globs], { cwd: repoRoot, env, stdio: 'inherit' });
process.exit(run.status ?? 1);
