/**
 * What the store's simulators share for sending webhooks to the app: signing left to each service, delivery, duplicates,
 * holding events back to send them out of order, and a record of what was sent. Webhooks only ever go to this machine.
 *
 *   const hooks = createWebhooks({ clock, url, sign });
 *   await hooks.send(payload, { duplicates?, signature?: 'good' | 'bad' | 'none', hold?, url?, headers? })
 *       -> { id, delivered, attempts, status } or { id, held: true }
 *   await hooks.flush({ order?: 'sent' | 'reverse' | [ids] })   delivers what was held, in the order asked (out-of-order events)
 *   await hooks.redeliver(id, { times? })                       the same bytes again (a provider's retry)
 *   hooks.list()                                                every delivery, oldest first: { id, body, signature, attempts, status, ok, held }
 *   hooks.setUrl(url)    hooks.reset()
 *
 * `sign(raw, payload, { bad })` returns the headers a real delivery carries; with bad it signs with a wrong secret.
 * A delivery the app does not answer is recorded with ok false and never thrown, as a provider would retry later.
 */
import { SimError } from './base.mjs';
import { isLoopbackUrl } from './guard.mjs';

const TIMEOUT_MS = 10_000;

export function createWebhooks({ clock, url: defaultUrl = null, sign }) {
  let url = defaultUrl;
  let seq = 0;
  let records = [];

  const view = (r) => ({ id: r.id, url: r.url, at: r.at, body: r.body, signature: r.signature, attempts: r.attempts, status: r.status, ok: r.ok, held: r.held, error: r.error });
  const outcome = (r) => (r.held ? { id: r.id, held: true } : { id: r.id, delivered: r.ok, attempts: r.attempts, status: r.status, ...(r.error ? { reason: r.error } : {}) });

  async function attempt(record) {
    record.attempts++;
    if (!record.url) {
      record.error = 'no_webhook_url';
      return;
    }
    if (!isLoopbackUrl(record.url)) throw new SimError(400, { error: 'Simulators send webhooks to this machine only.' });
    const signed = record.signature === 'none' ? {} : sign(record.raw, record.body, { bad: record.signature === 'bad' });
    try {
      const res = await fetch(record.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json', ...signed, ...record.headers }, body: record.raw });
      await res.text();
      record.status = res.status;
      record.ok = res.status >= 200 && res.status < 300;
      record.error = null;
    } catch (err) {
      record.status = null;
      record.ok = false;
      record.error = `The app did not answer (${err.name}).`;
    }
  }

  return {
    setUrl(next) {
      url = next || null;
    },
    get url() {
      return url;
    },
    async send(payload, { duplicates = 1, signature = 'good', hold = false, url: to = url, headers = {}, raw } = {}) {
      if (!['good', 'bad', 'none'].includes(signature)) throw new SimError(400, { error: 'signature is good, bad or none.' });
      const record = { id: ++seq, url: to, at: clock.now(), body: payload, raw: raw ?? JSON.stringify(payload), signature, headers, attempts: 0, status: null, ok: false, held: Boolean(hold), error: null, duplicates: Math.max(1, Number(duplicates) || 1) };
      records.push(record);
      if (record.held) return outcome(record);
      for (let i = 0; i < record.duplicates; i++) await attempt(record);
      return outcome(record);
    },
    async flush({ order = 'sent' } = {}) {
      const held = records.filter((r) => r.held);
      const sequence = Array.isArray(order) ? order.map((id) => held.find((r) => r.id === Number(id))).filter(Boolean) : order === 'reverse' ? [...held].reverse() : held;
      const out = [];
      for (const record of sequence) {
        record.held = false;
        for (let i = 0; i < record.duplicates; i++) await attempt(record);
        out.push(outcome(record));
      }
      return { deliveries: out };
    },
    async redeliver(id, { times = 1 } = {}) {
      const record = records.find((r) => r.id === Number(id));
      if (!record) throw new SimError(404, { error: `No delivery ${id}.` });
      record.held = false;
      for (let i = 0; i < Math.max(1, Number(times) || 1); i++) await attempt(record);
      return outcome(record);
    },
    list: () => records.map(view),
    reset() {
      seq = 0;
      records = [];
      url = defaultUrl;
    },
  };
}

/** The control routes every store simulator gives its webhooks: POST /webhooks/url, /webhooks/flush, /webhooks/redeliver, GET /webhooks. */
export function webhookControls(on, hooks) {
  on('GET', '/webhooks', () => ({ deliveries: hooks.list(), url: hooks.url }));
  on('POST', '/webhooks/url', ({ body }) => {
    hooks.setUrl(body.url);
    return { url: hooks.url };
  });
  on('POST', '/webhooks/flush', ({ body }) => hooks.flush({ order: body.order }));
  on('POST', '/webhooks/redeliver', ({ body }) => hooks.redeliver(body.id, { times: body.times }));
}
