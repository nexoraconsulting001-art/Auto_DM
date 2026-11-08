import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentTenant } from '../tenancy.js';

/**
 * Structured logs: one JSON line per entry with the time, level, message, business and request id,
 * so production log tools can search and alert on them. LOG_FORMAT=pretty prints readable lines.
 * Never pass message text, usernames or other personal data as fields (PRD 11, Privacy).
 *
 *   log.info('webhook.received', { entries: 2 })    log.warn(...)    log.error(..., { err })
 *   reportError(err, fields)    logs it and passes it to every reporter added with onError()
 */
const requestContext = new AsyncLocalStorage();
const reporters = [];
let format = process.env.LOG_FORMAT || 'json';
let sink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

export const setLogFormat = (f) => (format = f);
/** Replaces where log lines go (tests). */
export const setLogSink = (fn) => (sink = fn);

export const withRequestId = (id, fn) => requestContext.run({ requestId: id }, fn);
export const currentRequestId = () => requestContext.getStore()?.requestId ?? null;

function write(level, msg, fields = {}) {
  const tenant = currentTenant();
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(tenant?.slug || tenant?.id ? { tenant: tenant.slug || tenant.id } : {}),
    ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
    ...fields,
  };
  if (entry.err instanceof Error) entry.err = { message: entry.err.message, stack: entry.err.stack };
  const line = format === 'pretty'
    ? `${entry.time} ${level.toUpperCase().padEnd(5)} ${entry.tenant ? `[${entry.tenant}] ` : ''}${msg}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`
    : JSON.stringify(entry);
  sink(line, level);
}

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

/** Adds an error reporter (e.g. Sentry in production): fn(err, context). */
export function onError(fn) {
  reporters.push(fn);
}

export function reportError(err, fields = {}) {
  log.error(fields.msg || err?.message || 'error', { ...fields, err });
  const context = { ...fields, tenant: currentTenant()?.slug, requestId: currentRequestId() };
  for (const fn of reporters) {
    try {
      fn(err, context);
    } catch {
      // A broken reporter must never break the request.
    }
  }
}

/** Express middleware: a request id per request (kept from X-Request-Id when sent), echoed back. */
export function requestIds() {
  return (req, res, next) => {
    const given = req.get('x-request-id');
    const id = given && /^[\w-]{8,64}$/.test(given) ? given : crypto.randomUUID();
    res.set('X-Request-Id', id);
    withRequestId(id, next);
  };
}
