/**
 * Looking at a backup file before anything is restored from it, and damaging a good one for the drill.
 *
 * `checkBackup(file)` answers { ok, reason } without touching any database: the file must start as a pg_dump custom archive
 * (PGDMP and a format version this pg_restore reads), and pg_restore must be able to read all of it, every data block, to
 * a file that is thrown away. A truncated file and a corrupted data block both fail that read; a header a different version
 * wrote fails the first look. Run it before `npm run restore` on a backup that came from outside, and the drill uses it
 * to show a bad backup is refused before any target is opened (Q-09).
 *
 * `damage(buffer, kind)` makes the three bad backups of Q-09 (BAD_BACKUPS in index.mjs): the same bytes in, a damaged copy out.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export const MAGIC = 'PGDMP';
/** The archive format versions pg_restore 16 reads: 1.12 (PostgreSQL 9.x and later) up to 1.16. */
export const READABLE = Object.freeze({ major: 1, minMinor: 12, maxMinor: 16 });

/** { version: '1.15.0' } of a custom archive's header, or null when the bytes are not one. */
export function readHeader(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 5).toString('latin1') !== MAGIC) return null;
  return { major: buffer[5], minor: buffer[6], revision: buffer[7], version: `${buffer[5]}.${buffer[6]}.${buffer[7]}` };
}

export function headerProblem(buffer) {
  const header = readHeader(buffer);
  if (!header) return 'The file does not start as a PostgreSQL custom-format backup.';
  if (header.major !== READABLE.major || header.minor < READABLE.minMinor || header.minor > READABLE.maxMinor) {
    return `The backup is format version ${header.version}; this server reads ${READABLE.major}.${READABLE.minMinor} to ${READABLE.major}.${READABLE.maxMinor}.`;
  }
  return null;
}

/** A damaged copy of a good backup. Deterministic: the same input gives the same output. */
export function damage(buffer, kind) {
  const copy = Buffer.from(buffer);
  if (kind === 'truncated') return copy.subarray(0, Math.floor((copy.length * 2) / 3));
  if (kind === 'corrupted') {
    // Overwrite a run of bytes in the middle, after the table of contents, with a fixed pattern.
    const length = Math.min(512, Math.max(16, Math.floor(copy.length / 8)));
    const start = Math.floor(copy.length / 2);
    for (let i = 0; i < length && start + i < copy.length; i++) copy[start + i] = (0xa5 + i * 31) & 0xff;
    return copy;
  }
  if (kind === 'wrong_version') {
    copy[5] = READABLE.major;
    copy[6] = 99;
    copy[7] = 0;
    return copy;
  }
  throw new Error(`Unknown kind of damage "${kind}"`);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stderr: `${cmd} could not start: ${err.message}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** The environment for the pg tools: PG_BIN_DIR, when set, goes first on the path. */
export function toolEnv(env = process.env) {
  const dir = env.PG_BIN_DIR;
  if (!dir) return { ...env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: `${dir}${process.platform === 'win32' ? ';' : ':'}${env[key] ?? ''}` };
}

/** { pg_dump: '16.4', pg_restore: '16.4' } or the name of the first tool that is missing. */
export async function pgTools(env = process.env) {
  const found = {};
  for (const tool of ['pg_dump', 'pg_restore']) {
    const out = await new Promise((resolve) => {
      const child = spawn(tool, ['--version'], { env: toolEnv(env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? text : null));
    });
    if (!out) return { missing: tool };
    found[tool] = /(\d+(?:\.\d+)*)/.exec(out)?.[1] ?? out.trim();
  }
  return found;
}

/**
 * Reads the whole archive without a database. Answers { ok: true } or { ok: false, reason } where the reason names the first
 * thing wrong and carries no row of data. `env` is the environment for pg_restore.
 */
export async function checkBackup(file, { env = process.env } = {}) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, reason: 'The backup file cannot be read.' };
  }
  const problem = headerProblem(head);
  if (problem) return { ok: false, reason: problem };
  // Writes the whole script to the null device: every data block is read and decompressed, so a cut or damaged file fails here.
  const result = await run('pg_restore', ['--file', os.devNull, file], toolEnv(env));
  if (result.code !== 0) return { ok: false, reason: `pg_restore cannot read the backup: ${result.stderr.trim().split('\n')[0].slice(0, 200)}` };
  return { ok: true };
}
