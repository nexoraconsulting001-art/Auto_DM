// Report times on the business's own clock (PRD 7.9, 7.13), and the reporting API's limit of 60 calls a minute per key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyDue, nextRunAt, periodLabel, weeklyDue } from '../../../src/modules/reports/clock.js';
import { createRateLimiter } from '../../../src/modules/reports/reporting-api.js';
import { HOUR, istAt } from './support.js';

const IST = 'Asia/Kolkata';
const MONDAY = '2026-11-09';

test('N-40: the weekly report is due from Monday 09:00 on the business\'s clock, for the week before, and not at 08:59', () => {
  assert.equal(weeklyDue(istAt(MONDAY, 8, 59), IST), null);
  const due = weeklyDue(istAt(MONDAY, 9, 0), IST);
  assert.deepEqual([due.periodStart, due.periodEnd], ['2026-11-02', '2026-11-08']);
  assert.deepEqual(weeklyDue(istAt('2026-11-10', 8, 59), IST)?.periodStart, '2026-11-02', 'A worker that was down catches up within the day');
  assert.equal(weeklyDue(istAt('2026-11-10', 9, 0), IST), null, 'Not a day late');
  assert.equal(weeklyDue(istAt('2026-11-12', 12, 0), IST), null);
});

test('N-40: a business in UTC gets its report at its own 09:00, not India\'s', () => {
  assert.equal(weeklyDue(istAt(MONDAY, 9, 30), 'UTC'), null, '09:30 in India is 04:00 in UTC');
  assert.ok(weeklyDue(Date.parse(`${MONDAY}T09:05:00Z`), 'UTC'));
  assert.doesNotThrow(() => weeklyDue(Date.parse(`${MONDAY}T09:05:00Z`), 'Not/AZone'), 'A bad zone falls back to India and never throws');
});

test('N-43: the monthly report is due on the 1st at 09:00, for the calendar month before, across a year end', () => {
  assert.equal(monthlyDue(istAt('2026-12-01', 8, 59), IST), null);
  assert.deepEqual(Object.values(monthlyDue(istAt('2026-12-01', 9, 0), IST)).slice(0, 2), ['2026-11-01', '2026-11-30']);
  assert.deepEqual(Object.values(monthlyDue(istAt('2027-01-01', 10, 0), IST)).slice(0, 2), ['2026-12-01', '2026-12-31']);
  assert.deepEqual(Object.values(monthlyDue(istAt('2026-03-01', 9, 0), IST)).slice(0, 2), ['2026-02-01', '2026-02-28']);
  assert.equal(monthlyDue(istAt('2026-12-02', 9, 0), IST), null);
});

test('N-62: the next run of a schedule is at its hour on the business\'s clock, strictly after now', () => {
  const after = istAt(MONDAY, 9, 1);
  const weekly = nextRunAt({ frequency: 'weekly', weekday: 1, hourOfDay: 9 }, after, IST);
  assert.equal(weekly, istAt('2026-11-16', 9, 0));
  assert.equal(nextRunAt({ frequency: 'weekly', weekday: 1, hourOfDay: 9 }, istAt(MONDAY, 8, 59), IST), istAt(MONDAY, 9, 0));
  assert.equal(nextRunAt({ frequency: 'daily', hourOfDay: 9 }, istAt(MONDAY, 9, 0), IST), istAt('2026-11-10', 9, 0), 'Exactly at the hour is not after it');
  assert.equal(nextRunAt({ frequency: 'monthly', dayOfMonth: 15, hourOfDay: 18 }, after, IST), istAt('2026-11-15', 18, 0));
  assert.equal(nextRunAt({ frequency: 'monthly', hourOfDay: 9 }, after, IST), istAt('2026-12-01', 9, 0), 'Monthly defaults to the 1st');
  assert.equal(nextRunAt({ frequency: 'weekly', hourOfDay: 9 }, after, IST), weekly, 'Weekly defaults to Monday');
});

test('N-62: a zone with summer time keeps the local hour on both sides of the change', () => {
  const zone = 'America/New_York';
  const before = nextRunAt({ frequency: 'daily', hourOfDay: 9 }, Date.parse('2026-10-31T14:00:00Z'), zone);
  const after = nextRunAt({ frequency: 'daily', hourOfDay: 9 }, Date.parse('2026-11-02T15:00:00Z'), zone);
  assert.equal(new Date(before).toISOString(), '2026-11-01T14:00:00.000Z', '09:00 EST on 1 November');
  assert.equal(new Date(after).toISOString(), '2026-11-03T14:00:00.000Z');
  assert.equal(new Date(nextRunAt({ frequency: 'daily', hourOfDay: 9 }, Date.parse('2026-10-30T14:00:00Z'), zone)).toISOString(), '2026-10-31T13:00:00.000Z', '09:00 EDT the day before');
});

test('the week and month read as words', () => {
  assert.equal(periodLabel('2026-11-02', '2026-11-08'), '2 to 8 November 2026');
  assert.equal(periodLabel('2026-10-26', '2026-11-01'), '26 October to 1 November 2026');
  assert.equal(periodLabel('2026-12-28', '2027-01-03'), '28 December 2026 to 3 January 2027');
});

test('N-65: 60 calls in a minute per key; the 61st waits, and says for how long', () => {
  const clock = { t: 1_000_000 };
  const limiter = createRateLimiter({ clock: () => clock.t });
  for (let i = 0; i < 60; i++) {
    assert.equal(limiter.take(1).ok, true, `call ${i + 1}`);
    clock.t += 100;
  }
  const refused = limiter.take(1);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60, String(refused.retryAfter));
  assert.equal(limiter.take(2).ok, true, 'Another key is not affected');
  clock.t = 1_000_000 + 60_000;
  assert.equal(limiter.take(1).ok, true, 'The oldest call has left the window');
  assert.equal(limiter.take(1).ok, false);
  clock.t += HOUR;
  assert.equal(limiter.take(1).ok, true);
});
