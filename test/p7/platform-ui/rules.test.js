// The Platform Console's plain rules (console/src/platform/lib/rules.js): reasons, secrets, health order, the impersonation
// countdown and its second confirmation, the operator's active-time counting, and export input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_STATUSES, severityOf } from '../../../src/contracts/health.js';
import { ACTIVE_GAP_MS as CONTRACT_GAP, OPERATOR_TARGET_MS as CONTRACT_TARGET } from '../../../src/contracts/onboarding.js';
import { RawExportBody } from '../../../src/contracts/api/platform.js';
import {
  ACTIVE_GAP_MS, EXPORT_TABLES, HEALTH_ORDER, OPERATOR_TARGET_MS, REASON_MAX, WORDS, countdown, createActivityTracker, formatDuration, maskLink, maskSecret, nameMatches, parseIds, reasonProblem, targetState, word, worstFirst,
} from '../../../console/src/platform/lib/rules.js';

test('F-36 F-52: a reason must be written: blank, spaces, missing and over-long are all refused, and the limit is the server’s', () => {
  for (const bad of ['', '   ', '\n\t', null, undefined]) assert.equal(reasonProblem(bad), 'Give a reason', JSON.stringify(bad));
  assert.match(reasonProblem('x'.repeat(REASON_MAX + 1)), /at most 500/);
  assert.equal(reasonProblem('x'.repeat(REASON_MAX)), '');
  assert.equal(reasonProblem('  Meta asked us to stop  '), '');
});

test('F-122: a secret is never shown in full, and a link keeps only the start of its token', () => {
  const code = 'INVITE-9F3K2M8Q7R1T';
  const masked = maskSecret(code);
  assert.notEqual(masked, code);
  assert.ok(!masked.includes('9F3K2M8Q7R1T'));
  assert.ok(masked.startsWith('INVI'));
  assert.equal(maskSecret('abc'), '•••');
  assert.equal(maskSecret(''), '');
  const url = 'https://shop.example/onboard/Zk3pQ9sLm2Vx8TnB4wRy7HcA';
  const link = maskLink(url);
  assert.ok(!link.includes('Zk3pQ9sLm2Vx8TnB4wRy7HcA'));
  assert.ok(link.startsWith('https://shop.example/onboard/Zk3p'));
  assert.equal(maskLink('https://shop.example/start'), 'https://shop.example/start', 'a link with no token is left as it is');
});

test('F-40: the health order is the contract’s, worst first, then lowest score, and a business that could not be checked is not shown as fine', () => {
  assert.deepEqual([...HEALTH_ORDER], [...HEALTH_STATUSES]);
  const rows = [
    { tenantName: 'Ok', worst: 'ok', score: 100 },
    { tenantName: 'Warn', worst: 'warn', score: 40 },
    { tenantName: 'Unreachable', worst: 'unreachable', score: null },
    { tenantName: 'Bad high', worst: 'bad', score: 60 },
    { tenantName: 'Bad low', worst: 'bad', score: 10 },
    { tenantName: 'Bad none', worst: 'bad', score: null },
  ];
  assert.deepEqual(worstFirst(rows).map((r) => r.tenantName), ['Bad low', 'Bad high', 'Bad none', 'Unreachable', 'Warn', 'Ok']);
  assert.ok(severityOf('bad') < severityOf('unreachable') && severityOf('unreachable') < severityOf('warn'));
  assert.equal(rows[0].tenantName, 'Ok', 'the input is not changed');
});

test('F-45: the impersonation countdown counts down to zero and then says it is over', () => {
  const now = Date.UTC(2026, 10, 14, 10, 0, 0);
  assert.deepEqual(countdown(new Date(now + 30 * 60_000).toISOString(), now), { ms: 1_800_000, label: '30:00', over: false });
  assert.equal(countdown(new Date(now + 61_000).toISOString(), now).label, '1:01');
  assert.equal(countdown(new Date(now + 1).toISOString(), now).label, '0:01');
  assert.deepEqual(countdown(new Date(now - 5000).toISOString(), now), { ms: 0, label: '0:00', over: true });
});

test('F-44: write mode needs the business’s name typed; nothing else counts', () => {
  assert.equal(nameMatches('Kesar Kitchen', 'Kesar Kitchen'), true);
  assert.equal(nameMatches('  kesar kitchen ', 'Kesar Kitchen'), true);
  for (const wrong of ['', 'Kesar', 'Kesar Kitchens', null]) assert.equal(nameMatches(wrong, 'Kesar Kitchen'), false, String(wrong));
  assert.equal(nameMatches('', ''), false, 'a business with no name cannot be confirmed by typing nothing');
});

test('F-27: the operator’s time counts only active stretches, never a gap over two minutes, and is reported once', () => {
  assert.equal(ACTIVE_GAP_MS, CONTRACT_GAP);
  assert.equal(OPERATOR_TARGET_MS, CONTRACT_TARGET);
  const t0 = Date.UTC(2026, 10, 14, 9, 0, 0);
  const tracker = createActivityTracker();
  assert.equal(tracker.flush(), null, 'nothing yet');
  tracker.touch(t0);
  tracker.touch(t0 + 30_000);
  tracker.touch(t0 + 60_000);
  tracker.touch(t0 + 60_000 + ACTIVE_GAP_MS + 1); // a break: not counted
  tracker.touch(t0 + 60_000 + ACTIVE_GAP_MS + 10_001);
  const spent = tracker.flush();
  assert.equal(spent.activeMs, 70_000);
  assert.equal(spent.startedAt, new Date(t0).toISOString());
  assert.equal(spent.endedAt, new Date(t0 + 60_000 + ACTIVE_GAP_MS + 10_001).toISOString());
  assert.equal(tracker.flush(), null, 'what was reported is not reported twice');
  tracker.touch(t0);
  assert.equal(tracker.flush(), null, 'one touch is no time');
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(252_000), '4 min 12 s');
  assert.equal(formatDuration(600_000), '10 min');
  assert.equal(targetState(600_000), 'within');
  assert.equal(targetState(600_001), 'over');
});

test('F-123: raw export input: business numbers are whole numbers above zero, and the tables are the contract’s', () => {
  assert.deepEqual(parseIds('12, 15 18,12'), [12, 15, 18]);
  assert.deepEqual(parseIds(''), []);
  for (const bad of ['0', '-3', '1.5', 'abc', '12 x', '99999999999999999999']) assert.equal(parseIds(bad), null, bad);
  const sample = { reason: 'audit', tables: EXPORT_TABLES.map((t) => t.value), tenantIds: [1], from: '2026-11-01', to: '2026-11-14' };
  assert.equal(RawExportBody.safeParse(sample).success, true, 'every table offered is one the server accepts');
});

test('words: every machine value the server sends has words, so a raw code is never on a screen', () => {
  assert.equal(word('health', 'unreachable'), 'Could not check');
  assert.equal(word('nothing', 'x'), 'x');
  for (const group of Object.values(WORDS)) for (const [code, text] of Object.entries(group)) assert.ok(text && text !== code, code);
});
