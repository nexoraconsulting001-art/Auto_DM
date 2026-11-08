// Replaces EVERYTHING in the database at DATABASE_URL with a backup. Stop the web and worker first.
//   npm run restore -- --confirm=<database name>                     # the latest backup
//   npm run restore -- --confirm=<database name> backups/daily-07.dump
import { config } from '../src/config.js';
import { backupStorage, runRestore } from '../src/backup.js';

const args = process.argv.slice(2);
const confirm = args.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
const key = args.find((a) => !a.startsWith('--'));
const dbName = config.databaseUrl ? new URL(config.databaseUrl).pathname.slice(1) : '';
const storage = backupStorage(config);

if (!storage || !dbName) {
  console.error('Set DATABASE_URL, BACKUP_STORAGE_DRIVER and the BACKUP_S3_* settings first.');
  process.exit(1);
}
if (confirm !== dbName) {
  console.error(`This overwrites the database "${dbName}". To go ahead, add --confirm=${dbName}`);
  process.exit(1);
}
runRestore({ databaseUrl: config.databaseUrl, storage, key })
  .then((r) => console.log(`Restored ${r.key} (${Math.round(r.bytes / 1024)} KB)`))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
