import PDFDocument from 'pdfkit';
import { FIGURE_TEXT } from '../../contracts/analytics.js';

/**
 * How reports look. Report emails are seller messages: Bhava-branded, from Bhava, with the business's name and logo only as the workspace
 * identity (5.13). Everything that came from outside (a business name, a caption, a page address) is escaped before it is put in a page.
 */
const COLORS = Object.freeze({ ground: '#F6F5F1', ink: '#16152B', primary: '#3B2FC9', accent: '#F5B83D', good: '#17694A', muted: '#5C5B70', line: '#E3E1DA', card: '#FFFFFF' });

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const counts = new Intl.NumberFormat('en-IN');
const rupees = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatCount = (value) => (isNumber(value) ? counts.format(value) : FIGURE_TEXT.noData);
export const formatRupees = (paise) => (isNumber(paise) ? `₹${rupees.format(paise / 100)}` : FIGURE_TEXT.noData);

/** "up 12%", "down 4%", "no change"; nothing when there is no earlier figure to compare with, since a change from nothing means nothing. */
export function changeText(now, before) {
  if (!isNumber(now) || !isNumber(before) || before === 0) return '';
  const percent = Math.round(((now - before) / Math.abs(before)) * 100);
  if (percent === 0) return 'no change';
  return percent > 0 ? `up ${percent}%` : `down ${Math.abs(percent)}%`;
}

/** A short, single-line version of a caption. */
export const snippet = (text, max = 80) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Only a web address or one of the business's own uploads, made absolute, may be shown as the logo. */
export function logoSource(url, base) {
  if (typeof url !== 'string' || !url) return '';
  if (/^https:\/\/[^\s"'<>]+$/i.test(url)) return url;
  if (/^\/media\/[\w-]+$/.test(url) && base) return `${base}${url}`;
  return '';
}

const cell = (content, extra = '') => `<td style="padding:8px 10px;border-bottom:1px solid ${COLORS.line};${extra}">${content}</td>`;

function renderSection(section) {
  const heading = `<h2 style="font-family:Unbounded,Arial,sans-serif;font-size:15px;margin:24px 0 8px;color:${COLORS.ink}">${escapeHtml(section.heading)}</h2>`;
  if (section.text) return `${heading}<p style="margin:0 0 8px;color:${COLORS.muted}">${escapeHtml(section.text)}</p>`;
  if (section.figures) {
    const rows = section.figures.map(([label, value, change]) => `<tr>${cell(escapeHtml(label))}${cell(`<strong>${escapeHtml(value)}</strong>`, 'text-align:right')}${cell(escapeHtml(change ?? ''), `text-align:right;color:${COLORS.muted}`)}</tr>`).join('');
    return `${heading}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${COLORS.card}">${rows}</table>`;
  }
  const { columns, rows } = section.table;
  const head = `<tr>${columns.map((c, i) => `<th style="padding:8px 10px;text-align:${i ? 'right' : 'left'};font-size:12px;color:${COLORS.muted};border-bottom:1px solid ${COLORS.line}">${escapeHtml(c)}</th>`).join('')}</tr>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((v, i) => cell(escapeHtml(v), i ? 'text-align:right' : '')).join('')}</tr>`).join('')
    : `<tr>${cell(escapeHtml(section.empty ?? FIGURE_TEXT.noData), `color:${COLORS.muted}`)}</tr>`;
  return `${heading}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${COLORS.card}">${head}${body}</table>`;
}

/**
 * One report email. `notices` are things to act on (Reconnect Instagram); `links` are [label, absolute url]. Plain HTML with inline styles, which
 * is what mail clients render; the notifications framework (5.13) sends it as it is.
 */
export function emailHtml({ businessName, logoUrl, title, intro, notices = [], sections = [], links = [], footer }) {
  const logo = logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="" width="40" height="40" style="border-radius:8px;vertical-align:middle;margin-right:10px">` : '';
  const noticeHtml = notices.map((n) => `<p style="margin:16px 0;padding:12px 14px;background:#FDF1D6;border-left:4px solid ${COLORS.accent};color:${COLORS.ink}"><strong>${escapeHtml(n.title)}</strong>${n.text ? `<br>${escapeHtml(n.text)}` : ''}</p>`).join('');
  const linkHtml = links.map(([label, url]) => `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:${COLORS.primary};color:#FFFFFF;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a></p>`).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    `<body style="margin:0;padding:0;background:${COLORS.ground};font-family:Figtree,Arial,sans-serif;color:${COLORS.ink};font-size:14px;line-height:1.5">`,
    '<div style="max-width:600px;margin:0 auto;padding:24px 16px">',
    `<p style="margin:0 0 16px;font-family:Unbounded,Arial,sans-serif;font-weight:700;font-size:18px;color:${COLORS.primary}">Bhava</p>`,
    `<p style="margin:0 0 16px">${logo}<strong>${escapeHtml(businessName)}</strong></p>`,
    `<h1 style="font-family:Unbounded,Arial,sans-serif;font-size:20px;margin:0 0 8px">${escapeHtml(title)}</h1>`,
    intro ? `<p style="margin:0 0 8px;color:${COLORS.muted}">${escapeHtml(intro)}</p>` : '',
    noticeHtml,
    ...sections.map(renderSection),
    linkHtml,
    `<p style="margin:32px 0 0;font-size:12px;color:${COLORS.muted}">${footer}</p>`,
    '</div></body></html>',
  ].join('');
}

/** The standard PDF fonts cover Latin-1 only: anything else becomes "?", and the rupee sign is written "Rs". */
const pdfText = (value) => String(value ?? '').replace(/₹/g, 'Rs ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');

/**
 * The monthly performance report as a PDF, kept in the admin (7.9). Built from the same sections as the email, Bhava-branded.
 */
export function reportPdf({ businessName, title, intro, sections }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: pdfText(title), Author: 'Bhava', Creator: 'Bhava' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 96;

    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.primary).text('Bhava');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.ink).text(pdfText(businessName));
    doc.font('Helvetica-Bold').fontSize(16).text(pdfText(title));
    if (intro) doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted).text(pdfText(intro));

    const ensureRoom = (height) => {
      if (doc.y + height > doc.page.height - 60) doc.addPage();
    };
    const row = (values, { bold = false, color = COLORS.ink } = {}) => {
      ensureRoom(18);
      const y = doc.y;
      const first = values.length > 1 ? width * 0.4 : width;
      const rest = values.length > 1 ? (width - first) / (values.length - 1) : 0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
      values.forEach((v, i) => {
        const x = 48 + (i === 0 ? 0 : first + rest * (i - 1));
        doc.text(pdfText(v), x, y, { width: i === 0 ? first - 6 : rest - 6, align: i === 0 ? 'left' : 'right', lineBreak: false, ellipsis: true });
      });
      doc.x = 48;
      doc.y = y + 15;
    };

    for (const section of sections) {
      ensureRoom(50);
      doc.moveDown(1);
      doc.x = 48;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.ink).text(pdfText(section.heading));
      doc.moveDown(0.3);
      if (section.text) {
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(pdfText(section.text));
      } else if (section.figures) {
        for (const [label, value, change] of section.figures) row([label, value, change ?? '']);
      } else {
        row(section.table.columns, { bold: true, color: COLORS.muted });
        if (!section.table.rows.length) row([section.empty ?? FIGURE_TEXT.noData], { color: COLORS.muted });
        for (const r of section.table.rows) row(r);
      }
    }
    doc.moveDown(2);
    doc.x = 48;
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text('Made by Bhava from the figures it keeps for your business. Figures from Instagram may be revised.');
    doc.end();
  });
}
