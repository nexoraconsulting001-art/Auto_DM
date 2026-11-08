import os from 'node:os';
import { withTenant } from '../tenancy.js';

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
 *   stats() -> { [queue]: { queued, running, failed, unknown } }      close()
 */
export function createQueue(config = {}, { db } = {}) {
  const driver = config.queueDriver || 'pg';
  if (driver === 'pg') return pgQueue(db, config);
  if (driver === 'redis') return redisQueue(config);
  throw new Error(`Unknown QUEUE_DRIVER "${driver}" (use pg or redis)`);
}

export const backoffMs = (attempt) => Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1)); // 1s, 2s, 4s … max 1h

const workerId = () => `${os.hostname()}:${process.pid}`;

async function runHandler(handler, job) {
  return job.tenantId ? withTenant(job.tenantId, () => handler(job)) : handler(job);
}

function pgQueue(db, config) {
  if (!db) throw new Error('The pg queue needs the database');
  const pollMs = config.queuePollMs ?? 500;
  const leaseMs = config.queueLeaseMs ?? 5 * 60_000;
  const loops = [];
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
          await runHandler(handler, job);
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
            console.error(`queue ${queue}: ${err.message}`);
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
    async stats() {
      const rows = await db.query(
        `SELECT queue, status, count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running', 'failed', 'unknown') GROUP BY queue, status`,
      );
      const out = {};
      for (const r of rows) (out[r.queue] ??= { queued: 0, running: 0, failed: 0, unknown: 0 })[r.status] = r.n;
      return out;
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

function redisQueue(config) {
  if (!config.redisUrl) throw new Error('REDIS_URL is required when QUEUE_DRIVER=redis');
  let libPromise;
  const lib = () => (libPromise ??= import('bullmq'));
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
      const q = await queueFor(queue);
      const jobId = dedupeKey ? String(dedupeKey).replace(/:/g, '_') : undefined; // BullMQ ids can't contain ':'
      if (jobId && (await q.getJob(jobId))) return null;
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
        const worker = new Worker(queue, async (bjob) => {
          // A job started before but never finished means its worker died mid-run. Unless it is
          // safe to repeat, it ends as 'unknown' instead of running again (same rule as the pg driver).
          if (!bjob.data.retryInFlight && (bjob.attemptsStarted ?? 0) > (bjob.attemptsMade ?? 0) + 1) {
            throw new UnrecoverableError('unknown: worker stopped while running');
          }
          const job = { id: String(bjob.id), queue, tenantId: bjob.data.tenantId, payload: bjob.data.payload, attempt: bjob.attemptsMade + 1 };
          return runHandler(handler, job);
        }, { connection: connection(), concurrency, maxStalledCount: 1 });
        worker.on('error', (err) => console.error(`queue ${queue}: ${err.message}`));
        workers.push(worker);
      })();
      start.catch((err) => console.error(`queue ${queue} failed to start: ${err.message}`));
    },
    async every(queue, intervalMs, payload = {}) {
      const slot = Math.floor(Date.now() / intervalMs);
      return this.enqueue(queue, payload, { dedupeKey: `every-${slot}`, retryInFlight: true });
    },
    async stats() {
      const out = {};
      for (const [name, q] of queues) {
        const c = await q.getJobCounts('waiting', 'delayed', 'active', 'failed');
        const unknown = (await q.getFailed(0, 1000)).filter((j) => /^unknown:/.test(j.failedReason || '')).length;
        out[name] = { queued: c.waiting + c.delayed, running: c.active, failed: c.failed - unknown, unknown };
      }
      return out;
    },
    async cleanup() {},
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}
