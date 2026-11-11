import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { readCursor, writeCursor } from '../admin-api/paging.js';
import { safeCell } from '../reports/table.js';

// Loaded with require, as src/modules/reports/table.js does and for the same reason.
const ExcelJS = createRequire(import.meta.url)('exceljs');

/**
 * The seller's customer list (PRD 9.17, 9.22): this business's own buyers, worked out from this business's own orders,
 * so a shopper appears only after ordering here and only with what they ordered here (S-100). Signed-in shoppers are one
 * line each; guests are grouped by the phone number on their orders. Nothing here reads the shared profile, so the list
 * never shows that a person shops elsewhere, and marketing shows this business's own consent ledger only (S-104).
 *
 * Downloads (owner only): the file is made at once and kept for a day in the business's storage. There is no downloads
 * table in the Phase 4 contract, so each download IS its audit-log row (action shoppers.download), which the contract
 * already required: the row's id is the download's id, and its details hold the format, the row count and the file key.
 */
export const DOWNLOAD_ACTION = 'shoppers.download';
export const FILE_PATH = '/shopper-files/:id';
const FILE_TTL_MS = 24 * 3_600_000;
const MAX_ROWS = 50_000;
const BOM = String.fromCharCode(0xfeff);
const FILE_TYPES = Object.freeze({ csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

const likeOf = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const iso = (value) => (value ? new Date(value).toISOString() : '');

/** The customer list query: one row per customer of this business, newest order first. */
const LIST_SQL = `
WITH o AS (
  SELECT o.shopper_id, o.customer_name, o.phone, o.email, o.total_paise, o.refunded_paise, o.created_at, o.fulfilment_status,
         CASE WHEN o.shopper_id IS NOT NULL THEN 's' || o.shopper_id ELSE 'g' || regexp_replace(o.phone, '[^0-9]', '', 'g') END AS k
  FROM orders o
  WHERE o.tenant_id = $1 AND o.erased_at IS NULL AND (o.shopper_id IS NOT NULL OR regexp_replace(o.phone, '[^0-9]', '', 'g') <> '')
), g AS (
  SELECT k, max(shopper_id) AS shopper_id,
         (count(*) FILTER (WHERE fulfilment_status <> 'cancelled'))::int AS orders,
         COALESCE(sum(total_paise - refunded_paise) FILTER (WHERE fulfilment_status NOT IN ('pending', 'cancelled')), 0)::bigint AS spent,
         max(created_at) AS last_at,
         (array_agg(customer_name ORDER BY created_at DESC))[1] AS name,
         (array_agg(phone ORDER BY created_at DESC))[1] AS phone,
         (array_agg(email ORDER BY created_at DESC))[1] AS email
  FROM o GROUP BY k
)
SELECT g.k, g.shopper_id, g.orders, g.spent, g.last_at,
       COALESCE(NULLIF(s.name, ''), g.name) AS name, COALESCE(s.phone, g.phone) AS phone, COALESCE(NULLIF(s.email, ''), g.email) AS email
FROM g LEFT JOIN shoppers s ON s.tenant_id = $1 AND s.id = g.shopper_id
WHERE ($2::text IS NULL OR g.name ILIKE $2 OR s.name ILIKE $2 OR g.email ILIKE $2 OR regexp_replace(COALESCE(s.phone, g.phone), '[^0-9]', '', 'g') LIKE $3)
  AND ($4::text IS NULL OR g.k = $4)
  AND ($5::timestamptz IS NULL OR (g.last_at, g.k) < ($5::timestamptz, $6::text))
ORDER BY g.last_at DESC, g.k DESC
LIMIT $7`;

export function createCustomers({ db, platform }) {
  async function marketing(row) {
    if (!platform.consent.built) return { whatsapp: false, email: false };
    const who = row.shopper_id ? { shopperId: row.shopper_id } : { phone: row.phone || undefined, email: row.email || undefined };
    if (!who.shopperId && !who.phone && !who.email) return { whatsapp: false, email: false };
    const ask = async (channel) => (await platform.consent.allows({ purpose: 'marketing', channel, ...who })).granted === true;
    return { whatsapp: await ask('whatsapp'), email: await ask('email') };
  }

  const toItem = async (row) => ({
    id: row.shopper_id ?? null,
    name: row.name ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    signedIn: Boolean(row.shopper_id),
    orders: Number(row.orders),
    spentPaise: Math.max(0, Number(row.spent)),
    lastOrderAt: row.last_at ?? null,
    marketing: await marketing(row),
  });

  async function rows({ search, key = null, after = null, limit }) {
    const term = search ? String(search).trim() : '';
    const digits = term.replace(/[^0-9]/g, '');
    return db.query(LIST_SQL, [
      tenantId(), term ? likeOf(term) : null, digits.length >= 3 ? `%${digits}%` : term ? '-' : null, key,
      after ? after[0] : null, after ? after[1] : null, limit,
    ]);
  }

  async function list({ cursor, limit, search }) {
    const after = cursor ? readCursor(cursor, (k) => k.length === 2 && typeof k[0] === 'string' && !Number.isNaN(Date.parse(k[0])) && typeof k[1] === 'string' && k[1].length <= 40) : null;
    const found = await rows({ search, after, limit: limit + 1 });
    const shown = found.slice(0, limit);
    return {
      items: await Promise.all(shown.map(toItem)),
      nextCursor: found.length > limit ? writeCursor([iso(shown.at(-1).last_at), shown.at(-1).k]) : null,
    };
  }

  /** One shopper of this business, by their shopper id, if they have ordered here. null otherwise (S-99: another business's id is a 404). */
  async function get(id) {
    const [row] = await rows({ key: `s${id}`, limit: 1 });
    return row ? toItem(row) : null;
  }

  // ---- downloads (owner only) ----
  const COLUMNS = Object.freeze([
    { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'signedIn', label: 'Has an account' },
    { key: 'orders', label: 'Orders' }, { key: 'spent', label: 'Spent (₹)' }, { key: 'lastOrderAt', label: 'Last order' },
    { key: 'marketingWhatsapp', label: 'Offers on WhatsApp' }, { key: 'marketingEmail', label: 'Offers by email' },
  ]);
  const fileRow = (item) => ({
    name: item.name, phone: item.phone, email: item.email, signedIn: item.signedIn ? 'Yes' : 'No', orders: item.orders,
    spent: (item.spentPaise / 100).toFixed(2), lastOrderAt: iso(item.lastOrderAt), marketingWhatsapp: item.marketing.whatsapp ? 'Yes' : 'No', marketingEmail: item.marketing.email ? 'Yes' : 'No',
  });
  const cellOf = (column, row) => (column.key === 'phone' && /^\+?[0-9]{8,15}$/.test(row.phone) ? row.phone : safeCell(row[column.key]));
  const csvField = (value) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  async function fileOf(items, format) {
    const data = items.map(fileRow);
    if (format === 'csv') {
      const lines = [COLUMNS.map((c) => csvField(c.label)).join(','), ...data.map((row) => COLUMNS.map((c) => csvField(cellOf(c, row))).join(','))];
      return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
    }
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: true, useStyles: true });
    workbook.creator = '';
    workbook.lastModifiedBy = '';
    const sheet = workbook.addWorksheet('Customers');
    sheet.columns = COLUMNS.map((c) => ({ key: c.key, width: Math.min(40, Math.max(14, c.label.length + 2)) }));
    const header = sheet.addRow(COLUMNS.map((c) => c.label));
    header.font = { bold: true };
    header.commit();
    for (const row of data) sheet.addRow(COLUMNS.map((c) => cellOf(c, row))).commit();
    sheet.commit();
    await workbook.commit();
    await done;
    return Buffer.concat(chunks);
  }

  const ownsKey = (key) => typeof key === 'string' && key.startsWith(`t/${tenantId()}/shoppers/downloads/`);
  const toDownload = (row) => {
    const d = row.details ?? {};
    const expiresAt = new Date(new Date(row.created_at).getTime() + FILE_TTL_MS);
    const live = expiresAt > new Date();
    return { id: Number(row.id), format: d.format === 'csv' ? 'csv' : 'xlsx', status: live ? 'ready' : 'expired', rowCount: Number(d.rowCount) || 0, fileUrl: live ? `/shopper-files/${row.id}` : null, createdAt: row.created_at, expiresAt };
  };
  async function downloadRow(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const [row] = await db.query('SELECT id, details, created_at FROM audit_log WHERE tenant_id = $1 AND id = $2 AND action = $3', [tenantId(), id, DOWNLOAD_ACTION]);
    return row ?? null;
  }

  return {
    list,
    get,
    downloads: {
      async create({ format, user }) {
        const items = [];
        let cursor = null;
        do {
          const pageOf = await list({ cursor, limit: 100 });
          items.push(...pageOf.items);
          cursor = pageOf.nextCursor;
        } while (cursor && items.length < MAX_ROWS);
        const buffer = await fileOf(items.slice(0, MAX_ROWS), format);
        const key = `t/${tenantId()}/shoppers/downloads/${crypto.randomUUID()}.${format}`;
        await platform.storage.put(key, buffer, FILE_TYPES[format]);
        // The download is its audit row, written here so its id comes back (writeAudit returns nothing).
        const [row] = await db.query(
          'INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5) RETURNING id, details, created_at',
          [tenantId(), `user:${user.id}`, DOWNLOAD_ACTION, 'customers', JSON.stringify({ format, rowCount: Math.min(items.length, MAX_ROWS), file: key })],
        );
        log.info('shoppers.downloaded', { auditId: Number(row.id), rows: Math.min(items.length, MAX_ROWS) });
        return toDownload(row);
      },
      async list({ cursor, limit }) {
        const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
        const found = await db.query(
          'SELECT id, details, created_at FROM audit_log WHERE tenant_id = $1 AND action = $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4',
          [tenantId(), DOWNLOAD_ACTION, after, limit + 1],
        );
        const shown = found.slice(0, limit);
        return { items: shown.map(toDownload), nextCursor: found.length > limit ? writeCursor([Number(shown.at(-1).id)]) : null };
      },
      async get(id) {
        const row = await downloadRow(id);
        return row ? toDownload(row) : null;
      },
      /** The file, for the owner, while it lasts: { status, buffer?, type?, name? }. */
      async file(id) {
        const row = await downloadRow(id);
        if (!row) return { status: 404 };
        const view = toDownload(row);
        const key = row.details?.file;
        if (view.status !== 'ready' || !ownsKey(key)) {
          if (ownsKey(key)) await platform.storage.remove(key).catch(() => {});
          return { status: 410 };
        }
        const buffer = await platform.storage.get(key);
        if (!buffer) return { status: 410 };
        return { status: 200, buffer, type: FILE_TYPES[view.format], name: `customers-${new Date(row.created_at).toISOString().slice(0, 10)}.${view.format}` };
      },
    },
  };
}

/** Removes the files of downloads past their day, across businesses (a platform job: the audit log is read, never changed). */
export async function sweepDownloadFiles({ db, storage }) {
  const rows = await (db.platform ?? db).query(
    `SELECT tenant_id, details->>'file' AS file FROM audit_log
     WHERE action = $1 AND created_at < now() - make_interval(secs => $2) AND created_at > now() - make_interval(secs => $2 * 3)`,
    [DOWNLOAD_ACTION, FILE_TTL_MS / 1000],
  );
  let removed = 0;
  for (const row of rows) {
    if (typeof row.file === 'string' && row.file.startsWith(`t/${row.tenant_id}/shoppers/downloads/`)) {
      await storage.remove(row.file).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

/** Answers the customer routes of the seller API (src/contracts/api/store.js). */
export function customerApi(customers) {
  return {
    'shoppers.list': async ({ query }) => customers().list(query),
    'shoppers.get': async ({ params }) => customers().get(params.id),
    'shopperDownloads.list': async ({ query }) => customers().downloads.list(query),
    'shopperDownloads.create': async ({ body, user }) => customers().downloads.create({ format: body.format, user }),
    'shopperDownloads.get': async ({ params }) => customers().downloads.get(params.id),
  };
}

