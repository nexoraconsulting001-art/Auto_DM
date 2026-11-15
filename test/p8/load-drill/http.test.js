// The load test's own client and driver: it must count a refusal instead of stopping at it, start requests on schedule, and time from when each was due.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createClient, drive, percentile } from '../../../tools/load/http.mjs';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('percentile: nearest rank, null for nothing', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
});

test('request: sends the Host header and body, answers status and text, and a refused connection is an answer with an error', async () => {
  const seen = [];
  const server = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ host: req.headers.host, method: req.method, body: Buffer.concat(chunks).toString(), type: req.headers['content-type'] });
      res.statusCode = 201;
      res.end('made');
    });
  });
  const client = createClient({ port: server.port });
  const ok = await client.request({ method: 'POST', path: '/x', host: 'shop-one.example', body: { a: 1 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.text, 'made');
  assert.deepEqual(seen[0], { host: 'shop-one.example', method: 'POST', body: '{"a":1}', type: 'application/json' });
  client.close();
  await server.close();
  const refused = await createClient({ port: server.port }).request({ path: '/' });
  assert.equal(refused.status, 0);
  assert.match(refused.error, /ECONNREFUSED|ECONNRESET/);
});

test('drive: starts requests at the stated rate, whether or not the server keeps up, and times each from when it was due', async () => {
  let inFlight = 0;
  let peak = 0;
  const server = await serve((req, res) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight--; res.end('ok'); }, 120);
  });
  const client = createClient({ port: server.port, connections: 2 });
  const results = [];
  const { started } = await drive({ client, plan: [{ name: 'a', rate: 20, make: () => ({ path: '/' }) }, { name: 'b', rate: 5, make: () => null }], seconds: 1.5, onResult: (r) => results.push(r) });
  client.close();
  await server.close();
  assert.ok(started >= 29 && started <= 32, `20 a second for 1.5 s is 30 requests and the first at once, got ${started}`);
  assert.equal(results.length, started);
  assert.ok(peak <= 2, 'the agent never opens more sockets than it was given');
  // Two sockets at 120 ms each serve about 16 a second against 20 asked for: the queue grows, and the waiting shows as time.
  const late = results.slice(-5).map((r) => r.ms);
  assert.ok(Math.max(...late) > 250, `the wait for a socket is part of the time: ${late.map(Math.round)}`);
});

test('drive: stops starting new requests when told to, and still waits for the ones in the air', async () => {
  const server = await serve((req, res) => setTimeout(() => res.end('ok'), 50));
  const client = createClient({ port: server.port });
  const stop = { stopped: false };
  const results = [];
  setTimeout(() => { stop.stopped = true; }, 300);
  const out = await drive({ client, plan: [{ name: 'a', rate: 50, make: () => ({ path: '/' }) }], seconds: 5, stopSignal: stop, onResult: (r) => results.push(r) });
  client.close();
  await server.close();
  assert.ok(out.finished < 1500);
  assert.equal(results.length, out.started);
  assert.ok(results.every((r) => r.status === 200));
});
