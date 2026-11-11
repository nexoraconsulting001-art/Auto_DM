import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureAppRole, openDb } from './db/index.js';
import { createStorage } from './platform/storage.js';

/**
 * Nightly database backup, stored off the server (BACKUP_STORAGE_DRIVER: s3 for Oracle Object Storage
 * or any S3-compatible store; local for tests). Each backup is named after the day of the month, so
 * about 30 days are kept and the oldest is overwritten. Needs pg_dump and pg_restore (in the Docker image).
 */
export function backupStorage(config) {
  if (!config.backupStorageDriver) return null;
  return createStorage({
    storageDriver: config.backupStorageDriver,
    storageDir: config.backupStorageDir,
    s3Bucket: config.backupS3Bucket,
    s3Region: config.backupS3Region,
    s3Endpoint: config.backupS3Endpoint,
    s3AccessKeyId: config.backupS3AccessKeyId,
    s3SecretAccessKey: config.backupS3SecretAccessKey,
    s3ForcePathStyle: true,
  });
}

/** Connection settings for pg tools, as environment variables so the password stays off the command line. */
export function pgEnv(url) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new Error(`${cmd} could not start: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-500)}`))));
  });
}

const tempFile = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bhava-backup-'));
  return { file: path.join(dir, 'db.dump'), done: () => fs.rm(dir, { recursive: true, force: true }) };
};

const LATEST = 'backups/latest';
const dayKey = (date) => `backups/daily-${String(date.getUTCDate()).padStart(2, '0')}.dump`;

/** Dumps the database and uploads it. Returns { key, bytes }. */
export async function runBackup({ databaseUrl, storage, now = new Date() }) {
  if (!databaseUrl) throw new Error('Backups need DATABASE_URL');
  // databaseUrl is the owner's connection (ownerDatabaseUrl): pg_dump refuses to read tables that row-level security hides from it.
  const { file, done } = await tempFile();
  try {
    // Privileges stay in the dump: the app role's grants are what row-level security stands on.
    await run('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`], pgEnv(databaseUrl));
    const data = await fs.readFile(file);
    const key = dayKey(now);
    await storage.put(key, data, 'application/octet-stream');
    await storage.put(LATEST, Buffer.from(key), 'text/plain');
    return { key, bytes: data.length };
  } finally {
    await done();
  }
}

/**
 * Replaces everything in the database at databaseUrl (the owner's connection) with a backup. `key` defaults to the latest.
 * The app login's password is kept by the server, not the dump: on a new server the next start makes the login again.
 */
export async function runRestore({ databaseUrl, storage, key }) {
  const latest = key || (await storage.get(LATEST))?.toString();
  if (!latest) throw new Error('No backup found');
  const data = await storage.get(latest);
  if (!data) throw new Error(`Backup ${latest} not found`);
  const { file, done } = await tempFile();
  try {
    await fs.writeFile(file, data);
    // The dump grants to the app role, which may not exist yet on a new server.
    const db = await openDb({ url: databaseUrl, migrate: false, poolSize: 1 });
    await ensureAppRole(db).finally(() => db.close());
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${new URL(databaseUrl).pathname.slice(1)}`, file], pgEnv(databaseUrl));
    return { key: latest, bytes: data.length };
  } finally {
    await done();
  }
}
