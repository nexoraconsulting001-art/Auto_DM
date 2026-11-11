/**
 * An HTTP mail API, in the shape src/adapters/email's 'http' driver speaks: POST /messages with a bearer key and
 * { from, to: [..], subject, html, text, headers, reply_to }. No provider is chosen yet (PRD 5.4); this stands in for any.
 *
 *   POST /messages          -> { id }. An Idempotency-Key header repeats the same message instead of sending a second.
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   GET  /sent              every message accepted, oldest first, with its headers (List-Unsubscribe among them)
 *   POST /dkim { domain, pass }   which From domains pass DKIM; a message from a domain marked failing is refused (S-55)
 */
import { SimError, createSim } from '../base.mjs';

const mailError = (status, code, message) => new SimError(status, { error: { code, message } });
const domainOf = (from) => String(from ?? '').replace(/^.*</, '').replace(/>.*$/, '').split('@')[1]?.toLowerCase() ?? '';

export function createEmail({ apiKey = 'sim-email-key' } = {}) {
  let sent = [];
  let keys = new Map();
  let dkim = new Map();
  let seq = 0;

  const sim = createSim({
    name: 'email',
    errorBody: ({ kind }) => ({ error: { code: kind, message: `Simulated ${kind}.` } }),
    reset: () => {
      sent = [];
      keys = new Map();
      dkim = new Map();
      seq = 0;
    },
    routes: (on) => {
      on('POST', '/messages', (req) => {
        if (req.headers.authorization !== `Bearer ${apiKey}`) throw mailError(401, 'unauthorized', 'The API key is not valid.');
        const { from, to, subject, html, text, headers = {}, reply_to: replyTo } = req.body ?? {};
        if (!from || !Array.isArray(to) || !to.length || !subject || (!html && !text)) throw mailError(422, 'invalid', 'from, to, subject and a body are required.');
        if (!to.every((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address)))) throw mailError(422, 'invalid_recipient', 'A recipient address is not valid.');
        if (dkim.get(domainOf(from)) === false) throw mailError(403, 'domain_not_verified', 'The From domain has not passed DKIM.');
        const key = req.headers['idempotency-key'];
        if (key && keys.has(key)) return { id: keys.get(key) };
        const id = `msg_sim${++seq}`;
        sent.push({ id, from, fromDomain: domainOf(from), to, subject, html: html ?? '', text: text ?? '', headers, replyTo: replyTo ?? '', dkim: dkim.get(domainOf(from)) === true ? 'pass' : 'none', at: sim.clock.now() });
        if (key) keys.set(key, id);
        return { id };
      });
    },
    controls: (on) => {
      on('GET', '/sent', () => ({ sent }));
      on('POST', '/dkim', ({ body }) => {
        if (!body.domain) throw new SimError(400, { error: 'domain is required.' });
        dkim.set(String(body.domain).toLowerCase(), body.pass !== false);
        return { domain: body.domain, pass: body.pass !== false };
      });
    },
  });
  return sim;
}
