import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';
import { ApiError } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { currentBusiness, readsAnalytics } from './business.js';
import { downloadFileUrl, downloadKey, fileStore } from './files.js';
import { emailHtml, formatCount } from './render.js';
import { sourceTitle } from './sources.js';
import { FORMATS, fileName, renderTable } from './table.js';

/**
 * Summary downloads (7.9, 7.13). A file is its requester's: listed, opened and emailed only to them, built with what their role and the plan let them
 * see. Up to 50,000 rows it is made while they wait; above that it is queued, made by the worker, and a Bhava email links to it in the admin. Every
 * file goes after 7 days.
 */
export const QUEUE_DOWNLOAD = 'reports.download';
const MAX_ATTEMPTS = 3;
const ATTACHMENT_KEEP_DAYS = 30;

const definitionOf = (body) => Object.fromEntries(['query', 'funnelId', 'cohort', 'from', 'to'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

export function toDownload(row) {
  const lapsed = row.status === 'expired' || (row.status === 'ready' && Boolean(row.lapsed));
  const status = lapsed ? 'expired' : row.status;
  return {
    id: Number(row.id), source: row.source, format: row.format, status, background: row.background,
    rowCount: row.row_count === null || row.row_count === undefined ? null : Number(row.row_count),
    fileUrl: status === 'ready' ? downloadFileUrl(row.id) : null,
    createdAt: row.created_at, expiresAt: status === 'ready' || status === 'expired' ? row.expires_at : null,
  };
}

const SELECT = `SELECT *, (expires_at IS NOT NULL AND expires_at <= now()) AS lapsed FROM report_downloads`;

export function createDownloads(ctx, { sources, backgroundOverRows = L.downloadBackgroundOverRows }) {
  const { db, repos, platform } = ctx;
  const files = () => fileStore(platform);

  async function own(id, user) {
    const [row] = await db.query(`${SELECT} WHERE tenant_id = $1 AND id = $2 AND requested_by = $3`, [tenantId(), id, user.id]);
    return row ?? null;
  }

  /** Writes the file and marks the row ready, with its 7 days starting now. Returns the row, or null when someone else finished it first. */
  async function finish(row, table, name, runner = db) {
    const format = FORMATS[row.format];
    const buffer = await renderTable(row.format, table, { sheetName: name });
    const key = downloadKey(row.id, format.ext);
    await files().put(key, buffer, format.type);
    const [done] = await runner.query(
      `UPDATE report_downloads SET status = 'ready', row_count = $3, storage_key = $4, finished_at = now(), expires_at = now() + make_interval(days => $5)
       WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING *, false AS lapsed`,
      [tenantId(), row.id, table.rows.length, key, L.downloadExpiryDays],
    );
    return done ?? null;
  }

  async function fail(id) {
    await db.query(`UPDATE report_downloads SET status = 'failed', finished_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')`, [tenantId(), id]);
  }

  async function create(body, user) {
    if (body.from && body.to && body.from > body.to) throw new ApiError('validation_failed', 'The start date must be before the end date.', { fields: { from: 'The start date must be before the end date' } });
    const definition = definitionOf(body);
    // Built first, so a refusal (a funnel that isn't this business's, a cohort the plan doesn't have) answers before anything is stored.
    const built = await sources.build(body.source, definition, user);
    const background = built.table.rows.length > backgroundOverRows;
    const [row] = await db.query(
      `INSERT INTO report_downloads (tenant_id, requested_by, source, format, definition, status, background) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *, false AS lapsed`,
      [tenantId(), user.id, body.source, body.format, JSON.stringify(definition), background ? 'queued' : 'running', background],
    );
    log.info('reports.download_requested', { tenantId: tenantId(), downloadId: Number(row.id), userId: user.id, source: body.source, format: body.format, rows: built.table.rows.length, background });
    if (background) {
      await platform.queue.enqueue(QUEUE_DOWNLOAD, { id: Number(row.id) }, { tenantId: tenantId(), dedupeKey: `reports.download:${tenantId()}:${row.id}`, maxAttempts: MAX_ATTEMPTS, retryInFlight: true });
      return toDownload(row);
    }
    try {
      return toDownload((await finish(row, built.table, built.name)) ?? row);
    } catch (err) {
      await fail(row.id);
      throw err;
    }
  }

  async function list({ cursor, limit }, user) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
    const rows = await db.query(`${SELECT} WHERE tenant_id = $1 AND requested_by = $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`, [tenantId(), user.id, after, limit + 1]);
    const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
    return { items: page.items.map(toDownload), nextCursor: page.nextCursor };
  }

  async function get(id, user) {
    const row = await own(id, user);
    return row ? toDownload(row) : null;
  }

  /** The worker's half of a large download. Safe to run again: only a queued or running row is touched, and the file has one name. */
  async function build(job) {
    const id = Number(job.payload?.id);
    if (!isRowId(id)) return;
    const [row] = await db.query(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
    if (!row || !['queued', 'running'].includes(row.status)) return;
    try {
      await db.query(`UPDATE report_downloads SET status = 'running' WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`, [tenantId(), id]);
      const user = row.requested_by ? await repos.users.get(row.requested_by) : null;
      // Someone who has since lost analytics, or left, gets nothing.
      if (!readsAnalytics(user)) {
        await fail(id);
        log.warn('reports.download_refused', { tenantId: tenantId(), downloadId: id });
        return;
      }
      const built = await sources.build(row.source, row.definition ?? {}, user);
      const business = await currentBusiness(ctx);
      await db.tx(async (t) => {
        const done = await finish(row, built.table, built.name, t);
        if (!done) return;
        const url = `${business?.base ?? ''}${downloadFileUrl(id)}`;
        await t.query(
          `INSERT INTO report_deliveries (tenant_id, download_id, channel, user_id, to_address, subject, body) VALUES ($1, $2, 'email', $3, $4, $5, $6)`,
          [tenantId(), id, user.id, user.email ?? '', 'Your Bhava export is ready', emailHtml({
            businessName: business?.name ?? '', logoUrl: business?.logoUrl ?? '', title: 'Your export is ready',
            intro: `${sourceTitle[row.source] ?? 'Your file'}, ${row.format === 'xlsx' ? 'Excel' : 'CSV'}, ${formatCount(built.table.rows.length)} rows. Open it in your Bhava admin, signed in. The link works for ${L.downloadExpiryDays} days.`,
            links: [['Open the file', url]], footer: 'Sent by Bhava because you asked for this file.',
          })],
        );
      });
      log.info('reports.download_ready', { tenantId: tenantId(), downloadId: id, rows: built.table.rows.length });
    } catch (err) {
      if ((job.attempt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw err;
      reportError(err, { msg: 'reports.download_failed', tenantId: tenantId(), downloadId: id });
      await fail(id);
    }
  }

  /** Files past their 7 days go, for every business: the row stays, marked expired. Old scheduled-report attachments go after 30 days. */
  async function sweep() {
    const lapsed = await db.platform.query(
      `UPDATE report_downloads SET status = 'expired' WHERE id IN (SELECT id FROM report_downloads WHERE status = 'ready' AND expires_at <= now() ORDER BY expires_at LIMIT 500)
       RETURNING tenant_id, id, storage_key`,
    );
    const attachments = await db.platform.query(
      `UPDATE report_deliveries SET attachment_key = '' WHERE id IN (SELECT id FROM report_deliveries WHERE attachment_key <> '' AND created_at < now() - make_interval(days => $1) LIMIT 500)
       RETURNING attachment_key`,
      [ATTACHMENT_KEEP_DAYS],
    );
    const keys = new Set([...lapsed.map((r) => r.storage_key), ...attachments.map((r) => r.attachment_key)].filter(Boolean));
    for (const key of keys) {
      try {
        await files().remove(key);
      } catch (err) {
        reportError(err, { msg: 'reports.file_remove_failed' });
      }
    }
    return lapsed.length;
  }

  /** The file behind /report-files/d<id>: the requester's own, while it lasts. */
  async function file(id, user) {
    const row = await own(id, user);
    if (!row) return { status: 404 };
    const view = toDownload(row);
    if (view.status === 'expired') return { status: 410 };
    if (view.status !== 'ready' || !row.storage_key) return { status: 404 };
    const buffer = await files().get(row.storage_key);
    if (!buffer) return { status: 410 };
    const format = FORMATS[row.format];
    return { status: 200, buffer, type: format.type, name: fileName(`bhava-${row.source}-${row.id}`, format.ext) };
  }

  return { create, list, get, build, sweep, file };
}
