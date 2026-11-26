import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig, loadSecrets } from './config.js';
import { createAppStores } from './adapters/appstores/index.js';
import { createEas } from './adapters/eas/index.js';
import { createGoogleAdapters } from './adapters/google/index.js';
import { createMetaAdapters } from './adapters/meta/index.js';
import { createStoreAdapters } from './adapters/store.js';
import { openRuntimeDb, ownerDatabaseUrl } from './db/index.js';
import { createInstagram } from './instagram.js';
import { createInboundHooks } from './modules/automations/unmatched.js';
import { createCompliance } from './modules/compliance/index.js';
import { MODULES } from './modules/index.js';
import { createMetaCallObserver } from './modules/meta-calls.js';
import { ORDER_EVENTS_QUEUE, wireOrderEvents } from './modules/orders/events.js';
import { createNotify } from './modules/notifications/index.js';
import { createShopperMessages } from './modules/shopper-messages/index.js';
import { createSignupGuard } from './modules/signup/guard.js';
import { createRepos } from './repos/index.js';
import { backupStorage, lastBackupSuccess, runBackup } from './backup.js';
import { sweepRawExports } from './modules/platform-console/raw-export.js';
import { createPlatform, describePlatform } from './platform/index.js';
import { secretRefreshFailed } from './platform/metrics.js';
import { createErrorSink } from './platform/error-sink.js';
import { drainOnSignals } from './platform/health.js';
import { log, onError, reportError } from './platform/log.js';
import { guardProduction } from './platform/production-guard.js';
import { BACKUP, HOUSEKEEPING } from './platform/queue.js';

export { BACKUP, HOUSEKEEPING };
const HOUR = 3_600_000;
/** How long the worker trusts what it last read of the recorded backup time before reading it again (a CronJob may have run). */
const BACKUP_READ_MS = 5 * 60_000;

/**
 * backup_last_success_seconds (and so backup_age_seconds): when the last backup finished, as recorded with the backups by
 * whichever process ran it (this worker's job or the backup CronJob, src/backup.js). Nothing recorded: no series, so
 * BackupMissing fires rather than a fresh 0. succeeded() is called by this worker's own job when a backup finishes.
 */
export function watchBackups(metrics, storage, { now = () => Date.now() } = {}) {
  let known = null;
  let readAt = -Infinity;
  const current = async () => {
    if (now() - readAt >= BACKUP_READ_MS) {
      const recorded = await lastBackupSuccess(storage);
      readAt = now();
      if (recorded !== null && (known === null || recorded > known)) known = recorded;
    }
    return known;
  };
  metrics.gauge('backup_last_success_seconds', async () => {
    const at = await current();
    return at === null ? [] : [{ labels: {}, value: at }];
  });
  return {
    async succeeded({ at = new Date(now()) } = {}) {
      const seconds = Math.floor(new Date(at).getTime() / 1000);
      if (known === null || seconds > known) known = seconds;
    },
  };
}

/**
 * The worker's own HTTP listener: /healthz, /readyz and /startupz (src/platform/health.js) and /metrics with METRICS_TOKEN,
 * as on the web server, so the 'worker' scrape job reads what this process records. Anything else is 404.
 */
export function createWorkerProbes({ platform, config }) {
  const { health, metrics } = platform;
  return http.createServer((req, res) => {
    if (health.serve(req, res)) return;
    if (metrics.serve(req, res, config.metricsToken)) return;
    res.statusCode = 404;
    res.end('');
  });
}

/** Removes data past its retention: finished jobs, dead sessions, compliance events over 13 months, raw export files past 7 days. */
export async function housekeeping({ db: handle, queue, storage }) {
  const db = handle.platform ?? handle; // retention looks across every business, which only the platform path may do
  await queue.cleanup(14);
  await db.query(`DELETE FROM sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM platform_sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM compliance_events WHERE created_at < now() - interval '395 days'`);
  await db.query(`DELETE FROM rate_limit_hits WHERE window_start < now() - interval '2 days'`);
  await db.query(`DELETE FROM order_event_deliveries WHERE status = 'done' AND done_at < now() - interval '30 days'`);
  if (storage) await sweepRawExports({ db: handle, storage });
}

/** Registers every background job: the system's own, then each module's (see src/modules/index.js). */
export function registerJobs({ db, platform, config, modules = MODULES, metaCalls = createMetaCallObserver(modules), ig = createInstagram(config, { onCall: metaCalls.onCall }) }) {
  const { queue, metrics } = platform;
  queue.work(HOUSEKEEPING, () => housekeeping({ db, queue, storage: platform.storage }));

  const storage = backupStorage(config);
  if (storage) {
    const backups = watchBackups(metrics, storage);
    queue.work(BACKUP, async () => {
      const { key, bytes } = await runBackup({ databaseUrl: ownerDatabaseUrl(config), storage });
      await backups.succeeded({ at: new Date() });
      log.info('backup.done', { key, bytes });
    });
  } else {
    log.warn('backup.off', { reason: 'BACKUP_STORAGE_DRIVER is empty' });
  }

  const repos = createRepos(db, { storage: platform.storage, secrets: platform.secrets, modules });
  const meta = createMetaAdapters(config, { onCall: metaCalls.onCall });
  const google = createGoogleAdapters(config);
  const eas = createEas(config);
  const appStores = createAppStores(config);
  const compliance = createCompliance({ db, repos, ig, meta, config, platform });
  const providers = createStoreAdapters(config);
  const shopperMessages = createShopperMessages({ db, platform, providers, config, compliance });
  const inbound = createInboundHooks({ platform });
  const notify = createNotify({ db, providers, config });
  const jobContext = { db, repos, platform, config, ig, meta, google, eas, appStores, providers, compliance, shopperMessages, inbound, notify, modules, signupGuard: createSignupGuard({ enforce: Boolean(config.goliveEnforce) }) };
  metaCalls.bind(jobContext);
  // The order event bus: listeners register in each module's setup, and this worker is what delivers.
  const orderEvents = wireOrderEvents(jobContext);
  for (const module of modules) module.setup?.(jobContext);
  queue.work(ORDER_EVENTS_QUEUE, () => orderEvents.drain());
  const moduleSchedules = modules.map((m) => m.jobs?.(jobContext)).filter((s) => typeof s === 'function');

  /** Called every minute by every worker. Each job still runs only once per interval. */
  async function schedule() {
    await queue.every(HOUSEKEEPING, HOUR);
    if (storage) await queue.every(BACKUP, 24 * HOUR);
    // The safety net under the worker's own poll of the order events (main() below starts that).
    await queue.every(ORDER_EVENTS_QUEUE, 60_000);
    for (const moduleSchedule of moduleSchedules) await moduleSchedule();
  }
  return Object.assign(schedule, { context: jobContext });
}

async function main(config = defaultConfig) {
  // Secrets first, then the production rules, exactly as the web server does.
  let platform = null;
  const secretSource = await loadSecrets(config, { onAlert: secretRefreshFailed(() => platform?.metrics) });
  const guardProblems = guardProduction(config);
  if (guardProblems.length) log.warn('production.guard', { rules: guardProblems.map((p) => p.id) });
  const errorSink = createErrorSink(config, { service: 'worker' });
  onError(errorSink.report);
  const db = await openRuntimeDb(config);
  platform = createPlatform(config, { db, service: 'worker' });
  const schedule = registerJobs({ db, platform, config });
  const tick = () => schedule().catch((err) => reportError(err, { msg: 'worker.schedule_failed' }));
  await tick();
  const timer = setInterval(tick, 60_000);
  // Order events are handed to their listeners within a couple of seconds of the change that made them.
  const stopOrderEvents = schedule.context.orderEvents.start({ everyMs: config.orderEventsPollMs });

  // /healthz, /readyz, /startupz and /metrics, as on the web server.
  const { health } = platform;
  const probes = createWorkerProbes({ platform, config }).listen(config.workerHealthPort, config.workerHealthHost || '127.0.0.1');
  health.markStarted();
  secretSource.start(({ changed }) => log.info('secrets.refreshed', { settings: changed }));

  log.info('worker.started', { ...describePlatform(platform), secrets: secretSource.driver, release: config.release || null });

  // On SIGTERM and SIGINT: stop scheduling, let the jobs in progress finish (the queue's close waits for them), then
  // close, within SHUTDOWN_SECONDS. A job that cannot finish in time stays claimed in the queue and is run again after
  // its lock ends; the runtime track makes that release explicit with its own health.onDrain() step.
  health.onDrain('schedule', () => {
    clearInterval(timer);
    stopOrderEvents();
  });
  health.onDrain('secrets', () => secretSource.stop());
  health.onDrain('queue', () => platform.queue.close());
  health.onDrain('errors', () => errorSink.flush());
  health.onDrain('cache', () => platform.cache.close());
  health.onDrain('database', () => db.close());
  health.onDrain('probes', () => probes.close());
  drainOnSignals(health, { log, name: 'worker' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportError(err, { msg: 'worker.failed_to_start' });
    process.exit(1);
  });
}
