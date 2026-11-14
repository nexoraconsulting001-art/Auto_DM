import { WHATSAPP_CHANNEL } from '../../contracts/addons.js';
import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';

/**
 * Shoppers' WhatsApp messages, as Meta delivers them to POST /webhooks/whatsapp (PRD 6.12). This handler is registered in
 * beforeTenant ahead of order-alerts' one on the same path (the module list puts whatsapp-automation first) and always
 * hands the request on to it, which stores delivery reports and STOP for the order alerts and answers.
 *
 *   1. The signature (X-Hub-Signature-256, WHATSAPP_APP_SECRET) is checked on the exact bytes before anything is read. A
 *      bad or missing one, or bytes that are not JSON, is left alone: order-alerts' route refuses it with 401 or 400.
 *      A body changed after signing, to name another business's number, fails here like any other change.
 *   2. Each message is routed by the phone number id it was sent to (value.metadata.phone_number_id), and only by that:
 *      a number nobody holds is counted in inbound_unrouted (tenant.unknown_entry) and nothing else is kept.
 *   3. Inside its business, in one transaction: an inbound_events row keyed by the message id (a repeat is a no-op,
 *      logged as webhook.duplicate), the inbox thread (channel 'whatsapp', its number, the person's hash, their profile
 *      name; an older message never moves the window or the preview back) and the inbox message. If that fails the answer
 *      is 500 and Meta delivers again.
 *   4. Then each new message is worked through (process.js), still before the answer, so the keyword reply is queued
 *      while the window it was asked in is open. Whatever fails there stays 'pending' for the worker's sweep.
 *
 * The add-on being off changes none of this: messages are stored for the inbox, and process.js sends nothing.
 * Nothing is logged with a number, a name or a message.
 */
const MESSAGE_ID = /^[A-Za-z0-9_.:=+/-]{1,120}$/;
const PHONE_NUMBER_ID = /^[A-Za-z0-9_-]{1,40}$/;
const WA_ID = /^[1-9][0-9]{7,14}$/;
const MAX_MESSAGES = 200;
const INBOX_TEXT_CHARS = 2000;
const NAME_CHARS = 100;
const TEXT_TYPES = new Set(['text', 'button', 'interactive']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const objects = (list) => (Array.isArray(list) ? list.filter(isObject) : []);

/**
 * The delivery with every entry, change, contact and message that is not an object dropped, so one malformed item never
 * takes the valid ones beside it down (the adapter's parser reads fields of each without checking it is an object).
 */
function wellFormed(body) {
  return {
    entry: objects(body.entry).map((e) => ({
      changes: objects(e.changes).filter((c) => isObject(c.value)).map((c) => ({
        value: { ...c.value, metadata: isObject(c.value.metadata) ? c.value.metadata : {}, contacts: objects(c.value.contacts), messages: objects(c.value.messages) },
      })),
    })),
  };
}

export function createIntake(ctx, processor) {
  const { db, repos, config, providers, compliance } = ctx;
  const platformDb = db.platform ?? db;
  const now = () => (typeof compliance?.now === 'function' ? compliance.now() : new Date());

  async function owners(ids) {
    const rows = await platformDb.query(
      `SELECT a.phone_number_id, t.id, t.slug, t.name, t.status,
              (SELECT p.domain FROM tenant_domains p WHERE p.tenant_id = t.id AND p.is_primary AND p.status = 'verified') AS primary_domain
       FROM whatsapp_accounts a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.phone_number_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    return new Map(rows.map((r) => [r.phone_number_id, { id: r.id, slug: r.slug, name: r.name, status: r.status, primary_domain: r.primary_domain }]));
  }

  async function unrouted(phoneNumberId) {
    await platformDb.query(
      `INSERT INTO inbound_unrouted (channel, account_id) VALUES ('whatsapp', $1)
       ON CONFLICT (channel, account_id) DO UPDATE SET deliveries = inbound_unrouted.deliveries + 1, last_seen_at = now()`,
      [phoneNumberId],
    );
    log.warn('webhook.unknown_entry', { channel: WHATSAPP_CHANNEL, reason: 'tenant.unknown_entry' });
  }

  /** Stores one business's messages. Returns the inbound_events ids that are new. */
  async function storeForTenant(phoneNumberId, messages) {
    const at = now();
    const subjects = new Map();
    for (const m of messages) if (!subjects.has(m.from)) subjects.set(m.from, await repos.compliance.subjectHash(WHATSAPP_CHANNEL, m.from));
    const fresh = [];
    let duplicates = 0;
    await db.tx(async (t) => {
      for (const m of messages) {
        const sent = new Date(Math.min(+m.at || +at, +at));
        const [event] = await t.query(
          `INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id, payload, status, received_at)
           VALUES ($1, 'whatsapp', $2, 'messages', $3, '{}'::jsonb, 'pending', $4::timestamptz)
           ON CONFLICT (tenant_id, channel, field, object_id) DO NOTHING RETURNING id`,
          [tenantId(), phoneNumberId, m.messageId, at],
        );
        if (!event) {
          duplicates++;
          continue;
        }
        const isText = TEXT_TYPES.has(m.type);
        const text = isText ? String(m.text).replaceAll('\0', '').toWellFormed().slice(0, INBOX_TEXT_CHARS) : '';
        const [thread] = await t.query(
          `INSERT INTO inbox_threads (tenant_id, channel, wa_phone_number_id, subject_hash, recipient_id, username, last_message, last_message_at, last_user_message_at, created_at, updated_at)
           VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz, $8::timestamptz, $8::timestamptz)
           ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET
             wa_phone_number_id = EXCLUDED.wa_phone_number_id,
             recipient_id = EXCLUDED.recipient_id,
             username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE inbox_threads.username END,
             last_message = CASE WHEN inbox_threads.last_message_at IS NULL OR EXCLUDED.last_message_at >= inbox_threads.last_message_at THEN EXCLUDED.last_message ELSE inbox_threads.last_message END,
             last_message_at = GREATEST(inbox_threads.last_message_at, EXCLUDED.last_message_at),
             last_user_message_at = GREATEST(inbox_threads.last_user_message_at, EXCLUDED.last_user_message_at),
             status = CASE WHEN inbox_threads.status = 'closed' THEN 'open' ELSE inbox_threads.status END,
             updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [tenantId(), phoneNumberId, subjects.get(m.from), m.from, String(m.name ?? '').replaceAll('\0', '').toWellFormed().slice(0, NAME_CHARS), text, sent, at],
        );
        await t.query(
          `INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, kind, text, mid, created_at)
           VALUES ($1, $2, 'in', 'person', $3, $4, $5, $6::timestamptz)
           ON CONFLICT (tenant_id, mid) WHERE mid IS NOT NULL DO NOTHING`,
          [tenantId(), thread.id, isText ? 'text' : 'attachment', text, m.messageId, sent],
        );
        await t.query('UPDATE inbound_events SET payload = $3::jsonb WHERE tenant_id = $1 AND id = $2', [tenantId(), event.id, JSON.stringify({ threadId: thread.id, at: sent.toISOString(), type: isText ? 'text' : 'attachment' })]);
        fresh.push(event.id);
      }
    });
    for (let i = 0; i < duplicates; i++) {
      await repos.compliance.record({ channel: WHATSAPP_CHANNEL, kind: 'webhook', decision: 'skipped', reason: 'webhook.duplicate', details: { field: 'messages' }, at })
        .catch((err) => reportError(err, { msg: 'whatsapp.log_failed' }));
    }
    return fresh;
  }

  /** Every message of a verified delivery, routed and stored. Throws if anything could not be stored. */
  async function store(body) {
    const messages = providers.whatsapp.parseMessages(wellFormed(body))
      .filter((m) => MESSAGE_ID.test(m.messageId) && WA_ID.test(m.from) && PHONE_NUMBER_ID.test(m.phoneNumberId))
      .slice(0, MAX_MESSAGES)
      .sort((a, b) => +a.at - +b.at);
    const byNumber = new Map();
    for (const m of messages) byNumber.set(m.phoneNumberId, [...(byNumber.get(m.phoneNumberId) ?? []), m]);
    if (!byNumber.size) return [];
    const known = await owners([...byNumber.keys()]);
    const stored = [];
    for (const [phoneNumberId, list] of byNumber) {
      const tenant = known.get(phoneNumberId);
      if (!tenant) {
        await unrouted(phoneNumberId);
        continue;
      }
      const ids = await withTenant(tenant, () => storeForTenant(phoneNumberId, list));
      for (const id of ids) stored.push({ tenant, id });
    }
    return stored;
  }

  async function receive(req, res, next) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    const secret = config.whatsappAppSecret;
    if (!raw || !secret || !providers.whatsapp.verifyWebhook(raw, req.get(SIGNATURE_HEADERS.whatsapp) ?? '', secret)) return next();
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return next();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return next();
    let stored;
    try {
      stored = await store(body);
    } catch (err) {
      reportError(err, { msg: 'whatsapp.inbound_store_failed' });
      return res.status(500).json({ error: 'Something went wrong on our side.' });
    }
    for (const { tenant, id } of stored) {
      await processor.run(tenant, id).catch((err) => reportError(err, { msg: 'whatsapp.inbound_failed', event: Number(id) }));
    }
    return next();
  }

  return { receive, store };
}
