// Takes a database backup now (the worker does this nightly).
//   npm run backup
import { config } from '../src/config.js';
import { backupStorage, runBackup } from '../src/backup.js';

const storage = backupStorage(config);
if (!storage) {
  console.error('Set BACKUP_STORAGE_DRIVER and the BACKUP_S3_* settings first.');
  process.exit(1);
}
runBackup({ databaseUrl: config.databaseUrl, storage })
  .then(({ key, bytes }) => console.log(`Backup saved: ${key} (${Math.round(bytes / 1024)} KB)`))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
