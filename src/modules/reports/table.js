import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

// Loaded with require, not import: under the browser test runner's ESM loader, importing exceljs's CommonJS chain fails with
// 'Unexpected module status 3' (Node 22), which stops every browser test that starts the server.
const ExcelJS = createRequire(import.meta.url)('exceljs');

/**
 * Summary files (7.9, 7.13). A table is { columns: [{ key, label }], rows: [{ [key]: string | number | null }] }: figures only, never a visitor or shopper.
 * Text that a spreadsheet would run is made inert here, in one place, for both formats.
 */

const BOM = '﻿';
// =, +, - and @ start a formula; full-width forms are read the same way by some spreadsheets. Tab and CR at the start are refused by the
// same rule (OWASP), and spaces or control characters ahead of a formula character don't get it past the check.
const FORMULA_START = /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u;
const RISKY_START = /^[\t\r]/;

/** One cell's value as a file holds it. Numbers stay numbers; text that could run as a formula is prefixed with a quote. */
export function safeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).replace(/\0/g, '');
  return FORMULA_START.test(text) || RISKY_START.test(text) ? `'${text}` : text;
}

function csvField(value) {
  const cell = safeCell(value);
  if (typeof cell === 'number') return String(cell);
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** UTF-8 with a byte-order mark, so Excel reads Hindi and the rupee sign, and CRLF line ends. */
export function toCsv(table) {
  const lines = [table.columns.map((c) => csvField(c.label)).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => csvField(row[c.key])).join(','));
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}

/** An Excel workbook with one sheet. Every cell is a plain value: nothing is ever written as a formula. Streams, so a large export stays small in memory. */
export async function toXlsx(table, { sheetName = 'Report' } = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: true, useStyles: true });
  workbook.creator = 'Bhava';
  const sheet = workbook.addWorksheet(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Report');
  sheet.columns = table.columns.map((c) => ({ key: c.key, width: Math.min(60, Math.max(12, String(c.label).length + 2)) }));
  const header = sheet.addRow(table.columns.map((c) => safeCell(c.label)));
  header.font = { bold: true };
  header.commit();
  for (const row of table.rows) sheet.addRow(table.columns.map((c) => safeCell(row[c.key]))).commit();
  sheet.commit();
  await workbook.commit();
  await done;
  return Buffer.concat(chunks);
}

export const FORMATS = Object.freeze({
  csv: { ext: 'csv', type: 'text/csv; charset=utf-8', render: async (table) => toCsv(table) },
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', render: (table, options) => toXlsx(table, options) },
});

export const renderTable = (format, table, options) => FORMATS[format].render(table, options);

/** A name for a file: letters, digits and dashes only, so it is safe in a header and on any disk. */
export function fileName(base, ext) {
  const safe = String(base).normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  return `${safe || 'report'}.${ext}`;
}
