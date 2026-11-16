import os from 'node:os';
import { withTenant } from '../tenancy.js';
import { reportError } from './log.js';

/**
 * Background jobs. One interface, two drivers (QUEUE_DRIVER):
 *   pg     the `jobs` table in Postgres (QA)
 *   redis  BullMQ on Redis (production)
 *
 *   enqueue(queue, payload, { tenantId, delayMs, dedupeKey, maxAttempts, retryInFlight }) -> id | null
 *       dedupeKey: a second job with the same key in the same queue is dropped (returns null).
 *       retryInFlight: false (default) means a job running when its worker died is marked
 *       'unknown' and never run again, because its side effect (a DM) may already have happened.
 *   work(queue, handler, { concurrency }) starts processing; handler(job) runs as job.tenantId's business.
 *       Throw to retry with backoff, up to maxAttempts.
 *   every(queue, intervalMs, payload) enqueues one job per interval, however many servers call it.
 *   stats() -> { [queue]: { queued, delayed, running, failed, unknown } } for every queue any process has used:
 *       queued is ready to run now, delayed waits for its time (a delay or a retry's backoff).
 *   oldestWaiting() -> { [queue]: seconds } how long the oldest ready job of each queue has waited (queues with one only).
 *   onRun(listener) listener({ queue, result: 'ok' | 'failed' }) after every run of a job in this process (metrics).
 *   close()
 * A job that throws is reported (reportError 'job.failed') by the one run path both drivers share (runJob).
 */
export function createQueue(config = {}, { db, bullmq, redis } = {}) {
  const driver = config.queueDriver || 'pg';
  if (driver === 'pg') return pgQueue(db?.platform ?? db, config); // the queue serves every business from one table
  if (driver === 'redis') return redisQueue(config, { bullmq, redis }); // bullmq and redis: stand-ins for the tests
  throw new Error(`Unknown QUEUE_DRIVER "${driver}" (use pg or redis)`);
}

export const backoffMs = (attempt) => Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1)); // 1s, 2s, 4s … max 1h

const workerId = () => `${os.hostname()}:${process.pid}`;

/** One report for a job that threw, in both drivers (the log scrubs the message): final is true when no retry follows. */
function reportJobFailure(err, { queue, attempt, maxAttempts, final }) {
  reportError(err, { msg: 'job.failed', queue, attempt, final: final ?? attempt >= maxAttempts });
}

async function runHandler(handler, job) {
  return job.tenantId ? withTenant(job.tenantId, () => handler(job)) : handler(job);
}

/** The listeners of onRun(): one that throws is reported and never changes how the job ended. */
function runListeners() {
  const listeners = [];
  return {
    add: (fn) => listeners.push(fn),
    emit(event) {
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          reportError(err, { msg: 'queue.listener_failed', queue: event.queue });
        }
      }
    },
  };
}

/** Runs one job in either driver: tells the onRun listeners how it ended and reports a job that throws, then rethrows it. */
async function runJob(listeners, handler, job, { maxAttempts }) {
  try {
    const out = await runHandler(handler, job);
    listeners.emit({ queue: job.queue, result: 'ok' });
    return out;
  } catch (err) {
    listeners.emit({ queue: job.queue, result: 'failed' });
    reportJobFailure(err, { queue: job.queue, attempt: job.attempt, maxAttempts, final: err?.name === 'UnrecoverableError' ? true : undefined });
    throw err;
  }
}

function pgQueue(db, config) {
  if (!db) throw new Error('The pg queue needs the database');
  const pollMs = config.queuePollMs ?? 500;
  const leaseMs = config.queueLeaseMs ?? 5 * 60_000;
  const loops = [];
  const listeners = runListeners();
  let closed = false;

  /** Running jobs whose worker stopped renewing them: rerun if safe, otherwise mark unknown. */
  async function recoverStale() {
    await db.query(
      `UPDATE jobs SET status = CASE WHEN retry_in_flight AND attempts < max_attempts THEN 'queued' ELSE 'unknown' END,
         last_error = 'worker stopped while running', locked_by = NULL, lease_until = NULL,
         finished_at = CASE WHEN retry_in_flight AND attempts < max_attempts THEN NULL ELSE now() END
       WHERE status = 'running' AND lease_until < now()`,
    );
  }

  async function claim(queue, n) {
    return db.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $3,
         lease_until = now() + make_interval(secs => $4::float / 1000)
       WHERE id IN (
         SELECT id FROM jobs WHERE queue = $1 AND status = 'queued' AND run_at <= now()
         ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT $2)
       RETURNING id, queue, tenant_id, payload, attempts, max_attempts`,
      [queue, n, workerId(), leaseMs],
    );
  }

  async function finish(row, err) {
    if (!err) {
      await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), lease_until = NULL WHERE id = $1`, [row.id]);
      return;
    }
    const retry = row.attempts < row.max_attempts;
    await db.query(
      `UPDATE jobs SET status = $2, last_error = $3, lease_until = NULL, locked_by = NULL,
         run_at = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4::float / 1000) ELSE run_at END,
         finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
       WHERE id = $1`,
      [row.id, retry ? 'queued' : 'failed', String(err?.message || err).slice(0, 1000), backoffMs(row.attempts)],
    );
  }

  return {
    driver: 'pg',
    recoverStale,
    async enqueue(queue, payload = {}, { tenantId = null, delayMs = 0, dedupeKey = null, maxAttempts = 5, retryInFlight = false } = {}) {
      const [row] = await db.query(
        `INSERT INTO jobs (queue, tenant_id, payload, run_at, dedupe_key, max_attempts, retry_in_flight)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4::float / 1000), $5, $6, $7)
         ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [queue, tenantId, JSON.stringify(payload), delayMs, dedupeKey, maxAttempts, retryInFlight],
      );
      return row ? String(row.id) : null;
    },
    /** Runs ready jobs once (also used by tests). Returns how many ran. */
    async drain(queue, handler, { limit = 100 } = {}) {
      await recoverStale();
      const rows = await claim(queue, limit);
      for (const row of rows) {
        const job = { id: String(row.id), queue, tenantId: row.tenant_id, payload: row.payload, attempt: row.attempts };
        try {
          await runJob(listeners, handler, job, { maxAttempts: row.max_attempts });
          await finish(row);
        } catch (err) {
          await finish(row, err);
        }
      }
      return rows.length;
    },
    work(queue, handler, { concurrency = 1 } = {}) {
      const loop = async () => {
        while (!closed) {
          let ran = 0;
          try {
            ran = await this.drain(queue, handler, { limit: concurrency });
          } catch (err) {
            reportError(err, { msg: 'queue.poll_failed', queue });
          }
          if (!ran && !closed) await new Promise((r) => setTimeout(r, pollMs));
        }
      };
      loops.push(loop());
    },
    async every(queue, intervalMs, payload = {}) {
      const slot = Math.floor(Date.now() / intervalMs);
      return this.enqueue(queue, payload, { dedupeKey: `every:${slot}`, retryInFlight: true });
    },
    onRun: (fn) => listeners.add(fn),
    async stats() {
      const rows = await db.query(
        `SELECT queue, CASE WHEN status = 'queued' AND run_at > now() THEN 'delayed' ELSE status END AS status, count(*)::int AS n
           FROM jobs WHERE status IN ('queued', 'running', 'failed', 'unknown') GROUP BY 1, 2`,
      );
      const out = {};
      for (const r of rows) (out[r.queue] ??= emptyCounts())[r.status] = r.n;
      return out;
    },
    async oldestWaiting() {
      const rows = await db.query(
        `SELECT queue, extract(epoch FROM now() - min(run_at))::float AS age FROM jobs WHERE status = 'queued' AND run_at <= now() GROUP BY queue`,
      );
      return Object.fromEntries(rows.map((r) => [r.queue, Math.max(0, Number(r.age))]));
    },
    /** Deletes finished jobs older than `days`. */
    async cleanup(days = 14) {
      await db.query(`DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - make_interval(days => $1)`, [days]);
    },
    async close() {
      closed = true;
      await Promise.all(loops);
    },
  };
}

const emptyCounts = () => ({ queued: 0, delayed: 0, running: 0, failed: 0, unknown: 0 });

/** The Redis set of every queue name any process has worked or enqueued to, so the web process's stats see the worker's queues. */
export const QUEUE_REGISTRY_KEY = 'bhava:queues';

/** When a BullMQ job became ready: its creation plus its first delay, or the start of its last attempt when it is a retry. */
export const readyAt = (job) => Math.max(Number(job.timestamp) + Number(job.opts?.delay ?? 0), Number(job.processedOn ?? 0));

function redisQueue(config, injected = {}) {
  if (!config.redisUrl) throw new Error('REDIS_URL is required when QUEUE_DRIVER=redis');
  let libPromise;
  const lib = () => (libPromise ??= injected.bullmq ? Promise.resolve(injected.bullmq) : import('bullmq'));
  const connection = () => {
    const u = new URL(config.redisUrl);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      username: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      tls: u.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  };
  const queues = new Map();
  const workers = [];
  const listeners = runListeners();
  let registryClient;
  const registry = () => (registryClient ??= injected.redis
    ? Promise.resolve(injected.redis)
    : import('ioredis').then(({ default: Redis }) => new Redis(connection())));
  const registered = new Set();
  async function register(name) {
    if (registered.has(name)) return;
    await (await registry()).sadd(QUEUE_REGISTRY_KEY, name);
    registered.add(name);
  }
  /** Every queue name in the registry and this process's own, sorted. */
  async function names() {
    const listed = await (await registry()).smembers(QUEUE_REGISTRY_KEY);
    return [...new Set([...listed, ...registered])].sort();
  }
  async function queueFor(name) {
    if (!queues.has(name)) {
      const { Queue } = await lib();
      queues.set(name, new Queue(name, { connection: connection() }));
    }
    return queues.get(name);
  }

  return {
    driver: 'redis',
    async enqueue(queue, payload = {}, { tenantId = null, delayMs = 0, dedupeKey = null, maxAttempts = 5, retryInFlight = false } = {}) {
      await register(queue);
      const q = await queueFor(queue);
      const jobId = dedupeKey ? String(dedupeKey).replace(/:/g, '_') : undefined; // BullMQ ids can't contain ':'
      if (jobId) {
        const client = await q.client;
        const first = await client.set(`bhava:dedupe:${queue}:${jobId}`, '1', 'EX', 30 * 86_400, 'NX');
        if (!first) return null;
      }
      const job = await q.add(queue, { payload, tenantId, retryInFlight }, {
        jobId,
        delay: delayMs,
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 14 * 86_400 },
        removeOnFail: false,
      });
      return String(job.id);
    },
    work(queue, handler, { concurrency = 1 } = {}) {
      const start = (async () => {
        const { Worker, UnrecoverableError } = await lib();
        await register(queue);
        const worker = new Worker(queue, async (bjob) => {
          // A job started before but never finished means its worker died mid-run. Unless it is
          // safe to repeat, it ends as 'unknown' instead of running again (same rule as the pg driver).
          if (!bjob.data.retryInFlight && (bjob.attemptsStarted ?? 0) > (bjob.attemptsMade ?? 0) + 1) {
            throw new UnrecoverableError('unknown: worker stopped while running');
          }
          const job = { id: String(bjob.id), queue, tenantId: bjob.data.tenantId, payload: bjob.data.payload, attempt: (bjob.attemptsMade ?? 0) + 1 };
          return runJob(listeners, handler, job, { maxAttempts: bjob.opts?.attempts ?? 1 });
        }, { connection: connection(), concurrency, maxStalledCount: 1 });
        worker.on('error', (err) => reportError(err, { msg: 'queue.worker_error', queue }));
        workers.push(worker);
      })();
      start.catch((err) => reportError(err, { msg: 'queue.failed_to_start', queue }));
    },
    async every(queue, intervalMs, payload = {}) {
      const slot = Math.floor(Date.now() / intervalMs);
      return this.enqueue(queue, payload, { dedupeKey: `every-${slot}`, retryInFlight: true });
    },
    onRun: (fn) => listeners.add(fn),
    async stats() {
      const out = {};
      for (const name of await names()) {
        const q = await queueFor(name);
        const c = await q.getJobCounts('waiting', 'delayed', 'active', 'failed');
        const unknown = c.failed ? (await q.getFailed(0, 1000)).filter((j) => /^unknown:/.test(j?.failedReason || '')).length : 0;
        out[name] = { queued: c.waiting, delayed: c.delayed, running: c.active, failed: c.failed - unknown, unknown };
      }
      return out;
    },
    async oldestWaiting() {
      const out = {};
      const now = Date.now();
      for (const name of await names()) {
        const [oldest] = (await (await queueFor(name)).getWaiting(0, 0)).filter(Boolean); // BullMQ lists the oldest first here
        if (oldest) out[name] = Math.max(0, (now - readyAt(oldest)) / 1000);
      }
      return out;
    },
    async cleanup() {},
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      if (registryClient && !injected.redis) await (await registryClient).quit();
    },
  };
}
