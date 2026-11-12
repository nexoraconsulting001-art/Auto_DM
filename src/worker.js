import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { createAppStores } from './adapters/appstores/index.js';
import { createEas } from './adapters/eas/index.js';
import { createGoogleAdapters } from './adapters/google/index.js';
import { createMetaAdapters } from './adapters/meta/index.js';
import { createStoreAdapters } from './adapters/store.js';
import { openRuntimeDb, ownerDatabaseUrl } from './db/index.js';
import { createInstagram } from './instagram.js';
import { createCompliance } from './modules/compliance/index.js';
import { MODULES } from './modules/index.js';
import { createMetaCallObserver } from './modules/meta-calls.js';
import { ORDER_EVENTS_QUEUE, wireOrderEvents } from './modules/orders/events.js';
import { createNotify } from './modules/notifications/index.js';
import { createShopperMessages } from './modules/shopper-messages/index.js';
import { createRepos } from './repos/index.js';
import { backupStorage, runBackup } from './backup.js';
import { sweepRawExports } from './modules/platform-console/raw-export.js';
import { createPlatform, describePlatform } from './platform/index.js';
import { log, reportError } from './platform/log.js';

export const HOUSEKEEPING = 'system.housekeeping';
export const BACKUP = 'system.backup';
const HOUR = 3_600_000;

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
    queue.work(BACKUP, async () => {
      const { key, bytes } = await runBackup({ databaseUrl: ownerDatabaseUrl(config), storage });
      metrics.gauge('backup_last_success_seconds', () => [{ labels: {}, value: Math.floor(Date.now() / 1000) }]);
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
  const shopperMessages = createShopperMessages({ db, platform, providers, config });
  const notify = createNotify({ db, providers, config });
  const jobContext = { db, repos, platform, config, ig, meta, google, eas, appStores, providers, compliance, shopperMessages, notify, modules };
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
  const db = await openRuntimeDb(config);
  const platform = createPlatform(config, { db });
  const schedule = registerJobs({ db, platform, config });
  const tick = () => schedule().catch((err) => reportError(err, { msg: 'worker.schedule_failed' }));
  await tick();
  const timer = setInterval(tick, 60_000);
  // Order events are handed to their listeners within a couple of seconds of the change that made them.
  const stopOrderEvents = schedule.context.orderEvents.start({ everyMs: config.orderEventsPollMs });

  const health = http.createServer((req, res) => {
    res.statusCode = req.url === '/healthz' ? 200 : 404;
    res.end(req.url === '/healthz' ? 'ok' : '');
  }).listen(config.workerHealthPort, '127.0.0.1');

  log.info('worker.started', describePlatform(platform));

  const stop = async () => {
    clearInterval(timer);
    stopOrderEvents();
    health.close();
    await platform.queue.close(); // finishes the jobs in progress first
    await platform.cache.close();
    await db.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportError(err, { msg: 'worker.failed_to_start' });
    process.exit(1);
  });
}
