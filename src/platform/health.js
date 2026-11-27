import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Liveness, readiness, startup and shutdown for both processes (Phase 9; G-02, G-03). createPlatform() makes one, so it
 * is `ctx.platform.health` everywhere; src/server.js and src/worker.js serve it and drain through it.
 *
 *   live()                    -> { ok: true }. The process is up. Never looks at a dependency, so it stays true when one is down.
 *   await ready()             -> { ok, draining, checks: { database: 'up', migrations: 'up', queue: 'up', storage: 'up', cache: 'up' } }
 *   await startup()           -> { ok }. True once markStarted() was called and the first readiness passed.
 *   markStarted()             the process finished starting (it is listening, its jobs are registered)
 *   check(name, fn)           sets or replaces a dependency check: async () => 'up' | 'down' | 'behind' | 'unchecked'
 *   onDrain(name, fn)         a step of shutting down, run in the order added: stop taking work, finish what is in flight, close
 *   await drain({ deadlineMs }) -> { ok, timedOut, steps: [{ name, ok, ms }] }. Readiness is false from the moment it is called.
 *   serve(req, res)           answers /healthz, /health, /readyz and /startupz on a node:http server; false for any other path
 *   middleware()              Express middleware: counts the requests in flight and, once draining, refuses new ones (503,
 *                             Connection: close) while those in flight finish; probes pass through
 *   inFlight, idle()          how many requests are in flight, and a promise for the moment none is
 *
 * A state is one word. Nothing a check throws, and no address, driver error, business or setting, reaches an answer:
 * a check that throws or takes longer than HEALTH_CHECK_MS is `down`. `behind` is migrations only: the code knows a
 * migration the database has not run. `unchecked` does not fail readiness; it is what a dependency with no check answers.
 * Every readiness call runs the checks again, so a dependency that comes back turns readiness true by itself.
 *
 * The built-in checks: the database (both logins), the migrations, the queue (its stats, and on Redis its own
 * connection, pinged), storage (a probe object written and read back; on S3 a read of it, so no request writes) and the
 * cache (a read). On drain, when the deadline passes with jobs of this worker still claimed in the pg queue, they are
 * released by the queue's own rule: a job marked safe to repeat goes back to the queue (a few seconds later, after this
 * process is gone), every other one is marked `unknown` and never runs again, so nothing runs twice.
 */
export const HEALTH_DEPENDENCIES = Object.freeze(['database', 'migrations', 'queue', 'storage', 'cache']);
export const HEALTH_STATES = Object.freeze(['up', 'down', 'behind', 'unchecked']);
export const HEALTH_PATHS = Object.freeze({ live: '/healthz', ready: '/readyz', startup: '/startupz' });
const PROBE_PATHS = new Set([HEALTH_PATHS.live, HEALTH_PATHS.ready, HEALTH_PATHS.startup, '/health']);
const FAILING = new Set(['down', 'behind']);
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
/** The storage object readiness writes and reads. It belongs to no business. */
export const STORAGE_PROBE_KEY = 'health/probe';
/** How long the release of claimed jobs may take once the drain deadline has passed. */
const RELEASE_MS = 2000;
/** A released job that is safe to repeat waits this long, so it never runs beside the copy this process is ending. */
const RELEASE_DELAY_MS = 5000;

/** The migration numbers this build knows, from the files it ships. */
export function knownMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
}

/** The id the pg queue writes into jobs.locked_by for this process (src/platform/queue.js). */
export const queueWorkerId = () => `${os.hostname()}:${process.pid}`;

const within = (ms, work) => {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(timer));
};

/**
 * A Redis client for the queue's ping: fails at once while disconnected (no offline queue) and reconnects by itself.
 * It is handed out only once its first connection attempt has ended (made or refused): with no offline queue, a ping sent
 * while that first connection is still being made is refused at once, so every process's first readiness answer said the
 * queue was down although Redis was up (R5-PP-1).
 */
async function defaultRedis(url) {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000, retryStrategy: (n) => Math.min(200 * n, 2000) });
  // ioredis prints an unhandled error event with the address; the check's answer is all anyone needs.
  client.on('error', () => {});
  // The probe's connection never holds a process open on its own (a test, a tool).
  client.on('connect', () => client.stream?.unref?.());
  // A refused first attempt is answered by the ping ('down'); ioredis goes on reconnecting by its retry strategy.
  await client.connect().catch(() => {});
  return client;
}

/**
 * @param {object} [options]
 * @param {object} [options.redis] a client with ping() and disconnect() for the queue's Redis (tests); made from REDIS_URL otherwise
 * @param {string} [options.workerId] the pg queue's id for this process, whose claimed jobs a timed-out drain releases
 */
export function createHealth({ db = null, platform = {}, config = {}, migrations = knownMigrations, redis = null, workerId = queueWorkerId() } = {}) {
  const checkMs = Number(config.healthCheckMs) > 0 ? Number(config.healthCheckMs) : 2000;
  const checks = new Map(HEALTH_DEPENDENCIES.map((name) => [name, async () => 'unchecked']));
  const drainSteps = [];
  const open = new Set();
  let idleWaiters = [];
  let started = false;
  let startedOk = false;
  let draining = false;
  let known = null;
  let redisClient = null;
  const owner = db ? db.platform ?? db : null;

  if (db) {
    checks.set('database', async () => {
      await owner.query('SELECT 1');
      if (owner !== db) await db.query('SELECT 1');
      return 'up';
    });
    checks.set('migrations', async () => {
      known ??= migrations();
      const rows = await owner.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => String(r.version)));
      return known.every((version) => applied.has(version)) ? 'up' : 'behind';
    });
  }
  const queue = platform.queue;
  const redisUrl = config.redisUrl;
  if (queue?.stats) {
    checks.set('queue', async () => {
      if (queue.driver === 'redis' && (redis || redisUrl)) {
        redisClient ??= redis ? Promise.resolve(redis) : defaultRedis(redisUrl);
        const pong = await (await redisClient).ping();
        if (String(pong).toUpperCase() !== 'PONG') return 'down';
      }
      await queue.stats();
      return 'up';
    });
  }
  const storage = platform.storage;
  if (storage?.get) {
    checks.set('storage', async () => {
      if (storage.driver === 's3' || !storage.put) {
        // A read: answers null for a missing object, and throws when the bucket or its credentials are wrong.
        await storage.get(STORAGE_PROBE_KEY);
        return 'up';
      }
      const mark = `${process.pid}:${Date.now()}`;
      await storage.put(STORAGE_PROBE_KEY, Buffer.from(mark), 'text/plain');
      const back = await storage.get(STORAGE_PROBE_KEY);
      // Another process may have written its own mark in between; an answer at all is what proves the disk.
      return back && back.length ? 'up' : 'down';
    });
  }
  if (platform.cache?.get) {
    checks.set('cache', async () => {
      await platform.cache.get('health:probe');
      return 'up';
    });
  }

  async function runCheck(name) {
    try {
      const state = await within(checkMs, checks.get(name));
      return HEALTH_STATES.includes(state) ? state : 'down';
    } catch {
      return 'down';
    }
  }

  async function ready() {
    const names = [...checks.keys()];
    const states = await Promise.all(names.map(runCheck));
    const result = Object.fromEntries(names.map((name, i) => [name, states[i]]));
    const ok = !draining && !states.some((state) => FAILING.has(state));
    if (ok && started) startedOk = true;
    return { ok, draining, checks: result };
  }

  const settleIdle = () => {
    if (open.size) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  };

  /** Jobs this process still holds in the pg queue, released by the queue's rule. Answers how many. */
  async function releaseJobs() {
    if (!owner || !queue || queue.driver !== 'pg') return 0;
    const rows = await owner.query(
      `UPDATE jobs SET
         status = CASE WHEN retry_in_flight AND attempts < max_attempts THEN 'queued' ELSE 'unknown' END,
         run_at = CASE WHEN retry_in_flight AND attempts < max_attempts THEN now() + make_interval(secs => $2::float / 1000) ELSE run_at END,
         finished_at = CASE WHEN retry_in_flight AND attempts < max_attempts THEN NULL ELSE now() END,
         last_error = 'worker stopped while running', locked_by = NULL, lease_until = NULL
       WHERE status = 'running' AND locked_by = $1
       RETURNING id`,
      [workerId, RELEASE_DELAY_MS],
    );
    return rows.length;
  }

  async function closeOwn() {
    const client = redisClient;
    redisClient = null;
    if (client) await Promise.resolve(client).then((c) => c.disconnect?.()).catch(() => {});
  }

  const health = {
    live: () => ({ ok: true }),
    ready,
    async startup() {
      if (!started) return { ok: false };
      if (!startedOk) await ready();
      return { ok: startedOk };
    },
    markStarted() {
      started = true;
    },
    check(name, fn) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) throw new Error(`"${name}" is not a dependency name`);
      if (typeof fn !== 'function') throw new Error('A health check is a function');
      checks.set(name, fn);
    },
    onDrain(name, fn) {
      drainSteps.push({ name, fn });
    },
    get draining() {
      return draining;
    },
    get inFlight() {
      return open.size;
    },
    /** Resolves once no request is in flight (at once when none is). */
    idle() {
      if (!open.size) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    middleware() {
      return (req, res, next) => {
        const url = String(req.path ?? req.url ?? '').split('?')[0];
        if (PROBE_PATHS.has(url)) return next();
        if (draining) {
          res.statusCode = 503;
          res.setHeader('Connection', 'close');
          res.setHeader('Retry-After', '5');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ error: 'This server is restarting. Please try again in a moment.' }));
        }
        open.add(res);
        const end = () => {
          if (!open.delete(res)) return;
          settleIdle();
        };
        res.once('finish', end);
        res.once('close', end);
        return next();
      };
    },
    /** Runs every step in order, each once, and gives up at the deadline. A second call waits for the first. */
    drain({ deadlineMs = (Number(config.shutdownSeconds) || 25) * 1000 } = {}) {
      if (health.drained) return health.drained;
      draining = true;
      // The requests in flight finish, and their connections close after them instead of waiting for another request.
      for (const res of open) if (!res.headersSent) res.setHeader('Connection', 'close');
      const steps = [];
      const work = (async () => {
        for (const { name, fn } of drainSteps) {
          const at = Date.now();
          try {
            await fn();
            steps.push({ name, ok: true, ms: Date.now() - at });
          } catch {
            steps.push({ name, ok: false, ms: Date.now() - at });
          }
        }
      })();
      health.drained = within(deadlineMs, () => work)
        .then(() => ({ ok: steps.every((s) => s.ok), timedOut: false, steps }))
        .catch(async () => {
          health.released = await within(RELEASE_MS, releaseJobs).catch(() => 0);
          return { ok: false, timedOut: true, steps };
        })
        .finally(closeOwn);
      return health.drained;
    },
    drained: null,
    /** How many claimed jobs a timed-out drain gave back to the queue's rule (0 when none, or before a drain). */
    released: 0,
    /** For a plain node:http server (the worker). Answers and returns true, or returns false for a path that is not a probe. */
    serve(req, res) {
      const url = String(req.url ?? '').split('?')[0];
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      if (url === HEALTH_PATHS.live || url === '/health') return send(200, 'ok'), true;
      if (url === HEALTH_PATHS.ready) return ready().then((r) => send(r.ok ? 200 : 503, r)), true;
      if (url === HEALTH_PATHS.startup) return health.startup().then((r) => send(r.ok ? 200 : 503, r)), true;
      return false;
    },
  };
  return health;
}

/**
 * A drain step for a node:http server: it stops listening (a new connection is refused), closes the idle keep-alive
 * connections, and resolves when the requests in flight have finished and their connections closed. With `health`, a
 * request that still arrives on an open connection is refused by health.middleware() and never starts.
 */
export function drainHttp(server, health = null) {
  return new Promise((resolve) => {
    let closed = false;
    server.close(() => {
      closed = true;
      resolve();
    });
    server.closeIdleConnections?.();
    // Connections that were busy close once their response is out (Connection: close); any left idle after that go too.
    if (health) {
      health.idle().then(() => {
        if (!closed) server.closeIdleConnections?.();
      });
    }
  });
}

/**
 * SIGTERM and SIGINT drain and exit: 0 when every step finished, 1 when the deadline passed or a step failed. `log` is
 * told ids and milliseconds only. Returns the handler, so a test can call it without a signal.
 */
export function drainOnSignals(health, { log, exit = (code) => process.exit(code), proc = process, name = 'process' } = {}) {
  const stop = async (signal) => {
    log?.info?.(`${name}.draining`, { signal });
    const result = await health.drain();
    log?.[result.ok ? 'info' : 'warn']?.(`${name}.drained`, { timedOut: result.timedOut, released: health.released || 0, steps: result.steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'failed'}:${s.ms}`) });
    exit(result.ok ? 0 : 1);
  };
  proc.once('SIGTERM', () => stop('SIGTERM'));
  proc.once('SIGINT', () => stop('SIGINT'));
  return stop;
}
