/** Signing and delivering what Meta sends to an app: webhooks, and the deauthorize and deletion callbacks. */
import crypto from 'node:crypto';
import { SimError } from '../base.mjs';

const WRONG_SECRET_SUFFIX = '-wrong';

/** The X-Hub-Signature-256 value for these exact bytes. */
export const hubSignature = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

/** Meta's signed_request: base64url(HMAC-SHA256 of the encoded payload) + "." + base64url(JSON). */
export function signedRequest(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
}

/** The app's answer to something Meta sends. Redirects are not followed, so nothing can leave this machine. */
async function callApp(ctx, url, init) {
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ctx.s.limits.webhookTimeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    throw new SimError(502, { error: `The app did not answer (${err.name}).` });
  }
}

function signedHeaders(raw, secret, signature) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'facebookexternalua' };
  if (signature === 'none') return headers;
  const key = signature === 'bad' ? `${secret}${WRONG_SECRET_SUFFIX}` : secret;
  return { ...headers, 'x-hub-signature-256': hubSignature(raw, key), 'x-hub-signature': `sha1=${crypto.createHmac('sha1', key).update(raw).digest('hex')}` };
}

async function attempt(ctx, record) {
  record.attempts++;
  try {
    const { status } = await callApp(ctx, record.url, { method: 'POST', headers: signedHeaders(record.raw, ctx.s.app.secret, record.signature), body: record.raw });
    record.status = status;
    record.ok = status >= 200 && status < 300;
    record.error = null;
  } catch (err) {
    record.status = null;
    record.ok = false;
    record.error = err.message;
  }
}

const outcome = (record) => ({ id: record.id, delivered: record.ok, attempts: record.attempts, status: record.status, ...(record.error ? { reason: record.error } : {}) });

/** One POST of `raw`, repeated `duplicates` times with the same bytes (Meta redelivers). */
async function sendRaw(ctx, raw, body, { duplicates = 1, signature = 'good' } = {}) {
  const url = ctx.s.app.webhookUrl;
  const firstAttemptAt = ctx.clock.now();
  const record = { id: ++ctx.s.seq, url, firstAttemptAt, attempts: 0, body, raw, signature, status: null, ok: false, error: url ? null : 'no_webhook_url' };
  ctx.s.deliveries.push(record);
  if (!url) return outcome(record);
  for (let i = 0; i < Math.max(1, duplicates); i++) await attempt(ctx, record);
  return outcome(record);
}

export const deliverPayload = (ctx, payload, options) => sendRaw(ctx, JSON.stringify(payload), payload, options);
export const deliverRawBody = (ctx, raw, options) => sendRaw(ctx, raw, null, options);

/** Sends one entry if the account subscribed to `field`; options.deliver === false records nothing, options.hold batches it. */
export async function emit(ctx, account, field, entry, options = {}) {
  if (options.deliver === false) return { delivered: false, reason: 'not_requested' };
  if (!account.subscribedFields.has(field)) return { delivered: false, reason: 'not_subscribed' };
  if (options.hold) {
    ctx.s.held.push(entry);
    return { delivered: false, reason: 'held' };
  }
  return deliverPayload(ctx, { object: 'instagram', entry: [entry] }, options);
}

/** Delivers everything held so far in POSTs of at most `batchSize` entries. */
export async function flushHeld(ctx, { batchSize, ...options } = {}) {
  const max = Math.min(batchSize ?? ctx.s.limits.webhookBatch, ctx.s.limits.webhookBatch);
  const entries = ctx.s.held.splice(0);
  const deliveries = [];
  for (let i = 0; i < entries.length; i += max) {
    deliveries.push(await deliverPayload(ctx, { object: 'instagram', entry: entries.slice(i, i + max) }, options));
  }
  return { deliveries };
}

/** Meta's retry: every failed delivery again, until it is 36 hours past its first attempt. */
export async function retryFailed(ctx) {
  const cutoff = ctx.clock.now() - ctx.s.limits.webhookRetryMs;
  const result = { retried: 0, delivered: 0, gaveUp: 0 };
  for (const record of ctx.s.deliveries) {
    if (record.ok || !record.url) continue;
    if (record.firstAttemptAt <= cutoff) {
      result.gaveUp++;
      continue;
    }
    await attempt(ctx, record);
    result.retried++;
    if (record.ok) result.delivered++;
  }
  return result;
}

/** Meta's subscription handshake against the app's GET webhook route. */
export async function verifyHandshake(ctx, { verifyToken = ctx.s.app.verifyToken } = {}) {
  const { webhookUrl } = ctx.s.app;
  if (!webhookUrl) throw new SimError(400, { error: 'No webhook URL is configured.' });
  const challenge = crypto.randomBytes(8).toString('hex');
  const url = new URL(webhookUrl);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', verifyToken);
  url.searchParams.set('hub.challenge', challenge);
  const { status, text } = await callApp(ctx, url, {});
  return { status, verified: status === 200 && text === challenge };
}

/** POSTs a signed_request to a deauthorize or deletion callback and reports what the app answered. */
export async function sendCallback(ctx, url, label, userId, signature = 'good') {
  if (!url) throw new SimError(400, { error: `No ${label} URL is configured.` });
  const secret = signature === 'bad' ? `${ctx.s.app.secret}${WRONG_SECRET_SUFFIX}` : ctx.s.app.secret;
  const signed = signedRequest({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(ctx.clock.now() / 1000), user_id: userId }, secret);
  const { status, text } = await callApp(ctx, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(signature === 'none' ? {} : { signed_request: signed }),
  });
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // The app answered something other than JSON; it is reported as text.
  }
  return { status, body, signedRequest: signed };
}

/** The list a test reads: no raw bytes, since `body` holds the parsed form. */
export const deliveryView = (record) => ({ id: record.id, url: record.url, firstAttemptAt: record.firstAttemptAt, attempts: record.attempts, body: record.body, signature: record.signature, status: record.status, ok: record.ok, error: record.error });
