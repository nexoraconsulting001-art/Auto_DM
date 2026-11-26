// R5-PP-1: the first readiness answer of a process on the Redis queue says up when Redis is up.
// Redis is not available here, so a few lines of the Redis protocol on a loopback port stand in for it: the real ioredis client talks to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHealth } from '../../../src/platform/health.js';

/** Answers the ready check's INFO, PING and anything else the client sends on connect. */
async function tinyRedis() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      const text = String(data).toUpperCase();
      if (text.includes('INFO')) {
        const body = '# Server\r\nloading:0\r\n';
        socket.write(`$${body.length}\r\n${body}\r\n`);
      } else if (text.includes('PING')) socket.write('+PONG\r\n');
      else socket.write('+OK\r\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  });
  return { url: `redis://127.0.0.1:${server.address().port}`, close };
}

const redisQueue = { driver: 'redis', stats: async () => ({}) };

test('R5-PP-1: the very first readiness check on the Redis queue waits for its connection and says up', async (t) => {
  const redis = await tinyRedis();
  const health = createHealth({ platform: { queue: redisQueue }, config: { redisUrl: redis.url } });
  t.after(async () => {
    await health.drain({ deadlineMs: 100 }); // drain also disconnects the probe's client
    await redis.close();
  });
  const first = await health.ready();
  assert.equal(first.checks.queue, 'up', 'the first probe, before any other has warmed the connection');
  assert.equal(first.ok, true);
  assert.equal((await health.ready()).checks.queue, 'up');
});

test('R5-PP-1: a Redis that refuses the connection is still down at once', async (t) => {
  const health = createHealth({ platform: { queue: redisQueue }, config: { redisUrl: 'redis://127.0.0.1:1' } });
  t.after(() => health.drain({ deadlineMs: 100 })); // drain also disconnects the probe's client
  const answer = await health.ready();
  assert.equal(answer.checks.queue, 'down');
  assert.equal(answer.ok, false);
});
