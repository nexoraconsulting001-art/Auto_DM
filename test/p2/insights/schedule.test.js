// The polling schedule as arithmetic: every edge of 7.3 and 7.8, with no clock and no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS as L } from '../../../src/contracts/analytics.js';
import {
  ACCOUNT_JOBS, accountDaysToFetch, accountJitterSeconds, addDays, eachDay, firstDueAt, mediaEveryMs, mediaJitterSeconds, nextDueAfter, nextStoryDue, onlineFollowerCells, pollOffsetSeconds, retryDelayMs, storyPhase, zonedTime,
} from '../../../src/modules/insights/schedule.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-10T00:00:00Z');

function busiestMinute(seconds) {
  const counts = new Map();
  for (const s of seconds) counts.set(Math.floor(s / 60), (counts.get(Math.floor(s / 60)) ?? 0) + 1);
  return Math.max(...counts.values());
}

test('N-37: 50 businesses, wherever their ids start, never put more than 10% of starts in one minute', () => {
  for (const first of [1, 37, 1000, 123456]) {
    const offsets = Array.from({ length: 50 }, (_, i) => pollOffsetSeconds(first + i));
    assert.ok(offsets.every((o) => o >= 0 && o <= 3599));
    assert.ok(busiestMinute(offsets) <= 5, `from ${first}: ${busiestMinute(offsets)}`);
    const allJobs = offsets.flatMap((o) => ACCOUNT_JOBS.map((job) => accountJitterSeconds(o, job)));
    assert.ok(busiestMinute(allJobs) <= 20, `from ${first}: ${busiestMinute(allJobs)} of ${allJobs.length}`);
  }
});

test('one business\'s own jobs start in different minutes', () => {
  const seconds = ACCOUNT_JOBS.map((job) => accountJitterSeconds(1234, job));
  assert.equal(new Set(seconds.map((s) => Math.floor(s / 60))).size, ACCOUNT_JOBS.length);
});

test('a post keeps one place in the hour', () => {
  assert.equal(mediaJitterSeconds(100, 'abc'), mediaJitterSeconds(100, 'abc'));
  assert.ok(mediaJitterSeconds(100, 'abc') < 3600);
});

test('firstDueAt lands at that point of this hour or the next, never in the past', () => {
  assert.equal(firstDueAt(START + 10 * 60_000, 900), START + 15 * 60_000);
  assert.equal(firstDueAt(START + 20 * 60_000, 900), START + HOUR + 15 * 60_000);
  assert.equal(firstDueAt(START + 15 * 60_000, 900), START + 15 * 60_000);
});

test('nextDueAfter keeps the phase and owes nothing for missed runs', () => {
  assert.equal(nextDueAfter(START, DAY, START), START + DAY);
  assert.equal(nextDueAfter(START, DAY, START + 9 * DAY + 5), START + 10 * DAY);
  assert.equal(nextDueAfter(START, DAY, START + DAY), START + 2 * DAY);
});

test('how often media is read, by age, at each edge (7.8)', () => {
  assert.equal(mediaEveryMs(47 * HOUR), 3 * HOUR);
  assert.equal(mediaEveryMs(48 * HOUR), DAY);
  assert.equal(mediaEveryMs(30 * DAY - 1), DAY);
  assert.equal(mediaEveryMs(30 * DAY), 7 * DAY);
  assert.equal(mediaEveryMs(730 * DAY - 1), 7 * DAY);
  assert.equal(mediaEveryMs(730 * DAY), null);
});

test('N-10: a story is polled every 2h, then finally at 22h, inside the window', () => {
  const posted = Date.parse('2026-11-10T10:00:00Z');
  const seen = [];
  let at = posted;
  while (storyPhase(at - posted) === 'early') {
    at = nextStoryDue(posted, at);
    seen.push((at - posted) / HOUR);
  }
  assert.deepEqual(seen, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.equal(storyPhase(22 * HOUR), 'final');
  assert.equal(storyPhase(23.5 * HOUR - 1), 'final');
  assert.equal(storyPhase(23.5 * HOUR), 'closed');
});

test('a late story poll aims for the next step, and never past 22h', () => {
  assert.equal(nextStoryDue(START, START + 5 * HOUR), START + 6 * HOUR);
  assert.equal(nextStoryDue(START, START + 21 * HOUR), START + 22 * HOUR);
});

test('the last 3 days are always fetched, then what is missing, newest first, within Meta\'s 90', () => {
  const today = '2026-11-10';
  const all = accountDaysToFetch(today, [], 200);
  assert.deepEqual(all.days.slice(0, 3), ['2026-11-09', '2026-11-08', '2026-11-07']);
  assert.equal(all.days.at(-1), addDays(today, -89));
  assert.equal(all.days.length, 89);
  assert.equal(all.more, false);

  const firstRun = accountDaysToFetch(today, [], 30);
  assert.equal(firstRun.days.length, 33);
  assert.equal(firstRun.more, true);

  const stored = eachDay(addDays(today, -89), addDays(today, -1));
  assert.deepEqual(accountDaysToFetch(today, stored), { days: ['2026-11-09', '2026-11-08', '2026-11-07'], more: false });
});

test('a retry waits longer each time, up to 6 hours', () => {
  assert.equal(retryDelayMs(0, () => 0.5), 5 * 60_000);
  assert.equal(retryDelayMs(1, () => 0.5), 10 * 60_000);
  assert.ok(retryDelayMs(30, () => 1) <= 6 * HOUR * 1.2);
});

test('a moment in a business\'s time zone, and a zone nobody knows reads as the default', () => {
  assert.deepEqual(zonedTime(Date.parse('2026-11-10T18:45:00Z'), 'Asia/Kolkata'), { day: '2026-11-11', weekday: 3, hour: 0 });
  assert.deepEqual(zonedTime(Date.parse('2026-11-10T18:45:00Z'), 'Not/AZone'), { day: '2026-11-11', weekday: 3, hour: 0 });
});

test('online followers become weekday and hour cells in the business\'s zone, and junk is dropped', () => {
  const cells = onlineFollowerCells({ 0: 10, 19: 40, 99: 5, 3: 'x' }, Date.parse('2026-11-10T12:00:00Z'), 'Asia/Kolkata');
  assert.deepEqual(cells, [{ weekday: 2, hour: 5, value: 10 }, { weekday: 3, hour: 0, value: 40 }]);
});

test('the schedule\'s numbers are the contract\'s', () => {
  assert.equal(L.storyEveryMs, 2 * HOUR);
  assert.equal(L.pollLeaseMs, 600_000);
});
