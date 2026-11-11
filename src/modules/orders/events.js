import { EMITTED_EVENTS, ORDER_EVENTS, ORDER_EVENT_ENTITIES } from '../../contracts/orders.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';

/**
 * The order event bus (ctx.orderEvents). The database writes an outbox row (order_events, migration 403) in the same
 * transaction as every change to an order, payment, refund, shipment or return; this hands each row to every listener at
 * least once. Alerts, invoices, loyalty, stock, analytics and Shopify sync all hang off it, and so does the traffic order link.
 *
 * A module registers its listeners in its setup(ctx) hook, which runs once in the web app and once in the worker:
 *
 *   setup(ctx) {
 *     ctx.orderEvents.on('order.paid', 'invoices.issue', async (event) => { ... });
 *     ctx.orderEvents.on(['shipment.delivered', 'shipment.rto_delivered'], 'order-alerts.shipment', handler);
 *   }
 *
 *   on(types, name, handler)   types: one type, a list, or '*'. `name` is the listener's own, '<module>.<what>', and never
 *                              changes: deliveries are kept under it. handler(event, ctx) runs as the event's business.
 *   emit(t, { type, orderId, entity?, entityId?, data?, dedupeKey? })
 *                              For the EMITTED_EVENTS only (an invoice issued, stock moved), inside the caller's own
 *                              transaction. Status events are written by the database: never emit those.
 *   kick()                     Deliver soon, in this process. Call after your transaction commits; safe to call from anywhere.
 *   dispatch({ limit? })       One pass: fan new events out to listeners, then run what is due. -> { events, delivered, failed }
 *   drain()                    Runs until nothing is due (tests, and the worker's tick).
 *   start({ everyMs })         The worker's poll; returns stop().
 *
 * An event is { id, type, tenantId, orderId, entity, entityId, from, to, data, createdAt }: ids and statuses only.
 *
 * What a listener can rely on, and must provide:
 *   - At least once. A crash after the work and before the tick is recorded means the event comes again: be idempotent, with
 *     the event id (or the row's own unique key) as the guard. Every Phase 4 table that a listener writes has such a key.
 *   - In order per order: a listener never gets a later event of an order while an earlier one is still pending for it.
 *     Across orders there is no order.
 *   - A handler that throws is tried again with backoff, MAX_ATTEMPTS times, then marked failed and ops are told. A failed
 *     delivery no longer holds back later events of that order.
 *   - Look the row up again: by the time an event arrives the order may have moved on.
 */
export const ORDER_EVENTS_QUEUE = 'orders.events';
export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 300;
const NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const backoffSeconds = (attempt) => Math.min(3600, 5 * 4 ** Math.max(0, attempt - 1)); // 5s, 20s, 80s, ... up to an hour

const toEvent = (row) => ({
  id: Number(row.id),
  type: row.type,
  tenantId: row.tenant_id,
  orderId: row.order_id,
  entity: row.entity,
  entityId: Number(row.entity_id),
  from: row.from_status,
  to: row.to_status,
  data: row.data ?? {},
  createdAt: row.created_at,
});

export function createOrderEvents({ db }) {
  const platformDb = db.platform ?? db;
  const listeners = new Map();
  let ctx = null;
  let running = null;
  let again = false;

  function on(types, name, handler) {
    if (!NAME.test(String(name))) throw new Error(`An order event listener is named "<module>.<what>", not "${name}"`);
    if (typeof handler !== 'function') throw new Error(`The listener "${name}" needs a handler`);
    if (listeners.has(name)) throw new Error(`Two order event listeners are both named "${name}"`);
    const list = types === '*' ? null : [].concat(types);
    for (const type of list ?? []) if (!ORDER_EVENTS.includes(type)) throw new Error(`"${type}" is not an order event (src/contracts/orders.js)`);
    listeners.set(name, { types: list && new Set(list), handler });
  }

  async function emit(t, { type, orderId, entity = type?.split('.')[0], entityId = orderId, data = {}, dedupeKey = null }) {
    if (!EMITTED_EVENTS.includes(type)) throw new Error(`"${type}" is not an event a module may emit; status events are written by the database`);
    const entityName = entity === 'credit_note' ? 'invoice' : entity;
    if (!ORDER_EVENT_ENTITIES.includes(entityName)) throw new Error(`Unknown event entity "${entity}"`);
    const [row] = await t.query(
      `INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, data, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [tenantId(), type, orderId, entityName, entityId, JSON.stringify(data ?? {}), dedupeKey],
    );
    return row ? Number(row.id) : null;
  }

  /** Gives every new event a delivery row per listener that wants its type. One transaction, so an event is never half handed out. */
  async function fanOut(limit) {
    return platformDb.tx(async (t) => {
      const events = await t.query('SELECT id, tenant_id, type, order_id FROM order_events WHERE fanned_out_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [limit]);
      for (const event of events) {
        const names = [...listeners].filter(([, l]) => !l.types || l.types.has(event.type)).map(([name]) => name);
        if (!names.length) continue;
        await t.query(
          `INSERT INTO order_event_deliveries (event_id, listener, tenant_id, order_id) SELECT $1, name, $3, $4 FROM unnest($2::text[]) AS name ON CONFLICT DO NOTHING`,
          [event.id, names, event.tenant_id, event.order_id],
        );
      }
      if (events.length) await t.query('UPDATE order_events SET fanned_out_at = now() WHERE id = ANY($1::bigint[])', [events.map((e) => e.id)]);
      return events.length;
    });
  }

  async function claim(limit) {
    const names = [...listeners.keys()];
    if (!names.length) return [];
    return platformDb.query(
      `UPDATE order_event_deliveries d SET attempts = d.attempts + 1, locked_until = now() + make_interval(secs => $3::float)
       WHERE (d.event_id, d.listener) IN (
         SELECT c.event_id, c.listener FROM order_event_deliveries c
         WHERE c.status = 'pending' AND c.next_attempt_at <= now() AND (c.locked_until IS NULL OR c.locked_until < now()) AND c.listener = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM order_event_deliveries e WHERE e.listener = c.listener AND e.tenant_id = c.tenant_id AND e.order_id = c.order_id
                             AND e.status = 'pending' AND e.event_id < c.event_id)
         ORDER BY c.event_id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING d.event_id, d.listener, d.tenant_id, d.attempts`,
      [limit, names, LEASE_SECONDS],
    );
  }

  async function deliver(delivery) {
    const listener = listeners.get(delivery.listener);
    const key = [delivery.event_id, delivery.listener];
    try {
      const [row] = await platformDb.query('SELECT * FROM order_events WHERE id = $1', [delivery.event_id]);
      if (row) await withTenant(delivery.tenant_id, () => listener.handler(toEvent(row), ctx));
      await platformDb.query(`UPDATE order_event_deliveries SET status = 'done', done_at = now(), locked_until = NULL, last_error = '' WHERE event_id = $1 AND listener = $2`, key);
      return true;
    } catch (err) {
      const dead = delivery.attempts >= MAX_ATTEMPTS;
      // The error's code or kind only: a message can quote what it was working on.
      const reason = String(err?.code ?? err?.kind ?? err?.name ?? 'error').slice(0, 300);
      await platformDb.query(
        `UPDATE order_event_deliveries SET status = $3, last_error = $4, locked_until = NULL, next_attempt_at = now() + make_interval(secs => $5::float) WHERE event_id = $1 AND listener = $2`,
        [...key, dead ? 'failed' : 'pending', reason, backoffSeconds(delivery.attempts)],
      );
      reportError(err, { msg: 'order_events.delivery_failed', eventId: Number(delivery.event_id), listener: delivery.listener, attempt: delivery.attempts, dead });
      if (dead) {
        await platformDb.query(
          `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key) VALUES ($1, 'ops', 'order_events.delivery_failed', 'critical', $2, $3, $4)
           ON CONFLICT (tenant_id, audience, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
          [delivery.tenant_id, `The listener ${delivery.listener} gave up on order event ${delivery.event_id}.`, `order_event:${delivery.event_id}`, `order-event:${delivery.event_id}:${delivery.listener}`],
        ).catch((alertErr) => reportError(alertErr, { msg: 'order_events.alert_failed' }));
      }
      return false;
    }
  }

  async function dispatch({ limit = 100 } = {}) {
    const events = await fanOut(limit);
    const claimed = await claim(limit);
    let delivered = 0;
    // Oldest first. Only the order within one order is promised, but the same order every time is easier to reason about.
    claimed.sort((a, b) => Number(a.event_id) - Number(b.event_id));
    for (const delivery of claimed) if (await deliver(delivery)) delivered++;
    return { events, claimed: claimed.length, delivered, failed: claimed.length - delivered };
  }

  /** Passes until one finds nothing new and nothing due. A delivery waiting out its backoff is not due, so this always ends. */
  async function drain({ limit = 100, maxPasses = 1000 } = {}) {
    const total = { events: 0, delivered: 0, failed: 0 };
    for (let pass = 0; pass < maxPasses; pass++) {
      const once = await dispatch({ limit });
      total.events += once.events;
      total.delivered += once.delivered;
      total.failed += once.failed;
      if (!once.events && !once.claimed) break;
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
      .catch((err) => log.warn('order_events.kick_failed', { code: err?.code ?? err?.name ?? 'error' }))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function start({ everyMs = 2000 } = {}) {
    const timer = setInterval(kick, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return {
    on,
    emit,
    kick,
    dispatch,
    drain,
    start,
    /** The ctx handlers receive: set once by the app or the worker. */
    bind(context) {
      ctx = context;
    },
    /** Waits for a kick in progress, then drains: after this, everything that was due has been tried (tests). */
    async settle() {
      if (running) await running;
      return drain();
    },
    listeners: () => [...listeners.keys()],
  };
}

/** Builds ctx.orderEvents. The app and the worker both call this, then run each module's setup(ctx), where listeners register. */
export function wireOrderEvents(ctx) {
  const bus = createOrderEvents({ db: ctx.db });
  ctx.orderEvents = bus;
  bus.bind(ctx);
  return bus;
}
