// Shared by the Phase 9 spec tests: a database with a chosen secrets setup, child processes with a clean environment,
// and the search that proves a secret is nowhere. Nothing here looks inside the code being tested.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { openTestDb } from '../../helpers.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
export const json = (rel) => JSON.parse(read(rel));
export const key = () => crypto.randomBytes(32).toString('base64');
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const IS_WINDOWS = process.platform === 'win32';

const scratches = [];
/** A new empty folder, removed when the process ends. */
export function scratch(prefix = 'bhava-p9-spec-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of scratches) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left behind in the temp folder: harmless.
    }
  }
});

export async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await pause(25);
  }
}

/** Is the program on the PATH? Checks that need a container tool run only when it is, and are reported as needing CI otherwise. */
export function hasTool(name) {
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : [''];
  return String(process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && exts.some((ext) => fs.existsSync(path.join(dir, name + ext))));
}

/** The reason to give a skipped test: it needs something this machine lacks, and CI must prove it. */
export const needsCi = (what) => `needs CI: ${what} is not available here`;

/**
 * The tables a business's secrets live in, with a database whose secrets are written in `format`, master key `dataKey`
 * and older keys `dataKeyOld`. `make(slug)` creates a business and its repos.
 */
export async function secretsWorld({ format = 'v2', dataKey = key(), dataKeyOld } = {}) {
  const db = await openTestDb();
  const secrets = createSecrets({ dataKey, dataKeyOld, secretsFormat: format });
  const platform = createRepos(db, { secrets });
  const q = (text, params) => (db.platform ?? db).query(text, params);
  const made = [];
  async function make(slug) {
    const tenant = await platform.tenants.create({ slug, name: `Shop ${slug}`, plan: 't3' });
    const repos = bindTenant(platform, tenant);
    made.push(tenant);
    return { tenant, repos };
  }
  return { db, secrets, platform, make, q, dataKey, close: () => db.close?.() };
}

/** Connects an Instagram account to a business with a token. */
export async function connect(world, shop, igUserId, token) {
  await world.platform.tenants.linkIgAccount(shop.tenant.id, igUserId, `acct_${igUserId}`);
  await shop.repos.igAccounts.setToken(igUserId, token);
}

/** Every public table of the database, as [table, rows-as-text]. */
export async function dumpAll(q) {
  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out = [];
  for (const { table_name: name } of tables) {
    try {
      const rows = await q(`SELECT t::text AS row FROM "${name}" t`);
      out.push([name, rows.map((r) => r.row).join('\n')]);
    } catch {
      // A table the connection may not read holds nothing this check can see.
    }
  }
  return out;
}

/** The tables where `needle` appears. */
export async function whereFound(q, needle) {
  return (await dumpAll(q)).filter(([, text]) => text.includes(needle)).map(([name]) => name);
}

/** Fails, naming `label`, when any of `needles` is in `text`. Never prints the needle. */
export function assertNoneOf(label, text, needles) {
  const body = typeof text === 'string' ? text : JSON.stringify(text);
  needles.forEach((needle, i) => assert.equal(body.includes(needle), false, `${label} holds the secret #${i + 1}`));
}

/** The environment a child process gets: the machine's path and temp folder, and nothing else of ours. */
export function cleanEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'COMSPEC', 'ComSpec', 'LANG'];
  const base = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return { ...base, ...extra };
}

/** Runs `node args` to the end (or the timeout) in the repository and answers { code, stdout, stderr, timedOut }. */
export function runNode(args, { env = {}, cwd = ROOT, timeoutMs = 60_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? '');
  });
}

/** A long-running child; `stop()` ends it by its own pid. */
export function startNode(args, { env = {}, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, args, { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { stdout: '', stderr: '', exited: null, code: null, signal: null };
  child.stdout.on('data', (d) => (state.stdout += d));
  child.stderr.on('data', (d) => (state.stderr += d));
  const done = new Promise((resolve) => child.on('close', (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
    resolve(state);
  }));
  return { child, state, done, stop: () => { if (!state.exited) child.kill(); return done; } };
}

/** A free port on this machine. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** One request with a real Host header. */
export function request(port, { method = 'GET', path: p = '/', headers = {}, body, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host, port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('no answer in 20 s')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A stand-in provider that fails every call and echoes the whole request back in its error, as some providers do. */
export async function echoingProvider({ status = 400 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const echo = { method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(echo);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request ${req.method} http://${req.headers.host}${req.url} failed with ${req.headers.authorization ?? ''}`, type: 'OAuthException', code: 190, request: echo } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** `{ a: 1 }` -> the same object with every function and symbol dropped, as a log would show it. */
export const plain = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack, code: v.code } : v)));
