/**
 * What the load test's numbers mean: each function takes measurements and budgets.json and answers checks
 * ({ id, name, ok, measured, limit }) for the report. No clock, no network: tests feed it numbers.
 *
 * Margins (stated, never silent):
 *   - Every p95 and memory limit is applied exactly as budgets.json says: no allowance for a slow or busy machine is added.
 *     What the machine was doing is in the report (host probe) so a bad run can be read as one.
 *   - The storm's page limit is relative (factor times the same pages' p95 just before the storm) so it does not depend
 *     on how fast this machine is. A baseline under BASELINE_FLOOR_MS counts as BASELINE_FLOOR_MS: below that, a few
 *     milliseconds of scheduling noise on a loopback would fail a run that did nothing wrong.
 *   - A latency is judged only with at least MIN_SAMPLES answers: with fewer, the check fails (it proves nothing).
 */

export const BASELINE_FLOOR_MS = 100;
export const MIN_SAMPLES = 20;

const unitless = (v) => (v === null || v === undefined ? 'no reading' : v);

/** Q-05: failed requests and p95 per class. `byClass` is { class: { requests, failed, p95 } }. */
export function judgeMix({ budgets, byClass }) {
  const checks = [];
  const failed = Object.values(byClass).reduce((sum, c) => sum + c.failed, 0);
  const requests = Object.values(byClass).reduce((sum, c) => sum + c.requests, 0);
  checks.push({ id: 'Q-05', name: 'failed requests', ok: failed <= budgets.failedRequests && requests > 0, measured: `${failed}`, limit: `${budgets.failedRequests} (of ${requests} requests)` });
  for (const { class: name } of budgets.mix) {
    const c = byClass[name];
    const limit = budgets.p95Ms[name];
    const enough = c && c.requests >= MIN_SAMPLES;
    checks.push({ id: 'Q-05', name: `p95 ${name}`, ok: Boolean(enough && c.p95 !== null && c.p95 <= limit), measured: c ? `${unitless(c.p95)} ms over ${c.requests} requests` : 'no requests', limit: `${limit} ms` });
  }
  return checks;
}

/** Q-05: the highest memory of each process against its limit. A process that could not be read fails: no reading is not a pass. */
export function judgeMemory({ budgets, peaks }) {
  return ['web', 'worker', 'postgres'].map((role) => {
    const peak = peaks.memoryMb[role];
    return { id: 'Q-05', name: `peak memory ${role}`, ok: peak !== null && peak <= budgets.memoryMb[role], measured: peak === null ? 'could not be read' : `${peak}`, limit: `${budgets.memoryMb[role]} MB` };
  });
}

/**
 * Q-06. `baselinePageP95` and `stormPageP95`: the other businesses' page p95 before and during the storm (ms, or null).
 * `delays`: seconds between a comment arriving at another business and its DM going out (only DMs that went out have one, so
 * `others.unsent` counts the ones that did not: a DM stuck in the queue must not make the p95 look better). `others`: how many of
 * the other businesses' webhooks were stored and handled / how many were accepted.
 */
export function judgeStorm({ budgets, baselinePageP95, baselinePages, stormPageP95, stormPages, delays, others, stormAccepted, stormExpected }) {
  const rule = budgets.storm.otherBusiness;
  const floor = Math.max(baselinePageP95 ?? 0, BASELINE_FLOOR_MS);
  const pageLimit = Math.round(rule.pageP95Factor * floor * 10) / 10;
  const sorted = [...delays].sort((a, b) => a - b);
  const delayP95 = sorted.length ? sorted[Math.max(1, Math.ceil(0.95 * sorted.length)) - 1] : null;
  return [
    { id: 'Q-06', name: `storm accepted (${budgets.storm.comments} comments on one business)`, ok: stormAccepted === stormExpected && stormExpected > 0, measured: `${stormAccepted} of ${stormExpected} answered 200`, limit: 'all' },
    { id: 'Q-06', name: 'other businesses: page p95 during the storm', ok: stormPageP95 !== null && stormPages >= MIN_SAMPLES && baselinePages >= MIN_SAMPLES && stormPageP95 <= pageLimit, measured: `${unitless(stormPageP95)} ms over ${stormPages} pages (before: ${unitless(baselinePageP95)} ms over ${baselinePages})`, limit: `${pageLimit} ms (${rule.pageP95Factor} x max(before, ${BASELINE_FLOOR_MS} ms))` },
    { id: 'Q-06', name: 'other businesses: send delay p95', ok: delayP95 !== null && delays.length >= MIN_SAMPLES && delayP95 <= rule.sendDelayP95Seconds, measured: delayP95 === null ? 'no DMs went out' : `${Math.round(delayP95 * 10) / 10}`, limit: `${rule.sendDelayP95Seconds} s (${delays.length} DMs measured)` },
    { id: 'Q-06', name: 'other businesses: every DM went out (none left waiting or failed)', ok: others.unsent === 0 && delays.length > 0, measured: `${others.unsent} not sent${others.unsentDetail ? ` (${others.unsentDetail})` : ''}, ${delays.length} sent`, limit: '0 not sent' },
    { id: 'Q-06', name: 'other businesses: every webhook stored and handled', ok: others.accepted > 0 && others.handled === others.accepted, measured: `${others.handled} of ${others.accepted} handled`, limit: 'all' },
  ];
}

/** Q-07. `verify` is verifyWebhooks(): { accepted, lost, unhandled, duplicateSends }. `timing`: { backMs }. */
export function judgeRestart({ budgets, verify, timing, failedAfterBack }) {
  const rule = budgets.restart;
  return [
    { id: 'Q-07', name: 'lost webhooks (answered 200, not stored)', ok: verify.accepted > 0 && verify.lost <= rule.lostWebhooks, measured: `${verify.lost}`, limit: `${rule.lostWebhooks} (of ${verify.accepted} accepted)` },
    { id: 'Q-07', name: 'webhooks stored but never handled', ok: verify.unhandled === 0, measured: `${verify.unhandled}`, limit: '0' },
    { id: 'Q-07', name: 'sends twice', ok: verify.duplicateSends <= rule.duplicateSends, measured: `${verify.duplicateSends}`, limit: `${rule.duplicateSends}` },
    { id: 'Q-07', name: 'back after the restart', ok: timing.backMs !== null && timing.backMs <= rule.backWithinSeconds * 1000, measured: timing.backMs === null ? 'did not come back' : `${Math.round(timing.backMs / 100) / 10} s`, limit: `${rule.backWithinSeconds} s` },
    { id: 'Q-07', name: 'failed requests after it was back', ok: failedAfterBack === 0, measured: `${failedAfterBack}`, limit: '0' },
  ];
}
