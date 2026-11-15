import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Liveness, readiness, startup and shutdown for both processes (Phase 9; G-02, G-03). createPlatform() makes one, so it
 * is `ctx.platform.health` everywhere; src/server.js and src/worker.js serve it and drain through it.
 *
 *   live()                    -> { ok: true }. The process is up. Never looks at a dependency, so it stays true when one is down.
 *   await ready()             -> { ok, draining, checks: { database: 'up', migrations: 'up', queue: 'up', storage: 'unchecked', cache: 'up' } }
 *   await startup()           -> { ok }. True once markStarted() was called and the first readiness passed.
 *   markStarted()             the process finished starting (it is listening, its jobs are registered)
 *   check(name, fn)           sets or replaces a dependency check: async () => 'up' | 'down' | 'behind' | 'unchecked'
 *   onDrain(name, fn)         a step of shutting down, run in the order added: stop taking work, finish what is in flight, close
 *   await drain({ deadlineMs }) -> { ok, timedOut, steps: [{ name, ok, ms }] }. Readiness is false from the moment it is called.
 *   serve(req, res)           answers /healthz, /health, /readyz and /startupz on a node:http server; false for any other path
 *
 * A state is one word. Nothing a check throws, and no address, driver error, business or setting, reaches an answer:
 * a check that throws or takes longer than HEALTH_CHECK_MS is `down`. `behind` is migrations only: the code knows a
 * migration the database has not run. `unchecked` does not fail readiness; it is what a dependency with no check answers
 * (storage, until the runtime track adds its probe).
 *
 * The runtime track fills in: the storage probe, the queue's own connection check on Redis, the in-flight request count
 * and the release of jobs on drain. The interface above does not change.
 */
export const HEALTH_DEPENDENCIES = Object.freeze(['database', 'migrations', 'queue', 'storage', 'cache']);
export const HEALTH_STATES = Object.freeze(['up', 'down', 'behind', 'unchecked']);
export const HEALTH_PATHS = Object.freeze({ live: '/healthz', ready: '/readyz', startup: '/startupz' });
const FAILING = new Set(['down', 'behind']);
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** The migration numbers this build knows, from the files it ships. */
export function knownMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
}

const within = (ms, work) => {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(timer));
};

export function createHealth({ db = null, platform = {}, config = {}, migrations = knownMigrations } = {}) {
  const checkMs = Number(config.healthCheckMs) > 0 ? Number(config.healthCheckMs) : 2000;
  const checks = new Map(HEALTH_DEPENDENCIES.map((name) => [name, async () => 'unchecked']));
  const drainSteps = [];
  let started = false;
  let startedOk = false;
  let draining = false;
  let known = null;

  if (db) {
    const owner = db.platform ?? db;
    checks.set('database', async () => {
      await owner.query('SELECT 1');
      if (owner !== db) await db.query('SELECT 1');
      return 'up';
    });
    checks.set('migrations', async () => {
      known ??= migrations();
      const rows = await owner.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      return known.every((version) => applied.has(version)) ? 'up' : 'behind';
    });
  }
  if (platform.queue?.stats) {
    checks.set('queue', async () => {
      await platform.queue.stats();
      return 'up';
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
    /** Runs every step in order, each once, and gives up at the deadline. A second call waits for the first. */
    drain({ deadlineMs = (Number(config.shutdownSeconds) || 25) * 1000 } = {}) {
      if (health.drained) return health.drained;
      draining = true;
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
        .catch(() => ({ ok: false, timedOut: true, steps }));
      return health.drained;
    },
    drained: null,
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
 * SIGTERM and SIGINT drain and exit: 0 when every step finished, 1 when the deadline passed or a step failed. `log` is
 * told ids and milliseconds only. Returns the handler, so a test can call it without a signal.
 */
export function drainOnSignals(health, { log, exit = (code) => process.exit(code), proc = process, name = 'process' } = {}) {
  const stop = async (signal) => {
    log?.info?.(`${name}.draining`, { signal });
    const result = await health.drain();
    log?.[result.ok ? 'info' : 'warn']?.(`${name}.drained`, { timedOut: result.timedOut, steps: result.steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'failed'}:${s.ms}`) });
    exit(result.ok ? 0 : 1);
  };
  proc.once('SIGTERM', () => stop('SIGTERM'));
  proc.once('SIGINT', () => stop('SIGINT'));
  return stop;
}
