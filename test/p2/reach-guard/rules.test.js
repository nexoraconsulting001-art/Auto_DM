// PRD 7.6 and 7.7 as pure functions, at their exact edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_DEDUCTIONS } from '../../../src/contracts/analytics.js';
import {
  addDays, baselineBefore, bandOf, clearsTrip, isLearning, lastSettledDay, latestRun, median, mediaTrip, reachDaysTrip, reachGuardState, scoreHealth, statusMessage, tripMessage, withMediaBaselines,
} from '../../../src/modules/reach-guard/rules.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const T = { reachDropPercent: 60, mediaDropPercent: 50, clearPercent: 80 };

const series = (endDay, values) => values.map((reach, i) => ({ day: addDays(endDay, i - values.length + 1), reach }));
const usual = (n = 28, reach = 10_000) => Array(n).fill(reach);

const OK = { channel: 'instagram', active: true, hasToken: true, tokenExpiresAt: new Date(NOW + 50 * DAY), refreshFailures: 0, calls: 0, errors: 0, excluded: 0, maxUsagePercent: 0, buc80002: false, missingScopes: [], insightsDenied: false, webhooksSilent: false, tripDropPercent: null, policyErrors: 0 };
const health = (more) => scoreHealth({ ...OK, ...more }, NOW);
const codes = (result) => result.deductions.map((d) => d.code);

test('median of odd and even lists, and of nothing', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), null);
});

test('a day is settled once it is at least 2 days old', () => {
  assert.equal(lastSettledDay(NOW), '2026-11-08');
  assert.equal(lastSettledDay(Date.parse('2026-11-10T00:00:01Z')), '2026-11-08');
});

test('the baseline is the 28 days before the day, and never the day itself', () => {
  const s = series('2026-11-05', [...usual(28), 100, 200, 300]);
  const b = baselineBefore(s, '2026-11-03');
  assert.deepEqual(b, { value: 10_000, sample: 28 });
  assert.equal(baselineBefore([], '2026-11-03').value, null);
});

test('only the 28 days before count: older days are left out of the baseline', () => {
  const s = series('2026-11-05', [...usual(10, 99), ...usual(28, 500)]);
  assert.deepEqual(baselineBefore(s, '2026-11-06'), { value: 500, sample: 28 });
});

test('a run has to be consecutive calendar days', () => {
  assert.equal(latestRun([{ day: '2026-11-01', reach: 1 }, { day: '2026-11-03', reach: 1 }, { day: '2026-11-04', reach: 1 }], 3), null);
  assert.equal(latestRun([{ day: '2026-11-03', reach: 1 }], 3), null);
  assert.equal(latestRun(series('2026-11-05', [1, 2, 3]), 3).length, 3);
});

test('N-23: three days below 60% trip, with the drop worked out from their median', () => {
  const trip = reachDaysTrip(series('2026-11-08', [...usual(), 5500, 5200, 5800]), T);
  assert.deepEqual([trip.trigger, trip.baseline, trip.dropPercent], ['reach_days', 10_000, 45]);
  assert.deepEqual(trip.observed.map((d) => d.reach), [5500, 5200, 5800]);
});

test('exactly 60% is not below 60%, and 2 low days are not 3', () => {
  assert.equal(reachDaysTrip(series('2026-11-08', [...usual(), 5999, 5999, 6000]), T), null);
  assert.equal(reachDaysTrip(series('2026-11-08', [...usual(), 9000, 5000, 5000]), T), null);
  assert.ok(reachDaysTrip(series('2026-11-08', [...usual(), 5999, 5999, 5999]), T));
});

test('with no usable baseline there is no trip, and a baseline of 0 cannot be below', () => {
  assert.equal(reachDaysTrip(series('2026-11-08', [10, 10, 10]), T), null);
  assert.equal(reachDaysTrip(series('2026-11-08', [...usual(28, 0), 0, 0, 0]), T), null);
});

test('thresholds change where the line is', () => {
  const s = series('2026-11-08', [...usual(), 7000, 7000, 7000]);
  assert.equal(reachDaysTrip(s, T), null);
  assert.ok(reachDaysTrip(s, { ...T, reachDropPercent: 75 }));
});

test('Learning needs both 14 settled days and 5 media', () => {
  assert.equal(isLearning({ settledDays: 6, mediaCounted: 30 }), true);
  assert.equal(isLearning({ settledDays: 13, mediaCounted: 5 }), true);
  assert.equal(isLearning({ settledDays: 28, mediaCounted: 4 }), true);
  assert.equal(isLearning({ settledDays: 14, mediaCounted: 5 }), false);
});

const media = (kind, reaches, startMs = NOW - 100 * DAY) => reaches.map((reach, i) => ({ mediaId: `${kind}${i}`, kind, reach, postedAt: new Date(startMs + i * DAY) }));

test('each media is compared with the last 10 of its own type before it, and needs 5 of them', () => {
  const list = withMediaBaselines(media('reel', [100, 100, 100, 100, 100, 100, 50]));
  assert.deepEqual(list.map((m) => m.baseline), [null, null, null, null, null, 100, 100]);
  const twelve = withMediaBaselines(media('reel', [...Array(2).fill(1), ...Array(10).fill(1000), 7]));
  assert.equal(twelve.at(-1).baseline, 1000, 'the first two have dropped out of the last 10');
});

test('three consecutive media below 50% at 24h trip; one normal media breaks the run; exactly 50% is not below', () => {
  const trip = mediaTrip(withMediaBaselines(media('reel', [...Array(10).fill(1000), 400, 300, 200])), T);
  assert.deepEqual([trip.trigger, trip.dropPercent, trip.observed.length], ['media_24h', 70, 3]);
  assert.equal(mediaTrip(withMediaBaselines(media('reel', [...Array(10).fill(1000), 400, 900, 200, 300])), T), null);
  assert.equal(mediaTrip(withMediaBaselines(media('reel', [...Array(10).fill(1000), 400, 300, 500])), T), null);
});

test('types are judged separately, and media with no yardstick neither count nor break a run', () => {
  const reels = media('reel', [...Array(10).fill(1000), 100, 100]);
  const first = media('carousel', [99_999], NOW - 50 * DAY);
  const third = media('reel', [100], NOW - 40 * DAY);
  const ordered = [...reels, ...first, ...third];
  const list = withMediaBaselines(ordered);
  assert.equal(list.find((m) => m.kind === 'carousel').baseline, null);
  assert.ok(mediaTrip(list, T));
});

test('media from before the last trip cleared cannot start the next one', () => {
  const list = withMediaBaselines(media('reel', [...Array(10).fill(1000), 100, 100, 100]));
  assert.equal(mediaTrip(list, T, new Date(NOW - 80 * DAY)), null);
  assert.ok(mediaTrip(list, T, new Date(NOW - 95 * DAY)));
});

const dayTrip = { trigger: 'reach_days', baseline: 10_000, startedAt: new Date(NOW), observed: [{ day: '2026-11-03' }, { day: '2026-11-04' }, { day: '2026-11-05' }] };

test('N-26: 3 settled days at 80% or more clear against the baseline the trip started from', () => {
  assert.equal(clearsTrip(series('2026-11-08', [8000, 8000, 8000]), dayTrip, T), true);
  assert.equal(clearsTrip(series('2026-11-08', [8000, 7999, 8000]), dayTrip, T), false);
  assert.equal(clearsTrip(series('2026-11-07', [8000, 8000]), dayTrip, T), false, 'two days are not three');
});

test('the days that caused a trip can never clear it, and a media trip needs 3 days after it started', () => {
  assert.equal(clearsTrip(series('2026-11-05', [9000, 9000, 9000]), dayTrip, T), false);
  const mediaTripRow = { trigger: 'media_24h', baseline: 10_000, startedAt: new Date('2026-11-06T10:00:00Z'), observed: [] };
  assert.equal(clearsTrip(series('2026-11-05', [9000, 9000, 9000]), mediaTripRow, T), false);
  assert.equal(clearsTrip(series('2026-11-08', [9000, 9000, 9000]), mediaTripRow, T), true);
});

test('a trip with no baseline never clears by accident', () => {
  assert.equal(clearsTrip(series('2026-11-08', [1, 1, 1]), { ...dayTrip, baseline: null }, T), false);
});

test('the state: Permission needed first, then Tripped, then Watch, then Learning or Normal', () => {
  assert.equal(reachGuardState({ denied: true, tripOpen: true, watch: true, learning: true }), 'permission_needed');
  assert.equal(reachGuardState({ denied: false, tripOpen: true, watch: true, learning: true }), 'tripped');
  assert.equal(reachGuardState({ denied: false, tripOpen: false, watch: true, learning: true }), 'watch');
  assert.equal(reachGuardState({ denied: false, tripOpen: false, watch: false, learning: true }), 'learning');
  assert.equal(reachGuardState({ denied: false, tripOpen: false, watch: false, learning: false }), 'normal');
});

test('the copy leads with the drop and gives normal causes', () => {
  assert.match(tripMessage(45), /^Reach is down 45% vs your usual\. Possible normal causes: /);
});

test('no message ever says shadowbanned or safe', () => {
  const texts = [];
  for (const state of ['learning', 'normal', 'watch', 'tripped', 'permission_needed']) {
    for (const channel of ['instagram', 'facebook']) {
      for (const overridden of [false, true]) for (const restoring of [false, true]) texts.push(statusMessage({ state, channel, dropPercent: 40, settledDays: 3, mediaCounted: 1, overridden, restoring }));
    }
  }
  const everything = health({ tokenExpiresAt: new Date(NOW + 2 * DAY), refreshFailures: 2, calls: 100, errors: 30, maxUsagePercent: 90, buc80002: true, missingScopes: ['x'], insightsDenied: true, webhooksSilent: true, tripDropPercent: 40, policyErrors: 1 });
  const lost = health({ active: false });
  for (const d of [...everything.deductions, ...lost.deductions]) texts.push(d.message, d.fix);
  assert.ok(texts.length > 40);
  for (const text of texts) assert.doesNotMatch(text, /shadow\s?ban|\bsafe|safely/i, text);
});

test('every kind of deduction has the points the contract gives it, and a fix', () => {
  const all = [
    health({ tokenExpiresAt: new Date(NOW + 10 * DAY) }), health({ tokenExpiresAt: new Date(NOW + 2 * DAY) }), health({ refreshFailures: 1 }), health({ active: false }),
    health({ calls: 100, errors: 10 }), health({ calls: 100, errors: 30 }), health({ maxUsagePercent: 75 }), health({ buc80002: true }), health({ missingScopes: ['x'] }),
    health({ webhooksSilent: true }), health({ tripDropPercent: 30 }), health({ policyErrors: 1 }),
  ].flatMap((r) => r.deductions);
  assert.deepEqual(new Set(all.map((d) => d.code)), new Set(Object.keys(HEALTH_DEDUCTIONS)));
  for (const d of all) {
    assert.equal(d.points, HEALTH_DEDUCTIONS[d.code] === 'score_zero' ? -100 : HEALTH_DEDUCTIONS[d.code], d.code);
    assert.ok(d.message.length && d.fix.length, d.code);
  }
});

test('N-29: 10 days from expiry is -10 with "Refresh pending"; 14 days exactly counts, 15 does not', () => {
  const r = health({ tokenExpiresAt: new Date(NOW + 10 * DAY) });
  assert.equal(r.score, 90);
  assert.match(r.deductions[0].message, /Refresh pending/);
  assert.deepEqual(codes(health({ tokenExpiresAt: new Date(NOW + 14 * DAY) })), ['token_14d']);
  assert.deepEqual(codes(health({ tokenExpiresAt: new Date(NOW + 14 * DAY + 1) })), []);
});

test('N-30: 2 days from expiry is -20 and red; 3 days exactly counts', () => {
  const r = health({ tokenExpiresAt: new Date(NOW + 2 * DAY) });
  assert.equal(r.score, 80);
  assert.match(r.deductions[0].message, /^Red: /);
  assert.deepEqual(codes(health({ tokenExpiresAt: new Date(NOW + 3 * DAY) })), ['token_3d']);
});

test('a token check gives one deduction, its worst tier', () => {
  const r = health({ tokenExpiresAt: new Date(NOW + 2 * DAY), refreshFailures: 2 });
  assert.deepEqual(codes(r), ['token_refresh_failed']);
  assert.equal(r.score, 70);
});

test('N-31: rejected, deauthorized, expired or no token is score 0 with "Reconnect Instagram", whatever else is true', () => {
  for (const facts of [{ active: false }, { hasToken: false }, { tokenExpiresAt: new Date(NOW - 1) }]) {
    const r = health({ ...facts, webhooksSilent: true });
    assert.equal(r.score, 0);
    assert.equal(r.band, 'at_risk');
    assert.equal(r.deductions[0].code, 'token_rejected');
    assert.match(r.deductions[0].fix, /Reconnect Instagram/);
  }
  assert.match(health({ channel: 'facebook', active: false }).deductions[0].fix, /Reconnect Facebook/);
});

test('N-32: 30 of 100 calls failing is -30 with the rate shown; the edges are "above"', () => {
  const r = health({ calls: 100, errors: 30 });
  assert.equal(r.score, 70);
  assert.match(r.deductions[0].message, /API errors 30%/);
  assert.deepEqual(codes(health({ calls: 100, errors: 5 })), []);
  assert.deepEqual(codes(health({ calls: 100, errors: 6 })), ['api_errors_5']);
  assert.deepEqual(codes(health({ calls: 100, errors: 20 })), ['api_errors_5']);
  assert.deepEqual(codes(health({ calls: 100, errors: 21 })), ['api_errors_20']);
});

test('N-33: responses that are not API failures are left out of the rate entirely', () => {
  assert.deepEqual(codes(health({ calls: 10, errors: 0, excluded: 10 })), []);
  assert.deepEqual(codes(health({ calls: 20, errors: 1, excluded: 10 })), ['api_errors_5'], '1 of the 10 that count is 10%');
});

test('usage is -10 from 75%, and 80002 is -25 on top of it', () => {
  assert.deepEqual(codes(health({ maxUsagePercent: 74 })), []);
  const r = health({ maxUsagePercent: 75, buc80002: true });
  assert.deepEqual(codes(r), ['buc_80002', 'usage_75']);
  assert.equal(r.score, 65);
});

test('N-34: a missing permission is one -30 however many are missing, and says Permission needed', () => {
  const r = health({ missingScopes: ['a', 'b'], insightsDenied: true });
  assert.equal(r.score, 70);
  assert.deepEqual(codes(r), ['scope_missing']);
  assert.match(r.deductions[0].message, /Permission needed/);
});

test('the bands: 80 and up, 50 to 79, under 50', () => {
  assert.deepEqual([bandOf(100), bandOf(80), bandOf(79), bandOf(50), bandOf(49), bandOf(0)], ['good', 'good', 'watch', 'watch', 'at_risk', 'at_risk']);
});

test('deductions are worst first, and the score stops at 0', () => {
  const r = health({ tokenExpiresAt: new Date(NOW + 10 * DAY), calls: 100, errors: 30, maxUsagePercent: 80, buc80002: true, missingScopes: ['x'], webhooksSilent: true, tripDropPercent: 40, policyErrors: 2 });
  assert.equal(r.score, 0);
  const points = r.deductions.map((d) => d.points);
  assert.deepEqual(points, [...points].sort((a, b) => a - b));
  assert.equal(r.deductions.length, 8);
});

test('a clean account has no deductions and no words at all', () => {
  assert.deepEqual(health({}), { score: 100, band: 'good', deductions: [] });
});
