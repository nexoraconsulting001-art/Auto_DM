import { canSeeRevenue } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { fileStore, monthlyFileUrl } from './files.js';
import { monthLabel } from './clock.js';
import { fileName } from './table.js';

/** The reports that went out, for the admin's Reports screen. A monthly report links to its PDF; the PDF holds revenue only for someone who may see it. */
const SELECT = `SELECT id, kind, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, status, storage_key, sent_at,
  COALESCE((summary->>'hasRevenue')::boolean, false) AS has_revenue FROM report_runs`;

const toRun = (row) => ({
  id: Number(row.id), kind: row.kind, periodStart: row.period_start, periodEnd: row.period_end, status: row.status,
  fileUrl: row.kind === 'monthly' && row.storage_key ? monthlyFileUrl(row.id) : null, sentAt: row.sent_at,
});

export function createRuns({ db, platform }) {
  async function list({ cursor, limit, kind }) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
    const rows = await db.query(`${SELECT} WHERE tenant_id = $1 AND ($2 = 'all' OR kind = $2) AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`, [tenantId(), kind, after, limit + 1]);
    const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
    return { items: page.items.map(toRun), nextCursor: page.nextCursor };
  }

  async function get(id) {
    const [row] = await db.query(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
    return row ? toRun(row) : null;
  }

  /** The PDF behind /report-files/m<id>. */
  async function file(id, user) {
    const [row] = await db.query(`${SELECT} WHERE tenant_id = $1 AND id = $2 AND kind = 'monthly'`, [tenantId(), id]);
    if (!row || !row.storage_key) return { status: 404 };
    if (row.has_revenue && !canSeeRevenue(user)) return { status: 403, message: 'Owner only.' };
    const buffer = await fileStore(platform).get(row.storage_key);
    if (!buffer) return { status: 410 };
    return { status: 200, buffer, type: 'application/pdf', name: fileName(`bhava-report-${monthLabel(row.period_start)}`, 'pdf') };
  }

  return { list, get, file };
}
