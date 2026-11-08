import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { openDb } from './db/index.js';
import { backupStorage, runBackup } from './backup.js';
import { createPlatform, describePlatform } from './platform/index.js';
import { log, reportError } from './platform/log.js';

export const HOUSEKEEPING = 'system.housekeeping';
export const BACKUP = 'system.backup';
const HOUR = 3_600_000;

/** Removes data past its retention: finished jobs, dead sessions, compliance events over 13 months. */
export async function housekeeping({ db, queue }) {
  await queue.cleanup(14);
  await db.query(`DELETE FROM sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM compliance_events WHERE created_at < now() - interval '395 days'`);
}

/** Registers every background job. New jobs (DM sending, insights, ...) are added here. */
export function registerJobs({ db, platform, config }) {
  const { queue, metrics } = platform;
  queue.work(HOUSEKEEPING, () => housekeeping({ db, queue }));

  const storage = backupStorage(config);
  if (storage) {
    queue.work(BACKUP, async () => {
      const { key, bytes } = await runBackup({ databaseUrl: config.databaseUrl, storage });
      metrics.gauge('backup_last_success_seconds', () => [{ labels: {}, value: Math.floor(Date.now() / 1000) }]);
      log.info('backup.done', { key, bytes });
    });
  } else {
    log.warn('backup.off', { reason: 'BACKUP_STORAGE_DRIVER is empty' });
  }

  /** Called every minute by every worker. Each job still runs only once per interval. */
  return async function schedule() {
    await queue.every(HOUSEKEEPING, HOUR);
    if (storage) await queue.every(BACKUP, 24 * HOUR);
  };
}

async function main(config = defaultConfig) {
  // The built-in database can be open in only one process, and the web server has it.
  if (!config.databaseUrl) throw new Error('The worker needs DATABASE_URL (Postgres)');
  const db = await openDb({ url: config.databaseUrl });
  const platform = createPlatform(config, { db });
  const schedule = registerJobs({ db, platform, config });
  const tick = () => schedule().catch((err) => reportError(err, { msg: 'worker.schedule_failed' }));
  await tick();
  const timer = setInterval(tick, 60_000);

  const health = http.createServer((req, res) => {
    res.statusCode = req.url === '/healthz' ? 200 : 404;
    res.end(req.url === '/healthz' ? 'ok' : '');
  }).listen(config.workerHealthPort, '127.0.0.1');

  log.info('worker.started', describePlatform(platform));

  const stop = async () => {
    clearInterval(timer);
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
