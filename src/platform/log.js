import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentTenant } from '../tenancy.js';

/**
 * Structured logs: one JSON line per entry with the time, level, message, business and request id,
 * so production log tools can search and alert on them. LOG_FORMAT=pretty prints readable lines.
 * Never pass message text, usernames or other personal data as fields (PRD 11, Privacy); fields with such names are dropped.
 *
 *   log.info('webhook.received', { entries: 2 })    log.warn(...)    log.error(..., { err })
 *   reportError(err, fields)    logs it and passes it to every reporter added with onError()
 */
const requestContext = new AsyncLocalStorage();
const PRIVATE_FIELD = /^(user_?name|ig_?user_?name|text|message|body|caption|comment|reply|phone|mobile|email|address|password|passwd|secret|api_?key|token|access_?token|refresh_?token|authorization|cookie|signature)$/i;
const SECRET_SHAPES = [
  [/(Bearer\s+)[\w.~+/=-]+/gi, '$1[token]'],
  [/\b(EAA|IGQ|IGAA)[\w-]{12,}/g, '[token]'],
  [/\b(rzp_(?:live|test)_|sk_(?:live|test)_|shpat_|whsec_)[\w-]+/gi, '[key]'],
  [/\b((?:access_|refresh_)?token|api_?key|key|secret|password|signature)=[^&\s"']+/gi, '$1=[redacted]'],
  [/\+?\d(?:[ -]?\d){9,}/g, '[number]'],
];
/** Takes secret-shaped and phone-shaped text out of a string: an error's message can quote what a person wrote or a request carried. */
export function scrub(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_SHAPES) out = out.replace(pattern, replacement);
  return out;
}
const clean = (value, depth = 0) => {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object' || value instanceof Error) return value;
  if (depth >= 2) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELD.test(key)).map(([key, v]) => [key, clean(v, depth + 1)]));
};
const reporters = [];
let format = process.env.LOG_FORMAT || 'json';
let sink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

export const setLogFormat = (f) => (format = f);
/** Replaces where log lines go (tests). */
export const setLogSink = (fn) => (sink = fn);

export const withRequestId = (id, fn) => requestContext.run({ requestId: id }, fn);
export const currentRequestId = () => requestContext.getStore()?.requestId ?? null;

function write(level, msg, given = {}) {
  const fields = Object.fromEntries(Object.entries(given).filter(([key]) => !PRIVATE_FIELD.test(key)).map(([key, v]) => [key, clean(v)]));
  const tenant = currentTenant();
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: scrub(String(msg)),
    ...(tenant?.slug || tenant?.id ? { tenant: tenant.slug || tenant.id } : {}),
    ...(tenant?.id ? { tenantId: tenant.id } : {}),
    ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
    ...fields,
  };
  if (entry.err instanceof Error) {
    // The first line of a stack is the message, so only the frames are kept; the message is kept apart, with secret and phone shapes taken out.
    const frames = String(entry.err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).join('\n');
    entry.err = { name: entry.err.name, ...(entry.err.code ? { code: String(entry.err.code).slice(0, 80) } : {}), message: scrub(entry.err.message), stack: scrub(frames) };
  }
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
  const context = { ...fields, tenant: currentTenant()?.slug, tenantId: currentTenant()?.id ?? null, requestId: currentRequestId() };
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
