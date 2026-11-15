// A tiny suite for trying R-05 itself. It is not named *.test.js, so the real suite never runs it. READINESS_PASS_MODE says how it behaves:
//   ok      every test passes
//   driver  one test fails when the storage driver is object storage (it passes on the simple drivers)
//   broken  one test fails on every driver
//   touch   one test leaves a new file under src/ behind
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const mode = process.env.READINESS_PASS_MODE || 'ok';

test('passes on every driver', () => {
  assert.ok(true);
});

test('behaves the same on object storage', () => {
  if (mode === 'driver') assert.notEqual(process.env.STORAGE_DRIVER, 's3', 'an upload could not be read back');
});

test('is correct on every driver', () => {
  if (mode === 'broken') assert.fail('a plain bug');
});

test('leaves the source alone', () => {
  if (mode === 'touch') fs.writeFileSync('src/readiness-fixture-leftover.js', '// left behind by a test\n');
});

test('is skipped', { skip: 'not for this driver' }, () => {});
