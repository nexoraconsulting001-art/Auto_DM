import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS_DIR, runMigrations } from '../../../src/db/index.js';
import { openTestDb } from '../../helpers.js';

export const repoRoot = path.resolve(MIGRATIONS_DIR, '..', '..', '..');

/** Every file under `dir` (relative to the repo) as a repo-relative path. */
export function filesIn(dir) {
  return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
    const child = `${dir}/${e.name}`;
    return e.isDirectory() ? filesIn(child) : [child];
  });
}

/** A database migrated only up to and including `version`, plus a function that applies the rest. */
export async function dbAtMigration(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-migrations-'));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (f.slice(0, 3) <= version) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  const db = await openTestDb({ migrate: false });
  await runMigrations(db, dir);
  return { db, finish: () => runMigrations(db) };
}

export const at = (host) => ({ 'x-forwarded-host': host });
export const json = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
