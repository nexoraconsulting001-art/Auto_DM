import PDFDocument from 'pdfkit';
import { money, pdfText } from '../invoices/pdf.js';

/**
 * The settlement statement as files (PRD 5.12): a CSV with every line and a PDF of the totals. A seller surface, so it is
 * Bhava's; it holds order numbers, amounts and transfer references, never a shopper's name, number or address.
 */
const LABELS = Object.freeze({
  sale: 'Sale', gateway_fee: 'Gateway fee', gateway_fee_tax: 'GST on gateway fee', refund: 'Refund', transfer: 'Payout', transfer_reversal: 'Payout reversed',
  shipping_charge: 'Shipping charge', adjustment: 'Adjustment', cod_remittance: 'Cash on delivery remittance',
});
const monthLabel = (month) => new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A spreadsheet can't run a cell as a formula, and a comma or quote can't break a row. */
export function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const row = (cells) => cells.map(csvCell).join(',');

const balanceText = (paise) => (paise >= 0 ? `${money(paise)} owed to you` : `${money(-paise)} owed to Bhava`);

export function statementCsv({ businessName, statement, lines, payoutsIncludeShipping }) {
  const s = statement;
  const out = [
    row(['Bhava settlement statement']),
    row(['Business', businessName]),
    row(['Month', s.month.slice(0, 7)]),
    '',
    row(['Total', 'Amount (paise)']),
    row(['Opening balance', s.openingBalancePaise]),
    row(['Sales', s.salesPaise]),
    row(['Refunds', -s.refundsPaise]),
    row(['Gateway fees', -s.gatewayFeesPaise]),
    row(['Shipping charges', -s.shippingPaise]),
    row(['Commission', 0]),
    row(['Payouts', -s.payoutsPaise]),
    row(['Closing balance', s.closingBalancePaise]),
    '',
    row(['Counts', 'Number']),
    row(['Orders', s.counts.orders]),
    row(['Refunds', s.counts.refunds]),
    row(['Shipments', s.counts.shipments]),
    '',
    row(['Payout', 'Transfer reference', 'Amount (paise)', 'Date']),
    ...s.payouts.map((p) => row(['Payout', p.transferId, p.amountPaise, new Date(p.at).toISOString()])),
    '',
    row(['Line', 'Kind', 'Order', 'Reference', 'Amount (paise)', 'Date', 'In this statement']),
    ...lines.map((l) => row([l.id, LABELS[l.kind] ?? l.kind, l.orderNumber, l.ref, l.amountPaise, new Date(l.at).toISOString(), l.counted ? 'yes' : (l.kind === 'shipping_charge' && !payoutsIncludeShipping ? 'billed on invoice' : 'no')])),
    '',
    row(['Reconciliation', s.reconciliation]),
    ...s.differences.map((d) => row(['Difference', d.kind, d.ref ?? '', d.ourPaise ?? '', d.reportPaise ?? ''])),
  ];
  return Buffer.from(`${out.join('\r\n')}\r\n`, 'utf8');
}

export function statementPdf({ businessName, statement }) {
  const s = statement;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: pdfText(`Settlement statement ${s.month.slice(0, 7)}`), Author: 'Bhava', Creator: 'Bhava', Producer: 'Bhava' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const ink = '#16152B';
    doc.fillColor('#3B2FC9').font('Helvetica-Bold').fontSize(20).text('Bhava');
    doc.moveDown(0.5).fillColor(ink).fontSize(16).text('Settlement statement');
    doc.font('Helvetica').fontSize(11).text(pdfText(`${businessName} - ${monthLabel(s.month)}`));
    doc.moveDown();
    const line = (label, paise, { bold = false } = {}) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(pdfText(label), 48, y, { width: 300 });
      doc.text(pdfText(typeof paise === 'string' ? paise : money(paise)), 360, y, { width: 187, align: 'right' });
    };
    line('Opening balance', balanceText(s.openingBalancePaise));
    line(`Sales (${s.counts.orders} orders)`, s.salesPaise);
    line(`Refunds (${s.counts.refunds})`, -s.refundsPaise);
    line('Gateway fees, at cost', -s.gatewayFeesPaise);
    line(`Shipping charges, at cost (${s.counts.shipments} shipments)`, -s.shippingPaise);
    line('Commission: Bhava takes no share of your sales', 0);
    line('Payouts to your bank account', -s.payoutsPaise);
    doc.moveDown(0.3);
    line('Closing balance', balanceText(s.closingBalancePaise), { bold: true });
    doc.moveDown();
    doc.font('Helvetica-Bold').text('Payouts', 48);
    doc.font('Helvetica');
    if (!s.payouts.length) doc.text('No payouts this month.');
    for (const p of s.payouts) line(`${new Date(p.at).toISOString().slice(0, 10)}  ${p.transferId || 'no reference'}`, p.amountPaise);
    doc.moveDown();
    const status = { matched: 'Matches the payment gateway\'s settlement report and the courier\'s charges.', mismatch: 'Differs from the provider reports. Each difference is listed below.', pending: 'Not yet checked against the provider reports.' }[s.reconciliation];
    doc.font('Helvetica-Bold').text('Reconciliation', 48).font('Helvetica').text(pdfText(status));
    for (const d of s.differences.slice(0, 40)) doc.text(pdfText(`${d.kind}${d.ref ? ` ${d.ref}` : ''}: ours ${money(d.ourPaise ?? 0)}, report ${money(d.reportPaise ?? 0)}`));
    if (s.differences.length > 40) doc.text(`and ${s.differences.length - 40} more in the CSV.`);
    doc.end();
  });
}
