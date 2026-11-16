// D-10 (brand APKs): everything a buyer sees is the seller's brand (P-01, P-31). The shopper app's bundle is every module
// reachable from its entry, its own files and the shared packages it imports, so no runtime string in those may carry the
// platform name: not a storage key, not an error message. Import specifiers (@bhava/...) are module names the bundler
// drops, and comments are stripped. The CI scan of the built APK (apps/shopper/.maestro/support/scan-binary.mjs) found
// 'bhava.cache' (app-core cache.js) and a storage error message (app-core storage.js) in assets/index.android.bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TERM = ['bha', 'va'].join('');
const SCOPE = `@${TERM}/`;

/** Comments out, keeping line numbers. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
}

function resolveFile(base) {
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** A shared package's module, through its package.json exports (as the bundler resolves it). */
function resolveShared(spec) {
  const [, name, sub = ''] = /^@[^/]+\/([^/]+)(?:\/(.+))?$/.exec(spec);
  const dir = path.join(ROOT, 'packages', name);
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  const { exports = {}, main = 'index.js' } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const target = typeof exports === 'string' ? exports : exports[sub ? `./${sub}` : '.'] ?? (sub ? null : main);
  return target ? resolveFile(path.join(dir, target)) : null;
}

/** Every file of ours the shopper bundle holds, from its entry. */
function bundled() {
  const seen = new Set();
  const queue = [resolveFile(path.join(ROOT, 'apps/shopper/index.js'))];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file) || !/\.(js|jsx|json)$/.test(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g)) {
      const spec = m[2];
      if (spec.startsWith('.')) queue.push(resolveFile(path.resolve(path.dirname(file), spec)));
      else if (spec.startsWith(SCOPE)) queue.push(resolveShared(spec));
    }
  }
  return [...seen];
}

test('D-10: no runtime string the shopper app bundles (its own or a shared package\'s) names the platform', () => {
  const files = bundled();
  assert.ok(files.some((f) => f.includes(`${path.sep}packages${path.sep}app-core${path.sep}`)), 'the walk reaches the shared packages');
  assert.ok(files.length > 30, 'the walk follows the app');
  const hits = [];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8')).replace(/(['"])@[a-z]+\/[^'"]*\1/g, '""');
    text.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(TERM)) hits.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'the platform name in a string the buyer-facing bundle carries');
});
