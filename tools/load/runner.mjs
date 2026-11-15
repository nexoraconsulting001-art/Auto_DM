/**
 * The load test itself: the three parts (mix, storm, restart) on one world, the report. index.mjs holds the command line.
 * Nothing printed here carries a secret: every message goes through scrub().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeMemory, judgeMix, judgeRestart, judgeStorm } from './analyze.mjs';
import { drive, percentile, sleep } from './http.mjs';
import { startMonitor } from './monitor.mjs';
import { writeReport } from './stack.mjs';
import { EXPECT, classPlans, createRecorder, createRng, stormPlan } from './traffic.mjs';
import { backgroundJobs, sendDelays, verifyWebhooks, waitDrained } from './verify.mjs';
import { hostInfo, startWorld } from './world.mjs';

export const SEED = 20260101;
const STORM_SHOP = 0;
const BASELINE_SECONDS = 15;

/** Removes anything that looks like a database address or one of this run's made-up secrets from text meant for a person. */
export function scrub(text, secrets = []) {
  let out = String(text ?? '').replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://***');
  for (const secret of secrets) if (secret && String(secret).length >= 6) out = out.split(String(secret)).join('***');
  return out;
}

/**
 * Waits for the queues. What is judged is the first: every stored webhook handled (the work of the worker's inbound queue). The second is
 * best effort: the compliance gate paces an account's DMs (one conversation a second, 600 an hour), so a business that was sent many
 * comments has DMs waiting long after its webhooks were handled, and that is the gate working.
 */
async function settleQueues(world, { tenantIds = null, inboundMs = 90_000, sendsMs = 30_000 } = {}) {
  const inbound = await waitDrained(world, { ms: inboundMs, tenantIds, sends: false });
  const sends = await waitDrained(world, { ms: sendsMs, tenantIds, sends: true });
  return { inbound, sends };
}

const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

async function hostProbe(world) {
  const times = [];
  for (let i = 0; i < 40; i++) times.push((await world.client.request({ path: '/healthz' })).ms);
  return { ...hostInfo(), loadAverage: round1(os.loadavg()[0]), idleProbeP50Ms: round1(percentile(times, 50)), idleProbeP95Ms: round1(percentile(times, 95)) };
}

export async function runLoad({ budgets, parts, seconds, out, say = (m) => console.log(`load: ${m}`), root }) {
  const startedAt = new Date().toISOString();
  const checks = [];
  const notes = [];
  const summary = [];
  const data = {};
  const short = seconds !== null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-load-'));
  let world = null;
  let monitor = null;
  let secrets = [];
  try {
    world = await startWorld({ budgets, dir, say });
    secrets = [world.secrets.appSecret, world.secrets.verifyToken, world.secrets.session, world.secrets.dataKey, ...world.shops.map((s) => s.token)];
    monitor = startMonitor({ db: world.db, getPids: () => ({ web: world.web.pid, worker: world.worker.pid, postgres: world.pg.pid }), sharedBuffersMb: budgets.postgres.sharedBuffersMb });
    data.host = await hostProbe(world);
    const rps = budgets.run.requestsPerSecond;
    const shared = { world, rps, mix: budgets.mix };
    const mixPlan = (rec, tag, rngSeed) => classPlans({ ...shared, rec, tag, rng: createRng(rngSeed) });
    const mixSeconds = seconds ?? budgets.run.durationSeconds;
    const warmup = short ? Math.min(budgets.run.warmupSeconds, Math.max(3, Math.floor(seconds / 5))) : budgets.run.warmupSeconds;

    if (parts.includes('mix')) {
      say(`mix: ${warmup} s warm-up, then ${mixSeconds} s at ${rps} requests a second`);
      const warm = createRecorder();
      await drive({ client: world.client, plan: mixPlan(warm, 'w1', SEED), seconds: warmup, onResult: () => {} });
      const rec = createRecorder();
      const before = performance.now();
      await drive({ client: world.client, plan: mixPlan(rec, 'm1', SEED + 1), seconds: mixSeconds, onResult: rec.onResult });
      const driven = (performance.now() - before) / 1000;
      const settled = await settleQueues(world);
      const drained = settled.inbound;
      const byClass = Object.fromEntries(budgets.mix.map((m) => [m.class, rec.summary(m.class)]));
      const verify = await verifyWebhooks(world, [...warm.accepted, ...rec.accepted]);
      checks.push(...judgeMix({ budgets, byClass }));
      checks.push({ id: 'Q-05', name: 'every webhook answered 200 is stored and handled', ok: verify.accepted > 0 && verify.lost === 0 && verify.unhandled === 0 && drained, measured: `${verify.accepted} accepted, ${verify.lost} lost, ${verify.unhandled} not handled${drained ? '' : ', webhooks were still waiting after 90 s'}`, limit: 'none lost' });
      checks.push({ id: 'Q-05', name: 'no message sent twice', ok: verify.duplicateSends === 0, measured: `${verify.duplicateSends}`, limit: '0' });
      checks.push({ id: 'Q-05', name: 'checkouts paid and confirmed by webhook', ok: rec.counts.paymentErrors === 0 && rec.counts.paid > 0, measured: `${rec.counts.paid} paid, ${rec.counts.paymentErrors} payment errors`, limit: 'no errors' });
      data.mix = { byClass, slowestRoutes: rec.slowest(), sendsDrained: settled.sends, verify, counts: rec.counts, drivenSeconds: round1(driven), requestsPerSecond: rps };
      summary.push(['Mix', `${mixSeconds} s at ${rps} requests a second, ${Object.values(byClass).reduce((s, c) => s + c.requests, 0)} requests`]);
    }

    if (parts.includes('storm')) {
      const overSeconds = short ? Math.min(budgets.storm.overSeconds, seconds) : budgets.storm.overSeconds;
      const comments = Math.round(budgets.storm.comments * (overSeconds / budgets.storm.overSeconds));
      const baseSeconds = short ? Math.min(BASELINE_SECONDS, Math.max(5, Math.floor(seconds / 3))) : BASELINE_SECONDS;
      say(`storm: ${baseSeconds} s baseline, then ${comments} comments on one business over ${overSeconds} s`);
      const base = createRecorder();
      await drive({ client: world.client, plan: mixPlan(base, 'b1', SEED + 2), seconds: baseSeconds, onResult: base.onResult });
      const stormed = createRecorder();
      const since = new Date();
      const plan = [...mixPlan(stormed, 's1', SEED + 3), stormPlan({ world, rec: stormed, shopIndex: STORM_SHOP, comments, seconds: overSeconds, tag: 's2' })];
      await drive({ client: world.client, plan, seconds: overSeconds, onResult: stormed.onResult });
      const stormTenant = world.shops[STORM_SHOP].tenantId;
      const otherTenants = world.shops.filter((_, i) => i !== STORM_SHOP).map((s) => s.tenantId);
      // A DM of another business that is still not out after twice the p95 limit is not a slow DM but a missing one.
      const graceMs = Math.min(600_000, Math.max(60_000, 2000 * budgets.storm.otherBusiness.sendDelayP95Seconds));
      const othersSettled = await settleQueues(world, { tenantIds: otherTenants, inboundMs: 120_000, sendsMs: graceMs });
      const othersDrained = othersSettled.inbound;
      const stormSettled = await settleQueues(world, { tenantIds: [stormTenant], inboundMs: 120_000, sendsMs: 10_000 });
      const stormDrained = stormSettled.sends;
      const delays = await sendDelays(world, { tenantIds: otherTenants, since });
      const unsentRows = await world.db.platform.query(`SELECT status, reason, count(*)::int AS n FROM outbound_jobs WHERE tenant_id = ANY($1::int[]) AND created_at >= $2 AND status IN ('queued', 'sending', 'held', 'unknown', 'failed') GROUP BY status, reason ORDER BY n DESC`, [otherTenants, since]);
      const unsent = unsentRows.reduce((sum, row) => sum + row.n, 0);
      const unsentDetail = unsentRows.map((row) => `${row.n} ${row.status}${row.reason ? ` (${row.reason})` : ''}`).join(', ');
      const stormDelays = await sendDelays(world, { tenantIds: [stormTenant], since });
      const acceptedAll = [...base.accepted, ...stormed.accepted];
      const verify = await verifyWebhooks(world, acceptedAll);
      const verifyOthers = await verifyWebhooks(world, acceptedAll.filter((a) => a.tenantId !== stormTenant));
      const notStorm = (r) => r.shop !== STORM_SHOP;
      const basePages = base.summary('buyer_page', notStorm);
      const stormPages = stormed.summary('buyer_page', notStorm);
      const stormResults = stormed.summary('storm');
      checks.push(...judgeStorm({
        budgets,
        baselinePageP95: basePages.p95, baselinePages: basePages.requests, stormPageP95: stormPages.p95, stormPages: stormPages.requests,
        delays, others: { accepted: verifyOthers.accepted, handled: verifyOthers.accepted - verifyOthers.lost - verifyOthers.unhandled, unsent, unsentDetail },
        stormAccepted: stormed.accepted.filter((a) => a.name === 'storm').length, stormExpected: stormResults.requests,
      }));
      checks.push({ id: 'Q-06', name: 'no webhook lost, none sent twice (whole storm)', ok: verify.lost === 0 && verify.duplicateSends === 0 && othersDrained, measured: `${verify.lost} lost, ${verify.duplicateSends} twice, others ${othersDrained ? 'handled' : 'still had webhooks waiting'}`, limit: '0' });
      checks.push({ id: 'Q-06', name: 'failed requests of the other businesses during the storm', ok: Object.keys(budgets.p95Ms).every((c) => stormed.summary(c, notStorm).failed === 0), measured: Object.keys(budgets.p95Ms).map((c) => `${c} ${stormed.summary(c, notStorm).failed}`).join(', '), limit: '0' });
      const pct = (list, p) => (list.length ? round1(percentile(list, p)) : null);
      const p95 = (list) => pct(list, 95);
      data.storm = { comments, overSeconds, basePages, stormPages, stormBusiness: { accepted: stormResults, drained: stormDrained, sendDelayP95Seconds: p95(stormDelays), dmsSent: stormDelays.length }, othersSendDelaySeconds: { p50: pct(delays, 50), p95: p95(delays), max: delays.length ? round1(Math.max(...delays)) : null }, othersDms: delays.length, othersUnsent: unsentRows, verify };
      summary.push(['Storm', `${comments} comments on one business over ${overSeconds} s; its own DMs ${stormDrained ? 'all went out' : 'are paced by the gate'} (${stormDelays.length} sent when the wait ended)`]);
      if (!stormDrained) notes.push('The storm business still had DMs waiting when the wait ended: the compliance gate allows one new conversation a second and 600 private replies an hour for one Instagram account, so 2,000 comments cannot all be answered in a minute or in an hour. Its comments were all stored and handled; only the other businesses are judged on send delay.');
    }

    if (parts.includes('restart')) {
      const total = mixSeconds;
      const killAt = short ? Math.min(budgets.restart.afterSeconds, Math.max(3, Math.floor(seconds / 3))) : budgets.restart.afterSeconds;
      say(`restart: ${total} s of traffic, web and worker killed hard at ${killAt} s and started again`);
      const rec = createRecorder();
      const begin = performance.now();
      let timing = { downMs: null, backMs: null };
      let backAt = null;
      let restartError = null;
      const killer = (async () => {
        await sleep(killAt * 1000);
        const killedAt = performance.now() - begin;
        try {
          const t = await world.restart(['web', 'worker'], { hard: true });
          timing = { downMs: t.downMs, backMs: t.backMs };
          backAt = killedAt + t.downMs + t.backMs;
        } catch (err) {
          restartError = err;
        }
      })();
      await drive({ client: world.client, plan: mixPlan(rec, 'r1', SEED + 4), seconds: total, onResult: rec.onResult });
      await killer;
      if (restartError) throw restartError;
      const drained = (await settleQueues(world, { inboundMs: 120_000, sendsMs: 30_000 })).inbound;
      const verify = await verifyWebhooks(world, rec.accepted);
      // Requests that go out while the processes are down fail, and a webhook that fails is sent again until it is answered 200.
      // Anything that fails after the processes are back (and have had two seconds to take the held-up traffic) counts.
      const settledAt = (backAt ?? Infinity) + 2000;
      const failedAfterBack = rec.results.filter((r) => r.at - r.ms > settledAt && !EXPECT[r.name](r.status)).length;
      checks.push(...judgeRestart({ budgets, verify: { ...verify, unhandled: verify.unhandled + (drained ? 0 : 1) }, timing: restartError ? { backMs: null } : timing, failedAfterBack }));
      data.restart = { killAtSeconds: killAt, timing, verify, retries: rec.counts.webhookRetries, failedDuringOutage: rec.results.filter((r) => !EXPECT[r.name](r.status)).length - failedAfterBack };
      summary.push(['Restart', `web and worker killed hard at ${killAt} s; back in ${timing.backMs === null ? 'never' : `${round1(timing.backMs / 1000)} s`}; ${rec.counts.webhookRetries} webhook retries`]);
    }

    const stopped = await monitor.stop();
    monitor = null;
    checks.push(...judgeMemory({ budgets, peaks: stopped.peaks }));
    data.peaks = stopped.peaks;
    data.background = await backgroundJobs(world);
    summary.push(['Memory peaks (MB)', `web ${stopped.peaks.memoryMb.web}, worker ${stopped.peaks.memoryMb.worker}, database ${stopped.peaks.memoryMb.postgres}`]);
    summary.push(['Queues (peak)', `webhooks waiting ${stopped.peaks.queue.inbound}, sends waiting ${stopped.peaks.queue.outbound}, oldest webhook ${stopped.peaks.queue.inboundAgeS} s, database answer ${stopped.peaks.dbMs} ms`]);
  } catch (err) {
    checks.push({ id: 'Q-05', name: 'the load test ran to the end', ok: false, measured: scrub(err?.message ?? err, secrets).split('\n')[0].slice(0, 300), limit: 'no error' });
  } finally {
    await monitor?.stop().catch(() => {});
    await world?.close().catch(() => {});
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  if (data.host) {
    summary.push(['Machine', `${data.host.cpus} CPUs, ${data.host.totalMemoryMb} MB, ${data.host.platform}, node ${data.host.node}; idle probe p50 ${data.host.idleProbeP50Ms} ms, p95 ${data.host.idleProbeP95Ms} ms`]);
  }
  notes.push('Every limit is applied as budgets.json states it: no allowance for a slow or busy machine is added to a p95 or a memory limit. The storm page limit is relative to the same pages just before the storm (floor 100 ms).');
  notes.push('The web app and the worker run as separate processes with node heap flags set to three quarters of their limit; memory is judged on what the operating system says each process uses, and Postgres on the whole server tree.');
  notes.push('The simulators, the traffic and the monitor run in this one process on the same machine as the system under test, so the numbers include that competition.');
  if (short) notes.push(`A short run (--seconds ${seconds}): not a pass of record. The storm was scaled to the same rate and the restart came earlier.`);
  const report = {
    title: `Load test${short ? ' (short run, not of record)' : ''}`,
    ok: checks.length > 0 && checks.every((c) => c.ok),
    ofRecord: !short && parts.length === 3,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: [['Businesses', budgets.businesses], ['Parts', parts.join(', ')], ...summary],
    checks,
    notes,
    data,
  };
  const files = writeReport(out, JSON.parse(scrub(JSON.stringify(report), secrets)), root ? { root } : undefined);
  say(`report: ${files.md}`);
  for (const c of checks) say(`${c.ok ? 'pass' : 'FAIL'}  ${c.id} ${c.name}: ${c.measured} (limit ${c.limit})`);
  say(report.ok ? 'PASS' : 'FAIL');
  return report;
}

