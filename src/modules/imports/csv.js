import { CATALOG_LIMITS as L, CSV_COLUMNS, CatalogRuleError, canonicalProductUrl, checkMrp, parseRupees } from '../../contracts/catalog.js';
import { cleanUrls, plainLine } from './text.js';

/**
 * CSV for the catalog (PRD 8.6). In: a file of title, url, price, mrp, images (separated by |), category, sku, in_stock and
 * options, in UTF-8 with or without a byte order mark, with prices as people write them ("₹1,299"). Out: any CSV we hand a
 * seller, with every cell that a spreadsheet would run as a formula made plain text.
 *
 * Nothing in a cell is trusted: it is text, cleaned of control characters, and escaped wherever it is shown.
 */

const MAX_CELL = 20_000;
const ALIASES = Object.freeze({ name: 'title', product: 'title', link: 'url', product_url: 'url', image: 'images', categories: 'category', instock: 'in_stock', stock: 'in_stock', option: 'options' });

/** The file as text. Not UTF-8 (UTF-16 from a spreadsheet's "Unicode text", a stray byte) is refused, never guessed at. */
export function decodeCsv(buffer) {
  if (buffer.length > L.csvBytes) throw new CatalogRuleError('file_too_large');
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) throw new CatalogRuleError('not_utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer); // drops the byte order mark
  } catch {
    throw new CatalogRuleError('not_utf8');
  }
}

/** Comma, semicolon or tab: whichever the header line uses most outside quotes. */
function delimiterOf(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 10_000; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && Object.hasOwn(counts, c)) counts[c]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  return counts['\t'] > counts[','] ? '\t' : ',';
}

/**
 * The records of a CSV text: [{ line, cells }], line being where the record starts in the file (1 is the first line). Quoted
 * cells may hold the delimiter, line breaks and doubled quotes. One pass, and it stops with too_many_rows past `maxRecords`.
 */
export function parseCsv(text, { maxRecords = L.csvRows + 1 } = {}) {
  const delimiter = delimiterOf(text);
  const records = [];
  let cells = [];
  let parts = [];
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  let touched = false;
  let from = 0;
  const endCell = (to) => {
    parts.push(text.slice(from, to));
    const cell = parts.join('');
    cells.push(cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell);
    parts = [];
    wasQuoted = false;
  };
  const endRecord = (to) => {
    endCell(to);
    if (cells.some((c) => c.trim() !== '')) {
      if (records.length >= maxRecords) throw new CatalogRuleError('too_many_rows');
      records.push({ line: startLine, cells });
    }
    cells = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!touched) {
      startLine = line;
      touched = true;
    }
    if (quoted) {
      if (c === '"') {
        parts.push(text.slice(from, i));
        if (text[i + 1] === '"') {
          parts.push('"');
          i++;
        } else {
          quoted = false;
          wasQuoted = true;
        }
        from = i + 1;
      } else if (c === '\n') {
        line++;
      }
    } else if (c === '"' && !wasQuoted && text.slice(from, i).trim() === '') {
      quoted = true;
      from = i + 1;
    } else if (c === delimiter) {
      endCell(i);
      from = i + 1;
    } else if (c === '\n' || c === '\r') {
      endRecord(i);
      if (c === '\r' && text[i + 1] === '\n') i++;
      from = i + 1;
      line++;
    }
  }
  if (touched) endRecord(text.length);
  return records;
}

const headerName = (cell) => {
  const name = cell.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  return ALIASES[name] ?? name;
};

/**
 * A CSV file as rows: { columns, rows: [{ line, cells: { title, url, ... } }] }. The first record is the header; columns we
 * don't know are ignored. Throws CatalogRuleError: not_utf8, file_too_large, too_many_rows, or bad_row when there is no header
 * we can use (a title, url or sku column).
 */
export function readCsvFile(buffer) {
  const records = parseCsv(decodeCsv(buffer));
  if (!records.length) throw new CatalogRuleError('bad_row');
  const header = records[0].cells.map(headerName);
  const columns = CSV_COLUMNS.filter((c) => header.includes(c));
  if (!columns.some((c) => ['title', 'url', 'sku'].includes(c))) throw new CatalogRuleError('bad_row');
  if (records.length - 1 > L.csvRows) throw new CatalogRuleError('too_many_rows');
  const rows = records.slice(1).map(({ line, cells }) => {
    const row = {};
    for (const column of columns) row[column] = (cells[header.indexOf(column)] ?? '').trim();
    return { line, cells: row };
  });
  return { columns, rows };
}

const YES = /^(y|yes|true|1|in stock|instock|available)$/i;
const NO = /^(n|no|false|0|out of stock|outofstock|sold out|soldout|unavailable)$/i;

/** "Size: S|M|L; Colour: Red|Blue" (also with =) as options. Anything else in the cell is a bad row. */
function parseOptions(text) {
  const options = [];
  for (const part of text.split(';').map((p) => p.trim()).filter(Boolean)) {
    const at = part.search(/[:=]/);
    if (at <= 0) throw new CatalogRuleError('bad_row', 'options');
    const name = plainLine(part.slice(0, at), 40);
    const values = [];
    for (const raw of part.slice(at + 1).split('|')) {
      const value = plainLine(raw, 60);
      if (value && !values.some((v) => v.toLowerCase() === value.toLowerCase())) values.push(value);
    }
    if (!name || !values.length || values.length > L.optionValues || options.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw new CatalogRuleError('bad_row', 'options');
    options.push({ name, values });
  }
  if (options.length > L.options) throw new CatalogRuleError('bad_row', 'options');
  return options;
}

/**
 * One row as what it says about a product. A blank cell says nothing, so on an update it changes nothing: those fields come
 * back undefined. Throws CatalogRuleError naming the reason and the column: bad_price, negative_price, mrp_below_price, bad_row.
 */
export function rowToProduct(cells) {
  const given = (column) => typeof cells?.[column] === 'string' && cells[column].trim() !== '';
  const out = { name: undefined, externalUrl: undefined, pricePaise: undefined, mrpPaise: undefined, images: undefined, categories: undefined, sku: '', inStock: undefined, options: undefined };
  if (given('title')) {
    out.name = plainLine(cells.title, L.nameLength);
    if (!out.name) throw new CatalogRuleError('bad_row', 'title');
  }
  if (given('url')) {
    out.externalUrl = canonicalProductUrl(cells.url);
    if (!out.externalUrl) throw new CatalogRuleError('bad_row', 'url');
  }
  if (given('price')) out.pricePaise = parseRupees(cells.price);
  if (given('mrp')) {
    const mrp = parseRupees(cells.mrp);
    out.mrpPaise = out.pricePaise === undefined ? mrp : checkMrp(out.pricePaise, mrp);
  }
  if (given('images')) out.images = cleanUrls(cells.images.split('|').map((s) => s.trim()).slice(0, 50), undefined, L.images);
  if (given('category')) out.categories = [...new Set(cells.category.split('|').map((c) => plainLine(c, 60)).filter(Boolean))].slice(0, 10);
  if (given('sku')) out.sku = plainLine(cells.sku, 100);
  if (given('in_stock')) {
    const text = cells.in_stock.trim();
    if (YES.test(text)) out.inStock = true;
    else if (NO.test(text)) out.inStock = false;
    else throw new CatalogRuleError('bad_row', 'in_stock');
  }
  if (given('options')) out.options = parseOptions(cells.options);
  if (!out.sku && !out.externalUrl && !out.name) throw new CatalogRuleError('bad_row');
  return out;
}

// ---- out ------------------------------------------------------------------------------------------------------------

/**
 * One cell of a CSV we write. A value a spreadsheet would run as a formula (it starts with =, +, - or @, or with a tab or
 * carriage return that hides one) gets a leading apostrophe, which makes it plain text there. Then the usual quoting.
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of cells as CSV text, each cell made safe, lines ended the way spreadsheets expect. */
export const toCsv = (rows) => `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** An import's per-item report as CSV: the line, the link, the SKU, what became of it and why. */
export function importReportCsv(items) {
  return toCsv([
    ['line', 'url', 'sku', 'title', 'status', 'message'],
    ...items.map((item) => [item.line, item.url, item.sku, item.draft?.name ?? item.draft?.cells?.title ?? '', item.status, item.message]),
  ]);
}
