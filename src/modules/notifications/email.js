import { BRAND_LOGO, BRAND_NAME, WORKSPACE_BADGE, consoleLink } from '../../contracts/notifications.js';

/**
 * Bhava's email layouts for sellers (EMAIL_LAYOUTS): alert, security, report, account. Every one is Bhava's: its name at
 * the top, from Bhava's sender, Bhava's footer. The business appears once, as the workspace it is about: its name and, when
 * it has one, its logo as the workspace badge (data-workspace-badge), the only image it may have (F-58, F-88).
 *
 * The words are the kind's wording (wordingFor), which hold nothing about a shopper. No background images, and the only
 * link is the record in the seller console on the business's own address: a direct link, never a redirect.
 */
const COLORS = Object.freeze({ ground: '#F6F5F1', ink: '#16152B', primary: '#3B2FC9', accent: '#F5B83D', muted: '#5C5B70', card: '#FFFFFF', line: '#E3E1DA' });
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const FOOTERS = Object.freeze({
  alert: (business) => `You get this as a member of the ${business} team on ${BRAND_NAME}. Choose what you hear about, and how, in Settings, Notifications.`,
  security: () => `This is a security notice from ${BRAND_NAME} and cannot be switched off. If this was not you, remove the device under Settings, Devices.`,
  report: (business) => `You get this as a member of the ${business} team on ${BRAND_NAME}. Change or stop reports in Settings, Notifications.`,
  account: () => `This is about your ${BRAND_NAME} account.`,
});
const ACTIONS = Object.freeze({ alert: 'Open in Bhava', security: 'Review in Bhava', report: 'See the report', account: 'Open your account' });

/** A logo address an email may show: https, or this business's own uploaded file on its own address. */
export function logoSource(url, base) {
  if (typeof url !== 'string' || !url) return '';
  if (/^https:\/\/[^\s"'<>()]+$/i.test(url)) return url;
  if (/^\/media\/[\w-]+$/.test(url) && /^https?:\/\/[^\s"'<>()]+$/i.test(base ?? '')) return `${base}${url}`;
  return '';
}

/** { subject, html, text } for one kind's email. `link` is the record's path; `base` the business's own address. */
export function sellerEmail({ layout, words, business, logoUrl = '', base = '', link = '/' }) {
  const name = String(business ?? '').trim();
  const footer = (FOOTERS[layout] ?? FOOTERS.alert)(escapeHtml(name || 'your business'));
  const action = ACTIONS[layout] ?? ACTIONS.alert;
  const href = /^https?:\/\//.test(base) ? `${base}${consoleLink(link)}` : '';
  const badge = logoUrl
    ? `<img ${WORKSPACE_BADGE} src="${escapeHtml(logoUrl)}" alt="" width="32" height="32" style="border-radius:8px;vertical-align:middle;margin-right:8px">`
    : '';
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    `<body style="margin:0;padding:0;background-color:${COLORS.ground};font-family:Figtree,Arial,sans-serif;color:${COLORS.ink};font-size:14px;line-height:1.5">`,
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
    `<p ${BRAND_LOGO} style="margin:0 0 20px;font-family:Unbounded,Arial,sans-serif;font-weight:700;font-size:18px;color:${COLORS.primary}">${BRAND_NAME}</p>`,
    `<div style="background-color:${COLORS.card};border:1px solid ${COLORS.line};border-radius:12px;padding:20px">`,
    name ? `<p style="margin:0 0 12px;color:${COLORS.muted}">${badge}<strong style="color:${COLORS.ink}">${escapeHtml(name)}</strong></p>` : '',
    `<h1 style="font-family:Unbounded,Arial,sans-serif;font-size:19px;margin:0 0 8px">${escapeHtml(words.title)}</h1>`,
    words.body ? `<p style="margin:0 0 16px">${escapeHtml(words.body)}</p>` : '',
    href ? `<p style="margin:16px 0 0"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 16px;background-color:${COLORS.primary};color:#FFFFFF;text-decoration:none;border-radius:8px">${escapeHtml(action)}</a></p>` : '',
    '</div>',
    `<p style="margin:24px 0 0;font-size:12px;color:${COLORS.muted}">${footer}</p>`,
    '</div></body></html>',
  ].join('');
  const text = [BRAND_NAME, name, words.title, words.body, href, footer.replace(/&[a-z#0-9]+;/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[e] ?? e)]
    .filter(Boolean).join('\n\n');
  return { subject: name ? `${words.title} | ${name}` : words.title, html, text };
}

const unescape = (value) => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

/**
 * A report email as the reports module wrote it (report_deliveries.body) shows the business's logo as a plain image. Here
 * that one image, and only an image whose address is exactly this business's logo, is marked as the workspace badge, so
 * the email can pass sellerEmailProblem(). Any other image is left alone and the check refuses the email.
 */
export function markWorkspaceBadge(html, logoUrl) {
  if (!logoUrl) return String(html ?? '');
  return String(html ?? '').replace(/<img\b([^>]*)>/gi, (tag, attrs) => {
    if (tag.includes(WORKSPACE_BADGE) || tag.includes(BRAND_LOGO)) return tag;
    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\ssrc\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    return src !== undefined && unescape(src) === logoUrl ? `<img ${WORKSPACE_BADGE}${attrs}>` : tag;
  });
}

/** A plain-text part for an HTML email that came without one. */
export const textOf = (html) => unescape(String(html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h\d|div|tr)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
