/**
 * A small round-robin load balancer for the readiness checks (R-06). Requests go to the servers in turn, one after the other:
 * there is no stickiness and no memory of who sent what, so a seller's requests switch servers on every call.
 *
 *   const lb = await startProxy({ upstreams: [portA, portB] });
 *   lb.port                  where it listens (127.0.0.1)
 *   lb.log                   [{ server, method, status }] one entry per request answered; the path and headers are not kept
 *   lb.counts()              requests answered per server index
 *   lb.down(i) / lb.up(i)    take a server out of, or back into, the rotation by hand
 *   lb.failures()            requests that no server could answer
 *   await lb.close()
 *
 * A server that refuses the connection, or answers 503 because it is draining, did not run the request, so the request goes to
 * the next server; that server is taken out of the rotation until its /readyz answers 200 again (checked every 200 ms).
 */
import http from 'node:http';

export async function startProxy({ upstreams, probeMs = 200 }) {
  const state = upstreams.map((port) => ({ port, up: true, answered: 0 }));
  const log = [];
  const failures = [];
  const manual = new Set();
  let next = 0;

  const pick = (skip) => {
    for (let n = 0; n < state.length; n++) {
      const i = (next + n) % state.length;
      if (state[i].up && !skip.has(i)) {
        next = (i + 1) % state.length;
        return i;
      }
    }
    return -1;
  };

  const forward = (i, req, body) => new Promise((resolve) => {
    const out = http.request({ host: '127.0.0.1', port: state[i].port, method: req.method, path: req.url, headers: { ...req.headers, connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve({ ok: false, reason: 'reset' }));
    });
    out.on('error', (err) => resolve({ ok: false, reason: err.code || 'error', connect: err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' }));
    out.setTimeout(30_000, () => out.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    out.end(body);
  });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const tried = new Set();
    for (;;) {
      const i = pick(tried);
      if (i < 0) {
        failures.push({ method: req.method, reason: tried.size ? 'every server refused' : 'no server is up' });
        res.statusCode = 502;
        res.end('');
        return;
      }
      tried.add(i);
      const result = await forward(i, req, body);
      if (result.ok && result.status !== 503) {
        state[i].answered++;
        log.push({ server: i, method: req.method, status: result.status });
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      }
      if (!result.ok && !result.connect) {
        // The connection broke after the request was sent: the request may have run, so it is not repeated.
        failures.push({ method: req.method, reason: result.reason });
        res.statusCode = 502;
        res.end('');
        return;
      }
      // Refused, or draining: it did not run the request. Out of the rotation until /readyz says it is back.
      state[i].up = false;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const timer = setInterval(async () => {
    for (let i = 0; i < state.length; i++) {
      if (state[i].up || manual.has(i)) continue;
      try {
        const res = await fetch(`http://127.0.0.1:${state[i].port}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) state[i].up = true;
      } catch {
        // still down
      }
    }
  }, probeMs);
  timer.unref();

  return {
    port: server.address().port,
    log,
    counts: () => state.map((s) => s.answered),
    failures: () => failures.slice(),
    down(i) {
      manual.add(i);
      state[i].up = false;
    },
    up(i) {
      manual.delete(i);
      state[i].up = true;
    },
    isUp: (i) => state[i].up,
    async close() {
      clearInterval(timer);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
