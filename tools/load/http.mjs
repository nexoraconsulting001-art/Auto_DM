/**
 * The load test's HTTP client and its open-loop driver.
 *
 * `request` sends one request to the web app on this machine with any Host header (which fetch cannot do) and answers
 * { status, ms, text, error }. It never throws: a refused connection is an answer with `error` set, because the
 * test must count it, not stop at it.
 *
 * `drive` is an open-loop driver: it starts requests at a stated rate whether or not the earlier ones have finished,
 * and times each from the moment it was due, not from the moment a socket was free. A slow server therefore shows up
 * as slow answers rather than as fewer requests (no coordinated omission). One agent with `connections` sockets is
 * shared by every request of a driver.
 */
import http from 'node:http';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleep };

export function createClient({ port, connections = 40, timeoutMs = 20_000 }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections, keepAliveMsecs: 5000 });
  const request = ({ method = 'GET', path = '/', host, headers = {}, body, dueAt = null }) => new Promise((resolve) => {
    const start = dueAt ?? performance.now();
    const sent = { ...headers };
    if (host) sent.host = host;
    let payload = body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      sent['content-type'] ??= 'application/json';
    }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      resolve({ ms: performance.now() - start, ...out });
    };
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent, agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({ status: res.statusCode, text, headers: res.headers, error: null });
      });
      res.on('error', (err) => finish({ status: 0, text: '', error: err.code || err.name }));
    });
    req.on('error', (err) => finish({ status: 0, text: '', error: err.code || err.name }));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  return { request, close: () => agent.destroy() };
}

/**
 * Runs `plan` for `seconds`. `plan` is a list of { name, rate, make(i) } where rate is requests per second and make(i)
 * answers what to send (the same object `request` takes, plus an optional `after(result)` that runs when it is done).
 * Calls onResult({ name, status, ms, error, at, meta }) for each. Resolves when the time is up and every request has
 * finished. Answers { started, finished }.
 */
export async function drive({ client, plan, seconds, onResult, stopSignal = { stopped: false }, tickMs = 10 }) {
  const begin = performance.now();
  const end = begin + seconds * 1000;
  const state = plan.map((p) => ({ ...p, issued: 0, carry: 0 }));
  const inflight = new Set();
  let started = 0;
  while (performance.now() < end && !stopSignal.stopped) {
    const now = performance.now();
    for (const entry of state) {
      // Request k is due at k / rate seconds, so the first one goes out at once.
      const due = Math.floor(((now - begin) / 1000) * entry.rate) + 1;
      while (entry.issued < due) {
        const index = entry.issued++;
        const spec = entry.make(index);
        if (!spec) continue;
        const dueAt = begin + (index / entry.rate) * 1000;
        started++;
        const task = Promise.resolve(spec.before?.()).then(() => client.request({ ...spec, dueAt })).then(async (result) => {
          const outcome = { name: entry.name, status: result.status, ms: result.ms, error: result.error, at: performance.now() - begin, meta: spec.meta, text: result.text };
          if (spec.after) await spec.after(outcome);
          onResult?.(outcome);
        }).finally(() => inflight.delete(task));
        inflight.add(task);
      }
    }
    await sleep(tickMs);
  }
  await Promise.all([...inflight]);
  return { started, finished: performance.now() - begin };
}

/** The value at percentile p (0 to 100) of `values`, by the nearest-rank method. null for no values. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}
