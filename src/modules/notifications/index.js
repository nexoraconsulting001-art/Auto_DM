import { isCode, toE164 } from '../../contracts/accounts.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { ApiError } from '../../contracts/api/errors.js';
import {
  CODE_PURPOSES, CODE_REASONS, CODE_TEMPLATE, NOTIFY_CHANNELS, NOTIFY_EVENTS, NOTIFY_KINDS, NOTIFY_RULES, NOTIFY_SOURCES, NO_WHATSAPP_CODES,
  dataProblem, isTimezone, prefProblem, resolvePrefs,
} from '../../contracts/notifications.js';
import { ProviderError } from '../../adapters/http.js';
import { createPush } from '../../adapters/push/index.js';
import { log, reportError } from '../../platform/log.js';
import { createSecrets } from '../../platform/secrets.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { createDevices } from './devices.js';
import { checkEvent, writeEvent } from './outbox.js';
import { NOTIFY_QUEUE, createPipeline } from './pipeline.js';

export { NOTIFY_QUEUE } from './pipeline.js';

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
 * ctx.notify:
 *
 *   emit({ event, tenantId, audience?, key, data?, link?, channels? }, t?) -> event id, or null for a repeat
 *       Writes the outbox row and nothing else, so it is cheap and safe anywhere. Pass the open transaction as `t` and
 *       the notification commits or rolls back with the change it is about. The same (business, kind, key) inside ten
 *       minutes is one event. `data` is ids and numbers only. Throws on anything that breaks the rules (outbox.js).
 *   sendCode({ to, code, purpose }) -> { outcome: 'sent' | 'failed', reason, retryable }
 *       A seller's login code, from Bhava's own WhatsApp number, by the `login_code` template. Never SMS, never email.
 *   prefs.get({ userId }), prefs.save({ userId }, { quietHours?, events? })   inside withTenant; PrefsError for a choice
 *       that cannot be made
 *   deliveries.list({ userId?, eventId?, cursor?, limit? })   the delivery log, newest first
 *   inbox.list({ userId, cursor?, limit?, unread? }), inbox.markRead({ userId }, { ids } | { all: true })   the in-app list
 *   devices.register({ personId, deviceId, platform, token, appVersion }), devices.forget({ personId, deviceId?, reason })
 *       push_devices. The accounts track may call forget() on sign-out, device revocation and account deletion; without
 *       that call a device whose sign-in was revoked still gets nothing, because every push checks it (devices.js).
 *   channels() -> { push: { android, ios }, email, whatsapp, inapp }   which senders are set up
 *   dispatch({ limit? })   one pass: take the two sources (alerts, report deliveries), hand new events out (recipients,
 *                          preferences, quiet hours, the collapse hold), then send what is due (pipeline.js)
 *   drain()                passes until nothing is new and nothing is due (tests, and the worker's job)
 *   kick(), settle()       a drain soon in this process; wait for it and drain (tests)
 *   start({ everyMs })     the worker's poll (config.notifyPollMs); returns stop(). jobs() starts it and registers the
 *                          queue job NOTIFY_QUEUE as the safety net under it
 *   bind(ctx)              the module's setup gives it the repos (the brand kit, for the workspace badge)
 *   close()                stops the poll and closes the push connection
 *
 * dispatch runs outside withTenant: it works across businesses on db.platform, as the order event bus does.
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
/** Claimed per pass: few enough that the last of them is tried well inside its lease even when a provider hangs. */
const SEND_BATCH = 8;

export function createNotify({ db, providers, config = {}, push = createPush(config), secrets, now = () => new Date() }) {
  const platformDb = db?.platform ?? db;
  const bound = { repos: null };
  const devices = createDevices({ platformDb, secrets: secrets ?? createSecrets({ dataKey: config.dataKey, dataKeyOld: config.dataKeyOld }) });
  const pipeline = createPipeline({ platformDb, push, providers, config, clock: now, devices, getRepos: () => bound.repos });
  const timers = new Set();
  let running = null;
  let again = false;

  async function emit(input, t) {
    const event = checkEvent(input ?? {});
    if (t && !currentTenant()) throw new Error('emit() inside a transaction runs inside withTenant()');
    const id = await (t ? writeEvent(t, event) : withTenant(currentTenant() ?? event.forTenant, () => db.tx((q) => writeEvent(q, event))));
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

  const cursorOf = (cursor) => (/^\d{1,18}$/.test(String(cursor ?? '')) ? String(cursor) : null);

  const deliveries = {
    async list({ userId = null, eventId = null, cursor, limit = 25 } = {}) {
      const size = Math.min(100, Math.max(1, Number(limit) || 25));
      const rows = await db.query(
        `SELECT d.id, d.event_id, d.user_id, d.channel, d.status, d.attempt, d.provider_ref, d.reason, d.collapsed_into, d.group_count, d.created_at, d.sent_at, e.kind
         FROM notification_deliveries d JOIN notification_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
         WHERE d.tenant_id = $1 AND ($2::int IS NULL OR d.user_id = $2::int) AND ($3::bigint IS NULL OR d.event_id = $3::bigint) AND ($4::bigint IS NULL OR d.id < $4::bigint)
         ORDER BY d.id DESC LIMIT $5`,
        [tenantId(), userId, eventId, cursorOf(cursor), size + 1],
      );
      const items = rows.slice(0, size).map((r) => ({
        id: Number(r.id), eventId: Number(r.event_id), kind: r.kind, userId: r.user_id, channel: r.channel, status: r.status, attempt: r.attempt,
        providerRef: r.provider_ref, reason: r.reason, collapsedInto: r.collapsed_into === null ? null : Number(r.collapsed_into), count: r.group_count, createdAt: r.created_at, sentAt: r.sent_at,
      }));
      return { items, nextCursor: rows.length > size ? String(items.at(-1).id) : null };
    },
  };

  /** The in-app list of one account in the current business. Nobody reads or marks another person's. */
  const inbox = {
    async list({ userId, cursor, limit = 25, unread } = {}) {
      const size = Math.min(100, Math.max(1, Number(limit) || 25));
      const onlyUnread = unread === true || unread === '1';
      const rows = await db.query(
        `SELECT id, kind, title, body, link, created_at, read_at FROM notifications
         WHERE tenant_id = $1 AND user_id = $2 AND ($3::bigint IS NULL OR id < $3::bigint) AND ($4::boolean IS NOT TRUE OR read_at IS NULL)
         ORDER BY id DESC LIMIT $5`,
        [tenantId(), userId, cursorOf(cursor), onlyUnread, size + 1],
      );
      const [{ n }] = await db.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [tenantId(), userId]);
      const items = rows.slice(0, size).map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, readAt: r.read_at }));
      return { items, nextCursor: rows.length > size ? String(items.at(-1).id) : null, unread: n };
    },
    async markRead({ userId }, { ids, all } = {}) {
      if (all === true) {
        await db.query('UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [tenantId(), userId]);
        return;
      }
      const list = (ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 100);
      if (!list.length) return;
      await db.query('UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::bigint[]) AND read_at IS NULL', [tenantId(), userId, list]);
    },
  };

  /** Each step on its own, so a source that fails never stops sending, and sending never stops handing out. */
  async function step(name, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      reportError(err, { msg: `notify.${name}_failed` });
      return fallback;
    }
  }

  /** One pass. `send: false` only takes the sources and hands out (tests that change something between the two). */
  async function dispatch({ limit = 50, send = true } = {}) {
    const alerts = await step('alerts', () => pipeline.takeAlerts(limit), 0);
    const reports = await step('reports', () => pipeline.takeReports(limit), 0);
    const events = await step('fan_out', () => pipeline.fanOut(limit), 0);
    const idle = { claimed: 0, sent: 0, failed: 0, dropped: 0, retried: 0 };
    const sent = send ? await step('send', () => pipeline.sendDue(Math.min(limit, SEND_BATCH)), idle) : idle;
    return { taken: alerts + reports, events, ...sent };
  }

  /** Passes until one finds nothing new and nothing due. A delivery waiting out its backoff is not due, so this always ends. */
  async function drain({ limit = 50, maxPasses = 200 } = {}) {
    const total = { taken: 0, events: 0, claimed: 0, sent: 0, failed: 0, dropped: 0, retried: 0 };
    for (let pass = 0; pass < maxPasses; pass++) {
      const once = await dispatch({ limit });
      for (const key of Object.keys(total)) total[key] += once[key] ?? 0;
      if (!once.taken && !once.events && !once.claimed) break;
    }
    return total;
  }

  function kick() {
    if (running) {
      again = true;
      return running;
    }
    running = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        do {
          again = false;
          await drain();
        } while (again);
      })
      .catch((err) => log.warn('notify.kick_failed', { code: err?.code ?? err?.name ?? 'error' }))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function start({ everyMs = config.notifyPollMs || NOTIFY_RULES.pollMs } = {}) {
    const timer = setInterval(kick, Math.max(100, Number(everyMs) || NOTIFY_RULES.pollMs));
    timer.unref();
    timers.add(timer);
    return () => {
      clearInterval(timer);
      timers.delete(timer);
    };
  }

  return {
    emit,
    sendCode,
    prefs,
    deliveries,
    inbox,
    devices: { register: devices.register, forget: devices.forget },
    channels: () => ({
      push: { android: push.configured('android'), ios: push.configured('ios') },
      email: Boolean(providers?.email?.platform?.configured),
      whatsapp: Boolean(providers?.whatsapp?.platform?.configured),
      inapp: true,
    }),
    dispatch,
    drain,
    kick,
    start,
    async settle() {
      if (running) await running;
      return drain();
    },
    /** The repos the module's setup hands over: the brand kit, for the workspace badge in seller emails. */
    bind(context) {
      bound.repos = context?.repos ?? null;
    },
    /** Stops the poll and closes the push connection (tests, and the worker on its way out). */
    close: () => {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      return push.close?.();
    },
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

// ---- the seller API ---------------------------------------------------------------------------------------------------

/** A seller's own account in the current business. A shopper's session is refused: none of this is theirs. */
function seller(user) {
  if (!user || !SELLER_ROLES.includes(user.role)) throw new ApiError('forbidden');
  return user;
}

const switchable = (spec) => (spec.mandatory ? [] : ['push', 'email', 'whatsapp'].filter((channel) => channel !== 'whatsapp' || spec.whatsapp));

async function prefsView(notify, userId) {
  const saved = await notify.prefs.get({ userId });
  const ready = notify.channels();
  return {
    ...saved,
    kinds: NOTIFY_KINDS.map((kind) => {
      const spec = NOTIFY_EVENTS[kind];
      return { kind, label: spec.label, critical: spec.critical, mandatory: spec.mandatory, channels: switchable(spec) };
    }),
    available: { push: ready.push.android || ready.push.ios, email: ready.email, whatsapp: ready.whatsapp, inapp: true },
  };
}

/** The person behind this request's account, when the account is theirs: the app's sign-in names them, and users.person_id agrees. */
async function personOf(ctx, user, req) {
  const [row] = await ctx.db.query('SELECT person_id FROM users WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL', [tenantId(), user.id]);
  const personId = row?.person_id === null || row?.person_id === undefined ? null : Number(row.person_id);
  if (!personId) return null;
  if (req.session?.kind !== 'access') return personId;
  const [family] = await ctx.db.platform.query(`SELECT person_id FROM token_families WHERE id = $1 AND subject_kind = 'user' AND revoked_at IS NULL`, [req.session.familyId]);
  return family && Number(family.person_id) === personId ? personId : null;
}

function api(ctx = {}) {
  return {
    'notifications.list': ({ query, user }) => ctx.notify.inbox.list({ userId: seller(user).id, cursor: query.cursor, limit: query.limit, unread: query.unread }),
    'notifications.markRead': async ({ body, user }) => {
      await ctx.notify.inbox.markRead({ userId: seller(user).id }, body);
    },
    'notifications.prefs': ({ user }) => prefsView(ctx.notify, seller(user).id),
    'notifications.savePrefs': async ({ body, user }) => {
      const me = seller(user);
      try {
        await ctx.notify.prefs.save({ userId: me.id }, body);
      } catch (err) {
        if (err instanceof PrefsError) throw new ApiError('validation_failed', err.message, { fields: { [err.field]: err.message } });
        throw err;
      }
      return prefsView(ctx.notify, me.id);
    },
    'push.register': async ({ body, user, req }) => {
      const me = seller(user);
      // Only the owner app's own sign-in on this very device can say where its pushes go.
      if (req.session?.kind !== 'access' || !req.session.deviceId || !req.session.familyId) throw new ApiError('forbidden', 'Turn on notifications from the Bhava for Business app.');
      if (body.deviceId !== req.session.deviceId) throw new ApiError('forbidden', 'Turn on notifications from the device you signed in on.');
      const personId = await personOf(ctx, me, req);
      if (!personId) throw new ApiError('forbidden', 'Sign in again to turn on notifications.');
      try {
        await ctx.notify.devices.register({ personId, deviceId: body.deviceId, platform: body.platform, token: body.token, appVersion: body.appVersion ?? '' });
      } catch (err) {
        if (/DATA_KEY/.test(err?.message ?? '')) throw new ApiError('conflict', 'Notifications are not set up on this server yet.');
        throw err;
      }
    },
    'push.unregister': async ({ params, user, req }) => {
      const personId = await personOf(ctx, seller(user), req);
      if (personId) await ctx.notify.devices.forget({ personId, deviceId: params.id, reason: 'signed_out' });
    },
  };
}

export const notifications = {
  name: 'notifications',
  setup(ctx) {
    ctx.notify?.bind?.(ctx);
    if (ctx.notify && ctx.orderEvents) ctx.orderEvents.on(Object.keys(NOTIFY_SOURCES.orderEvents), 'notifications.orders', onOrderEvent(ctx));
  },
  api,
  /** The worker's poll hands out and sends every few seconds (a critical push leaves inside 30 s); the queue job is the net under it. */
  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(NOTIFY_QUEUE, () => ctx.notify.drain());
    if (Number(ctx.config?.notifyPollMs) !== 0) ctx.notify.start({ everyMs: ctx.config?.notifyPollMs || NOTIFY_RULES.pollMs });
    return async function schedule() {
      await queue.every(NOTIFY_QUEUE, 60_000);
    };
  },
};
