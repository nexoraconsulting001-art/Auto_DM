import crypto from 'node:crypto';

/**
 * Counters and timings in Prometheus text format at /metrics, so any monitoring tool can scrape them
 * (production adds dashboards and alerts on top). Labels never carry personal data.
 *
 *   metrics.inc('http_requests_total', { status: '200' })
 *   metrics.observe('http_request_seconds', 0.12)
 *   metrics.gauge('queue_jobs', () => [{ labels: { queue: 'dm', status: 'queued' }, value: 3 }])
 */
export function createMetrics() {
  const counters = new Map();
  const timings = new Map();
  const gauges = new Map();
  const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  const key = (labels = {}) => JSON.stringify(Object.entries(labels).sort());
  const fmt = (labels = {}) => {
    const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`);
    return parts.length ? `{${parts.join(',')}}` : '';
  };

  return {
    inc(name, labels = {}, by = 1) {
      const m = counters.get(name) ?? new Map();
      const k = key(labels);
      m.set(k, { labels, value: (m.get(k)?.value ?? 0) + by });
      counters.set(name, m);
    },
    observe(name, seconds, labels = {}) {
      const m = timings.get(name) ?? new Map();
      const k = key(labels);
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
      gauges.set(name, read);
    },
    async render() {
      const out = [];
      for (const [name, m] of counters) {
        out.push(`# TYPE ${name} counter`);
        for (const { labels, value } of m.values()) out.push(`${name}${fmt(labels)} ${value}`);
      }
      for (const [name, m] of timings) {
        out.push(`# TYPE ${name} histogram`);
        for (const t of m.values()) {
          BUCKETS.forEach((b, i) => out.push(`${name}_bucket${fmt({ ...t.labels, le: b })} ${t.buckets[i]}`));
          out.push(`${name}_bucket${fmt({ ...t.labels, le: '+Inf' })} ${t.count}`);
          out.push(`${name}_sum${fmt(t.labels)} ${t.sum}`);
          out.push(`${name}_count${fmt(t.labels)} ${t.count}`);
        }
      }
      for (const [name, read] of gauges) {
        out.push(`# TYPE ${name} gauge`);
        try {
          for (const { labels, value } of await read()) out.push(`${name}${fmt(labels)} ${value}`);
        } catch {
          // A gauge that can't be read right now is left out of this scrape.
        }
      }
      return `${out.join('\n')}\n`;
    },
    /** Express middleware counting requests by method, route group and status, with timings. */
    middleware() {
      return (req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
          const group = req.path.split('/')[1] || 'home';
          const labels = { method: req.method, group: /^[a-z-]{1,20}$/.test(group) ? group : 'other', status: String(res.statusCode) };
          this.inc('http_requests_total', labels);
          this.observe('http_request_seconds', Number(process.hrtime.bigint() - start) / 1e9, { group: labels.group });
        });
        next();
      };
    },
    /** Express handler for /metrics, protected by METRICS_TOKEN (Bearer). Hidden when no token is set. */
    handler(token) {
      return async (req, res) => {
        const sent = (req.get('authorization') || '').replace(/^Bearer /, '');
        const ok = token && sent.length === token.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(token));
        if (!ok) return res.sendStatus(404);
        res.type('text/plain; version=0.0.4').send(await this.render());
      };
    },
  };
}
