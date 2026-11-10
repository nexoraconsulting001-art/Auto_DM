/**
 * Conversions API, and the browser pixel it pairs with (PRD 7.14), so a seller's pixel never reaches Meta in a test. Point the page's pixel host at this
 * server and server events at GRAPH_BASE_URL.
 *
 * Controls, under /__sim:
 *   POST /pixels         { pixelId, token? }: returns the token
 *   POST /pixels/revoke  { pixelId }: the token stops working, with code 190
 *   GET  /capi/events?pixelId=   { received, deduped }: every event that arrived, and what Meta would count after removing browser and server duplicates
 */
import crypto from 'node:crypto';
import { SimError, reply } from '../base.mjs';
import { ERRORS, HOUR, graphError } from './constants.mjs';
import { input, jsonParam, requestToken } from './state.mjs';

const refuse = (error, status = 400) => new SimError(status, { error });
const invalid = (message) => graphError(ERRORS.INVALID_PARAM, `(#100) ${message}`);
const MAX_EVENTS = 1000;
const MAX_AGE_S = 7 * 24 * 3600;
const DEDUPE_WINDOW_MS = 48 * HOUR;
const IS_SHA256 = /^[0-9a-f]{64}$/;
const PIXEL_SCRIPT = '/* simulated pixel */ window.fbq = window.fbq || function () {};';

function checkUserData(userData) {
  if (userData === undefined) return;
  if (typeof userData !== 'object' || userData === null) throw invalid('user_data must be an object');
  for (const banned of ['email', 'phone', 'client_ip_address_raw']) if (Object.hasOwn(userData, banned)) throw invalid(`user_data has no field ${banned}: hash it as em or ph`);
  for (const field of ['em', 'ph']) {
    if (userData[field] === undefined) continue;
    const values = Array.isArray(userData[field]) ? userData[field] : [userData[field]];
    for (const value of values) if (typeof value !== 'string' || !IS_SHA256.test(value)) throw invalid(`user_data.${field} must be a lowercase SHA-256 hash`);
  }
}

function checkEvent(ctx, event) {
  if (typeof event?.event_name !== 'string' || !event.event_name) throw invalid('event_name is required');
  if (!Number.isInteger(event.event_time)) throw invalid('event_time must be a unix time in seconds');
  const nowS = Math.floor(ctx.clock.now() / 1000);
  if (event.event_time < nowS - MAX_AGE_S) throw invalid('event_time is too far in the past');
  if (event.event_time > nowS + 60) throw invalid('event_time is in the future');
  if (typeof event.action_source !== 'string' || !event.action_source) throw invalid('action_source is required');
  checkUserData(event.user_data);
}

function dedupe(events) {
  const seen = new Map();
  return events.filter((event) => {
    if (!event.eventId) return true;
    const key = `${event.pixelId}|${event.eventName}|${event.eventId}`;
    const first = seen.get(key);
    if (first !== undefined && event.at - first < DEDUPE_WINDOW_MS) return false;
    seen.set(key, event.at);
    return true;
  });
}

export function conversionRoutes(on, ctx) {
  // Meta's own path for server events. A pixel nobody registered with /__sim/pixels is not found, as it would be.
  on('POST', '/:id/events', (req) => {
    const pixel = ctx.s.pixels.get(req.params.id);
    if (!pixel) throw graphError(ERRORS.OBJECT_NOT_FOUND);
    const token = requestToken(req);
    if (!token) throw graphError(ERRORS.TOKEN_MISSING);
    if (pixel.revoked || token !== pixel.token) throw graphError(ERRORS.TOKEN_INVALID);
    const events = jsonParam(input(req).data);
    if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) throw invalid(`data must hold 1 to ${MAX_EVENTS} events`);
    for (const event of events) checkEvent(ctx, event);
    for (const event of events) {
      ctx.s.capiEvents.push({ at: ctx.clock.now(), source: 'server', pixelId: pixel.pixelId, eventName: event.event_name, eventId: event.event_id ?? '', eventTime: event.event_time, userData: event.user_data ?? {}, customData: event.custom_data ?? {} });
    }
    return { events_received: events.length, messages: [], fbtrace_id: crypto.randomBytes(8).toString('base64url') };
  });

  // What a page's pixel loads and calls. A hit for a pixel nobody registered is recorded too, so a test can see it happen.
  on('GET', '/en_US/fbevents.js', () => reply(200, PIXEL_SCRIPT, { 'content-type': 'application/javascript' }));
  const browserHit = (req) => {
    const params = input(req);
    ctx.s.capiEvents.push({ at: ctx.clock.now(), source: 'browser', pixelId: String(params.id ?? ''), eventName: String(params.ev ?? ''), eventId: String(params.eid ?? ''), eventTime: Math.floor(ctx.clock.now() / 1000), userData: {}, customData: {} });
    return reply(200, '', { 'content-type': 'image/gif' });
  };
  on('GET', '/tr', browserHit);
  on('POST', '/tr', browserHit);
}

export function conversionControls(on, ctx) {
  on('POST', '/pixels', ({ body }) => {
    if (typeof body.pixelId !== 'string' && typeof body.pixelId !== 'number') throw refuse('pixelId is required.');
    const pixelId = String(body.pixelId);
    const token = body.token ?? `EAAsim${crypto.randomBytes(16).toString('hex')}`;
    ctx.s.pixels.set(pixelId, { pixelId, token, revoked: false });
    return { pixelId, token };
  });

  on('POST', '/pixels/revoke', ({ body }) => {
    const pixel = ctx.s.pixels.get(String(body.pixelId));
    if (!pixel) throw refuse('No such pixel.', 404);
    pixel.revoked = true;
    return { ok: true };
  });

  on('GET', '/capi/events', ({ query }) => {
    const received = ctx.s.capiEvents.filter((e) => !query.pixelId || e.pixelId === query.pixelId);
    return { received, deduped: dedupe(received) };
  });
}
