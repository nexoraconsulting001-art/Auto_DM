// hosting.backups reads when the last backup finished from the active queue driver (R4-OPS-2): on the Redis queue the Postgres
// jobs table is empty, so reading it there reported a backup that ran an hour ago as old. Stand-in BullMQ and a stand-in table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES } from '../../../src/modules/golive/probes.js';
import { createQueue } from '../../../src/platform/queue.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-27T10:00:00Z');
const run = (queue) => PROBES['backups.recent'].run({ queue, db: { query: async () => { throw new Error('the jobs table must not be read'); } }, now: () => NOW, config: { rootDir: '/nonexistent' } });

function redisWith(finishedOn) {
  const calls = [];
  class Queue {
    constructor(name) { this.name = name; }
    async getJobs(types, start, end, asc) { calls.push({ name: this.name, types, start, end, asc }); return finishedOn ? [{ finishedOn }] : []; }
    async close() {}
  }
  const set = new Set();
  const queue = createQueue({ queueDriver: 'redis', redisUrl: 'redis://127.0.0.1:1' }, { bullmq: { Queue }, redis: { sadd: async (_k, n) => set.add(n), smembers: async () => [...set] } });
  return { queue, calls };
}

test('hosting.backups on the Redis queue: a backup that finished an hour ago is recent (the drill report then decides)', async () => {
  const { queue, calls } = redisWith(NOW - HOUR);
  assert.equal((await queue.lastFinished('system.backup')).getTime(), NOW - HOUR);
  assert.deepEqual(calls[0], { name: 'system.backup', types: ['completed'], start: 0, end: 0, asc: false });
  assert.equal((await run(queue)).detail, 'drillNotPassed', 'past the backup age check; no drill report in this folder');
});

test('hosting.backups on the Redis queue: a backup 30 hours ago, or none kept, is old', async () => {
  assert.equal((await run(redisWith(NOW - 30 * HOUR).queue)).detail, 'backupOld');
  assert.equal((await run(redisWith(0).queue)).detail, 'backupOld');
});

test('hosting.backups on the pg queue reads the jobs table for that queue and status only', async () => {
  const seen = [];
  const db = { query: async (sql, params) => { seen.push({ sql, params }); return [{ at: new Date(NOW - HOUR) }]; } };
  const queue = createQueue({ queueDriver: 'pg' }, { db });
  assert.equal((await run(queue)).detail, 'drillNotPassed');
  assert.match(seen[0].sql, /FROM jobs WHERE queue = \$1 AND status = 'done'/);
  assert.deepEqual(seen[0].params, ['system.backup']);
});

test('hosting.backups with no queue to ask is unknown, not old', async () => {
  assert.equal((await run(undefined)).state, 'unknown');
});
