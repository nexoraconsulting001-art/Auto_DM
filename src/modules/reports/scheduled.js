import { ApiError, canSeeRevenue } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { REPORTING_STATUSES, currentBusiness, readsAnalytics, teamReaders } from './business.js';
import { CATCH_UP_MS, clockOf, nextRunAt, periodLabel, safeZone, scheduleRule } from './clock.js';
import { fileStore, scheduledKey } from './files.js';
import { emailHtml, escapeHtml } from './render.js';
import { FORMATS, fileName, renderTable } from './table.js';

/**
 * Scheduled reports (7.13): any saved view, daily, weekly or monthly at an hour on the business's clock, as a CSV or Excel file attached to a Bhava
 * email. Recipients are the team by default; only the owner adds an outside address, and every change to the list is in the audit log. Each recipient
 * gets the version their role allows. Nothing goes while the business is paused, suspended or closed, and a run missed then is not sent late.
 */
export const QUEUE_SCHEDULED = 'reports.scheduled';
const MAX_ATTEMPTS = 3;
const notFound = () => new ApiError('not_found');

/** Enough of an address to recognise it in the audit log, and no more. */
export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
}

const toRecipient = (r) => ({ id: r.id, kind: r.kind, userId: r.user_id ?? null, email: r.kind === 'team' ? r.user_email ?? r.email ?? '' : r.email, addedAt: r.added_at });

export function createScheduled(ctx, { sources }) {
  const { db, repos, platform, config } = ctx;
  const now = () => clockOf(config)();
  const files = () => fileStore(platform);
  const visibleTo = (alias = 'v') => `(${alias}.visibility = 'team' OR ${alias}.created_by = $2)`;

  async function zone() {
    const [row] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId()]);
    return safeZone(row?.timezone);
  }

  async function recipientsOf(ids, runner = db) {
    if (!ids.length) return new Map();
    const rows = await runner.query(
      `SELECT r.*, u.email AS user_email FROM scheduled_report_recipients r LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
       WHERE r.tenant_id = $1 AND r.scheduled_report_id = ANY($2::int[]) ORDER BY r.id`,
      [tenantId(), ids],
    );
    const out = new Map(ids.map((id) => [id, []]));
    for (const r of rows) out.get(r.scheduled_report_id)?.push(toRecipient(r));
    return out;
  }

  const toSchedule = (row, recipients) => ({
    id: row.id, viewId: row.view_id, viewName: row.view_name, frequency: row.frequency, hourOfDay: row.hour_of_day, weekday: row.weekday, dayOfMonth: row.day_of_month,
    format: row.format, enabled: row.enabled, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, recipients,
  });

  /** A schedule this person can see: its view is shared with the team, or theirs. */
  async function find(id, user, runner = db) {
    const [row] = await runner.query(
      `SELECT s.*, v.name AS view_name FROM scheduled_reports s JOIN saved_views v ON v.tenant_id = s.tenant_id AND v.id = s.view_id
       WHERE s.tenant_id = $1 AND s.id = $3 AND ${visibleTo()}`,
      [tenantId(), user.id, id],
    );
    return row ?? null;
  }

  async function one(id, user) {
    const row = await find(id, user);
    if (!row) return null;
    return toSchedule(row, (await recipientsOf([row.id])).get(row.id));
  }

  async function list({ cursor, limit }, user) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
    const rows = await db.query(
      `SELECT s.*, v.name AS view_name FROM scheduled_reports s JOIN saved_views v ON v.tenant_id = s.tenant_id AND v.id = s.view_id
       WHERE s.tenant_id = $1 AND ${visibleTo()} AND ($3::int IS NULL OR s.id < $3) ORDER BY s.id DESC LIMIT $4`,
      [tenantId(), user.id, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (row) => [row.id]);
    const recipients = await recipientsOf(page.items.map((r) => r.id));
    return { items: page.items.map((row) => toSchedule(row, recipients.get(row.id))), nextCursor: page.nextCursor };
  }

  async function requirePlan() {
    if (!(await repos.entitlements.can('reports.scheduled'))) throw new ApiError('forbidden', 'Scheduled reports are available from tier 2.');
  }

  async function create(body, user) {
    await requirePlan();
    const [view] = await db.query(`SELECT v.id, v.visibility, v.created_by FROM saved_views v WHERE v.tenant_id = $1 AND v.id = $3 AND ${visibleTo()}`, [tenantId(), user.id, body.viewId]);
    if (!view) throw new ApiError('not_found', 'We couldn’t find that view.');
    const rule = scheduleRule(body);
    const next = nextRunAt({ ...rule, hourOfDay: body.hourOfDay }, now(), await zone());
    // A shared view goes to the whole team that reads analytics; a private one to the person who made it.
    const team = view.visibility === 'team' ? await teamReaders(db) : [user];
    const id = await db.tx(async (t) => {
      const [row] = await t.query(
        `INSERT INTO scheduled_reports (tenant_id, view_id, frequency, hour_of_day, weekday, day_of_month, format, enabled, next_run_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10) RETURNING id`,
        [tenantId(), view.id, rule.frequency, body.hourOfDay, rule.weekday, rule.dayOfMonth, body.format, body.enabled, new Date(next), user.id],
      );
      for (const person of team) {
        await t.query(
          `INSERT INTO scheduled_report_recipients (tenant_id, scheduled_report_id, kind, user_id, added_by) VALUES ($1, $2, 'team', $3, $4) ON CONFLICT DO NOTHING`,
          [tenantId(), row.id, person.id, user.id],
        );
      }
      await writeAudit(t, { actor: `user:${user.id}`, action: 'scheduled_report.created', target: `scheduled_report:${row.id}`, details: { scheduledReportId: row.id, viewId: view.id, frequency: rule.frequency, hourOfDay: body.hourOfDay, format: body.format, teamRecipients: team.length } });
      return row.id;
    });
    return one(id, user);
  }

  async function update(id, change, user) {
    const row = await find(id, user);
    if (!row) return null;
    if (change.enabled === true && !row.enabled) await requirePlan();
    const frequency = change.frequency ?? row.frequency;
    const rule = scheduleRule({ frequency, weekday: change.weekday ?? row.weekday ?? undefined, dayOfMonth: change.dayOfMonth ?? row.day_of_month ?? undefined });
    const hourOfDay = change.hourOfDay ?? row.hour_of_day;
    const enabled = change.enabled ?? row.enabled;
    const next = nextRunAt({ ...rule, hourOfDay }, now(), await zone());
    await db.tx(async (t) => {
      await t.query(
        `UPDATE scheduled_reports SET frequency = $3, hour_of_day = $4, weekday = $5, day_of_month = $6, format = $7, enabled = $8, next_run_at = $9::timestamptz, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), id, rule.frequency, hourOfDay, rule.weekday, rule.dayOfMonth, change.format ?? row.format, enabled, new Date(next)],
      );
      const changed = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
      await writeAudit(t, { actor: `user:${user.id}`, action: 'scheduled_report.updated', target: `scheduled_report:${id}`, details: { scheduledReportId: id, ...changed } });
    });
    return one(id, user);
  }

  async function remove(id, user) {
    return db.tx(async (t) => {
      const row = await find(id, user, t);
      if (!row) return false;
      await t.query('DELETE FROM scheduled_reports WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      await writeAudit(t, { actor: `user:${user.id}`, action: 'scheduled_report.removed', target: `scheduled_report:${id}`, details: { scheduledReportId: id, viewId: row.view_id } });
      return true;
    });
  }

  /** The owner adds an address. A team member's address makes them a team recipient; anyone else's is outside the business. */
  async function addRecipient(id, { email }, user) {
    const row = await find(id, user);
    if (!row) return null;
    const [member] = await db.query(
      `SELECT id, role, permissions FROM users WHERE tenant_id = $1 AND email <> '' AND lower(email) = lower($2) AND role IN ('owner', 'manager', 'staff') ORDER BY id LIMIT 1`,
      [tenantId(), email],
    );
    if (member && !readsAnalytics(member)) throw new ApiError('validation_failed', 'This person can’t see analytics. Give them the analytics permission first.', { fields: { email: 'This person can’t see analytics' } });
    const added = await db.tx(async (t) => {
      const [saved] = await t.query(
        `INSERT INTO scheduled_report_recipients (tenant_id, scheduled_report_id, kind, user_id, email, added_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING *`,
        [tenantId(), id, member ? 'team' : 'outside', member?.id ?? null, member ? '' : email, user.id],
      );
      if (!saved) return null;
      await writeAudit(t, { actor: `user:${user.id}`, action: 'scheduled_report.recipient_added', target: `scheduled_report:${id}`, details: { scheduledReportId: id, recipientId: saved.id, kind: saved.kind, email: maskEmail(email) } });
      return saved;
    });
    if (!added) throw new ApiError('conflict', 'That address already gets this report.');
    return toRecipient({ ...added, user_email: member ? email : undefined });
  }

  async function removeRecipient(recipientId, user) {
    return db.tx(async (t) => {
      const [gone] = await t.query(
        `DELETE FROM scheduled_report_recipients r USING scheduled_reports s, saved_views v
         WHERE r.tenant_id = $1 AND r.id = $3 AND s.tenant_id = r.tenant_id AND s.id = r.scheduled_report_id AND v.tenant_id = s.tenant_id AND v.id = s.view_id AND ${visibleTo()}
         RETURNING r.id, r.kind, r.email, r.scheduled_report_id`,
        [tenantId(), user.id, recipientId],
      );
      if (!gone) return false;
      await writeAudit(t, { actor: `user:${user.id}`, action: 'scheduled_report.recipient_removed', target: `scheduled_report:${gone.scheduled_report_id}`, details: { scheduledReportId: gone.scheduled_report_id, recipientId: gone.id, kind: gone.kind, ...(gone.email ? { email: maskEmail(gone.email) } : {}) } });
      return true;
    });
  }

  // ---- running --------------------------------------------------------------------------------------------------------

  /** Who gets which version. Team members must still read analytics and see the view; an outside address gets what the owner who added it sees. */
  async function audiences(schedule) {
    const rows = await db.query(
      `SELECT r.id, r.kind, r.user_id, r.email, u.role, u.permissions, u.email AS user_email FROM scheduled_report_recipients r
       LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id WHERE r.tenant_id = $1 AND r.scheduled_report_id = $2 ORDER BY r.id`,
      [tenantId(), schedule.id],
    );
    const out = [];
    for (const r of rows) {
      if (r.kind === 'outside') {
        if (r.email) out.push({ recipient: r, audience: 'full', to: r.email, userId: null });
        continue;
      }
      const person = { id: r.user_id, role: r.role, permissions: r.permissions ?? [] };
      if (!readsAnalytics(person)) continue;
      if (schedule.visibility !== 'team' && schedule.view_owner !== person.id) continue;
      out.push({ recipient: r, audience: canSeeRevenue(person) ? 'full' : 'limited', to: r.user_email ?? '', userId: person.id });
    }
    return out;
  }

  async function run(job) {
    const id = Number(job.payload?.id);
    const dueAt = job.payload?.dueAt;
    if (!isRowId(id) || typeof dueAt !== 'string') return;
    const [schedule] = await db.query(
      `SELECT s.*, v.definition, v.name AS view_name, v.visibility, v.created_by AS view_owner, now() AS db_now FROM scheduled_reports s
       JOIN saved_views v ON v.tenant_id = s.tenant_id AND v.id = s.view_id WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId(), id],
    );
    if (!schedule || !schedule.enabled || +new Date(schedule.next_run_at) !== +new Date(dueAt)) return;
    const business = await currentBusiness(ctx);
    if (!business?.reporting) return;

    const due = +new Date(schedule.next_run_at);
    const at = Math.max(now(), +new Date(schedule.db_now));
    const next = nextRunAt({ frequency: schedule.frequency, weekday: schedule.weekday ?? undefined, dayOfMonth: schedule.day_of_month ?? undefined, hourOfDay: schedule.hour_of_day }, Math.max(at, due), business.timeZone);
    const advance = (runner, ran) => runner.query(
      `UPDATE scheduled_reports SET next_run_at = $4::timestamptz, last_run_at = CASE WHEN $5::boolean THEN now() ELSE last_run_at END, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND date_trunc('milliseconds', next_run_at) = $3::timestamptz RETURNING id`,
      [tenantId(), id, new Date(due), new Date(next), ran],
    );
    // Missed while the business was paused or the plan didn't include it: the next one is set, and the old one isn't sent late.
    if (at - due > CATCH_UP_MS || !(await repos.entitlements.can('reports.scheduled'))) {
      await advance(db, false);
      log.info('reports.scheduled_skipped', { tenantId: tenantId(), scheduledReportId: id });
      return;
    }

    try {
      const people = await audiences(schedule);
      const format = FORMATS[schedule.format];
      const built = new Map();
      for (const audience of new Set(people.map((p) => p.audience))) {
        const result = await sources.explore({ query: schedule.definition }, null, { allowRevenue: audience === 'full' });
        const key = scheduledKey(id, result.period.since, audience, format.ext);
        await files().put(key, await renderTable(schedule.format, result.table, { sheetName: schedule.view_name }), format.type);
        built.set(audience, { ...result, key });
      }
      const period = built.values().next().value?.period ?? null;
      await db.tx(async (t) => {
        const [claimed] = await advance(t, Boolean(period));
        if (!claimed || !period) return;
        const [runRow] = await t.query(
          `INSERT INTO report_runs (tenant_id, kind, scheduled_report_id, period_start, period_end, status, summary) VALUES ($1, 'scheduled', $2, $3::date, $4::date, 'building', $5::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId(), id, period.since, period.until, JSON.stringify({ viewId: schedule.view_id, rows: Object.fromEntries([...built].map(([a, b]) => [a, b.table.rows.length])) })],
        );
        if (!runRow) return;
        const label = periodLabel(period.since, period.until);
        const name = fileName(`${schedule.view_name}-${period.until}`, format.ext);
        for (const person of people) {
          const body = emailHtml({
            businessName: business.name, logoUrl: business.logoUrl, title: schedule.view_name,
            intro: `${label}. The figures are attached as ${schedule.format === 'xlsx' ? 'an Excel' : 'a CSV'} file.`,
            footer: person.userId
              ? 'Sent by Bhava. Change or stop scheduled reports in your Bhava admin.'
              : `Sent by Bhava because ${escapeHtml(business.name)} scheduled this report for this address. Ask them to remove it if you no longer want it.`,
          });
          await t.query(
            `INSERT INTO report_deliveries (tenant_id, report_run_id, channel, user_id, to_address, subject, body, attachment_key, attachment_name) VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, $8)`,
            [tenantId(), runRow.id, person.userId, person.to, `Bhava scheduled report: ${schedule.view_name}`, body, built.get(person.audience).key, name],
          );
        }
        await t.query(`UPDATE report_runs SET status = $3, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END WHERE tenant_id = $1 AND id = $2`, [tenantId(), runRow.id, people.length ? 'sent' : 'skipped']);
      });
      log.info('reports.scheduled_sent', { tenantId: tenantId(), scheduledReportId: id, recipients: people.length });
    } catch (err) {
      if ((job.attempt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw err;
      reportError(err, { msg: 'reports.scheduled_failed', tenantId: tenantId(), scheduledReportId: id });
      await advance(db, false);
    }
  }

  return { list, create, update, remove, addRecipient, removeRecipient, run, one };
}

/** Every due schedule of every business that is open, as one queued job each. Runs outside any business. */
export async function enqueueDueSchedules({ db, platform }, at) {
  const due = await db.platform.query(
    `SELECT s.tenant_id, s.id, s.next_run_at FROM scheduled_reports s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.enabled AND t.status = ANY($2::text[]) AND s.next_run_at <= greatest(now(), $1::timestamptz) ORDER BY s.next_run_at LIMIT 500`,
    [new Date(at), REPORTING_STATUSES],
  );
  for (const row of due) {
    const dueAt = new Date(row.next_run_at).toISOString();
    await platform.queue.enqueue(QUEUE_SCHEDULED, { id: row.id, dueAt }, { tenantId: row.tenant_id, dedupeKey: `reports.scheduled:${row.tenant_id}:${row.id}:${+new Date(dueAt)}`, maxAttempts: MAX_ATTEMPTS, retryInFlight: true });
  }
  return due.length;
}
