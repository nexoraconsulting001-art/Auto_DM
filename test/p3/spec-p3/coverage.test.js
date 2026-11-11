// Every Phase 3 scenario in the requirement list has at least one test named for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p3.json'), 'utf8'));

function allSpecSource() {
  const roots = [here, path.join(repoRoot, 'e2e/p3/spec-p3')];
  return roots.flatMap((root) => (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((f) => /\.(test|spec)\.js$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8'))).join('\n');
}

const named = () => [...allSpecSource().matchAll(/test\(\s*[`'"]((?:K|F)-\d{2,3}):/g)].map((m) => m[1]);

test('every scenario in requirements/p3.json has a test whose name starts with its id', () => {
  const have = new Set(named());
  assert.deepEqual(requirements.map((r) => r.id).filter((id) => !have.has(id)), []);
});

test('no scenario id is named that is not in the list', () => {
  const known = new Set(requirements.map((r) => r.id));
  assert.deepEqual([...new Set(named().filter((id) => !known.has(id)))], []);
});
