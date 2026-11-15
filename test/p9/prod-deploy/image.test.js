// G-01: the production image. The Dockerfile and .dockerignore are read as text here; building and running the image
// needs Docker, which this machine may not have: those checks run when it does and are otherwise left to the prod
// workflow's image job (reported as skipped, never as passed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dockerIgnored, dockerignorePatterns, filesUnder, hasTool, read } from './support.js';

const dockerfile = read('Dockerfile');
const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)].map((m) => ({ image: m[1], name: m[2] }));
const stageText = (name) => {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}\\s*$`, 'm'));
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /m);
  return next === -1 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
};

/** The files a process loads: relative imports followed from the entry points. */
function closure(entries) {
  const seen = new Set();
  const queue = entries.map((e) => path.join(ROOT, e));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      let next = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(next) && fs.statSync(next).isDirectory()) next = path.join(next, 'index.js');
      queue.push(next);
    }
  }
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
}

test('G-01 one Dockerfile, a target for the web server and one for the worker, on a pinned multi-arch base', () => {
  const names = stages.map((s) => s.name);
  for (const target of ['web', 'worker']) assert.ok(names.includes(target), `target ${target}`);
  assert.equal(stages.at(-1).name, 'web', 'the default build (no --target) is the web server, as the QA compose file expects');
  const base = /^ARG NODE_IMAGE=(\S+)$/m.exec(dockerfile)?.[1];
  assert.match(base, /^node:\d+\.\d+\.\d+-[a-z]+-slim$/, 'the base is an exact Node release, not a moving tag');
  assert.ok(stages.filter((s) => !s.image.startsWith('$') && !['base', 'runtime', 'console', 'deps'].includes(s.image)).length === 0, 'every stage starts from the pinned base or another stage');
  assert.match(stageText('worker'), /CMD \["node", "src\/worker\.js"\]/);
  assert.match(stageText('web'), /CMD \["node", "src\/server\.js"\]/);
  const instructions = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(instructions, /--platform=|amd64|x86_64|aarch64|arm64/, 'nothing in the build is tied to one architecture');
  assert.match(dockerfile, /linux\/amd64,linux\/arm64/, 'the multi-arch build command is written down');
});

test('G-01 production dependencies only, a non-root user, a signal-forwarding init and a health check per target', () => {
  const deps = stageText('deps');
  assert.match(deps, /npm ci --omit=dev --workspace @bhava\/console --workspace @bhava\/api-client --include-workspace-root/);
  assert.match(deps, /react-native expo/, 'the install refuses the app packages');
  const runtime = stageText('runtime');
  assert.match(runtime, /COPY --from=deps \/app\/node_modules node_modules/);
  assert.doesNotMatch(runtime, /npm (ci|install)/, 'nothing is installed into the final image by npm');
  assert.match(runtime, /^USER node$/m);
  assert.match(runtime, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
  assert.match(runtime, /tini/);
  assert.match(runtime, /NPM_CONFIG_CACHE=\/tmp\/\.npm/, 'npm writes only to /tmp, the one writable folder');
  assert.match(runtime, /test ! -e tools\/sim\/index\.mjs/, 'the build fails if a simulator reached the image');
  assert.match(stageText('web'), /HEALTHCHECK[\s\S]*PORT\|\|3000\)\+'\/healthz'/);
  assert.match(stageText('worker'), /HEALTHCHECK[\s\S]*WORKER_HEALTH_PORT\|\|3001\)\+'\/healthz'/);
  // Whatever runs as root (apt) happens before USER, and nothing after it switches back.
  const afterUser = dockerfile.slice(dockerfile.indexOf('USER node'));
  assert.doesNotMatch(afterUser, /^USER (?!node)/m);
  assert.doesNotMatch(afterUser, /^RUN /m, 'no RUN step after the switch to the non-root user changes the image');
});

test('G-01 the build context: everything the server, the worker and the scripts load is in it, and no app, test or simulator', () => {
  const patterns = dockerignorePatterns();
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js') && f !== 'showcase.js').map((f) => `scripts/${f}`);
  const needed = closure(['src/server.js', 'src/worker.js', ...scripts]);
  assert.ok(needed.length > 100);
  assert.deepEqual(needed.filter((f) => dockerIgnored(patterns, f)), [], 'a file the image runs is left out of the build context');
  for (const rel of ['src/db/migrations/001_init.sql', 'public/store.css', 'seed/mehtamart.json', 'package.json', 'package-lock.json', 'tools/sim/guard.mjs', 'tools/drill/compare.mjs', 'deploy/golive/attestations.json']) {
    assert.equal(dockerIgnored(patterns, rel), false, rel);
  }
  const simulators = filesUnder('tools/sim').filter((f) => f !== 'tools/sim/guard.mjs');
  assert.ok(simulators.length > 10);
  assert.deepEqual(simulators.filter((f) => !dockerIgnored(patterns, f)), [], 'no simulator reaches the image');
  for (const rel of ['apps/shopper/package.json', 'packages', 'test/helpers.js', 'e2e', 'docs', '.env', 'console/.env', 'deploy/bhava/compose.yaml', 'tools/load', 'tools/build-brand/fixtures', 'scripts/showcase.js', '.git/HEAD', 'node_modules/pg/package.json']) {
    assert.equal(dockerIgnored(patterns, rel), true, rel);
  }
});

test('G-01 the image builds and runs as a non-root user on a read-only file system (needs Docker)', { timeout: 590_000 }, (t) => {
  if (!hasTool('docker', ['info'])) return t.skip('Docker is not available here: the prod workflow\'s image job builds both architectures and runs this');
  for (const target of ['worker', 'web']) {
    const tag = `bhava-p9-test:${target}`;
    const built = spawnSync('docker', ['build', '--target', target, '-t', tag, '.'], { cwd: ROOT, stdio: 'ignore', timeout: 540_000 });
    assert.equal(built.status, 0, `docker build --target ${target}`);
    const id = spawnSync('docker', ['run', '--rm', tag, 'id', '-u'], { encoding: 'utf8' });
    assert.notEqual(id.stdout.trim(), '0');
    for (const entry of ['src/server.js', 'src/worker.js']) {
      const r = spawnSync('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', tag, 'node', '--check', entry]);
      assert.equal(r.status, 0, `${target}: node --check ${entry} on a read-only root`);
    }
    const sim = spawnSync('docker', ['run', '--rm', tag, 'test', '-e', 'tools/sim/index.mjs']);
    assert.notEqual(sim.status, 0, 'no simulator in the image');
  }
});
