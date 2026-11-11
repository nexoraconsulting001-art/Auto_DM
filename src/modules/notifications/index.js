import { isCode, toE164 } from '../../contracts/accounts.js';
import {
  CODE_PURPOSES, CODE_REASONS, CODE_TEMPLATE, NOTIFY_AUDIENCES, NOTIFY_CHANNELS, NOTIFY_EVENTS, NOTIFY_RULES, NOTIFY_SOURCES, NO_WHATSAPP_CODES,
  dataProblem, isLinkPath, isReservedKind, isTimezone, linkFor, prefProblem, resolvePrefs,
} from '../../contracts/notifications.js';
import { ProviderError } from '../../adapters/http.js';
import { createPush } from '../../adapters/push/index.js';
import { log } from '../../platform/log.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { notBuilt } from '../not-built.js';

/**
 * Notifications to sellers (PRD 5.13) and owner push (10.5): the one service that turns an event into deliveries on
 * push, email, WhatsApp and in-app, exposed as ctx.notify. One track owns this folder and edits nothing outside it.
 * Sellers hear from Bhava here. A shopper is never reached from here: that is ctx.shopperMessages, and stays so.
 *
 * The contract it builds against:
 *
 *   src/contracts/notifications.js      the kinds (NOTIFY_EVENTS), the numbers (NOTIFY_RULES), the wording checks, the
 *                                       preference rules, the sources. Read its header first.
 *   src/contracts/api/notifications.js  the routes and their shapes
 *   migrations 520, 521                 notification_events (the outbox), notification_deliveries (the log),
 *                                       notifications (the in-app list), notification_prefs: tenant tables.
 *                                       push_devices: platform-only, through db.platform. alerts.notified_at and
 *                                       report_deliveries.notified_at mark what has been taken from those two
 *   src/adapters/push                   send({ platform, token, title, body, data, collapseKey, ttl }) and
 *                                       forCredentials(creds); held here and nowhere else
 *   ctx.providers.whatsapp.platform     Bhava's own WhatsApp number: send({ to, template, params, code })
 *   ctx.providers.email.platform        Bhava's own sender: send({ to, subject, html, text, idempotencyKey })
 *
 * Nothing outside this folder calls any of those three senders. A test keeps it so.
 *
 * ctx.notify, as it is now (the contract step built these; their shapes are fixed):
 *
 *   emit({ event, tenantId, audience?, key, data?, link?, channels? }, t?) -> event id, or null for a repeat
 *       Writes the outbox row and nothing else, so it is cheap and safe anywhere. Pass the open transaction as `t` and
 *       the notification commits or rolls back with the change it is about. `event` is a kind in NOTIFY_EVENTS;
 *       `tenantId` must be the current business when there is one; `key` says what happened (`order:12`): the same
 *       (business, kind, key) inside ten minutes is one event; `data` is ids and numbers only (dataProblem), and is
 *       what the wording and the link are filled from; `link` overrides the kind's path; `channels` narrows the kind's
 *       channels (a report delivery is for one). Throws on a kind, audience, key, data or link that breaks the rules:
 *       those are bugs in the caller, not events to drop quietly.
 *   sendCode({ to, code, purpose }) -> { outcome: 'sent' | 'failed', reason, retryable }
 *       A seller's login code, from Bhava's own WhatsApp number, by the `login_code` template. Never SMS, never email.
 *       Never throws for a provider's refusal, never logs or returns the number or the code. Reasons: CODE_REASONS.
 *   prefs.get({ userId }) -> { quietHours, events: { [kind]: { push, email, whatsapp, inapp } } }   every default filled in
 *   prefs.save({ userId }, { quietHours?, events? }) -> the same, after saving. Throws PrefsError for a choice that
 *       cannot be made (in-app off, a security notice changed, WhatsApp for a kind with no template).
 *   deliveries.list({ userId?, eventId?, cursor?, limit? }) -> { items, nextCursor }   the delivery log, newest first
 *   channels() -> { push: { android, ios }, email, whatsapp, inapp }   which senders are set up
 *
 * What the track adds here, shaped like the order event bus (src/modules/orders/events.js):
 *
 *   dispatch({ limit? })   one pass: hand new events out (recipients, preferences, quiet hours, the collapse hold), take
 *                          the two sources, then send what is due. drain() runs it until nothing is due; start({ everyMs })
 *                          is the worker's poll (config.notifyPollMs), and jobs() registers both.
 *   The in-app list, push.register and push.unregister behind their routes, and the email layouts.
 *
 * Rules the tests will hold this folder to (the numbers are NOTIFY_RULES):
 *
 * Handing out. Through db.platform, one transaction per batch, `FOR UPDATE SKIP LOCKED` on events with fanned_out_at
 * empty. Recipients are the business's accounts in the event's audience with removed_at empty. For each, and each
 * channel the kind (or the event's `channels`) names: no row when resolvePrefs says off, except that a channel with no
 * sender, or a person with no device, phone or address, gets a row `dropped` with the reason, so the log says why
 * nothing came. next_attempt_at is deliverAt(). The in-app delivery writes the `notifications` row in the same
 * transaction and is `sent` at once. Rows are unique on (event, user, channel): insert with ON CONFLICT DO NOTHING.
 *
 * Sending. Claim due rows with a lease (locked_until), count the try before sending (attempt + 1, which the database
 * stops at 3), look the account up again and drop the row if it was removed. A retryable failure goes back to queued at
 * nextAttemptAt(); the third, or one that another try cannot change, is `failed` with the provider's kind as reason.
 * not_configured is `dropped`, never retried, and never stops another channel. A WhatsApp send whose answer was lost
 * is `failed` with unknown_delivery and not sent again.
 *
 * Push. The title and body come from wordingFor() and nothing else; data is exactly { tenantId, kind, link, eventId,
 * count }; pushProblem() runs on the finished push and a refusal is `failed`, reason `content`, nothing sent. One
 * delivery per person covers all their devices (push_devices by users.person_id, deleted_at empty): sent if any device
 * took it. A device the provider calls unregistered or invalid_token is deleted then and there (deleted_at, the reason,
 * token_enc wiped), and is not a failed try if another device took the push. Collapsing is in the contract's header:
 * hold, join, one push with the wording for many, the same collapseKey when a late one arrives.
 *
 * Email. Bhava's layout for the kind, from providers.email.platform, checked with sellerEmailProblem(): Bhava's name and
 * sender, the business's logo only as the workspace badge. The delivery id is the idempotency key.
 *
 * Sources. alerts with audience owner and notified_at empty: a kind in NOTIFY_SOURCES.alerts becomes an event with key
 * `alert:<id>`, any other is only stamped. report_deliveries still queued with notified_at empty and a user: an event for
 * that one person on that one channel, key `report_delivery:<id>`, and the row's own status follows the delivery's. A
 * report row for an outside address is not a notification: send it by the platform email sender as the row says and
 * mark the row. Order events are already wired below.
 *
 * Devices. push.register stores the token encrypted (platform.secrets) with tokenHash() as its hash, for the signed-in
 * person and the device id of their session; a token or a device seen before replaces its old row. Signing out,
 * revoking a device and deleting an account delete its row.
 *
 * Logs hold ids, kinds and reasons only: no number, address, token or word of a message.
 */
export class PrefsError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'PrefsError';
    this.field = field;
  }
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const result = (outcome, reason, retryable = false) => ({ outcome, reason, retryable });

function checkEvent({ event, tenantId: forTenant, audience, key, data = {}, link, channels }) {
  const spec = NOTIFY_EVENTS[event];
  if (!spec) throw new Error(isReservedKind(event) ? `"${event}" is kept for a later phase: add its row to NOTIFY_EVENTS first` : `"${event}" is not a notification kind (src/contracts/notifications.js)`);
  if (!Number.isInteger(forTenant) || forTenant <= 0) throw new Error('emit() names the business: tenantId');
  const current = currentTenant()?.id;
  if (current && current !== forTenant) throw new Error('emit() can only notify the current business');
  const to = audience ?? spec.audience;
  const one = typeof to === 'object' && to !== null && Object.keys(to).length === 1 && Number.isInteger(to.userId) && to.userId > 0;
  if (!one && !NOTIFY_AUDIENCES.includes(to)) throw new Error(`An audience is one of ${NOTIFY_AUDIENCES.join(', ')}, or { userId }`);
  if (typeof key !== 'string' || !key || key.length > 120) throw new Error('emit() needs a key that says what happened, such as "order:12"');
  const problem = dataProblem(data);
  if (problem) throw new Error(`Notification data is ids and numbers only: ${problem}`);
  const path = link ?? linkFor(event, data);
  if (!isLinkPath(path)) throw new Error('A notification link is a path, such as /orders/12');
  if (channels !== undefined && (!Array.isArray(channels) || !channels.length || !channels.every((c) => NOTIFY_CHANNELS.includes(c)))) throw new Error(`channels is a list from ${NOTIFY_CHANNELS.join(', ')}`);
  return { kind: event, forTenant, audience: to, key, data, path, channels: channels ?? null };
}

export function createNotify({ db, providers, config = {}, push = createPush(config) }) {
  async function emit(input, t) {
    const event = checkEvent(input ?? {});
    if (t && !currentTenant()) throw new Error('emit() inside a transaction runs inside withTenant()');
    const write = async (q) => {
      // A key older than the window is free again: what happened then is done, and this is something new.
      await q.query(
        `UPDATE notification_events SET live = false WHERE tenant_id = $1 AND kind = $2 AND event_key = $3 AND live AND created_at < now() - make_interval(secs => $4::float)`,
        [event.forTenant, event.kind, event.key, NOTIFY_RULES.dedupeMs / 1000],
      );
      const [row] = await q.query(
        `INSERT INTO notification_events (tenant_id, kind, event_key, audience, channels, data, link) VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6::jsonb, $7)
         ON CONFLICT (tenant_id, kind, event_key) WHERE live DO NOTHING RETURNING id`,
        [event.forTenant, event.kind, event.key, JSON.stringify(event.audience), event.channels, JSON.stringify(event.data), event.path],
      );
      return row ? Number(row.id) : null;
    };
    const id = await (t ? write(t) : withTenant(currentTenant() ?? event.forTenant, () => db.tx(write)));
    log.info(id ? 'notify.event' : 'notify.duplicate', { kind: event.kind, ...(id ? { eventId: id } : {}) });
    return id;
  }

  async function sendCode({ to, code, purpose } = {}) {
    const number = toE164(to);
    if (!number || !isCode(code) || !CODE_PURPOSES.includes(purpose)) return result('failed', CODE_REASONS.invalid);
    const sender = providers?.whatsapp?.platform;
    if (!sender?.configured) {
      log.warn('notify.code_not_sent', { purpose, reason: CODE_REASONS.notConfigured });
      return result('failed', CODE_REASONS.notConfigured);
    }
    try {
      await sender.send({ to: number.slice(1), template: CODE_TEMPLATE, params: [code], code });
      log.info('notify.code_sent', { purpose });
      return result('sent', CODE_REASONS.ok);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const reason = err.delivery === 'unknown' ? CODE_REASONS.unknownDelivery : NO_WHATSAPP_CODES.includes(String(err.code)) ? CODE_REASONS.noWhatsApp : CODE_REASONS.provider;
      log.warn('notify.code_not_sent', { purpose, reason, kind: err.kind, status: err.status, code: err.code });
      // A code that may have gone out is not sent again: the person asks for a new one.
      return result('failed', reason, reason === CODE_REASONS.provider && err.retryable);
    }
  }

  const savedOf = (row) => (row ? { quietHours: { enabled: row.quiet_enabled, from: row.quiet_from, to: row.quiet_to, timezone: row.timezone }, events: row.events ?? {} } : {});

  const prefs = {
    async get({ userId }) {
      const [row] = await db.query('SELECT quiet_enabled, quiet_from, quiet_to, timezone, events FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2', [tenantId(), userId]);
      return resolvePrefs(savedOf(row));
    },

    async save({ userId }, { quietHours, events } = {}) {
      const tenant = tenantId();
      if (quietHours !== undefined) {
        if (quietHours === null || typeof quietHours !== 'object') throw new PrefsError('Quiet hours need a start and an end.', 'quietHours');
        if (quietHours.enabled !== undefined && typeof quietHours.enabled !== 'boolean') throw new PrefsError('Quiet hours are on or off.', 'quietHours.enabled');
        for (const edge of ['from', 'to']) if (quietHours[edge] !== undefined && !CLOCK.test(String(quietHours[edge]))) throw new PrefsError('Use a time such as 22:00.', `quietHours.${edge}`);
        if (quietHours.timezone !== undefined && !isTimezone(quietHours.timezone)) throw new PrefsError('Choose a time zone from the list.', 'quietHours.timezone');
      }
      for (const [kind, chosen] of Object.entries(events ?? {})) {
        if (chosen === null || typeof chosen !== 'object') throw new PrefsError('Choose on or off for each channel.', `events.${kind}`);
        for (const [channel, enabled] of Object.entries(chosen)) {
          const problem = prefProblem(kind, channel, enabled);
          if (problem) throw new PrefsError(problem === 'invalid' ? 'That is not a notification that can be changed.' : problem, `events.${kind}.${channel}`);
        }
      }
      return db.tx(async (t) => {
        await t.query('INSERT INTO notification_prefs (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, userId]);
        const [row] = await t.query('SELECT quiet_enabled, quiet_from, quiet_to, timezone, events FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [tenant, userId]);
        const before = savedOf(row);
        const quiet = { ...before.quietHours, ...(quietHours ?? {}) };
        // Only what differs from the kind's defaults is kept, so a default that changes later reaches everyone who never chose.
        const kept = {};
        for (const [kind, spec] of Object.entries(NOTIFY_EVENTS)) {
          const merged = { ...(before.events[kind] ?? {}), ...(events?.[kind] ?? {}) };
          const differs = Object.fromEntries(Object.entries(merged).filter(([channel, enabled]) => NOTIFY_CHANNELS.includes(channel) && typeof enabled === 'boolean' && enabled !== spec.channels.includes(channel) && !prefProblem(kind, channel, enabled)));
          if (Object.keys(differs).length) kept[kind] = differs;
        }
        await t.query(
          'UPDATE notification_prefs SET quiet_enabled = $3, quiet_from = $4, quiet_to = $5, timezone = $6, events = $7::jsonb, updated_at = now() WHERE tenant_id = $1 AND user_id = $2',
          [tenant, userId, quiet.enabled === true, quiet.from, quiet.to, quiet.timezone, JSON.stringify(kept)],
        );
        return resolvePrefs({ quietHours: quiet, events: kept });
      });
    },
  };

  const deliveries = {
    async list({ userId = null, eventId = null, cursor, limit = 25 } = {}) {
      const size = Math.min(100, Math.max(1, Number(limit) || 25));
      const rows = await db.query(
        `SELECT d.id, d.event_id, d.user_id, d.channel, d.status, d.attempt, d.provider_ref, d.reason, d.collapsed_into, d.group_count, d.created_at, d.sent_at, e.kind
         FROM notification_deliveries d JOIN notification_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
         WHERE d.tenant_id = $1 AND ($2::int IS NULL OR d.user_id = $2::int) AND ($3::bigint IS NULL OR d.event_id = $3::bigint) AND ($4::bigint IS NULL OR d.id < $4::bigint)
         ORDER BY d.id DESC LIMIT $5`,
        [tenantId(), userId, eventId, /^\d{1,18}$/.test(String(cursor ?? '')) ? cursor : null, size + 1],
      );
      const items = rows.slice(0, size).map((r) => ({
        id: Number(r.id), eventId: Number(r.event_id), kind: r.kind, userId: r.user_id, channel: r.channel, status: r.status, attempt: r.attempt,
        providerRef: r.provider_ref, reason: r.reason, collapsedInto: r.collapsed_into === null ? null : Number(r.collapsed_into), count: r.group_count, createdAt: r.created_at, sentAt: r.sent_at,
      }));
      return { items, nextCursor: rows.length > size ? String(items.at(-1).id) : null };
    },
  };

  return {
    emit,
    sendCode,
    prefs,
    deliveries,
    channels: () => ({
      push: { android: push.configured('android'), ios: push.configured('ios') },
      email: Boolean(providers?.email?.platform?.configured),
      whatsapp: Boolean(providers?.whatsapp?.platform?.configured),
      inapp: true,
    }),
    /** Closes the push connection (tests, and the worker on its way out). */
    close: () => push.close?.(),
  };
}

/** "A new order" and a failed payment, from the order event bus. The listener only writes outbox rows, so it is quick and safe to repeat. */
function onOrderEvent(ctx) {
  return async (event) => {
    const [order] = await ctx.db.query('SELECT order_number, payment_mode FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
    if (!order) return;
    let kind = NOTIFY_SOURCES.orderEvents[event.type];
    if (event.type === 'order.confirmed' && order.payment_mode === 'cod') kind = 'order.cod_to_confirm';
    const data = { orderId: event.orderId };
    // An order number is the business's own counter. One that would not pass as an id is simply left out of the words.
    if (!dataProblem({ orderNumber: order.order_number })) data.orderNumber = order.order_number;
    await ctx.notify.emit({ event: kind, tenantId: tenantId(), key: event.type === 'payment.failed' ? `payment:${event.entityId}` : `order:${event.orderId}`, data });
  };
}

export const notifications = {
  name: 'notifications',
  setup(ctx) {
    if (ctx.notify && ctx.orderEvents) ctx.orderEvents.on(Object.keys(NOTIFY_SOURCES.orderEvents), 'notifications.orders', onOrderEvent(ctx));
  },
  api: () => notBuilt('notifications.list', 'notifications.markRead', 'notifications.prefs', 'notifications.savePrefs', 'push.register', 'push.unregister'),
};
