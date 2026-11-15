/**
 * What the load test watches while it runs: the memory of web, worker and Postgres, the depth and age of the queues, and
 * how long the database takes to answer. Sampled on a timer, kept as a list, summarised as peaks.
 *
 * Memory, per process:
 *   web, worker   resident memory (Linux: VmRSS, Windows: working set, macOS: ps rss), the same measure as rssMb in stack.mjs
 *   postgres      the whole server: the postmaster and every process under it. Where the system can say what is private to
 *                 each process (Linux: proportional set size; Windows: private bytes) those are added up and the shared
 *                 buffers are counted once on top; where it cannot (macOS) resident sizes are added, which over-counts.
 *                 The QA server's limit is on the whole container, which is what this stands for.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { sleep } from './http.mjs';

const run = promisify(execFile);
const MB = 1048576;

// Starting PowerShell costs about two seconds, so on Windows one stays running and prints the process list every second and a half.
const WINDOWS_SCRIPT = `while ($true) { Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='postgres.exe'" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 1500 }`;
let reader = null;

const windowsRows = (text) => {
  const rows = JSON.parse(text || '[]');
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, rss: Number(r.WorkingSetSize) / MB, priv: r.PrivatePageCount === null || r.PrivatePageCount === undefined ? null : Number(r.PrivatePageCount) / MB }));
};

function startWindowsReader() {
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const state = { child, latest: null, at: 0, waiters: [] };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf(String.fromCharCode(10)); end >= 0; end = buffer.indexOf(String.fromCharCode(10))) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        state.latest = windowsRows(line);
        state.at = Date.now();
        state.waiters.splice(0).forEach((resolve) => resolve());
      } catch {
        // a partial line: the next one is whole
      }
    }
  });
  child.on('error', () => { reader = null; });
  child.on('close', () => { if (reader === state) reader = null; });
  return state;
}

/** Stops the Windows process lister, if one was started. The monitor does this when it stops. */
export function closeProcessReader() {
  reader?.child.kill();
  reader = null;
}

async function windowsTable() {
  reader ??= startWindowsReader();
  const state = reader;
  if (!state.latest || Date.now() - state.at > 5000) await new Promise((resolve) => { state.waiters.push(resolve); setTimeout(resolve, 10_000); });
  return state.latest ?? [];
}

async function linuxTable() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024;
      let pss = null;
      try {
        pss = Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8'))?.[1] ?? 0) / 1024;
      } catch {
        pss = null;
      }
      rows.push({ pid: Number(entry), ppid, rss, priv: pss });
    } catch {
      // the process ended between the listing and the read
    }
  }
  return rows;
}

async function unixTable() {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  return stdout.trim().split('\n').map((line) => {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid, rss: kb / 1024, priv: null };
  });
}

export const processTable = () => (process.platform === 'win32' ? windowsTable() : process.platform === 'linux' ? linuxTable() : unixTable());

/** One reading of { web, worker, postgres } in MB; a role that cannot be read is null (the report says so, never 0). */
export async function readMemory({ pids, sharedBuffersMb }) {
  const table = await processTable();
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const out = { web: null, worker: null, postgres: null };
  for (const role of ['web', 'worker']) {
    const row = pids[role] && byPid.get(pids[role]);
    out[role] = row ? Math.round(row.rss) : null;
  }
  const root = pids.postgres && byPid.get(pids.postgres);
  if (root) {
    const members = [];
    const walk = (pid) => {
      const row = byPid.get(pid);
      if (row) members.push(row);
      for (const child of table) if (child.ppid === pid && child.pid !== pid) walk(child.pid);
    };
    walk(root.pid);
    const exact = members.every((m) => m.priv !== null);
    out.postgres = Math.round(exact ? members.reduce((sum, m) => sum + m.priv, 0) + sharedBuffersMb : members.reduce((sum, m) => sum + m.rss, 0));
  }
  return out;
}

const QUEUE_SQL = `SELECT
  (SELECT count(*) FROM inbound_events WHERE status IN ('stored', 'processing'))::int AS inbound,
  (SELECT count(*) FROM outbound_jobs WHERE status IN ('queued', 'sending', 'held'))::int AS outbound,
  (SELECT count(*) FROM jobs WHERE status IN ('queued', 'running'))::int AS jobs,
  COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(received_at) FROM inbound_events WHERE status = 'stored')), 0)::float AS inbound_age_s,
  COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(run_at) FROM outbound_jobs WHERE status = 'queued' AND run_at <= now())), 0)::float AS outbound_age_s`;

/**
 * Starts sampling every `everyMs`. `getPids()` answers the current { web, worker, postgres } (they change on a restart).
 * stop() answers { samples, peaks }.
 */
export function startMonitor({ db, getPids, sharedBuffersMb, everyMs = 2000 }) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      const sample = { at, memory: { web: null, worker: null, postgres: null }, queue: null, dbMs: null };
      try {
        const t0 = performance.now();
        const [row] = await db.platform.query(QUEUE_SQL);
        sample.dbMs = Math.round(performance.now() - t0);
        sample.queue = { inbound: row.inbound, outbound: row.outbound, jobs: row.jobs, inboundAgeS: Math.round(row.inbound_age_s * 10) / 10, outboundAgeS: Math.round(row.outbound_age_s * 10) / 10 };
      } catch {
        // a restart in progress: the sample has no queue reading
      }
      try {
        sample.memory = await readMemory({ pids: getPids(), sharedBuffersMb });
      } catch {
        // memory could not be read this time
      }
      samples.push(sample);
      const wait = everyMs - (Date.now() - at);
      if (wait > 0) await sleep(wait);
    }
  })();
  return {
    samples,
    async stop() {
      running = false;
      await loop;
      closeProcessReader();
      return { samples, peaks: peaks(samples) };
    },
  };
}

/** The highest reading of each series; null when there was none. */
export function peaks(samples) {
  const top = (values) => (values.length ? Math.max(...values) : null);
  const mem = (role) => top(samples.map((s) => s.memory?.[role]).filter((v) => v !== null && v !== undefined));
  const q = (key) => top(samples.map((s) => s.queue?.[key]).filter((v) => v !== null && v !== undefined));
  return {
    memoryMb: { web: mem('web'), worker: mem('worker'), postgres: mem('postgres') },
    queue: { inbound: q('inbound'), outbound: q('outbound'), jobs: q('jobs'), inboundAgeS: q('inboundAgeS'), outboundAgeS: q('outboundAgeS') },
    dbMs: top(samples.map((s) => s.dbMs).filter((v) => v !== null)),
    samples: samples.length,
  };
}
