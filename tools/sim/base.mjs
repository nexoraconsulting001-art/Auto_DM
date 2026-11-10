/**
 * What every simulator shares: one HTTP server on loopback, with a control surface under /__sim that is
 * never faulted and never recorded.
 *
 *   GET    /__sim/health
 *   GET    /__sim/calls?method=&path=&since=     every request the service received, oldest first
 *   DELETE /__sim/calls
 *   GET    /__sim/faults                         faults still waiting to fire
 *   POST   /__sim/faults                         adds one (see below); returns it with its id
 *   DELETE /__sim/faults[/:id]
 *   GET    /__sim/clock
 *   POST   /__sim/clock                          { now?, advanceMs?, freeze? }; every service rule reads this clock
 *   POST   /__sim/reset                          faults, calls, clock and the service's data back to the start
 *
 * Fault: { kind, match?, times?, after?, ...options }
 *   match    { method?, path?, query?, body? }: path is the path as sent and may use *; query and body match
 *            as a subset, and the value "*" means present with any value
 *   times    how many requests it fires on (default 1), or "forever"
 *   after    let this many matching requests through first (default 0)
 *   kind:
 *     timeout       never answers. delayMs drops the connection after that long
 *     rate_limit    status (default 429), retryAfter (seconds), and the service's own error shape
 *     server_error  status (500 to 599, default 500)
 *     malformed     mode: truncated | html | empty | garbage | wrong_shape | aborted (headers and half a body)
 *     drop          resets the connection without answering
 *     partial       the request takes effect, then the answer fails: then is server_error, timeout, drop or
 *                   malformed (default server_error), or give status and/or body to answer exactly that
 *   rate_limit, server_error, malformed and partial accept headers; rate_limit, server_error and partial accept body.
 *
 * In-process callers use sim.post('/faults', spec) and sim.get('/calls'): the same handlers, without HTTP.
 */
import http from 'node:http';
import { assertSimulatorsAllowed, isLoopbackHost } from './guard.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_CALLS = 20_000;
const CONTROL_PREFIX = '/__sim';

const FAULT_KEYS = new Set(['kind', 'match', 'times', 'after', 'status', 'body', 'headers', 'retryAfter', 'delayMs', 'mode', 'then', 'code', 'subcode', 'regainMinutes']);
const FAULT_KINDS = new Set(['timeout', 'rate_limit', 'server_error', 'malformed', 'drop', 'partial']);
const PARTIAL_THEN = new Set(['server_error', 'timeout', 'drop', 'malformed']);
const MATCH_KEYS = new Set(['method', 'path', 'query', 'body']);
const MALFORMED_BODIES = {
  truncated: '{"data":[{"id":"1","na',
  html: '<!doctype html><title>Bad gateway</title><h1>Bad gateway</h1>',
  empty: '',
  garbage: '\u0000\ufffd<<not json>>',
  wrong_shape: '[1,2,3]',
};

/** Thrown by a handler to refuse a request; `body` is what the caller receives. */
export class SimError extends Error {
  constructor(status, body, headers = {}) {
    super(typeof body === 'string' ? body : body?.error?.message ?? body?.error ?? `HTTP ${status}`);
    this.name = 'SimError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** A handler's answer when plain 200 JSON will not do. */
export const reply = (status, body, headers = {}) => new Reply(status, body, headers);

const badInput = (error) => new SimError(400, { error });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function compilePath(pattern) {
  const keys = [];
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function createTable() {
  const routes = [];
  return {
    on(method, pattern, handler) {
      routes.push({ method, handler, ...compilePath(pattern) });
    },
    find(method, path) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(path);
        if (match) return { handler: route.handler, params: Object.fromEntries(route.keys.map((key, i) => [key, decodeSegment(match[i + 1])])) };
      }
      return null;
    },
  };
}

function createClock() {
  let offset = 0;
  let frozenAt = null;
  const clock = {
    now: () => frozenAt ?? Date.now() + offset,
    get frozen() {
      return frozenAt !== null;
    },
    advance(ms) {
      if (frozenAt !== null) frozenAt += ms;
      else offset += ms;
    },
    set(ms) {
      if (frozenAt !== null) frozenAt = ms;
      else offset = ms - Date.now();
    },
    freeze(on) {
      if (on && frozenAt === null) frozenAt = Date.now() + offset;
      if (!on && frozenAt !== null) {
        offset = frozenAt - Date.now();
        frozenAt = null;
      }
    },
    reset() {
      offset = 0;
      frozenAt = null;
    },
  };
  return clock;
}

const globToRegex = (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

function isSubset(expected, actual) {
  if (expected === '*') return actual !== undefined && actual !== null;
  if (!isObject(expected)) return String(expected) === String(actual);
  return isObject(actual) && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
}

/** A typo in a fault must fail the test that wrote it, not quietly inject nothing. */
function checkFault(spec) {
  if (!isObject(spec)) throw badInput('A fault must be an object.');
  for (const key of Object.keys(spec)) if (!FAULT_KEYS.has(key)) throw badInput(`Unknown fault option "${key}".`);
  if (!FAULT_KINDS.has(spec.kind)) throw badInput(`Unknown fault kind "${spec.kind}". Use one of: ${[...FAULT_KINDS].join(', ')}.`);
  const times = spec.times ?? 1;
  if (times !== 'forever' && !(Number.isInteger(times) && times >= 1)) throw badInput('times must be a whole number from 1, or "forever".');
  const after = spec.after ?? 0;
  if (!Number.isInteger(after) || after < 0) throw badInput('after must be a whole number from 0.');
  if (spec.match !== undefined) {
    if (!isObject(spec.match)) throw badInput('match must be an object.');
    for (const key of Object.keys(spec.match)) if (!MATCH_KEYS.has(key)) throw badInput(`Unknown match option "${key}".`);
    if (spec.match.path !== undefined && typeof spec.match.path !== 'string') throw badInput('match.path must be a string.');
    if (spec.match.method !== undefined && typeof spec.match.method !== 'string') throw badInput('match.method must be a string.');
  }
  if (spec.kind === 'server_error' && spec.status !== undefined && !(Number.isInteger(spec.status) && spec.status >= 500 && spec.status <= 599)) {
    throw badInput('A server_error status must be 500 to 599.');
  }
  if (spec.kind === 'rate_limit' && spec.status !== undefined && !(Number.isInteger(spec.status) && spec.status >= 400 && spec.status <= 499)) {
    throw badInput('A rate_limit status must be 400 to 499.');
  }
  if (spec.mode !== undefined && spec.mode !== 'aborted' && !Object.hasOwn(MALFORMED_BODIES, spec.mode)) throw badInput(`Unknown malformed mode "${spec.mode}".`);
  if (spec.then !== undefined && !PARTIAL_THEN.has(spec.then)) throw badInput(`Unknown partial then "${spec.then}".`);
  if (spec.delayMs !== undefined && !(Number.isFinite(spec.delayMs) && spec.delayMs >= 0)) throw badInput('delayMs must be a number from 0.');
  return { ...spec, times, after };
}

function readBody(rq) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    rq.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SimError(413, { error: 'Request body too large.' }));
        rq.destroy();
        return;
      }
      chunks.push(chunk);
    });
    rq.on('end', () => resolve(Buffer.concat(chunks)));
    rq.on('error', reject);
  });
}

async function parseBody(raw, contentType = '') {
  if (!raw.length) return { body: undefined };
  const type = contentType.split(';')[0].trim().toLowerCase();
  try {
    if (type === 'application/json' || type.endsWith('+json')) return { body: JSON.parse(raw.toString('utf8')) };
    if (type === 'application/x-www-form-urlencoded') return { body: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) };
    if (type === 'multipart/form-data') return { body: Object.fromEntries(await new Response(raw, { headers: { 'content-type': contentType } }).formData()) };
  } catch {
    return { bodyError: true };
  }
  return { body: raw.toString('utf8') };
}

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return '';
  }
}

function write(rs, { status, body, headers = {} }) {
  const isJson = body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = body === undefined || body === null ? '' : isJson ? JSON.stringify(body) : body;
  rs.writeHead(status, {
    ...(isJson ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
    ...headers,
    'content-length': Buffer.byteLength(payload),
  });
  rs.end(payload);
}

/**
 * `spec`: { name, routes(on), controls?(on), reset?(), rewritePath?(path), errorBody?({ kind, status, fault, req }),
 * decorate?(req, fault), notFound?(req) }. Handlers get { method, path, rawPath, params, query, body, headers }
 * and return a value (200 JSON) or reply(status, body, headers), or throw SimError. A handler that does not
 * await is atomic, so two racing requests cannot both pass a check.
 */
export function createSim(spec) {
  const clock = createClock();
  const routes = createTable();
  const controls = createTable();
  const held = new Set();
  let faults = [];
  let calls = [];
  let faultSeq = 0;
  let callSeq = 0;
  let server = null;

  const errorBody = spec.errorBody ?? (({ status, kind }) => ({ error: { code: kind, message: `Simulated ${kind} (${status}).` } }));

  async function run(table, req, notFound) {
    try {
      const route = table.find(req.method, req.path);
      if (!route) return notFound ? await notFound(req) : reply(404, { error: `No route for ${req.method} ${req.path}.` });
      req.params = route.params;
      const out = await route.handler(req);
      return out instanceof Reply ? out : reply(200, out ?? {});
    } catch (err) {
      if (err instanceof SimError) return reply(err.status, err.body, err.headers);
      process.stderr.write(`[sim:${spec.name}] handler failed: ${err.stack}\n`);
      return reply(500, { error: `Simulator bug: ${err.message}` });
    }
  }

  const runService = (req) =>
    run(routes, req, spec.notFound && ((r) => {
      const out = spec.notFound(r);
      return out instanceof Reply ? out : reply(404, out);
    }));

  function matches(fault, req) {
    const match = fault.match;
    if (!match) return true;
    if (match.method && match.method.toUpperCase() !== req.method) return false;
    if (match.path && !globToRegex(match.path).test(req.rawPath)) return false;
    if (match.query && !isSubset(match.query, req.query)) return false;
    if (match.body && !isSubset(match.body, req.body)) return false;
    return true;
  }

  /** Claims a firing before any await, so racing requests each use up their own. */
  function takeFault(req) {
    for (const fault of faults) {
      if (!matches(fault, req)) continue;
      if (fault.skipped < fault.after) {
        fault.skipped++;
        continue;
      }
      fault.fired++;
      if (fault.times !== 'forever' && fault.fired >= fault.times) faults = faults.filter((f) => f !== fault);
      return fault;
    }
    return null;
  }

  function finish(rs, call, out, req, fault) {
    write(rs, { ...out, headers: { ...spec.decorate?.(req, fault), ...out.headers } });
    call.status = out.status;
    call.response = out.body ?? null;
  }

  function hold(rs, fault) {
    held.add(rs);
    const timer = fault.delayMs !== undefined ? setTimeout(() => rs.destroy(), fault.delayMs) : null;
    timer?.unref();
    rs.on('close', () => {
      held.delete(rs);
      if (timer) clearTimeout(timer);
    });
  }

  function sendMalformed(rs, call, fault) {
    const status = fault.status ?? 200;
    const mode = fault.mode ?? 'truncated';
    call.status = status;
    if (mode === 'aborted') {
      rs.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', 'content-length': 4096, ...fault.headers });
      rs.write('{"data":[', () => rs.destroy());
      return;
    }
    rs.writeHead(status, { 'content-type': mode === 'html' ? 'text/html' : 'application/json; charset=UTF-8', 'content-length': Buffer.byteLength(MALFORMED_BODIES[mode]), ...fault.headers });
    rs.end(MALFORMED_BODIES[mode]);
  }

  async function inject(fault, req, rs, call) {
    const { kind } = fault;
    if (kind === 'partial') {
      const out = await runService(req);
      call.applied = out.status < 400;
      call.handled = { status: out.status, body: out.body ?? null };
      if (fault.status !== undefined || fault.body !== undefined) {
        return finish(rs, call, reply(fault.status ?? out.status, fault.body ?? out.body, fault.headers), req, fault);
      }
      return inject({ ...fault, kind: fault.then ?? 'server_error' }, req, rs, call);
    }
    if (kind === 'timeout') return hold(rs, fault);
    if (kind === 'drop') return rs.destroy();
    if (kind === 'malformed') return sendMalformed(rs, call, fault);
    const status = fault.status ?? (kind === 'rate_limit' ? 429 : 500);
    const retryAfter = kind === 'rate_limit' && fault.retryAfter !== undefined ? { 'retry-after': String(fault.retryAfter) } : {};
    finish(rs, call, reply(status, fault.body ?? errorBody({ kind, status, fault, req }), { ...retryAfter, ...fault.headers }), req, fault);
  }

  async function onRequest(rq, rs) {
    try {
      // A browser page cannot reach the control surface by rebinding a public name to loopback.
      if (!isLoopbackHost(hostnameOf(rq.headers.host))) return write(rs, { status: 403, body: { error: 'Simulators answer on loopback only.' } });
      const url = new URL(rq.url, 'http://sim.localhost');
      const { body, bodyError } = await parseBody(await readBody(rq), rq.headers['content-type']);
      const base = { method: rq.method, rawPath: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: rq.headers, params: {} };

      if (url.pathname === CONTROL_PREFIX || url.pathname.startsWith(`${CONTROL_PREFIX}/`)) {
        if (bodyError || (body !== undefined && !isObject(body))) return write(rs, { status: 400, body: { error: 'The control body must be a JSON object.' } });
        const out = await run(controls, { ...base, path: url.pathname.slice(CONTROL_PREFIX.length) || '/', body: body ?? {} });
        return write(rs, out);
      }

      const req = { ...base, path: spec.rewritePath?.(url.pathname) ?? url.pathname };
      const call = { seq: ++callSeq, at: clock.now(), method: req.method, path: req.rawPath, query: req.query, headers: req.headers, body: body ?? null, status: null, response: null, applied: false, fault: null };
      calls.push(call);
      if (calls.length > MAX_CALLS) calls.shift();

      const fault = takeFault(req);
      if (fault) {
        call.fault = { id: fault.id, kind: fault.kind };
        return await inject(fault, req, rs, call);
      }
      if (bodyError) return finish(rs, call, reply(400, errorBody({ kind: 'bad_request', status: 400, fault: {}, req })), req);
      const out = await runService(req);
      call.applied = out.status < 400;
      finish(rs, call, out, req);
    } catch (err) {
      if (rs.headersSent) return void rs.destroy();
      if (err instanceof SimError) return write(rs, { status: err.status, body: err.body, headers: err.headers });
      process.stderr.write(`[sim:${spec.name}] request failed: ${err.stack}\n`);
      write(rs, { status: 500, body: { error: `Simulator bug: ${err.message}` } });
    }
  }

  function resetAll() {
    faults = [];
    calls = [];
    clock.reset();
    spec.reset?.();
  }

  controls.on('GET', '/health', () => ({ ok: true, name: spec.name }));
  controls.on('GET', '/calls', ({ query }) => ({
    calls: calls.filter((c) => (!query.method || c.method === query.method.toUpperCase()) && (!query.path || globToRegex(query.path).test(c.path)) && (!query.since || c.seq > Number(query.since))),
  }));
  controls.on('DELETE', '/calls', () => {
    calls = [];
    return { ok: true };
  });
  controls.on('GET', '/faults', () => ({ faults }));
  controls.on('POST', '/faults', ({ body }) => {
    const fault = { id: `f${++faultSeq}`, ...checkFault(body), fired: 0, skipped: 0 };
    faults.push(fault);
    return fault;
  });
  controls.on('DELETE', '/faults', () => {
    faults = [];
    return { ok: true };
  });
  controls.on('DELETE', '/faults/:id', ({ params }) => {
    const before = faults.length;
    faults = faults.filter((f) => f.id !== params.id);
    if (faults.length === before) throw new SimError(404, { error: `No fault ${params.id}.` });
    return { ok: true };
  });
  controls.on('GET', '/clock', () => ({ now: clock.now(), frozen: clock.frozen }));
  controls.on('POST', '/clock', ({ body }) => {
    for (const key of ['now', 'advanceMs']) if (body[key] !== undefined && !Number.isFinite(body[key])) throw badInput(`${key} must be a number.`);
    if (body.freeze !== undefined) clock.freeze(Boolean(body.freeze));
    if (body.now !== undefined) clock.set(body.now);
    if (body.advanceMs !== undefined) clock.advance(body.advanceMs);
    return { now: clock.now(), frozen: clock.frozen };
  });
  controls.on('POST', '/reset', () => {
    resetAll();
    return { ok: true };
  });

  async function control(method, path, body = {}, query = {}) {
    const out = await run(controls, { method, path, rawPath: `${CONTROL_PREFIX}${path}`, query, body, headers: {}, params: {} });
    if (out.status >= 400) throw new SimError(out.status, out.body);
    return out.body;
  }

  const sim = {
    name: spec.name,
    url: null,
    port: null,
    clock,
    /** Listens on 127.0.0.1 only; there is no option to bind anywhere else. */
    async start({ port = 0, env = process.env } = {}) {
      assertSimulatorsAllowed(env);
      if (server) throw new Error(`The ${spec.name} simulator is already running.`);
      const listener = http.createServer(onRequest);
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
      });
      server = listener;
      sim.port = listener.address().port;
      sim.url = `http://127.0.0.1:${sim.port}`;
      return sim;
    },
    async close() {
      if (!server) return;
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closing;
      server = null;
    },
    post: (path, body) => control('POST', path, body),
    get: (path, query) => control('GET', path, undefined, query),
    delete: (path) => control('DELETE', path),
    fault: (faultSpec) => control('POST', '/faults', faultSpec),
    calls: async (query) => (await control('GET', '/calls', undefined, query)).calls,
  };

  spec.routes(routes.on);
  spec.controls?.(controls.on);
  return sim;
}
