// Every Phase 1 scenario in the requirement list has at least one test named for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p1.json'), 'utf8'));

function allSpecSource() {
  const roots = [here, path.join(repoRoot, 'e2e/p1/spec-p1')];
  return roots.flatMap((root) => (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((f) => /\.(test|spec)\.js$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8'))).join('\n');
}

test('every scenario in requirements/p1.json has a test whose name starts with its id', () => {
  const source = allSpecSource();
  const generated = /\$\{id\}:/.test(source) ? [...source.matchAll(/\['((?:C|A|FB)-\d{2})'/g)].map((m) => m[1]) : [];
  const named = new Set([...source.matchAll(/test\(\s*[`'"]((?:C|A|FB)-\d{2}):/g)].map((m) => m[1]).concat(generated));
  const missing = requirements.map((r) => r.id).filter((id) => !named.has(id));
  assert.deepEqual(missing, []);
});

test('no scenario id is named that is not in the list', () => {
  const known = new Set(requirements.map((r) => r.id));
  const named = [...allSpecSource().matchAll(/test\(\s*[`'"]((?:C|A|FB)-\d{2}):/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named.filter((id) => !known.has(id)))], []);
});
