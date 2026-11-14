import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { tenantId } from '../../tenancy.js';
import { money, pdfText } from '../invoices/pdf.js';

/**
 * Bhava's own documents to a business, as files (PRD 5.12): the invoice or credit note PDF, and the monthly settlement
 * statement as PDF and CSV. These are seller surfaces, so they carry Bhava's name and colours (Neel and Haldi). Each is made
 * once, kept in private storage under the business's own prefix, and opened by a signed link that lasts minutes and names
 * the business, the document and the format.
 */
export const BILLING_FILE_PATH = '/billing/files/:kind/:id';
export const FILE_LINK_MS = 5 * 60_000;
const INK = '#16152B';
const PRIMARY = '#3B2FC9';
const MUTED = '#5B5A6E';
const LINE = '#D9D7CF';
const TITLES = { invoice: 'Tax invoice', credit_note: 'Credit note' };

const sign = (secret, business, kind, id, format, exp) => crypto.createHmac('sha256', String(secret)).update(`billing-file:${business}:${kind}:${id}:${format}:${exp}`).digest('base64url');

/** A short-lived link to one of this business's billing files. -> { fileUrl, expiresAt } */
export function fileLink(secret, { kind, id, format = 'pdf' }, now = Date.now()) {
  const exp = Math.floor((now + FILE_LINK_MS) / 1000);
  return { fileUrl: `/billing/files/${kind}/${Number(id)}?format=${format}&exp=${exp}&sig=${sign(secret, tenantId(), kind, Number(id), format, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** True when the link is this business's, for this document and format, and has not run out. */
export function fileLinkValid(secret, { kind, id, format, exp, sig }, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isSafeInteger(e) || e * 1000 < now || typeof sig !== 'string' || sig.length > 100) return false;
  const want = Buffer.from(sign(secret, tenantId(), kind, Number(id), format, e));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export const fileNameOf = (number, ext) => `${String(number).replace(/[^A-Za-z0-9-]+/g, '-')}.${ext}`;
const dateText = (at) => new Date(at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Bhava', Author: 'Bhava', Creator: 'Bhava', Producer: 'Bhava' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

function party(doc, x, y, heading, p) {
  doc.fillColor(MUTED).fontSize(8).text(heading, x, y);
  doc.fillColor(INK).fontSize(10).text(pdfText(p.legalName || ''), x, y + 12, { width: 240 });
  if (p.gstin) doc.fontSize(8).text(`GSTIN ${pdfText(p.gstin)}`, { width: 240 });
  if (p.address) doc.fontSize(8).fillColor(MUTED).text(pdfText(p.address), { width: 240 });
  if (p.stateCode) doc.fontSize(8).fillColor(MUTED).text(`State code ${pdfText(p.stateCode)}`, { width: 240 });
}

/** One invoice or credit note: `doc` is the issued row, `lines` its lines (snake_case), `original` the invoice a credit note corrects. */
export function invoicePdf({ doc: row, lines, original = null }) {
  return render((doc) => {
    const left = 40;
    const width = doc.page.width - 80;
    doc.fillColor(PRIMARY).fontSize(20).text('Bhava', left, 40);
    doc.fillColor(INK).fontSize(14).text(TITLES[row.doc_type] ?? 'Invoice', left, 40, { width, align: 'right' });
    doc.fontSize(9).fillColor(MUTED).text(`No. ${pdfText(row.number)}   Date ${dateText(row.issued_at)}`, left, 62, { width, align: 'right' });
    if (original) doc.text(`Against invoice ${pdfText(original.number)} of ${dateText(original.issued_at)}`, { width, align: 'right' });
    party(doc, left, 100, 'FROM', row.seller ?? {});
    party(doc, left + 280, 100, 'BILLED TO', row.buyer ?? {});
    doc.fillColor(MUTED).fontSize(8).text(`Place of supply: ${pdfText(row.place_of_supply)}`, left + 280, 170);
    if (row.period_start) doc.text(`Period: ${pdfText(String(row.period_start).slice(0, 10))} to ${pdfText(String(row.period_end ?? '').slice(0, 10))}`, left + 280, 182);

    let y = 210;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).stroke();
    const cols = [left, left + 230, left + 280, left + 350, left + 420];
    doc.fillColor(MUTED).fontSize(8);
    ['Item', 'Qty', 'Taxable', 'Tax', 'Amount'].forEach((h, i) => doc.text(h, cols[i], y + 6, { width: i === 0 ? 220 : 65, align: i === 0 ? 'left' : 'right' }));
    y += 22;
    for (const l of lines) {
      const tax = Number(l.cgst_paise) + Number(l.sgst_paise) + Number(l.igst_paise);
      const discount = Number(l.discount_paise) > 0 ? ` (less ${money(l.discount_paise)} offer)` : '';
      doc.fillColor(INK).fontSize(9).text(`${pdfText(l.description)}${pdfText(discount)}${l.sac ? `  SAC ${pdfText(l.sac)}` : ''}`, cols[0], y, { width: 220 });
      const h = Math.max(14, doc.y - y);
      doc.text(String(l.quantity), cols[1], y, { width: 65, align: 'right' });
      doc.text(money(l.taxable_paise), cols[2], y, { width: 65, align: 'right' });
      doc.text(money(tax), cols[3], y, { width: 65, align: 'right' });
      doc.text(money(Number(l.taxable_paise) + tax), cols[4], y, { width: 65, align: 'right' });
      y += h + 6;
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 40;
      }
    }
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).stroke();
    y += 8;
    const total = (label, value) => {
      doc.fillColor(INK).fontSize(9).text(label, cols[2], y, { width: 135, align: 'right' });
      doc.text(money(value), cols[4], y, { width: 65, align: 'right' });
      y += 14;
    };
    total('Taxable value', row.taxable_paise);
    if (Number(row.cgst_paise) || Number(row.sgst_paise)) {
      total('CGST', row.cgst_paise);
      total('SGST', row.sgst_paise);
    } else total('IGST', row.igst_paise);
    total(row.doc_type === 'credit_note' ? 'Total credited' : 'Total', row.total_paise);
    if (row.reason) doc.fillColor(MUTED).fontSize(8).text(`Reason: ${pdfText(row.reason)}`, left, y + 10, { width });
    doc.fillColor(MUTED).fontSize(7).text('Bhava takes no commission on your sales. Charges passed through are at cost.', left, doc.page.height - 60, { width, align: 'center' });
  });
}

const signed = (b) => ({ amountPaise: Math.abs(Number(b)), owedTo: Number(b) >= 0 ? 'business' : 'bhava' });
export const balanceOf = signed;

/** The settlement statement as CSV: one row per figure, then each payout with its transfer reference. */
export function statementCsv(s) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ['Month', String(s.month).slice(0, 10)], ['Opening balance (paise)', s.opening_balance_paise], ['Sales (paise)', s.sales_paise], ['Refunds (paise)', s.refunds_paise],
    ['Gateway fees at cost (paise)', s.gateway_fees_paise], ['Shipping at cost (paise)', s.shipping_paise], ['Commission (paise)', s.commission_paise], ['Payouts (paise)', s.payouts_paise],
    ['Closing balance (paise)', s.closing_balance_paise], ['Orders', s.counts?.orders ?? 0], ['Refunds', s.counts?.refunds ?? 0], ['Shipments', s.counts?.shipments ?? 0], ['Reconciliation', s.reconciliation],
    [], ['Payout transfer', 'Amount (paise)', 'At'], ...(s.payouts ?? []).map((p) => [p.transferId, p.amountPaise, p.at]),
  ];
  return Buffer.from(rows.map((r) => r.map(esc).join(',')).join('\n') + '\n', 'utf8');
}

export function statementPdf(s, business) {
  return render((doc) => {
    const left = 40;
    const width = doc.page.width - 80;
    doc.fillColor(PRIMARY).fontSize(20).text('Bhava', left, 40);
    doc.fillColor(INK).fontSize(14).text('Settlement statement', left, 40, { width, align: 'right' });
    doc.fontSize(9).fillColor(MUTED).text(`${pdfText(business)}  ${String(s.month).slice(0, 7)}`, left, 62, { width, align: 'right' });
    let y = 110;
    const row = (label, value) => {
      doc.fillColor(INK).fontSize(10).text(label, left, y);
      doc.text(value, left, y, { width, align: 'right' });
      y += 18;
    };
    const bal = (b) => `${money(Math.abs(Number(b)))} ${Number(b) >= 0 ? 'owed to you' : 'owed to Bhava'}`;
    row('Opening balance', bal(s.opening_balance_paise));
    row(`Sales (${s.counts?.orders ?? 0} orders)`, money(s.sales_paise));
    row(`Refunds (${s.counts?.refunds ?? 0})`, money(s.refunds_paise));
    row('Gateway fees, at cost', money(s.gateway_fees_paise));
    row(`Shipping, at cost (${s.counts?.shipments ?? 0} shipments)`, money(s.shipping_paise));
    row('Bhava commission', money(0));
    row('Payouts', money(s.payouts_paise));
    row('Closing balance', bal(s.closing_balance_paise));
    y += 10;
    doc.fillColor(MUTED).fontSize(8).text('Payouts', left, y);
    y += 14;
    for (const p of s.payouts ?? []) {
      doc.fillColor(INK).fontSize(8).text(`${pdfText(p.transferId)}  ${dateText(p.at)}`, left, y);
      doc.text(money(p.amountPaise), left, y, { width, align: 'right' });
      y += 12;
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = 40;
      }
    }
    doc.fillColor(MUTED).fontSize(7).text(`Reconciled against the payment gateway's settlement report: ${pdfText(s.reconciliation)}.`, left, doc.page.height - 60, { width, align: 'center' });
  });
}
