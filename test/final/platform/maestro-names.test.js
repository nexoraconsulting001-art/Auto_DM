// D-10 (Maestro artifacts): Maestro names each command file after its flow ("commands-(<flow name>).json"), and the
// workflows upload those folders as artifacts. GitHub refuses an artifact path holding " : < > | * ? or a line break, so
// a flow's name may hold none of them; a requirement's id still starts the name ("P-27 - ...").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FORBIDDEN = /[":<>|*?\r\n]/;

function flows(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return flows(full);
    return /\.ya?ml$/.test(entry.name) ? [full] : [];
  });
}

/** The `name:` of a flow's header (the part above `---`), unquoted. */
function nameOf(file) {
  const header = fs.readFileSync(file, 'utf8').split(/^---\s*$/m)[0];
  const raw = /^name:\s*(.+)$/m.exec(header)?.[1]?.trim();
  if (!raw) return null;
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.startsWith('"') ? JSON.parse(raw) : raw;
}

test('D-10: no Maestro flow name holds a character GitHub refuses in an artifact path', () => {
  const all = ['owner', 'shopper'].flatMap((app) => flows(path.join(ROOT, 'apps', app, '.maestro')));
  const named = all.map((file) => ({ file: path.relative(ROOT, file).split(path.sep).join('/'), name: nameOf(file) })).filter((f) => f.name);
  assert.ok(named.length > 20, 'the flows are found');
  assert.deepEqual(named.filter((f) => ARTIFACT_FORBIDDEN.test(f.name)).map((f) => `${f.file}: ${f.name}`), []);
  for (const f of named) if (/^[A-Z]{1,3}-\d+/.test(f.name)) assert.match(f.name, /^[A-Z]{1,3}-\d+ - \S/, `${f.file}: a requirement's id starts the name`);
});
