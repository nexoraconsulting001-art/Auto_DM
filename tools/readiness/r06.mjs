/**
 * R-06 (G-11): two web servers and a worker on the production drivers, behind a small round-robin load balancer.
 *
 *   two_servers_ready           both servers and the worker answer, and the balancer sends requests to them in turn
 *   session_survives_switch     a seller signs in once; their requests alternate between the servers and stay signed in
 *   upload_shows_on_both        an image uploaded through one server is read through the other, and the other way round
 *   scheduled_job_runs_once     a scheduled job started by both servers' schedulers runs once; webhooks sent to both servers
 *                               (and sent again to the other) are each processed once
 *   drain_loses_nothing         one server is stopped while requests and webhooks keep coming: no request fails, the
 *                               session still works, every webhook is processed once
 *
 * The balancer takes each request to the next server in turn: round robin, with no stickiness, so a seller's requests alternate.
 * Everything runs on a database, a bucket and (when REDIS_URL names one) a Redis made for this run, and is removed at the end.
 * With READINESS_ALLOW_SIMPLE_DRIVERS=1 the check may run without Redis (the queue then lives in Postgres and the cache in memory)
 * and without object storage; the report then says `reduced: true` and is not the R-06 proof.
 *
 * The report holds counts, names and ids only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/index.js';
import { createQueue } from '../../src/platform/queue.js';
import { waitDrained } from '../load/verify.mjs';
import { STEPS } from '../prod-checks/steps.mjs';
import { createCleanup } from '../prod-checks/cleanup.mjs';
import { assertLocalServices, makeScrub } from '../prod-checks/guard.mjs';
import { startProxy } from '../prod-checks/proxy.mjs';
import { createReport } from '../prod-checks/report.mjs';
import { claimRedis, provisionBucket, provisionClickhouse, provisionPostgres, s3Settings } from '../prod-checks/services.mjs';
import {
  allLoopback, appEnv, authed, createClient, freePort, lastOutput, multipartFile, pngBytes, rawRequest, runSecrets, seedBusinesses, sha256, signedCommentWebhook,
  signIn, sleep, startRole, startSimulators, waitWeb, waitWorkerUp,
} from '../prod-checks/stack.mjs';

const HOUR = 3_600_000;
const WEBHOOKS = 8;

/** The drivers this run uses, named. Production drivers unless the run is the reduced one. */
export function driversFor(env, reduced) {
  const redis = Boolean(env.REDIS_URL);
  const s3 = Boolean(env.S3_ENDPOINT && env.S3_BUCKET);
  if (!reduced && !(redis && s3)) throw Object.assign(new Error('R-06 needs REDIS_URL, S3_ENDPOINT and S3_BUCKET (set READINESS_ALLOW_SIMPLE_DRIVERS=1 for a reduced run on this machine).'), { code: 'missing_services' });
  return { queue: redis ? 'redis' : 'pg', cache: redis ? 'redis' : 'memory', storage: s3 ? 's3' : 'local', analytics: env.CLICKHOUSE_URL ? 'clickhouse' : 'pg' };
}

const fanOf = (i) => `91${String(700000 + i).padStart(14, '0')}`;

export async function run({ env = process.env, keep = false, log = () => {} } = {}) {
  assertLocalServices(env);
  const reduced = env.READINESS_ALLOW_SIMPLE_DRIVERS === '1';
  const drivers = driversFor(env, reduced);
  // A self-test of the check: on a reduced run, each web server may be given its own file folder, which the check must catch.
  const fault = reduced ? env.READINESS_INJECT_FAULT || '' : '';
  if (fault === 'split-storage') drivers.storage = 'local';
  const scrub = makeScrub(env);
  let scrubNow = scrub;
  const report = createReport('r06', { steps: STEPS.r06, scrub: (t) => scrubNow(t), reduced });
  const cleanup = createCleanup({ keep, log });
  const say = (line) => log(scrub(line));
  const secrets = runSecrets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-r06-'));
  cleanup.add('work folder', () => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { shops: [] };

  try {
    // ---- what this run is made of: fresh database, bucket, analytics database; an empty Redis
    const pg = await provisionPostgres({ adminUrl: env.TEST_DATABASE_URL, cleanup, label: 'r06' });
    const settings = { QUEUE_DRIVER: drivers.queue, CACHE_DRIVER: drivers.cache, ANALYTICS_DRIVER: drivers.analytics };
    let bucket = null;
    if (drivers.queue === 'redis') {
      await claimRedis({ url: env.REDIS_URL, cleanup });
      settings.REDIS_URL = env.REDIS_URL;
    }
    if (drivers.storage === 's3') {
      bucket = await provisionBucket({ env, cleanup, label: 'r06' });
      Object.assign(settings, s3Settings(env, bucket.bucket));
    } else {
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      Object.assign(settings, { STORAGE_DRIVER: 'local', STORAGE_DIR: path.join(dir, 'files') });
    }
    if (drivers.analytics === 'clickhouse') {
      const ch = await provisionClickhouse({ url: env.CLICKHOUSE_URL, cleanup, label: 'r06' });
      Object.assign(settings, { CLICKHOUSE_URL: env.CLICKHOUSE_URL, CLICKHOUSE_DB: ch.database });
    }
    const guard = allLoopback([env.TEST_DATABASE_URL, env.REDIS_URL, env.CLICKHOUSE_URL, env.S3_ENDPOINT]);
    const secretsForScrub = [pg.appPassword, secrets.appSecret, secrets.session, secrets.dataKey, secrets.verifyToken];
    const scrubAll = makeScrub(env, secretsForScrub);
    scrubNow = scrubAll;
    const sayAll = (line) => log(scrubAll(line));

    // ---- ports, the balancer, the simulators, the database
    const [portA, portB, workerPort] = [await freePort(), await freePort(), await freePort()];
    const lb = await startProxy({ upstreams: [portA, portB] });
    cleanup.add('load balancer', () => lb.close());
    const sims = await startSimulators({ cleanup, secrets, webhookUrl: `http://127.0.0.1:${lb.port}/webhook` });
    const db = await openDb({ url: pg.appUrl, ownerUrl: pg.ownerUrl, poolSize: 3 });
    cleanup.add('database handle', () => db.close());

    const envFor = (port, split = false) => {
      const own = split && fault === 'split-storage' ? path.join(dir, `files-${port}`) : null;
      if (own) fs.mkdirSync(own, { recursive: true });
      return appEnv({ ownerUrl: pg.ownerUrl, appUrl: pg.appUrl, port, workerPort, metaUrl: sims.meta.url, razorpay: sims.razorpay, secrets, storageDir: path.join(dir, 'files'), settings: own ? { ...settings, STORAGE_DIR: own } : settings, guard });
    };
    sayAll('R-06: starting two web servers and a worker');
    const serverA = startRole('web', { env: envFor(portA, true), cleanup, label: 'web A' });
    const serverB = startRole('web', { env: envFor(portB, true), cleanup, label: 'web B' });
    const worker = startRole('worker', { env: envFor(await freePort()), cleanup, label: 'worker' });
    const direct = [portA, portB];
    const client = createClient({ port: lb.port, connections: 8 });
    cleanup.add('client', async () => client.close());
    Object.assign(world, { db, meta: sims.meta, razorpay: sims.razorpay, client, secrets, webPort: lb.port, say: () => {} });

    // ---- 1. two_servers_ready
    await report.step('two_servers_ready', async () => {
      try {
        await Promise.all([waitWeb(portA, serverA), waitWeb(portB, serverB), waitWorkerUp(workerPort, worker)]);
      } catch (err) {
        const which = [serverA, serverB, worker].find((n) => n.child.exitCode !== null)?.label;
        throw new Error(`${which ? `${which} stopped while starting` : err.message}: ${lastOutput(worker.child.exitCode !== null ? worker : serverA)}`);
      }
      const served = [];
      for (let i = 0; i < 6; i++) {
        const before = lb.log.length;
        const res = await client.request({ path: '/healthz' });
        if (res.status !== 200) throw new Error(`the load balancer's request ${i + 1} to /healthz answered ${res.status || res.error}`);
        served.push(lb.log[before]?.server);
      }
      const alternates = served.every((s, i) => i === 0 || s !== served[i - 1]) && new Set(served).size === 2;
      if (!alternates) return { problems: [`requests did not alternate between the two servers (went to: ${served.join(',')})`] };
      return `2 web servers and 1 worker answer; requests alternate between the servers; drivers: queue=${drivers.queue} cache=${drivers.cache} storage=${drivers.storage} analytics=${drivers.analytics}${reduced ? ' (reduced run)' : ''}`;
    }, { blocking: true });

    // ---- the seller: one business, made the way a person makes one
    let shop = null;
    let token = null;
    {
      await report.step('session_survives_switch', async () => {
        await seedBusinesses(world, 1);
        [shop] = world.shops;
        const before = lb.log.length;
        token = await signIn(client, shop);
        const problems = [];
        let items = null;
        for (let i = 0; i < 12; i++) {
          const res = await client.request({ path: '/api/v1/products', host: shop.host, headers: authed(token) });
          if (res.status !== 200) {
            problems.push(`request ${i + 1} through the balancer answered ${res.status || res.error} (signed-in seller, server ${lb.log.at(-1)?.server === 0 ? 'A' : 'B'})`);
            continue;
          }
          const n = JSON.parse(res.text).items?.length;
          if (items === null) items = n;
          else if (n !== items) problems.push(`request ${i + 1} saw ${n} products where the first saw ${items}`);
        }
        const servers = new Set(lb.log.slice(before).map((r) => r.server));
        if (servers.size < 2) problems.push(`the requests did not reach both servers (reached: ${[...servers].join(',')})`);
        // The token is checked on each server on its own, with no balancer between.
        for (const [name, port] of [['A', portA], ['B', portB]]) {
          const res = await rawRequest({ port, path: '/api/v1/products', host: shop.host, headers: authed(token) });
          if (res.status !== 200) problems.push(`server ${name} on its own answered ${res.status || res.error} to a session the other server made`);
        }
        if (problems.length) return { problems };
        return `signed in once; 12 requests alternated across both servers and stayed signed in; the session also works on each server on its own (${items} products seen each time)`;
      });
    }

    // ---- 3. upload_shows_on_both
    await report.step('upload_shows_on_both', async () => {
      if (!shop) throw new Error('no seller to upload as');
      const problems = [];
      const before = bucket ? (await bucket.keys()).length : null;
      let made = 0;
      for (const [from, to] of [[0, 1], [1, 0]]) {
        const bytes = await pngBytes();
        const form = multipartFile({ bytes });
        const up = await rawRequest({ port: direct[from], method: 'POST', path: '/api/v1/media', host: shop.host, headers: { ...authed(token), 'content-type': form.contentType }, body: form.body });
        const name = ['A', 'B'];
        if (up.status !== 201) {
          problems.push(`upload through server ${name[from]} answered ${up.status || up.error}`);
          continue;
        }
        made++;
        const { id } = JSON.parse(up.body.toString('utf8'));
        const here = await rawRequest({ port: direct[from], path: `/media/${id}`, host: shop.host });
        const there = await rawRequest({ port: direct[to], path: `/media/${id}`, host: shop.host });
        const viaLb = await client.request({ path: `/media/${id}`, host: shop.host });
        if (there.status !== 200) problems.push(`an image uploaded through server ${name[from]} answered ${there.status || there.error} on server ${name[to]}`);
        else if (here.status !== 200) problems.push(`an image uploaded through server ${name[from]} answered ${here.status || here.error} on the same server`);
        else if (sha256(there.body) !== sha256(here.body)) problems.push(`the image read on server ${name[to]} is not the one read on server ${name[from]}`);
        else if (!String(there.headers['content-type'] ?? '').startsWith('image/')) problems.push(`the image on server ${name[to]} came back as ${there.headers['content-type'] ?? 'no type'}`);
        if (viaLb.status !== 200) problems.push(`the image answered ${viaLb.status || viaLb.error} through the balancer`);
      }
      if (bucket && made) {
        const after = (await bucket.keys()).length;
        if (after - before < made) problems.push(`object storage holds ${after - before} new files for ${made} uploads`);
      }
      return problems.length ? { problems } : `an image uploaded on each server was read, byte for byte, on the other${bucket ? ' and is in object storage' : ''}`;
    });

    // ---- 4. scheduled_job_runs_once (and webhooks processed once)
    const probeQueue = `readiness.probe.${crypto.randomBytes(4).toString('hex')}`;
    const queueConfig = { queueDriver: drivers.queue, redisUrl: drivers.queue === 'redis' ? env.REDIS_URL : undefined, queuePollMs: 200 };
    const nodes = ['A', 'B'].map((name) => ({ name, queue: createQueue(queueConfig, { db }) }));
    for (const n of nodes) cleanup.add(`scheduler ${n.name}`, () => n.queue.close());
    await db.platform.exec('CREATE TABLE IF NOT EXISTS readiness_probe_runs (id bigserial PRIMARY KEY, queue text NOT NULL, node text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now())');
    for (const n of nodes) n.queue.work(probeQueue, async () => { await db.platform.query('INSERT INTO readiness_probe_runs (queue, node) VALUES ($1, $2)', [probeQueue, n.name]); });
    const probeRuns = async (queue = probeQueue) => (await db.platform.query('SELECT node FROM readiness_probe_runs WHERE queue = $1', [queue])).map((r) => r.node);

    const sendHook = async (i, { again = 'other' } = {}) => {
      const id = `c${crypto.randomBytes(5).toString('hex')}${i}`;
      const fan = fanOf(i);
      await sims.meta.post('/comments', { igUserId: shop.igUserId, mediaId: shop.reelId, id, from: { id: fan, username: `fan_${fan.slice(-6)}` }, text: 'price please', deliver: false });
      const hook = signedCommentWebhook({ shop, id, fan, secret: secrets.appSecret });
      const post = (send) => send({ method: 'POST', path: '/webhook', headers: hook.headers, body: hook.raw });
      const mark = lb.log.length;
      const first = await post((r) => client.request(r));
      // Meta sends a webhook again when it is unsure it arrived: the same bytes, here to the other server (or, while one is stopped, through the balancer).
      const servedBy = lb.log[mark]?.server;
      const second = again === 'other' && servedBy !== undefined ? await post((r) => rawRequest({ port: direct[1 - servedBy], ...r })) : await post((r) => client.request(r));
      return { id, ok: first.status === 200 && second.status === 200 };
    };
    const webhookProblems = async (ids) => {
      const problems = [];
      const drained = await waitDrained(world, { ms: 60_000, sends: false });
      if (!drained) problems.push('webhooks were still waiting to be processed after 60 s');
      const rows = await db.platform.query(`SELECT object_id, status, count(*)::int AS n FROM inbound_events WHERE tenant_id = $1 AND object_id = ANY($2::text[]) GROUP BY object_id, status`, [shop.tenantId, ids]);
      const by = new Map();
      for (const r of rows) by.set(r.object_id, [...(by.get(r.object_id) ?? []), r]);
      for (const id of ids) {
        const got = by.get(id) ?? [];
        const total = got.reduce((s, r) => s + r.n, 0);
        if (total === 0) problems.push(`webhook ${id} was answered 200 but never stored`);
        else if (total > 1) problems.push(`webhook ${id} was stored ${total} times`);
        else if (got[0].status !== 'done') problems.push(`webhook ${id} ended as ${got[0].status}, not done`);
      }
      await waitDrained(world, { ms: 25_000, sends: true });
      const { sent } = await sims.meta.get('/sent');
      const per = new Map();
      for (const m of sent) if (m.commentId && ids.includes(m.commentId)) per.set(m.commentId, (per.get(m.commentId) ?? 0) + 1);
      for (const [id, n] of per) if (n > 1) problems.push(`the reply to comment ${id} was sent ${n} times`);
      return problems;
    };

    await report.step('scheduled_job_runs_once', async () => {
      const problems = [];
      // The slot a job belongs to is the hour: do not start in the last 90 seconds of one, or the job may run in two slots.
      const toBoundary = HOUR - (Date.now() % HOUR);
      if (toBoundary < 90_000) await sleep(toBoundary + 1000);
      const slot = Math.floor(Date.now() / HOUR);
      const realBefore = drivers.queue === 'pg' ? await db.platform.query(`SELECT count(*)::int AS n FROM jobs WHERE queue = 'system.housekeeping' AND status = 'done'`) : null;
      await Promise.all(Array.from({ length: 12 }, (_, i) => nodes[i % 2].queue.every(probeQueue, HOUR)));
      const end = Date.now() + 20_000;
      while ((await probeRuns()).length === 0 && Date.now() < end) await sleep(250);
      await sleep(2500);
      const ran = await probeRuns();
      if (ran.length === 0) problems.push('the scheduled job started by both servers never ran');
      else if (ran.length > 1) problems.push(`the scheduled job ran ${ran.length} times in one hour (on ${[...new Set(ran)].map((n) => `node ${n}`).join(' and ')}), not once`);
      if (realBefore && Math.floor(Date.now() / HOUR) === slot) {
        const [{ n }] = await db.platform.query(`SELECT count(*)::int AS n FROM jobs WHERE queue = 'system.housekeeping' AND status = 'done'`);
        if (n > 1) problems.push(`the worker's housekeeping job ran ${n} times in one hour, not once`);
      }
      // Webhooks: each one goes to a server through the balancer and is sent again, as Meta does, to the other server.
      const sent = [];
      for (let i = 0; i < WEBHOOKS; i++) sent.push(await sendHook(i));
      for (const s of sent) if (!s.ok) problems.push(`webhook ${s.id} was not answered 200 by both servers`);
      problems.push(...await webhookProblems(sent.map((s) => s.id)));
      return problems.length ? { problems } : `the scheduled job started by both servers ran once; ${WEBHOOKS} webhooks, each sent to both servers, were stored and processed once and no reply went out twice`;
    });

    // ---- 5. drain_loses_nothing
    await report.step('drain_loses_nothing', async () => {
      const problems = [];
      const results = { gets: 0, getFailures: [], hooks: [], hookFailures: [] };
      let stopLoad = false;
      const getLoop = (async () => {
        while (!stopLoad) {
          const res = await client.request({ path: '/api/v1/products', host: shop.host, headers: authed(token) });
          results.gets++;
          if (res.status !== 200) results.getFailures.push(res.status || res.error);
          await sleep(25);
        }
      })();
      let hookIndex = 100;
      const hookLoop = (async () => {
        while (!stopLoad) {
          const r = await sendHook(hookIndex++, { again: 'lb' });
          results.hooks.push(r.id);
          if (!r.ok) results.hookFailures.push(r.id);
          await sleep(200);
        }
      })();
      await sleep(2500);
      const beforeStop = lb.counts();
      if (process.platform === 'win32') {
        // Windows cannot send a graceful stop: take the server out of the rotation first, as a deploy does, and let its work end.
        lb.down(0);
        await sleep(600);
      }
      const stoppedAt = Date.now();
      const exit = await serverA.stop();
      const exitMs = Date.now() - stoppedAt;
      await sleep(3000);
      stopLoad = true;
      await Promise.all([getLoop, hookLoop]);
      if (results.getFailures.length) problems.push(`${results.getFailures.length} of ${results.gets} requests failed while server A stopped (${[...new Set(results.getFailures)].join(', ')})`);
      if (results.hookFailures.length) problems.push(`${results.hookFailures.length} of ${results.hooks.length} webhooks were not answered 200 while server A stopped`);
      if (lb.failures().length) problems.push(`the balancer could not answer ${lb.failures().length} requests (${[...new Set(lb.failures().map((f) => f.reason))].join(', ')})`);
      if (exit.code !== 0 && process.platform !== 'win32') problems.push(`server A stopped with exit code ${exit.code ?? exit.signal}, not 0`);
      // The session and the work carry on, on the server that is left.
      const afterCounts = lb.counts();
      const res = await client.request({ path: '/api/v1/products', host: shop.host, headers: authed(token) });
      if (res.status !== 200) problems.push(`after server A stopped the seller's session answered ${res.status || res.error}`);
      if (lb.log.at(-1)?.server !== 1) problems.push('the request after the stop did not go to server B');
      problems.push(...await webhookProblems(results.hooks));
      const probe2 = `${probeQueue}.after`;
      nodes[1].queue.work(probe2, async () => { await db.platform.query('INSERT INTO readiness_probe_runs (queue, node) VALUES ($1, $2)', [probe2, 'B']); });
      await nodes[1].queue.every(probe2, HOUR);
      const end = Date.now() + 20_000;
      while ((await probeRuns(probe2)).length === 0 && Date.now() < end) await sleep(250);
      await sleep(1500);
      const ranAfter = (await probeRuns(probe2)).length;
      if (ranAfter !== 1) problems.push(`a job started after server A stopped ran ${ranAfter} times, not once`);
      if (worker.child.exitCode !== null) problems.push('the worker stopped when server A stopped');
      return problems.length ? { problems } : `server A stopped in ${exitMs} ms (exit ${exit.code ?? exit.signal}) with ${results.gets} requests and ${results.hooks.length} webhooks in flight: none failed, server B took over (A answered ${beforeStop[0]} requests before, B ${afterCounts[1] - beforeStop[1]} after), the session still works and every webhook was processed once`;
    });
  } catch (err) {
    // A start-up failure before the steps could run: every step not yet judged fails with the reason.
    for (const name of STEPS.r06) if (!report.has(name)) report.fail(name, `not run: ${String(err.message).split('\n')[0]}`);
  } finally {
    const failed = await cleanup.run();
    cleanup.dispose();
    if (failed.length) say(`could not remove: ${failed.join(', ')}`);
  }
  const out = report.finish();
  return out;
}
