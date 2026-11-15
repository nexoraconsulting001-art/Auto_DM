// What the monitor reports: peaks of what it saw, and a reading of real processes where the system allows one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import { closeProcessReader, peaks, processTable, readMemory, startMonitor } from '../../../tools/load/monitor.mjs';

after(() => closeProcessReader());

test('peaks: the highest of each series, null for a series with no reading, never 0', () => {
  const samples = [
    { memory: { web: 100, worker: 50, postgres: null }, queue: { inbound: 3, outbound: 1, jobs: 0, inboundAgeS: 1.5, outboundAgeS: 0 }, dbMs: 12 },
    { memory: { web: 180, worker: null, postgres: null }, queue: { inbound: 9, outbound: 0, jobs: 2, inboundAgeS: 0.5, outboundAgeS: 7 }, dbMs: 40 },
    { memory: { web: 90, worker: 70, postgres: null }, queue: null, dbMs: null },
  ];
  assert.deepEqual(peaks(samples), {
    memoryMb: { web: 180, worker: 70, postgres: null },
    queue: { inbound: 9, outbound: 1, jobs: 2, inboundAgeS: 1.5, outboundAgeS: 7 },
    dbMs: 40,
    samples: 3,
  });
  assert.deepEqual(peaks([]).memoryMb, { web: null, worker: null, postgres: null });
  assert.equal(peaks([]).dbMs, null);
});

test('readMemory: a running process has a reading, a process that is not there has none', async () => {
  const child = spawn(process.execPath, ['-e', 'const keep = Buffer.alloc(40 * 1048576, 1); setInterval(() => keep[0]++, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const table = await processTable();
    assert.ok(table.some((row) => row.pid === child.pid), 'the process table lists it');
    const reading = await readMemory({ pids: { web: child.pid, worker: 2 ** 30, postgres: 2 ** 30 }, sharedBuffersMb: 128 });
    assert.ok(reading.web > 20 && reading.web < 2000, `web ${reading.web}`);
    assert.equal(reading.worker, null);
    assert.equal(reading.postgres, null);
  } finally {
    child.kill();
  }
});

test('readMemory: a server of several processes is the postmaster and everything under it', async () => {
  const parent = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); for (let i = 0; i < 2; i++) spawn(process.execPath, ['-e', 'const keep = Buffer.alloc(30 * 1048576, 1); setInterval(() => keep[0]++, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const table = await processTable();
    const children = table.filter((row) => row.ppid === parent.pid);
    assert.equal(children.length, 2, 'the table shows who is whose child');
    const one = await readMemory({ pids: { web: null, worker: null, postgres: parent.pid }, sharedBuffersMb: 128 });
    assert.ok(one.postgres >= 128 + 40, `the tree is added up, with the shared buffers once: ${one.postgres}`);
  } finally {
    parent.kill();
  }
});

test('the monitor samples on its own and stops with its samples and their peaks', async () => {
  const db = { platform: { query: async () => [{ inbound: 4, outbound: 2, jobs: 1, inbound_age_s: 0.25, outbound_age_s: 3 }] } };
  const monitor = startMonitor({ db, getPids: () => ({ web: process.pid, worker: null, postgres: null }), sharedBuffersMb: 128, everyMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const { samples, peaks: result } = await monitor.stop();
  assert.ok(samples.length >= 2, `${samples.length} samples`);
  assert.equal(result.queue.inbound, 4);
  assert.equal(result.queue.outboundAgeS, 3);
  assert.ok(result.memoryMb.web > 10);
  assert.equal(result.memoryMb.worker, null);
  const down = startMonitor({ db: { platform: { query: async () => { throw new Error('connection refused'); } } }, getPids: () => ({}), sharedBuffersMb: 128, everyMs: 200 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stopped = await down.stop();
  assert.ok(stopped.samples.length >= 1 && stopped.samples.every((s) => s.queue === null), 'a database that does not answer leaves no queue reading and does not stop the monitor');
});
