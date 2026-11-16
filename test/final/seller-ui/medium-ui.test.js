// Medium seller-ui findings (final review): notification links, AI replies permissions, the loyalty probe, app/console parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTIFY_EVENTS } from '../../../src/contracts/notifications.js';
import { routes } from '../../../src/contracts/api/index.js';
import { MANAGERS } from '../../../src/contracts/api/access.js';
import { loyaltyFromFeatures } from '../../../console/src/features/loyalty/entitled.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const indexes = (dir, name) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name, name)).filter((f) => fs.existsSync(path.join(root, f)));
const pathsIn = (files) => files.flatMap((f) => [...read(f).matchAll(/path: '([^']*)'/g)].map((m) => m[1]));

const matches = (pattern, link) => {
  const a = pattern.split('/').filter(Boolean);
  const b = link.split('/').filter(Boolean);
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
};

test('seller-ui-7: every notification link opens a screen in the console and in the owner app', () => {
  const consolePages = pathsIn(indexes('console/src/features', 'index.jsx'));
  const appScreens = pathsIn(indexes('apps/owner/src/features', 'index.js'));
  for (const [kind, spec] of Object.entries(NOTIFY_EVENTS)) {
    const link = spec.link.replace(/\{[A-Za-z]+\}/g, 'x');
    assert.ok(consolePages.some((p) => matches(p, link)), `${kind}: console has no page for ${spec.link}`);
    assert.ok(appScreens.some((p) => matches(p, link)), `${kind}: the owner app has no screen for ${spec.link}`);
  }
});

test('seller-ui-3: the AI replies toggle and confidence are offered only to those the server lets save them', () => {
  assert.equal(routes['aiReplies.save'].access, MANAGERS);
  const page = read('console/src/features/ai-replies/AiRepliesPage.jsx');
  const settings = page.slice(page.indexOf('function Settings('), page.indexOf('function TestQuestion('));
  assert.match(settings, /useAllowed\(\)\(MANAGERS\)/);
  const gated = settings.match(/!canChange/g) ?? [];
  assert.ok(gated.length >= 3, 'the toggle, the number field and the save button are each disabled for staff');
});

test('seller-ui-5: loyalty on tier 3 is read from billing.features, never probed with a plan-gated route', () => {
  assert.ok(routes['loyalty.members'].feature, 'loyalty.members is plan gated, so calling it on tier 3 raises the plan refusal');
  const hook = read('console/src/features/loyalty/useLoyalty.js');
  assert.doesNotMatch(hook, /api\.loyalty\./);
  assert.match(hook, /api\.billing\.features\(\)/);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: { loyalty: { on: true, limit: null } } }), true);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: { loyalty: { on: false, limit: null } } }), false);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: {} }), false);
  assert.equal(loyaltyFromFeatures(undefined), false);
});

test('D-14: every console page has an owner app screen (parity check passes)', () => {
  execFileSync(process.execPath, ['tools/parity-check.mjs'], { cwd: root, stdio: 'pipe' });
});
