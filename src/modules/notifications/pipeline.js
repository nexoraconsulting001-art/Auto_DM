import { PERMISSIONS, SELLER_ROLES } from '../../contracts/api/access.js';
import {
  NOTIFY_CHANNELS, NOTIFY_EVENTS, NOTIFY_RULES, NOTIFY_SOURCES, NO_WHATSAPP_CODES, PUSH_TOKEN_GONE, QUIET_CHANNELS,
  collapseKeyFor, dataProblem, deliverAt, linkFor, nextAttemptAt, pushProblem, quietUntil, resolvePrefs, sellerEmailProblem, wordingFor,
} from '../../contracts/notifications.js';
import { ProviderError } from '../../adapters/http.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { logoSource, markWorkspaceBadge, sellerEmail, textOf } from './email.js';
import { checkEvent, writeEvent } from './outbox.js';

/**
 * The worker side of ctx.notify: take the two sources, hand events out, send what is due. Everything here runs on
 * db.platform, because it looks across businesses the way the order event bus and the job queue do; every statement
 * still names the business of the row it touches, and every link between rows carries tenant_id.
 *
 * At least once, never twice:
 *   - Handing out locks events with SKIP LOCKED, and deliveries are unique on (event, account, channel), so two workers
 *     never make two deliveries of one event to one person on one channel.
 *   - Sending claims a due row with a lease (locked_until) and counts the try first. Before the provider is called the
 *     lease is renewed against the value this worker set, and the outcome is written only while the lease is still
 *     this worker's: a slow worker that lost its row neither sends nor records.
 *   - A WhatsApp row is marked `sending` when claimed. Claimed again after its lease ran out with that mark still on, the
 *     answer of the earlier try was lost, so it is failed with unknown_delivery and never sent again on a guess. Email
 *     carries the delivery as its idempotency key, and a push carries a collapse key, so repeating those is harmless.
 *   - Collapse groups are decided under an advisory lock per business and kind, taken in one order by every worker.
 */
export const NOTIFY_QUEUE = 'notifications.dispatch';
const LEASE_MS = 120_000;
const SEND_CONCURRENCY = 4;
const LOCK_GROUPS = 52101;
const DIRECT_REPORT_RETRY_MS = 30 * 60_000;
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

const isSeller = (user) => Boolean(user) && SELLER_ROLES.includes(user.role);

function inAudience(user, audience) {
  if (!isSeller(user)) return false;
  if (audience && typeof audience === 'object') return Number(user.id) === Number(audience.userId);
  if (audience === 'owner') return user.role === 'owner';
  if (audience === 'managers') return user.role === 'owner' || user.role === 'manager';
  if (PERMISSIONS.includes(audience)) return user.role !== 'staff' || (user.permissions ?? []).includes(audience);
  return false;
}

const savedOf = (row) => (row ? { quietHours: { enabled: row.quiet_enabled, from: row.quiet_from, to: row.quiet_to, timezone: row.timezone }, events: row.events ?? {} } : {});
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const valuesOf = (ev) => ({ ...(ev.data ?? {}), business: ev.business ?? '' });

/** The report_deliveries row an event stands for, when it came from that source. */
function reportRowOf(ev) {
  const id = Number(ev.data?.reportDeliveryId);
  return Number.isSafeInteger(id) && id > 0 && ev.event_key === `report_delivery:${id}` ? id : null;
}

/** The body variables of Bhava's WhatsApp template for a kind: the workspace's name, then each placeholder of the wording for one, in order. */
export function whatsappParams(kind, values) {
  const spec = NOTIFY_EVENTS[kind];
  const names = [...`${spec.one.title} ${spec.one.body}`.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).filter((n, i, all) => n !== 'business' && n !== 'count' && all.indexOf(n) === i);
  return [values.business, ...names.map((name) => values[name])].map((v) => String(v ?? '').trim().slice(0, 60) || '-');
}

/**
 * Runs fn for one row of a batch inside the batch's transaction, behind a savepoint: a row that fails is rolled back on
 * its own and reported, so one bad row can never hold up the rows after it or stall the batch on every pass.
 */
async function eachRow(t, rows, fn, what) {
  const failed = [];
  for (const row of rows) {
    await t.query('SAVEPOINT notify_row');
    try {
      await fn(row);
      await t.query('RELEASE SAVEPOINT notify_row');
    } catch (err) {
      await t.query('ROLLBACK TO SAVEPOINT notify_row');
      failed.push(row);
      reportError(err, { msg: `notify.${what}_failed`, id: Number(row.id) });
    }
  }
  return failed;
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function createPipeline({ platformDb, push, providers, config, clock, devices, getRepos = () => null }) {
  const ready = {
    push: () => push.configured('android') || push.configured('ios'),
    email: () => Boolean(providers?.email?.platform?.configured),
    whatsapp: () => Boolean(providers?.whatsapp?.platform?.configured),
  };

  // ---- contacts ---------------------------------------------------------------------------------------------------

  /** Where each recipient can be reached: an email address, a verified phone (E.164), how many devices. */
  async function contactsFor(q, users) {
    const personIds = [...new Set(users.map((u) => u.person_id).filter((id) => id !== null && id !== undefined).map(Number))];
    const identities = personIds.length
      ? await q.query(`SELECT i.person_id, i.kind, i.subject, i.email FROM person_identities i JOIN people p ON p.id = i.person_id AND p.deleted_at IS NULL
                       WHERE i.person_id = ANY($1::bigint[]) ORDER BY i.id`, [personIds])
      : [];
    const counts = await devices.counts(q, personIds);
    const byPerson = new Map();
    for (const row of identities) {
      const entry = byPerson.get(Number(row.person_id)) ?? {};
      if (row.kind === 'phone' && !entry.phone) entry.phone = row.subject;
      if (row.kind !== 'phone' && EMAIL.test(row.email ?? '') && !entry.email) entry.email = row.email.toLowerCase();
      byPerson.set(Number(row.person_id), entry);
    }
    return new Map(users.map((u) => {
      const person = byPerson.get(Number(u.person_id)) ?? {};
      const email = EMAIL.test(String(u.email ?? '').trim()) ? String(u.email).trim().toLowerCase() : person.email ?? '';
      return [u.id, { email, phone: person.phone ?? '', devices: u.person_id ? counts.get(Number(u.person_id)) ?? 0 : 0 }];
    }));
  }

  async function contactOf(user) {
    return (await contactsFor(platformDb, [user])).get(user.id);
  }

  async function settleReport(q, tenantId, reportId, status) {
    await q.query(
      `UPDATE report_deliveries SET status = $3, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
      [tenantId, reportId, status],
    );
  }

  // ---- handing out ------------------------------------------------------------------------------------------------

  async function handOutChannel(t, ev, user, channel, prefs, contact, now) {
    const spec = NOTIFY_EVENTS[ev.kind];
    const insert = async ({ status = 'queued', reason = '', at = now, sentAt = null, collapsedInto = null }) => {
      const [row] = await t.query(
        `INSERT INTO notification_deliveries (tenant_id, event_id, user_id, channel, status, reason, next_attempt_at, created_at, sent_at, collapsed_into)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (event_id, user_id, channel) DO NOTHING RETURNING id`,
        [ev.tenant_id, ev.id, user.id, channel, status, reason, at, now, sentAt, collapsedInto],
      );
      return row ? status : null;
    };

    if (channel === 'inapp') {
      const words = wordingFor(ev.kind, { values: valuesOf(ev) });
      await t.query(
        `INSERT INTO notifications (tenant_id, user_id, event_id, kind, title, body, link, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (event_id, user_id) DO NOTHING`,
        [ev.tenant_id, user.id, ev.id, ev.kind, truncate(words.title, 120), truncate(words.body, 240), ev.link, now],
      );
      return insert({ status: 'sent', sentAt: now });
    }
    if (!ready[channel]()) return insert({ status: 'dropped', reason: 'not_configured' });
    const reachable = channel === 'push' ? contact.devices > 0 : channel === 'email' ? Boolean(contact.email) : Boolean(contact.phone);
    if (!reachable) return insert({ status: 'dropped', reason: 'no_address' });
    const at = deliverAt(ev.kind, channel, prefs, now);
    if (!at) return null;
    if (channel !== 'push' || !spec.collapse || spec.critical) return insert({ at });

    // Collapse: join the group still waiting, or the one that went out inside collapseMs; otherwise open a new one.
    const [leader] = await t.query(
      `SELECT d.id, d.status FROM notification_deliveries d JOIN notification_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
       WHERE d.tenant_id = $1 AND d.user_id = $2 AND d.channel = 'push' AND d.collapsed_into IS NULL AND e.kind = $3
         AND (d.status = 'queued' OR (d.status = 'sent' AND d.created_at > $4))
       ORDER BY d.id DESC LIMIT 1 FOR UPDATE OF d`,
      [ev.tenant_id, user.id, ev.kind, new Date(now.getTime() - NOTIFY_RULES.collapseMs)],
    );
    if (!leader) return insert({ at });
    const joined = await insert({ status: 'collapsed', collapsedInto: leader.id });
    if (!joined) return null;
    // A group that already went out goes again with the new count and the same collapse key, so the phone shows one.
    const again = quietUntil(prefs.quietHours, now) ?? now;
    await t.query(
      `UPDATE notification_deliveries SET group_count = group_count + 1, status = 'queued',
         attempt = CASE WHEN status = 'sent' THEN 0 ELSE attempt END,
         next_attempt_at = CASE WHEN status = 'sent' THEN $3 ELSE next_attempt_at END,
         reason = CASE WHEN status = 'sent' THEN '' ELSE reason END
       WHERE tenant_id = $1 AND id = $2`,
      [ev.tenant_id, leader.id, again],
    );
    return 'collapsed';
  }

  async function handOut(t, ev, now) {
    const spec = NOTIFY_EVENTS[ev.kind];
    const reportId = reportRowOf(ev);
    if (!spec) {
      log.warn('notify.unknown_kind', { eventId: Number(ev.id) });
      return 0;
    }
    const users = await t.query('SELECT id, role, permissions, email, person_id FROM users WHERE tenant_id = $1 AND removed_at IS NULL AND role = ANY($2)', [ev.tenant_id, SELLER_ROLES]);
    const recipients = users.filter((u) => inAudience(u, ev.audience));
    const outcomes = [];
    if (recipients.length) {
      const saved = await t.query('SELECT * FROM notification_prefs WHERE tenant_id = $1 AND user_id = ANY($2::int[])', [ev.tenant_id, recipients.map((u) => u.id)]);
      const prefsOf = new Map(saved.map((row) => [row.user_id, resolvePrefs(savedOf(row))]));
      const contacts = await contactsFor(t, recipients);
      for (const user of recipients) {
        const prefs = prefsOf.get(user.id) ?? resolvePrefs();
        for (const channel of ev.channels ?? NOTIFY_CHANNELS) {
          if (!prefs.events[ev.kind]?.[channel]) continue;
          const outcome = await handOutChannel(t, ev, user, channel, prefs, contacts.get(user.id), now);
          if (outcome) outcomes.push(outcome);
        }
      }
    }
    // A report delivery that nothing will carry is over now; one that is queued follows its delivery.
    if (reportId && !outcomes.some((o) => o === 'queued' || o === 'sent')) await settleReport(t, ev.tenant_id, reportId, 'failed');
    log.info('notify.handed_out', { eventId: Number(ev.id), kind: ev.kind, recipients: recipients.length, deliveries: outcomes.length });
    return outcomes.length;
  }

  async function fanOut(limit) {
    const now = clock();
    return platformDb.tx(async (t) => {
      const events = await t.query(
        `SELECT e.id, e.tenant_id, e.kind, e.event_key, e.audience, e.channels, e.data, e.link, tn.name AS business
         FROM notification_events e JOIN tenants tn ON tn.id = e.tenant_id
         WHERE e.fanned_out_at IS NULL ORDER BY e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED`,
        [limit],
      );
      if (!events.length) return 0;
      // Every group this batch may touch, locked in one order, so two workers never decide one group at once and never deadlock.
      const groups = [...new Set(events.filter((e) => NOTIFY_EVENTS[e.kind]?.collapse).map((e) => `${e.tenant_id}:${e.kind}`))].sort();
      for (const group of groups) await t.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_GROUPS, group]);
      // An event that cannot be handed out is reported and marked like the rest, so it never blocks the ones after it.
      await eachRow(t, events, (ev) => handOut(t, ev, now), 'hand_out');
      await t.query('UPDATE notification_events SET fanned_out_at = now() WHERE id = ANY($1::bigint[])', [events.map((e) => e.id)]);
      return events.length;
    });
  }

  // ---- the two sources --------------------------------------------------------------------------------------------

  /** ids and numbers from an alert row, for the wording and the link. Anything that would not pass as data is left out. */
  async function alertData(t, alert) {
    const data = { alertId: Number(alert.id) };
    const target = String(alert.target ?? '');
    const channel = /^(instagram|facebook):/.exec(target)?.[1];
    if (channel) data.account = channel === 'instagram' ? 'Instagram' : 'Facebook';
    const days = /^expiry_(\d{1,3})d:/.exec(String(alert.dedupe_key ?? ''))?.[1];
    if (days) data.days = Number(days);
    const orderId = /^order:(\d{1,10})$/.exec(target)?.[1];
    if (orderId) {
      data.orderId = Number(orderId);
      const [order] = await t.query('SELECT order_number FROM orders WHERE tenant_id = $1 AND id = $2', [alert.tenant_id, data.orderId]);
      if (order && !dataProblem({ orderNumber: order.order_number })) data.orderNumber = order.order_number;
    }
    const returnId = /^return-requested:(\d{1,10})$/.exec(String(alert.dedupe_key ?? ''))?.[1];
    if (returnId) data.returnId = Number(returnId);
    if (alert.kind === 'thread.handoff' && /^\d{1,10}$/.test(target)) data.threadId = Number(target);
    for (const key of Object.keys(data)) if (dataProblem({ [key]: data[key] })) delete data[key];
    return data;
  }

  async function takeAlerts(limit) {
    return platformDb.tx(async (t) => {
      const rows = await t.query(
        `SELECT id, tenant_id, kind, target, dedupe_key FROM alerts WHERE notified_at IS NULL AND audience = 'owner' AND tenant_id IS NOT NULL
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      await eachRow(t, rows, async (alert) => {
        const kind = NOTIFY_SOURCES.alerts[alert.kind];
        if (!kind) return; // stays in the alerts list only
        await writeEvent(t, checkEvent({ event: kind, tenantId: alert.tenant_id, key: `alert:${alert.id}`, data: await alertData(t, alert) }, { anyBusiness: true }));
      }, 'alert');
      if (rows.length) await t.query('UPDATE alerts SET notified_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      return rows.length;
    });
  }

  /**
   * A report row that is not a notification (an outside address, or a report with no notification kind): sent by Bhava's
   * own email sender exactly as the reports module wrote it, with the row's id as the idempotency key, and marked.
   */
  async function sendReportDirect(row) {
    const sender = providers?.email?.platform;
    const finish = (status, reason = '') => {
      log.info('notify.report_direct', { reportDeliveryId: Number(row.id), status, ...(reason ? { reason } : {}) });
      return settleReport(platformDb, row.tenant_id, row.id, status);
    };
    if (row.channel !== 'email' || !EMAIL.test(String(row.to_address ?? ''))) return finish('failed', 'no_address');
    if (row.attachment_key) return finish('failed', 'attachment_unsupported');
    if (!sender?.configured) return finish('failed', 'not_configured');
    const [full] = await platformDb.query('SELECT subject, body FROM report_deliveries WHERE tenant_id = $1 AND id = $2', [row.tenant_id, row.id]);
    const [tenant] = await platformDb.query('SELECT id, slug, name FROM tenants WHERE id = $1', [row.tenant_id]);
    if (!full || !tenant) return finish('failed', 'gone');
    const logo = await logoFor(tenant);
    const html = markWorkspaceBadge(full.body, logo);
    if (sellerEmailProblem({ from: sender.from, html }, { platformFrom: sender.from })) return finish('failed', 'content');
    try {
      await sender.send({ to: row.to_address, subject: full.subject, html, text: textOf(html), idempotencyKey: `report-delivery-${row.tenant_id}-${row.id}` });
      return finish('sent');
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return finish('failed', err.code === 'not_configured' ? 'not_configured' : err.kind);
    }
  }

  async function takeReports(limit) {
    const direct = [];
    const taken = await platformDb.tx(async (t) => {
      const rows = await t.query(
        `SELECT r.id, r.tenant_id, r.channel, r.user_id, r.to_address, r.report_run_id, r.attachment_key, rr.kind AS run_kind
         FROM report_deliveries r LEFT JOIN report_runs rr ON rr.tenant_id = r.tenant_id AND rr.id = r.report_run_id
         WHERE r.notified_at IS NULL AND r.status = 'queued' ORDER BY r.id LIMIT $1 FOR UPDATE OF r SKIP LOCKED`,
        [limit],
      );
      const broken = await eachRow(t, rows, async (row) => {
        const kind = NOTIFY_SOURCES.reportPeriods[row.run_kind];
        if (!row.user_id || !kind) {
          direct.push(row);
          return;
        }
        const data = { reportDeliveryId: Number(row.id), ...(row.report_run_id ? { reportRunId: Number(row.report_run_id) } : {}) };
        await writeEvent(t, checkEvent({ event: kind, tenantId: row.tenant_id, audience: { userId: row.user_id }, key: `report_delivery:${row.id}`, data, channels: [row.channel] }, { anyBusiness: true }));
      }, 'report');
      // A report row that could not become an event is over: marked failed, never left looking queued.
      for (const row of broken) await settleReport(t, row.tenant_id, row.id, 'failed');
      if (rows.length) await t.query('UPDATE report_deliveries SET notified_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      return rows.length;
    });
    // A direct send that was claimed long ago and never marked (the worker stopped): again, under the same idempotency key.
    // Rows migration 520 stamped (notified_at equal to created_at) were there before this module and are never sent late.
    const stale = await platformDb.query(
      `SELECT r.id, r.tenant_id, r.channel, r.user_id, r.to_address, r.attachment_key FROM report_deliveries r LEFT JOIN report_runs rr ON rr.tenant_id = r.tenant_id AND rr.id = r.report_run_id
       WHERE r.status = 'queued' AND r.notified_at < now() - make_interval(secs => $1::float) AND r.notified_at > r.created_at
         AND (r.user_id IS NULL OR rr.kind IS NULL OR rr.kind <> ALL($2::text[])) ORDER BY r.id LIMIT $3`,
      [DIRECT_REPORT_RETRY_MS / 1000, Object.keys(NOTIFY_SOURCES.reportPeriods), limit],
    );
    const seen = new Set(direct.map((r) => Number(r.id)));
    for (const row of [...direct, ...stale.filter((r) => !seen.has(Number(r.id)))]) {
      try {
        await sendReportDirect(row);
      } catch (err) {
        reportError(err, { msg: 'notify.report_direct_failed', reportDeliveryId: Number(row.id) });
      }
    }
    return taken;
  }

  // ---- sending ------------------------------------------------------------------------------------------------------

  async function logoFor(tenant) {
    const repos = getRepos();
    if (!repos?.brandKit) return '';
    try {
      const kit = await withTenant({ id: tenant.id, slug: tenant.slug, name: tenant.name }, () => repos.brandKit.get());
      return logoSource(kit?.logoUrl ?? '', tenantBaseUrl(tenant, config ?? {}) || '');
    } catch (err) {
      reportError(err, { msg: 'notify.brand_failed', tenantId: tenant.id });
      return '';
    }
  }

  async function sendPush(row, ev, user) {
    if (!ready.push()) return { status: 'dropped', reason: 'not_configured' };
    const list = await devices.forPerson(user.person_id);
    if (!list.length) return { status: 'dropped', reason: 'no_address' };
    const count = Math.max(1, Number(row.group_count) || 1);
    const words = wordingFor(ev.kind, { count, values: valuesOf(ev) });
    // A group opens the list; one event opens its record.
    const link = count > 1 ? linkFor(ev.kind, {}) : ev.link;
    const data = { tenantId: ev.tenant_id, kind: ev.kind, link, eventId: Number(ev.id), count };
    const problem = pushProblem({ ...words, data });
    if (problem) {
      log.warn('notify.push_refused', { deliveryId: Number(row.id), kind: ev.kind, problem });
      return { status: 'failed', reason: 'content' };
    }
    const collapseKey = collapseKeyFor({ tenantId: ev.tenant_id, kind: ev.kind, groupId: row.id });
    const took = [];
    let ref = '';
    let retry = null;
    let gone = '';
    let other = '';
    let notConfigured = 0;
    for (const device of list) {
      row.calledProvider = true;
      try {
        const answer = await push.send({ platform: device.platform, token: device.token, title: words.title, body: words.body, data, collapseKey, ttl: NOTIFY_RULES.pushTtlSeconds });
        if (answer?.ok) {
          took.push(device.id);
          ref ||= String(answer.id ?? '').slice(0, 200);
        } else notConfigured++;
      } catch (err) {
        if (!(err instanceof ProviderError)) {
          reportError(err, { msg: 'notify.push_error', deliveryId: Number(row.id), pushDeviceId: device.id });
          other ||= 'error';
        } else if (PUSH_TOKEN_GONE.includes(err.kind)) {
          gone = err.kind;
          await devices.markGone(device.id, err.kind);
        } else if (err.retryable) {
          retry = err;
        } else {
          other ||= err.kind;
        }
      }
    }
    if (took.length) {
      await devices.markOk(took);
      return { status: 'sent', ref, sentCount: count };
    }
    if (retry) return { status: 'retry', reason: retry.kind, retryAfter: retry.retryAfter };
    if (other) return { status: 'failed', reason: other };
    if (gone) return { status: 'failed', reason: gone };
    return { status: 'dropped', reason: notConfigured ? 'not_configured' : 'no_address' };
  }

  async function sendEmail(row, ev, user) {
    const sender = providers?.email?.platform;
    if (!sender?.configured) return { status: 'dropped', reason: 'not_configured' };
    const { email: to } = await contactOf(user);
    if (!to) return { status: 'dropped', reason: 'no_address' };
    const tenant = { id: ev.tenant_id, slug: ev.slug, name: ev.business };
    const logo = await logoFor(tenant);
    let message;
    const reportId = reportRowOf(ev);
    if (reportId) {
      // The report itself, as the reports module wrote it for this person.
      const [report] = await platformDb.query('SELECT subject, body FROM report_deliveries WHERE tenant_id = $1 AND id = $2', [ev.tenant_id, reportId]);
      if (!report) return { status: 'dropped', reason: 'no_address' };
      const html = markWorkspaceBadge(report.body, logo);
      message = { subject: report.subject, html, text: textOf(html) };
    } else {
      message = sellerEmail({ layout: NOTIFY_EVENTS[ev.kind].email, words: wordingFor(ev.kind, { values: valuesOf(ev) }), business: ev.business, logoUrl: logo, base: tenantBaseUrl(tenant, config ?? {}) || '', link: ev.link });
    }
    const problem = sellerEmailProblem({ from: sender.from, html: message.html }, { platformFrom: sender.from });
    if (problem) {
      log.warn('notify.email_refused', { deliveryId: Number(row.id), kind: ev.kind, problem });
      return { status: 'failed', reason: 'content' };
    }
    row.calledProvider = true;
    try {
      const { messageId } = await sender.send({ to, subject: message.subject, html: message.html, text: message.text, idempotencyKey: `notify-${ev.tenant_id}-${row.id}` });
      return { status: 'sent', ref: String(messageId ?? '').slice(0, 200) };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.code === 'not_configured') return { status: 'dropped', reason: 'not_configured' };
      // The delivery is the idempotency key, so a try whose answer was lost is safe to make again.
      if (err.retryable || err.delivery === 'unknown') return { status: 'retry', reason: err.kind };
      return { status: 'failed', reason: err.kind };
    }
  }

  async function sendWhatsApp(row, ev, user) {
    const sender = providers?.whatsapp?.platform;
    const spec = NOTIFY_EVENTS[ev.kind];
    if (!sender?.configured) return { status: 'dropped', reason: 'not_configured' };
    if (!spec.whatsapp) return { status: 'dropped', reason: 'pref_off' };
    const { phone } = await contactOf(user);
    if (!/^\+[1-9]\d{7,14}$/.test(phone ?? '')) return { status: 'dropped', reason: 'no_address' };
    row.calledProvider = true;
    try {
      const { messageId } = await sender.send({ to: phone.slice(1), template: spec.whatsapp, params: whatsappParams(ev.kind, valuesOf(ev)) });
      // A 200 that names no message proves nothing either way: it may have gone, so it is not sent again.
      if (!messageId) return { status: 'failed', reason: 'unknown_delivery' };
      return { status: 'sent', ref: String(messageId).slice(0, 200) };
    } catch (err) {
      if (!(err instanceof ProviderError)) return { status: 'failed', reason: 'no_address' }; // refused before anything was sent
      if (err.code === 'not_configured') return { status: 'dropped', reason: 'not_configured' };
      if (err.delivery === 'unknown') return { status: 'failed', reason: 'unknown_delivery' };
      if (NO_WHATSAPP_CODES.includes(String(err.code))) return { status: 'failed', reason: 'no_whatsapp' };
      if (err.retryable) return { status: 'retry', reason: err.kind };
      return { status: 'failed', reason: err.kind };
    }
  }

  const SENDERS = { push: sendPush, email: sendEmail, whatsapp: sendWhatsApp };

  /** Writes what happened, only while the lease is still this worker's. Returns the status written, or null. */
  async function finish(row, outcome, now) {
    const own = [row.tenant_id, row.id, row.lease];
    let rows;
    if (outcome.status === 'sent') {
      // A group that someone joined while its push was in flight goes again at once with the new count.
      rows = await platformDb.query(
        `UPDATE notification_deliveries SET status = CASE WHEN group_count > $4 THEN 'queued' ELSE 'sent' END,
           attempt = CASE WHEN group_count > $4 THEN 0 ELSE attempt END, next_attempt_at = $5, sent_at = $5, provider_ref = $6, reason = '', locked_until = NULL
         WHERE tenant_id = $1 AND id = $2 AND locked_until = $3 RETURNING status`,
        [...own, outcome.sentCount ?? Number(row.group_count), now, outcome.ref ?? ''],
      );
    } else if (outcome.status === 'retry') {
      const next = nextAttemptAt(row.attempt, now);
      if (!next) return finish(row, { status: 'failed', reason: outcome.reason }, now);
      const wait = Number(outcome.retryAfter) > 0 ? Math.max(next.getTime(), now.getTime() + Math.min(3600, Number(outcome.retryAfter)) * 1000) : next.getTime();
      rows = await platformDb.query(
        `UPDATE notification_deliveries SET status = 'queued', next_attempt_at = $4, reason = $5, locked_until = NULL WHERE tenant_id = $1 AND id = $2 AND locked_until = $3 RETURNING status`,
        [...own, new Date(wait), String(outcome.reason).slice(0, 80)],
      );
    } else if (outcome.status === 'hold') {
      // Quiet hours began after the event was handed out: not a try, so it is given back.
      rows = await platformDb.query(
        `UPDATE notification_deliveries SET next_attempt_at = $4, attempt = GREATEST(attempt - 1, 0), reason = '', locked_until = NULL WHERE tenant_id = $1 AND id = $2 AND locked_until = $3 RETURNING status`,
        [...own, outcome.until],
      );
    } else {
      rows = await platformDb.query(
        `UPDATE notification_deliveries SET status = $4, reason = $5, locked_until = NULL WHERE tenant_id = $1 AND id = $2 AND locked_until = $3 RETURNING status`,
        [...own, outcome.status, String(outcome.reason || 'error').slice(0, 80)],
      );
    }
    const status = rows[0]?.status ?? null;
    log.info('notify.delivery', { deliveryId: Number(row.id), eventId: Number(row.event_id), channel: row.channel, attempt: row.attempt, status: status ?? 'lease_lost', ...(outcome.reason ? { reason: outcome.reason } : {}) });
    return status;
  }

  async function followReport(ev, status) {
    const reportId = ev && reportRowOf(ev);
    if (!reportId || !['sent', 'failed', 'dropped'].includes(status)) return;
    await settleReport(platformDb, ev.tenant_id, reportId, status === 'sent' ? 'sent' : 'failed');
  }

  async function loadEvent(tenantId, eventId) {
    const [ev] = await platformDb.query(
      `SELECT e.id, e.tenant_id, e.kind, e.event_key, e.data, e.link, t.name AS business, t.slug FROM notification_events e JOIN tenants t ON t.id = e.tenant_id WHERE e.tenant_id = $1 AND e.id = $2`,
      [tenantId, eventId],
    );
    return ev ?? null;
  }

  async function sendOne(row, now) {
    // Still this worker's? A row that waited in the pool past its lease may have been taken by another worker.
    const lease = new Date(clock().getTime() + LEASE_MS);
    const [mine] = await platformDb.query(
      `UPDATE notification_deliveries SET locked_until = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND locked_until = $3 RETURNING id`,
      [row.tenant_id, row.id, row.lease, lease],
    );
    if (!mine) return 'lost';
    row.lease = lease;
    let ev = null;
    try {
      ev = await loadEvent(row.tenant_id, row.event_id);
      if (!ev || !NOTIFY_EVENTS[ev.kind]) return await finish(row, { status: 'dropped', reason: 'content' }, now);
      if (row.channel === 'whatsapp' && row.was === 'sending') {
        // The last try was claimed and its answer never recorded: it may have gone out.
        return await followAfter(ev, await finish(row, { status: 'failed', reason: 'unknown_delivery' }, now));
      }
      const [user] = await platformDb.query('SELECT id, role, email, person_id, removed_at FROM users WHERE tenant_id = $1 AND id = $2', [row.tenant_id, row.user_id]);
      // Checked again before every try: someone removed from the team gets nothing more from it.
      if (!user || user.removed_at || !isSeller(user)) return await followAfter(ev, await finish(row, { status: 'dropped', reason: 'removed' }, now));
      const [saved] = await platformDb.query('SELECT * FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2', [row.tenant_id, row.user_id]);
      const prefs = resolvePrefs(savedOf(saved));
      if (!prefs.events[ev.kind]?.[row.channel]) return await followAfter(ev, await finish(row, { status: 'dropped', reason: 'pref_off' }, now));
      if (QUIET_CHANNELS.includes(row.channel) && !NOTIFY_EVENTS[ev.kind].critical) {
        const until = quietUntil(prefs.quietHours, now);
        if (until) return await finish(row, { status: 'hold', until }, now);
      }
      const outcome = await SENDERS[row.channel](row, ev, user);
      return await followAfter(ev, await finish(row, outcome, now));
    } catch (err) {
      reportError(err, { msg: 'notify.send_failed', deliveryId: Number(row.id), channel: row.channel });
      // Nothing reached a provider: safe to try again later. Otherwise the lease runs out and the row is looked at then.
      if (!row.calledProvider) {
        try {
          return await followAfter(ev, await finish(row, { status: 'retry', reason: 'error' }, now));
        } catch {
          // The database is the problem: the lease runs out and the row comes back.
        }
      }
      return 'error';
    }
  }

  async function followAfter(ev, status) {
    await followReport(ev, status);
    return status;
  }

  async function sendDue(limit) {
    const now = clock();
    // A last try that was claimed and never recorded (the worker stopped) is over: its answer was lost.
    const stuck = await platformDb.query(
      `UPDATE notification_deliveries SET status = 'failed', reason = CASE WHEN reason IN ('', 'sending') THEN 'unknown_delivery' ELSE reason END, locked_until = NULL
       WHERE status = 'queued' AND attempt >= $1 AND locked_until IS NOT NULL AND locked_until < $2 RETURNING tenant_id, event_id`,
      [NOTIFY_RULES.maxAttempts, now],
    );
    for (const row of stuck) await followReport(await loadEvent(row.tenant_id, row.event_id), 'failed');
    const lease = new Date(now.getTime() + LEASE_MS);
    const claimed = await platformDb.query(
      `WITH due AS (
         SELECT id, reason FROM notification_deliveries
         WHERE status = 'queued' AND next_attempt_at <= $2 AND (locked_until IS NULL OR locked_until < $2) AND attempt < $3
         ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE notification_deliveries d SET attempt = d.attempt + 1, locked_until = $4,
         reason = CASE WHEN d.channel = 'whatsapp' THEN 'sending' ELSE d.reason END
       FROM due WHERE d.id = due.id
       RETURNING d.id, d.tenant_id, d.event_id, d.user_id, d.channel, d.attempt, d.group_count, due.reason AS was`,
      [limit, now, NOTIFY_RULES.maxAttempts, lease],
    );
    const tally = { claimed: claimed.length, sent: 0, failed: 0, dropped: 0, retried: 0 };
    await pool(claimed.map((row) => ({ ...row, lease })), SEND_CONCURRENCY, async (row) => {
      const status = await sendOne(row, now);
      if (status === 'sent') tally.sent++;
      else if (status === 'failed') tally.failed++;
      else if (status === 'dropped') tally.dropped++;
      else if (status === 'queued') tally.retried++;
    });
    return tally;
  }

  return { fanOut, takeAlerts, takeReports, sendDue };
}
