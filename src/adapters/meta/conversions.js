import crypto from 'node:crypto';
import { DEFAULT_GRAPH_VERSION } from './client.js';
import { metaUrls } from './hosts.js';
import { createMetaHttp } from './http.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Meta's user_data, hashed and with nothing else in it. Call only with consent, for a signed-in shopper (PRD 7.14; format to confirm). */
export function hashedUserData({ email, phone } = {}) {
  const data = {};
  const normalEmail = String(email ?? '').trim().toLowerCase();
  const normalPhone = String(phone ?? '').replace(/\D/g, '');
  if (normalEmail) data.em = [sha256(normalEmail)];
  if (normalPhone) data.ph = [sha256(normalPhone)];
  return data;
}

/**
 * The seller's own Conversions API connection. `pixel` is { pixelId, token }, from tag_settings. Same rules as every Meta call: a 10 s timeout, no
 * redirects, only Meta's host or a simulator outside production, and the token in a header. A failure is a MetaApiError.
 *
 *   send(pixel, events) -> { received, status }
 *
 * Events are in Meta's format, with event_id shared with the browser hit so duplicates can be removed. Never give it an IP, a user agent or an unhashed contact.
 * Ask platform.consent first: a shopper who hasn't said yes gets no server event.
 */
export function createConversions(config = {}, { env = process.env, onCall } = {}) {
  const urls = metaUrls(config, env);
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION;
  const call = createMetaHttp({ timeoutMs: config.metaTimeoutMs, onCall });

  return {
    async send({ pixelId, token }, events) {
      if (!Array.isArray(events) || !events.length) throw new Error('Conversions API needs at least one event');
      const { data, status } = await call({ base: urls.facebookGraph, version, method: 'POST', pathname: `${encodeURIComponent(String(pixelId))}/events`, token, body: { data: events } });
      return { received: Number.isInteger(data.events_received) ? data.events_received : 0, status };
    },
  };
}
