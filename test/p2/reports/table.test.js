// Summary files (PRD 7.9, 7.13): what a spreadsheet could run is made inert, the CSV is UTF-8 with a BOM, and Excel cells are plain values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fileName, safeCell, toCsv, toXlsx } from '../../../src/modules/reports/table.js';
import { parseCsv } from './support.js';

test('N-39: text starting with a formula character is prefixed with a quote, however it is dressed up', () => {
  for (const value of ['=HYPERLINK("x","y")', '+SUM(1)', '-2+3', '@cmd', '\t=cmd', '\r=cmd', '\n=cmd', '  =cmd', ' =cmd', '​=cmd', '＝cmd', '\tplain', '\rplain']) {
    assert.equal(safeCell(value), `'${value}`, JSON.stringify(value));
  }
});

test('N-39: ordinary text, numbers and empty figures are left as they are', () => {
  assert.equal(safeCell('Brunch look'), 'Brunch look');
  assert.equal(safeCell('a=b'), 'a=b');
  assert.equal(safeCell('नमस्ते'), 'नमस्ते');
  assert.equal(safeCell(-5), -5, 'A negative number is a number, not a formula');
  assert.equal(safeCell(0), 0);
  assert.equal(safeCell(null), '');
  assert.equal(safeCell(undefined), '');
  assert.equal(safeCell(Number.NaN), '');
  assert.equal(safeCell('a\0b'), 'ab', 'No NUL byte reaches a file');
});

test('N-39: the CSV has a BOM, CRLF line ends, and one cell for text with quotes, commas and new lines', () => {
  const table = { columns: [{ key: 'a', label: 'Caption' }, { key: 'b', label: 'Views' }], rows: [{ a: 'She said "hi", then\nleft', b: 12 }, { a: '=HYPERLINK("https://evil.example","Click")', b: -3 }] };
  const buffer = toCsv(table);
  assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = buffer.toString('utf8').slice(1);
  assert.match(text, /\r\n/);
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ['Caption', 'Views']);
  assert.deepEqual(rows[1], ['She said "hi", then\nleft', '12']);
  assert.deepEqual(rows[2], ['\'=HYPERLINK("https://evil.example","Click")', '-3']);
});

test('N-39: an Excel file holds no formula, the escaped text as text, and numbers as numbers', async () => {
  const caption = '=HYPERLINK("https://evil.example","x")';
  const buffer = await toXlsx({ columns: [{ key: 'a', label: '=label' }, { key: 'b', label: 'Views' }], rows: [{ a: caption, b: 7 }, { a: 'plain', b: null }] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const cells = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
    cells.push(cell.value);
  }));
  assert.deepEqual(cells, ["'=label", 'Views', `'${caption}`, 7, 'plain', '']);
  assert.equal(sheet.getRow(2).getCell(2).type, ExcelJS.ValueType.Number);
});

test('a file name is letters, digits and dashes only, so it is safe in a header', () => {
  assert.equal(fileName('Weekly "sales"\r\nX-Evil: 1', 'csv'), 'Weekly-sales-X-Evil-1.csv');
  assert.equal(fileName('', 'pdf'), 'report.pdf');
  assert.equal(fileName('../../etc/passwd', 'csv'), 'etcpasswd.csv');
});
