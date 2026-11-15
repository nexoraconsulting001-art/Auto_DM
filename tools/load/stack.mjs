/**
 * The platform as the QA server runs it, on this machine, for the load test and the restore drill (Phase 8): a real
 * Postgres with the QA server's settings and two logins, and the web app and the worker as two separate processes, each
 * under its memory limit. Every limit comes from budgets.json. Nothing here reaches an outside service: the processes are
 * pointed at tools/sim by the caller's `env`.
 *
 *   const pg = await startPostgres({ dir, budgets });          // { ownerUrl, appUrl, port, pid, stop() }
 *   const web = startNode('web', { budgets, env });            // { pid, child, role, limitMb, output(), stop() }
 *   const worker = startNode('worker', { budgets, env });
 *   rssMb(web.pid)                                             // resident memory now, in MB, or null when it cannot be read
 *
 * Stop what you start, by its own pid: `await web.stop(); await worker.stop(); await pg.stop();`.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = Object.freeze({ web: 'src/server.js', worker: 'src/worker.js' });

/** budgets.json, checked for the fields the tools read. */
export function loadBudgets(file = path.join(ROOT, 'tools', 'load', 'budgets.json')) {
  const budgets = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const role of ['web', 'worker', 'postgres']) {
    if (!Number.isInteger(budgets.memoryMb?.[role]) || budgets.memoryMb[role] <= 0) throw new Error(`budgets.json: memoryMb.${role} must be a whole number of MB`);
  }
  if (!Number.isInteger(budgets.postgres?.sharedBuffersMb) || !Number.isInteger(budgets.postgres?.maxConnections)) throw new Error('budgets.json: postgres.sharedBuffersMb and postgres.maxConnections are required');
  const weights = (budgets.mix ?? []).reduce((sum, part) => sum + part.weight, 0);
  if (weights !== 100) throw new Error(`budgets.json: the traffic mix adds up to ${weights}, not 100`);
  for (const part of budgets.mix) if (!(budgets.p95Ms?.[part.class] > 0)) throw new Error(`budgets.json: no p95 target for "${part.class}"`);
  return budgets;
}

/** The server flags that make Postgres the QA server's: the same two settings as deploy/bhava/compose.yaml. */
export const postgresFlags = (budgets) => [
  '-c', 'listen_addresses=127.0.0.1',
  '-c', `shared_buffers=${budgets.postgres.sharedBuffersMb}MB`,
  '-c', `max_connections=${budgets.postgres.maxConnections}`,
];

/**
 * Node's own heap limit for a process held to `limitMb` in all: three quarters of it, leaving the rest for buffers and
 * native memory. The limit the report judges is resident memory (rssMb), not this flag.
 */
export const nodeFlags = (limitMb) => [`--max-old-space-size=${Math.floor(limitMb * 0.75)}`];

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/**
 * Starts an embedded Postgres in `dir` (an empty or missing folder) with the budget's settings, creates the database
 * `bhava`, and makes the two logins the QA server has: the owner of the tables (migrations, the platform's work) and the
 * restricted app login (every business's work). Passwords are made up for the run and never printed.
 */
export async function startPostgres({ dir, budgets, database = 'bhava' }) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { default: pgClient } = await import('pg');
  const { ensureAppLogin } = await import('../../src/db/index.js');
  const port = await freePort();
  const ownerPassword = crypto.randomBytes(16).toString('hex');
  const appPassword = crypto.randomBytes(16).toString('hex');
  const output = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'bhava',
    password: ownerPassword,
    persistent: true, // the caller deletes the folder, after stop()
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: postgresFlags(budgets),
    onLog: (line) => output.push(String(line)),
    onError: (line) => output.push(String(line)),
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(database);
  } catch (err) {
    await pg.stop().catch(() => {});
    throw new Error(`${err?.message ?? 'Postgres exited during start'}\n${output.slice(-15).join('')}`);
  }
  const ownerUrl = `postgres://bhava:${ownerPassword}@127.0.0.1:${port}/${database}`;
  const appUrl = `postgres://bhava_app_load:${appPassword}@127.0.0.1:${port}/${database}`;
  const client = new pgClient.Client({ connectionString: ownerUrl });
  try {
    await client.connect();
    const db = { exec: (sql) => client.query(sql), query: async (sql, params) => (await client.query(sql, params)).rows };
    await ensureAppLogin(db, appUrl);
  } catch (err) {
    await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    throw err;
  }
  await client.end();
  return { ownerUrl, appUrl, port, pid: pg.process.pid, output: () => output.join(''), stop: () => pg.stop() };
}

/**
 * Starts the web app or the worker as its own process under its memory limit. `env` is the whole environment: the two
 * database addresses (DATABASE_URL the app login, DATABASE_OWNER_URL the owner), the simulators' addresses and made-up
 * secrets. Output is kept in memory (the last 200 lines) and never printed, because a log line is not checked for
 * personal data here.
 */
export function startNode(role, { budgets, env, cwd = ROOT }) {
  if (!ENTRY[role]) throw new Error(`"${role}" is not web or worker`);
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('The load tools never run with NODE_ENV=production');
  const limitMb = budgets.memoryMb[role];
  const child = spawn(process.execPath, [...nodeFlags(limitMb), ENTRY[role]], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    });
  }
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return {
    role,
    pid: child.pid,
    child,
    limitMb,
    exited,
    output: () => lines.join('\n'),
    /** Stops this process only. `hard` is a crash (Q-07): no chance to finish what it was doing. */
    stop: async ({ hard = false } = {}) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(hard ? 'SIGKILL' : 'SIGTERM');
      return exited;
    },
  };
}

/** Resident memory of one process now, in MB, or null where it cannot be read (the report then says so, never 0). */
export function rssMb(pid) {
  try {
    if (process.platform === 'linux') {
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
      return kb ? Math.round(Number(kb) / 1024) : null;
    }
    if (process.platform === 'win32') {
      const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const kb = /"([\d.,\s]+) K"/.exec(row)?.[1]?.replace(/[^\d]/g, '');
      return kb ? Math.round(Number(kb) / 1024) : null;
    }
    const kb = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return kb ? Math.round(Number(kb) / 1024) : null;
  } catch {
    return null;
  }
}

/**
 * Writes one report twice under test-results/<name>/: report.json (the data) and report.md (the same, to read).
 * `report` is { title, ok, startedAt, finishedAt, summary: [[label, value]], checks: [{ id, name, ok, measured, limit }], notes: [text] }.
 * `checks[].id` is a requirement id (Q-05 to Q-09) where the check stands for one. Answers the two paths.
 */
export function writeReport(name, report, { root = ROOT } = {}) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error('A report name is lower-case letters, digits and dashes');
  const dir = path.join(root, 'test-results', name);
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, 'report.json');
  const md = path.join(dir, 'report.md');
  fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# ${report.title}`,
    '',
    `Result: **${report.ok ? 'PASS' : 'FAIL'}**. Started ${report.startedAt}, finished ${report.finishedAt}.`,
    '',
    ...(report.summary?.length ? ['| | |', '|---|---|', ...report.summary.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`), ''] : []),
    '| Check | Result | Measured | Limit |',
    '|---|---|---|---|',
    ...(report.checks ?? []).map((c) => `| ${cell(c.id ? `${c.id} ${c.name}` : c.name)} | ${c.ok ? 'pass' : 'FAIL'} | ${cell(c.measured)} | ${cell(c.limit)} |`),
    '',
    ...(report.notes ?? []).map((note) => `- ${note}`),
  ];
  fs.writeFileSync(md, `${lines.join('\n').trimEnd()}\n`);
  return { json, md };
}
