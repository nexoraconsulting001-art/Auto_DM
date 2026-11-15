// `npm run golive` as a person runs it (G-15, G-16): its arguments, its exit codes, the Markdown report, sign-offs from a
// chosen file, and no secret in anything it prints, with a database address it cannot reach and a provider that hangs.
import '../../../tools/net-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GOLIVE_ITEMS, GoliveStatus } from '../../../src/contracts/golive.js';
import { parseArgs } from '../../../scripts/golive.js';
import { assertNoneOf, runNode } from '../spec-p9/support.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-cli-'));
const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const golive = (args, env = {}) => runNode(['scripts/golive.js', ...args], { env: { ALLOW_PGLITE: '1', ...env }, timeoutMs: 120_000 });

test('G-15: the arguments: --markdown is new, --json with --markdown and anything unknown are refused with exit 2 and no list', async () => {
  assert.deepEqual(parseArgs(['--markdown', '--owner', 'user', '--offline']), { json: false, blocking: false, owner: 'user', offline: true, markdown: true });
  for (const args of [['--json', '--markdown'], ['--owner'], ['--show-values'], ['--owner', 'everyone']]) {
    const res = await golive(args);
    assert.equal(res.code, 2, args.join(' '));
    assert.equal(/MISSING|ready/.test(res.stdout), false);
  }
});

test('G-15: the Markdown report groups the items, gives each open one its next step, and exits 1 while a blocking item is open', async () => {
  const res = await golive(['--markdown', '--offline', '--blocking']);
  assert.equal(res.code, 1, res.stderr.slice(0, 200));
  assert.match(res.stdout, /^# Go-live checklist/);
  assert.match(res.stdout, /\*\*Not ready for go-live: \d+ blocking items? open\.\*\*/);
  assert.match(res.stdout, /## Founder \(user\) · Phase 0: foundation/);
  for (const item of GOLIVE_ITEMS.filter((i) => i.blocks)) assert.ok(res.stdout.includes(`\`${item.id}\``), item.id);
  for (const item of GOLIVE_ITEMS.filter((i) => !i.blocks)) assert.equal(res.stdout.includes(`\`${item.id}\``), false, item.id);
});

test('G-15: sign-offs come from the file GOLIVE_ATTESTATIONS names, and its names and references are not printed', async () => {
  const file = path.join(dir, 'attest.json');
  const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'legal.pages', signedOffBy: 'Kavya Iyer', role: 'Counsel', date, reference: 'drive-folder-91' }, { id: 'legal.dpdp', signedOffBy: 'K', role: 'Counsel', date }] }));
  const res = await golive(['--json', '--offline'], { GOLIVE_ATTESTATIONS: file });
  const status = GoliveStatus.parse(JSON.parse(res.stdout));
  assert.equal(status.items.find((i) => i.id === 'legal.pages').state, 'ready');
  assert.equal(status.items.find((i) => i.id === 'legal.dpdp').state, 'missing', 'a one-letter name is no sign-off');
  const text = await golive(['--offline'], { GOLIVE_ATTESTATIONS: file });
  assertNoneOf('the output', `${res.stdout}${text.stdout}${text.stderr}`, ['Kavya Iyer', 'drive-folder-91']);
  assert.match(text.stdout, /1 entry with no valid name, role, date or item/);
});

test('G-16: live checks with a database it cannot reach and a provider that hangs still finish, print no secret and report nothing ready that was not shown', async () => {
  const hang = http.createServer(() => {});
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => { hang.closeAllConnections?.(); hang.close(resolve); }));
  const base = `http://127.0.0.1:${hang.address().port}`;
  const env = {
    DATABASE_URL: 'postgres://app:MARKER-cli-db-7y@127.0.0.1:1/bhava', APP_SECRET: 'MARKER-cli-app-8u', IG_APP_ID: '1784201234567', VERIFY_TOKEN: 'MARKER-cli-verify-9i',
    AI_BASE_URL: base, AI_API_KEY: 'MARKER-cli-ai-0o', RAZORPAY_KEY_ID: 'rzp_live_Cli1234567', RAZORPAY_KEY_SECRET: 'MARKER-cli-rzp-1p',
  };
  const started = Date.now();
  const res = await golive(['--json'], env);
  assert.ok(Date.now() - started < 100_000);
  assert.equal(res.code, 1, res.stderr.slice(0, 200));
  assertNoneOf('the output', `${res.stdout}\n${res.stderr}`, ['MARKER-cli-db-7y', 'MARKER-cli-app-8u', 'MARKER-cli-verify-9i', 'MARKER-cli-ai-0o', 'MARKER-cli-rzp-1p']);
  const status = GoliveStatus.parse(JSON.parse(res.stdout));
  const item = (id) => status.items.find((i) => i.id === id);
  assert.equal(item('ai.provider').state, 'missing', 'an http address of our choosing is a test address');
  assert.equal(item('meta.app_settings').state, 'ready');
  for (const id of ['meta.app_live', 'razorpay.route', 'hosting.backups', 'hosting.secrets', 'hosting.guard']) assert.notEqual(item(id).state, 'ready', id);
});
