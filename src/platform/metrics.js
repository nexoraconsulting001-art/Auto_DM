import crypto from 'node:crypto';
import { FORBIDDEN_LABELS, METRICS, METRIC_LABELS, metricProblem } from '../contracts/metrics.js';
import { reportError } from './log.js';

/**
 * Counters, gauges and timings in Prometheus text format at /metrics, so any monitoring tool can scrape them (Phase 9).
 * Every name, type and label is checked against the catalogue (METRICS in src/contracts/metrics.js):
 *
 *   metrics.inc('http_requests_total', { method: 'GET', group: 'store', status: '200' })
 *   metrics.observe('http_request_seconds', 0.12, { group: 'store' })
 *   metrics.gauge('queue_jobs', () => [{ labels: { queue: 'dm', status: 'queued' }, value: 3 }])
 *
 * - A label the catalogue does not give a metric, a value outside a label's set, or a type used the wrong way is not written;
 *   `createMetrics({ strict: true })` throws instead (the tests), and also refuses a name the catalogue does not have. rejected() lists what was refused.
 * - Each metric holds at most `maxSeries` label combinations; a new one beyond that is dropped, so no label can grow without bound.
 * - Label values never carry a business, person, address or text (FORBIDDEN_LABELS), so /metrics holds no personal data.
 * - /metrics answers only with its token; without one configured it does not exist. handler(token) is the web server's
 *   (Express) and serve(req, res, token) the worker's probe server's (node:http): both give the same answer.
 * - The middleware also counts webhook requests by provider and outcome, and requests in flight.
 * - Setting `backup_last_success_seconds` also gives `backup_age_seconds`.
 */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DEFAULT_MAX_SERIES = 500;

/** Which outside service's webhook a request is, from its method and path; null for any other request. */
export function webhookProviderOf(method, path) {
  if (method !== 'POST') return null;
  if (path === '/webhook') return 'meta';
  if (path === '/webhooks/whatsapp') return 'whatsapp';
  if (path === '/webhooks/courier') return 'shiprocket';
  if (path === '/webhooks/shopify') return 'shopify';
  if (path === '/webhooks/billing/razorpay') return 'razorpay_billing';
  if (path === '/webhooks/razorpay' || path.startsWith('/webhooks/razorpay/')) return 'razorpay';
  return null;
}

/** accepted (the 2xx), bad_signature (refused as not genuine), or refused (any other answer, including every fault of ours). */
export const webhookResultOf = (status) => (status < 300 ? 'accepted' : [400, 401, 403].includes(status) ? 'bad_signature' : 'refused');

/** The call class of a Meta call, from what it did. */
export function metaCallClass({ method = 'GET', pathname = '' } = {}) {
  const path = String(pathname);
  if (/(^|\/)(oauth|refresh_access_token|debug_token|access_token)/.test(path)) return 'token';
  if (/\/messages$|\/message_attachments$|\/replies$|\/private_replies$/.test(path)) return 'send';
  if (/\/insights$|\/insights\//.test(path)) return 'insights';
  if (/subscribed_apps/.test(path)) return 'subscribe';
  if (/\/(media|media_publish|stories)$/.test(path)) return 'media';
  return method === 'GET' ? 'read' : 'other';
}

/** ok, throttled, token_error, timeout or error. */
export function metaCallResult({ status = 0, kind } = {}) {
  if (kind === 'throttled' || kind === 'buc_throttled') return 'throttled';
  if (kind === 'token_invalid') return 'token_error';
  if (kind === 'timeout' || kind === 'network') return 'timeout';
  if (kind || status >= 400 || status === 0) return 'error';
  return 'ok';
}

/** The compliance gate's outcomes (src/contracts/compliance.js OUTCOMES) as compliance_outcomes_total's five. */
const SEND_OUTCOMES = Object.freeze({
  sent: 'sent', sent_fallback: 'sent', queued: 'queued', held: 'blocked', failed: 'failed', unknown: 'failed',
  cancelled: 'skipped', expired: 'skipped', skipped: 'skipped', would_send: 'skipped',
});

/**
 * The labels one send decision is counted under: compliance_outcomes_total { channel, outcome, family } (family is the
 * reason code's first part, 'none' without one) and, when a provider took the message, sends_accepted_total. null for a
 * channel outside the label set.
 */
export function sendOutcomeLabels(channel, { outcome, reason = '' } = {}) {
  if (!METRIC_LABELS.channel.values.includes(channel)) return null;
  const family = String(reason || '').split('.')[0] || 'none';
  const mapped = SEND_OUTCOMES[outcome] ?? 'failed';
  return { channel, outcome: mapped, family: /^[a-z][a-z_]{0,20}$/.test(family) ? family : 'other', accepted: mapped === 'sent' };
}

/** One webhook delivery written down before the 200 (webhook_stored_total; WebhookNotStored compares it with the accepted ones). */
export function countWebhookStored(metrics, provider) {
  metrics?.inc('webhook_stored_total', { provider });
}

/** One stored webhook event worked through (webhook_processed_total): its final status, 'retry' when it will be tried again, or 'failed' when given up. */
export function countWebhookProcessed(metrics, provider, result) {
  metrics?.inc('webhook_processed_total', { provider, result });
}

/** The onAlert of loadSecrets() for both processes: reported, and counted once the platform's metrics exist. */
export function secretRefreshFailed(metricsOf) {
  return (alert = {}) => {
    reportError(new Error('secrets.refresh_failed'), { msg: 'secrets.refresh_failed', code: alert.code });
    metricsOf()?.inc('secret_refresh_failures_total');
  };
}

/** A log entry's name as a bounded label: its first dotted part, lower snake case, 30 characters at most. */
export function errorKind(msg) {
  const first = String(msg ?? '').split('.')[0].toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return /^[a-z]/.test(first) ? first : 'error';
}

export function createMetrics({ strict = false, maxSeries = DEFAULT_MAX_SERIES, service = 'web', now = () => Date.now() } = {}) {
  const counters = new Map();
  const timings = new Map();
  const gauges = new Map();
  const refused = new Map();
  let inFlight = 0;
  const key = (labels = {}) => JSON.stringify(Object.entries(labels).sort());
  const fmt = (labels = {}) => {
    const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`);
    return parts.length ? `{${parts.join(',')}}` : '';
  };
  const refuseWhy = (why) => refused.set(why, (refused.get(why) ?? 0) + 1);

  /**
   * True when this write is refused. It throws instead when strict. A catalogued metric is held to its type, labels and values.
   * One the catalogue does not have is refused when strict; otherwise it is written, but a forbidden label name or a long label
   * value is still refused, and the series limit still holds, so even an uncatalogued metric cannot grow without bound.
   */
  function problemOf(name, labels, type) {
    if (METRICS[name]) return metricProblem(name, labels) ?? (METRICS[name].type !== type ? `${name} is a ${METRICS[name].type}, not a ${type}` : null);
    if (strict) return `${name} is not in the catalogue`;
    const bad = Object.entries(labels).find(([label, value]) => FORBIDDEN_LABELS.includes(label) || String(value).length > 40);
    return bad ? `${name} has the label ${bad[0]}` : null;
  }
  function refuse(name, labels, type) {
    const why = problemOf(name, labels, type);
    if (!why) return false;
    if (strict) throw new Error(why);
    refuseWhy(why);
    return true;
  }
  const full = (store, name, k) => {
    const m = store.get(name);
    if (m && !m.has(k) && m.size >= maxSeries) {
      refuseWhy(`${name} is at its series limit`);
      return true;
    }
    return false;
  };

  const self = {
    inc(name, labels = {}, by = 1) {
      if (refuse(name, labels, 'counter')) return;
      const k = key(labels);
      if (full(counters, name, k)) return;
      const m = counters.get(name) ?? new Map();
      m.set(k, { labels, value: (m.get(k)?.value ?? 0) + by });
      counters.set(name, m);
    },
    observe(name, seconds, labels = {}) {
      if (refuse(name, labels, 'histogram')) return;
      const k = key(labels);
      if (full(timings, name, k)) return;
      const m = timings.get(name) ?? new Map();
      const t = m.get(k) ?? { labels, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      t.count++;
      t.sum += seconds;
      BUCKETS.forEach((b, i) => {
        if (seconds <= b) t.buckets[i]++;
      });
      m.set(k, t);
      timings.set(name, m);
    },
    gauge(name, read) {
      if (refuse(name, {}, 'gauge')) return;
      gauges.set(name, read);
      if (name === 'backup_last_success_seconds') {
        gauges.set('backup_age_seconds', async () => (await read()).map(({ labels, value }) => ({ labels, value: Math.max(0, Math.floor(now() / 1000) - value) })));
      }
    },
    /** What the catalogue refused, by reason: [] when nothing was. */
    rejected: () => [...refused].map(([why, count]) => ({ why, count })),
    async render() {
      const out = [];
      const head = (name, type) => out.push(`# HELP ${name} ${METRICS[name]?.help ?? name}`, `# TYPE ${name} ${type}`);
      for (const [name, m] of counters) {
        head(name, 'counter');
        for (const { labels, value } of m.values()) out.push(`${name}${fmt(labels)} ${value}`);
      }
      for (const [name, m] of timings) {
        head(name, 'histogram');
        for (const t of m.values()) {
          BUCKETS.forEach((b, i) => out.push(`${name}_bucket${fmt({ ...t.labels, le: b })} ${t.buckets[i]}`));
          out.push(`${name}_bucket${fmt({ ...t.labels, le: '+Inf' })} ${t.count}`);
          out.push(`${name}_sum${fmt(t.labels)} ${t.sum}`);
          out.push(`${name}_count${fmt(t.labels)} ${t.count}`);
        }
      }
      const sources = new Map([['http_requests_in_flight', async () => [{ labels: { service }, value: inFlight }]], ...gauges]);
      for (const [name, read] of sources) {
        const lines = [];
        try {
          for (const { labels, value } of await read()) {
            if ((METRICS[name] && metricProblem(name, labels)) || !Number.isFinite(Number(value))) continue;
            lines.push(`${name}${fmt(labels)} ${value}`);
          }
        } catch {
          // A gauge that can't be read right now is left out of this scrape.
          continue;
        }
        if (lines.length) out.push(`# HELP ${name} ${METRICS[name]?.help ?? name}`, `# TYPE ${name} gauge`, ...lines);
      }
      return `${out.join('\n')}\n`;
    },
    /** Express middleware counting requests by method, route group and status, with timings, requests in flight and webhooks by provider. */
    middleware() {
      return (req, res, next) => {
        const start = process.hrtime.bigint();
        let done = false;
        inFlight++;
        const finish = () => {
          if (done) return;
          done = true;
          inFlight--;
          const group = req.path.split('/')[1] || 'home';
          const labels = { method: req.method, group: /^[a-z-]{1,20}$/.test(group) ? group : 'other', status: String(res.statusCode) };
          self.inc('http_requests_total', labels);
          self.observe('http_request_seconds', Number(process.hrtime.bigint() - start) / 1e9, { group: labels.group });
          const provider = webhookProviderOf(req.method, req.path);
          if (provider) self.inc('webhook_received_total', { provider, result: webhookResultOf(res.statusCode) });
        };
        res.on('finish', finish);
        res.on('close', finish);
        next();
      };
    },
    /** The answer to a scrape: 200 and the text with the right token (Bearer), 404 otherwise or when no token is set. */
    async answer(authorization, token) {
      const header = String(authorization || '');
      const sent = header.startsWith('Bearer ') ? header.slice(7) : '';
      const ok = Boolean(token) && sent.length === token.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(token));
      return ok ? { status: 200, type: 'text/plain; version=0.0.4', body: await self.render() } : { status: 404, type: 'text/plain', body: 'Not Found' };
    },
    /** Express handler for /metrics, protected by METRICS_TOKEN (Bearer). Hidden when no token is set. */
    handler(token) {
      return async (req, res) => {
        const { status, type, body } = await self.answer(req.get('authorization'), token);
        res.set('Cache-Control', 'no-store');
        res.status(status).type(type).send(body);
      };
    },
    /** The same on a node:http server (the worker's probe server): answers /metrics and returns true; false for any other path. */
    serve(req, res, token) {
      if (new URL(req.url, 'http://x').pathname !== '/metrics') return false;
      self.answer(req.headers.authorization, token).then(({ status, type, body }) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
      }, () => {
        res.writeHead(500, { 'cache-control': 'no-store' });
        res.end();
      });
      return true;
    },
  };
  return self;
}

const instrumented = new WeakSet();

/**
 * Counts every run of a queue's jobs (job_runs_total by queue and result, job_failures_total) through the queue's onRun(),
 * which both drivers call from the one path every job runs through (src/platform/queue.js). Once per queue object.
 * Returns false when the queue has no onRun() or is already counted.
 */
export function instrumentQueue(metrics, queue) {
  if (typeof queue?.onRun !== 'function' || instrumented.has(queue)) return false;
  instrumented.add(queue);
  queue.onRun(({ queue: name, result }) => {
    metrics.inc('job_runs_total', { queue: name, result });
    if (result === 'failed') metrics.inc('job_failures_total', { queue: name });
  });
  return true;
}
