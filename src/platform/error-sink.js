import { fileURLToPath } from 'node:url';
import { ERROR_EVENT_FIELDS } from '../contracts/metrics.js';

/**
 * Where errors go beside the log (Phase 9). ERROR_SINK picks the driver:
 *
 *   none   nowhere (the default)
 *   http   ERROR_SINK_URL: one JSON document per error, POSTed with Authorization: Bearer ERROR_SINK_TOKEN when set.
 *          Any error tracker with an HTTP intake, or a small relay in front of one, takes it; tools/sim/errors receives it.
 *
 * What is sent is ERROR_EVENT_FIELDS in src/contracts/metrics.js and nothing else: the error's class and code, the name of
 * the log entry, where in the code it was thrown (file, line and function of each frame, with no message), the
 * request id and the business's id. Never the error's message, a request body, an address, a header, a name or a phone:
 * an error message can quote what a person wrote.
 *
 *   const sink = createErrorSink(config, { service: 'web' });
 *   onError(sink.report);          // src/platform/log.js calls it for every reportError()
 *   await sink.flush();            // on drain: waits for what is in flight
 *
 * It never throws and never blocks the caller: at most MAX_IN_FLIGHT posts at once, the rest are dropped and counted.
 */
export const ERROR_SINKS = Object.freeze(['none', 'http']);
const MAX_IN_FLIGHT = 20;
const FRAME = /^\s*at (?:(.+?) \()?(.*?):(\d+):\d+\)?$/;

const localPath = (file) => {
  if (!file.startsWith('file://')) return file;
  try {
    return fileURLToPath(file);
  } catch {
    return file;
  }
};

/** The stack as [{ fn, file, line }], repository-relative, with the message line dropped. At most 20 frames. */
export function framesOf(err, root = '') {
  const lines = String(err?.stack ?? '').split('\n');
  const frames = [];
  for (const line of lines) {
    const found = FRAME.exec(line);
    if (!found) continue;
    const file = localPath(found[2]).replace(/\\/g, '/');
    const at = root ? file.replace(`${root.replace(/\\/g, '/')}/`, '') : file;
    frames.push({ fn: (found[1] ?? '').slice(0, 80), file: at.replace(/^.*\/node_modules\//, 'node_modules/').slice(-160), line: Number(found[3]) });
    if (frames.length === 20) break;
  }
  return frames;
}

/** The document for one error: exactly ERROR_EVENT_FIELDS. */
export function errorEvent(err, context = {}, { service = 'web', release = '', root = '', now = () => new Date() } = {}) {
  const event = {
    time: now().toISOString(),
    service,
    release,
    event: typeof context.msg === 'string' ? context.msg.slice(0, 80) : 'error',
    errorClass: String(err?.name ?? 'Error').slice(0, 80),
    code: err?.code === undefined || err?.code === null ? null : String(err.code).slice(0, 80),
    frames: framesOf(err, root),
    requestId: context.requestId ?? null,
    tenantId: Number.isInteger(context.tenantId) ? context.tenantId : null,
    route: typeof context.route === 'string' ? context.route.slice(0, 80) : null,
  };
  return Object.fromEntries(ERROR_EVENT_FIELDS.map((field) => [field, event[field]]));
}

export function createErrorSink(config = {}, { service = 'web', fetch: send = (...args) => globalThis.fetch(...args), now } = {}) {
  const driver = config.errorSink || 'none';
  if (!ERROR_SINKS.includes(driver)) throw new Error(`Unknown ERROR_SINK "${driver}" (use ${ERROR_SINKS.join(' or ')})`);
  const stats = { sent: 0, failed: 0, dropped: 0 };
  if (driver === 'none') return { driver, report() {}, flush: async () => {}, stats: () => ({ ...stats }) };
  if (!config.errorSinkUrl) throw new Error('ERROR_SINK is http, so ERROR_SINK_URL must be set');
  const inFlight = new Set();
  const headers = { 'content-type': 'application/json', ...(config.errorSinkToken ? { authorization: `Bearer ${config.errorSinkToken}` } : {}) };

  return {
    driver,
    report(err, context = {}) {
      if (inFlight.size >= MAX_IN_FLIGHT) {
        stats.dropped += 1;
        return;
      }
      let body;
      try {
        body = JSON.stringify(errorEvent(err, context, { service, release: config.release ?? '', root: config.rootDir ?? '', ...(now ? { now } : {}) }));
      } catch {
        stats.failed += 1;
        return;
      }
      const post = Promise.resolve()
        .then(() => send(config.errorSinkUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(Number(config.errorSinkTimeoutMs) || 3000), redirect: 'error' }))
        .then((response) => {
          stats[response.ok ? 'sent' : 'failed'] += 1;
        })
        .catch(() => {
          stats.failed += 1;
        })
        .finally(() => inFlight.delete(post));
      inFlight.add(post);
    },
    flush: () => Promise.allSettled([...inFlight]).then(() => {}),
    stats: () => ({ ...stats }),
  };
}
