import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { safeCell } from '../reports/table.js';
import { tenantId } from '../../tenancy.js';
import { CHANNELS } from './rules.js';

// Loaded with require, as src/modules/reports/table.js does and for the same reason.
const ExcelJS = createRequire(import.meta.url)('exceljs');

/**
 * The file of a business's leads (PRD 8.15): CSV or XLSX, this business's rows only. Each channel's consent is a column, and a
 * withdrawn one says so with its date (K-58), so nobody markets to a withdrawn contact from an old file by mistake. Text a
 * spreadsheet would run is made inert (safeCell); a phone number is "+" and digits by the time it is stored, so it is written
 * as it is.
 */
const CHANNEL_LABELS = Object.freeze({ whatsapp: 'WhatsApp consent', sms: 'SMS consent', email: 'Email consent', call: 'Call consent' });
const SOURCE_LABELS = Object.freeze({ landing: 'Reel page', creator: 'Creator page', store: 'Store', bio: 'Bio link' });
const BOM = String.fromCharCode(0xfeff);
const PHONE = /^\+[1-9]\d{7,14}$/;

export const COLUMNS = Object.freeze([
  { key: 'firstName', label: 'First name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'source', label: 'Source' },
  { key: 'page', label: 'Page' },
  { key: 'campaign', label: 'Campaign' },
  ...CHANNELS.map((channel) => ({ key: channel, label: CHANNEL_LABELS[channel] })),
  { key: 'withdrawn', label: 'Consent withdrawn' },
  { key: 'consentVersion', label: 'Consent wording version' },
  { key: 'consentedAt', label: 'Consented at' },
  { key: 'createdAt', label: 'Added at' },
]);

const iso = (value) => (value ? new Date(value).toISOString() : '');

/** One lead as a row of the file. `row` is a lead from the repo, with its consents. */
export function fileRow(row) {
  const consents = new Map(row.consents.map((c) => [c.channel, c]));
  const cell = (channel) => {
    const c = consents.get(channel);
    if (!c) return '';
    return c.withdrawn_at ? `Withdrawn ${iso(c.withdrawn_at).slice(0, 10)}` : 'Yes';
  };
  const withdrawn = row.consents.filter((c) => c.withdrawn_at);
  return {
    firstName: row.first_name,
    phone: row.phone,
    email: row.email,
    source: SOURCE_LABELS[row.source] ?? row.source,
    page: row.source_ref,
    campaign: row.utm_campaign,
    ...Object.fromEntries(CHANNELS.map((channel) => [channel, cell(channel)])),
    withdrawn: !withdrawn.length ? 'No' : withdrawn.length === row.consents.length ? 'Yes, all' : 'Yes, some',
    consentVersion: row.consent_version,
    consentedAt: iso(row.consented_at),
    createdAt: iso(row.created_at),
  };
}

const cellOf = (column, row) => (column.key === 'phone' && PHONE.test(row.phone) ? row.phone : safeCell(row[column.key]));

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with a byte-order mark and CRLF line ends, so Excel reads every script. */
export function leadsCsv(rows) {
  const lines = [COLUMNS.map((c) => csvField(c.label)).join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvField(cellOf(c, row))).join(','));
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}

/** One sheet of plain values: nothing is written as a formula. The workbook names no maker. */
export async function leadsXlsx(rows) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: true, useStyles: true });
  const sheet = workbook.addWorksheet('Leads');
  sheet.columns = COLUMNS.map((c) => ({ key: c.key, width: Math.min(40, Math.max(14, c.label.length + 2)) }));
  const header = sheet.addRow(COLUMNS.map((c) => c.label));
  header.font = { bold: true };
  header.commit();
  for (const row of rows) sheet.addRow(COLUMNS.map((c) => cellOf(c, row))).commit();
  sheet.commit();
  await workbook.commit();
  await done;
  return Buffer.concat(chunks);
}

export const FILE_TYPES = Object.freeze({
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** Under the business's own folder, so one business's row can never name another's file. */
export const fileKey = (id, format) => `t/${tenantId()}/leads/downloads/${id}.${format}`;
export const ownsKey = (key) => typeof key === 'string' && key.startsWith(`t/${tenantId()}/leads/downloads/`);

/** Where a ready file opens: outside /api/v1, because it isn't JSON. */
export const LEAD_FILE_PATH = '/leads/files/:id';
export const fileUrl = (id) => `/leads/files/${id}`;
