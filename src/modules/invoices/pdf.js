import PDFDocument from 'pdfkit';
import { INDIAN_STATES, financialYearLabel } from '../../contracts/orders.js';

/**
 * The invoice, bill of supply or credit note as a PDF (PRD 9.13). A shopper receives it, so it carries the seller's brand
 * only: the seller's legal name, address, GSTIN and brand colour, and nothing of the platform, in the text or in the
 * file's own properties. Everything comes from the issued row, which never changes, so the same row always draws the
 * same document; a buyer masked on a deletion request (9.18) is drawn masked.
 *
 * The standard PDF fonts cover Latin-1 only: other letters are drawn as "?", and the rupee sign is written "Rs".
 */
const INK = '#16152B';
const MUTED = '#5B5A6E';
const LINE = '#D9D7CF';
const HEX = /^#[0-9a-f]{6}$/i;

export const pdfText = (value) => String(value ?? '')
  .replace(/₹/g, 'Rs ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');

/** Rs 1,234.50, Indian grouping, always two decimals. */
export function money(paise) {
  const n = Number(paise);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const rupees = Math.floor(abs / 100).toString().replace(/(\d)(?=(\d\d)+\d$)/g, '$1,');
  return `${sign}Rs ${rupees}.${String(abs % 100).padStart(2, '0')}`;
}

const percent = (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const stateName = (code) => (INDIAN_STATES[code] ?? INDIAN_STATES[Number(code)] ?? '');
const dateText = (at) => new Date(at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export const TITLES = Object.freeze({ invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', credit_note: 'Credit note' });

/**
 * invoice   the issued row (snake_case, as the database gives it)
 * brand     { name, color }: the store's name and its primary colour, for the heading
 * order     { orderNumber, loyaltyPaise, totalPaise } of the order it is for
 * original  for a credit note, the invoice it corrects: { number, issued_at }
 */
export function invoicePdf({ invoice, brand = {}, order = {}, original = null }) {
  return new Promise((resolve, reject) => {
    const seller = invoice.seller ?? {};
    const buyer = invoice.buyer ?? {};
    const title = TITLES[invoice.doc_type] ?? 'Invoice';
    const owner = pdfText(seller.legalName || brand.name || '');
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: pdfText(`${title} ${invoice.number}`), Author: owner, Creator: owner, Producer: owner, Subject: pdfText(title) } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const accent = HEX.test(brand.color ?? '') ? brand.color : INK;
    const left = 40;
    const width = doc.page.width - 80;
    const registered = invoice.doc_type !== 'bill_of_supply' && Boolean(seller.gstin);
    const interState = Number(invoice.igst_paise) > 0 || (invoice.lines ?? []).some((l) => l.igstPaise > 0);

    // Heading: the store, then what this document is.
    doc.font('Helvetica-Bold').fontSize(16).fillColor(accent).text(pdfText(brand.name || seller.legalName || ''), left, 40, { width });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(pdfText(title));
    doc.moveDown(0.4);
    const top = doc.y;

    // The seller on the left, the document's numbers on the right.
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(pdfText(seller.legalName || brand.name || ''), left, top, { width: width / 2 - 10 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    if (seller.address) doc.text(pdfText(seller.address), { width: width / 2 - 10 });
    if (seller.gstin) doc.text(pdfText(`GSTIN: ${seller.gstin}`));
    if (seller.stateCode) doc.text(pdfText(`State: ${stateName(seller.stateCode)} (${seller.stateCode})`));
    const sellerBottom = doc.y;

    const facts = [
      [`${title} no.`, invoice.number],
      ['Date', dateText(invoice.issued_at)],
      ['Financial year', financialYearLabel(Number(invoice.fy))],
      ['Order', order.orderNumber ?? ''],
      ['Place of supply', `${stateName(invoice.place_of_supply)} (${invoice.place_of_supply})`],
      ...(original ? [['Against invoice', `${original.number}, ${dateText(original.issued_at)}`]] : []),
    ];
    let y = top;
    for (const [label, value] of facts) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(label), left + width / 2, y, { width: 90 });
      doc.font('Helvetica-Bold').fillColor(INK).text(pdfText(value), left + width / 2 + 90, y, { width: width / 2 - 90 });
      y = doc.y + 2;
    }
    doc.y = Math.max(sellerBottom, y) + 10;

    // The buyer.
    doc.x = left;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Billed to', left, doc.y);
    doc.font('Helvetica').fillColor(MUTED);
    const buyerLines = [buyer.name, buyer.address, buyer.stateCode ? `State: ${stateName(buyer.stateCode)} (${buyer.stateCode})` : ''].filter(Boolean);
    doc.text(pdfText(buyerLines.length ? buyerLines.join('\n') : 'Details removed at the customer’s request'), { width });
    doc.moveDown(0.8);

    // The lines.
    const taxCols = !registered ? [] : interState ? [['IGST', 'igstPaise']] : [['CGST', 'cgstPaise'], ['SGST', 'sgstPaise']];
    const cols = [
      { label: 'Item', w: 0, align: 'left' },
      { label: 'HSN/SAC', w: 52, align: 'left' },
      { label: 'Qty', w: 28, align: 'right' },
      { label: 'Value', w: 62, align: 'right' },
      ...(registered ? [{ label: 'Taxable', w: 62, align: 'right' }, { label: 'Rate', w: 36, align: 'right' }] : []),
      ...taxCols.map(([label]) => ({ label, w: 54, align: 'right' })),
    ];
    const fixed = cols.reduce((a, c) => a + c.w, 0);
    cols[0].w = width - fixed;
    const row = (values, { bold = false, color = INK } = {}) => {
      if (doc.y + 18 > doc.page.height - 60) doc.addPage();
      const rowTop = doc.y;
      let x = left;
      let bottom = rowTop;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color);
      values.forEach((value, i) => {
        doc.text(pdfText(value), x + 2, rowTop, { width: cols[i].w - 4, align: cols[i].align });
        bottom = Math.max(bottom, doc.y);
        x += cols[i].w;
      });
      doc.moveTo(left, bottom + 3).lineTo(left + width, bottom + 3).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.x = left;
      doc.y = bottom + 6;
    };
    row(cols.map((c) => c.label), { bold: true, color: MUTED });
    for (const line of invoice.lines ?? []) {
      const value = line.grossPaise - (line.discountPaise ?? 0);
      const name = line.discountPaise ? `${line.description} (after ${money(line.discountPaise)} off)` : line.description;
      row([
        name,
        line.hsn || '-',
        line.qty ? String(line.qty) : '-',
        money(value),
        ...(registered ? [money(line.taxablePaise), percent(line.rateBp)] : []),
        ...taxCols.map(([, key]) => money(line[key])),
      ]);
    }

    // The totals.
    doc.moveDown(0.4);
    const total = (label, value, bold = false) => {
      if (doc.y + 16 > doc.page.height - 60) doc.addPage();
      const at = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(INK);
      doc.text(pdfText(label), left + width - 260, at, { width: 160, align: 'right' });
      doc.text(pdfText(value), left + width - 100, at, { width: 100, align: 'right' });
      doc.x = left;
      doc.y = Math.max(doc.y, at + 14);
    };
    if (registered) {
      total('Taxable value', money(invoice.taxable_paise));
      if (Number(invoice.cgst_paise) || !interState) total('CGST', money(invoice.cgst_paise));
      if (Number(invoice.sgst_paise) || !interState) total('SGST', money(invoice.sgst_paise));
      if (interState) total('IGST', money(invoice.igst_paise));
    }
    total(invoice.doc_type === 'credit_note' ? 'Credited' : 'Total', money(invoice.total_paise), true);
    if (invoice.doc_type !== 'credit_note') {
      const points = Number(order.loyaltyPaise ?? 0);
      if (points > 0) {
        total('Paid with points', money(-points));
        total('Paid', money(Number(invoice.total_paise) - points), true);
      }
      if (Number(invoice.advance_paise) > 0 || Number(invoice.balance_paise) > 0) {
        total('Paid in advance', money(invoice.advance_paise));
        total('Due on delivery', money(invoice.balance_paise));
      }
    }

    doc.moveDown(1.2);
    doc.x = left;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    const notes = [
      registered ? 'Prices include GST.' : 'Not registered for GST: no tax is charged on this bill of supply.',
      invoice.doc_type === 'credit_note' ? 'This credit note reduces the invoice it names by the amount above.' : '',
      'This is a computer-generated document and needs no signature.',
    ].filter(Boolean);
    doc.text(pdfText(notes.join(' ')), left, doc.y, { width });
    doc.end();
  });
}
