/**
 * Text that arrives from someone else's website or file (PRD 8.3 to 8.6). It is stored as plain text and escaped wherever it is
 * shown, never trusted as HTML: tags are dropped (script, style and the like with everything inside them), entities are decoded,
 * control characters and NUL (which Postgres text can't hold) are removed, and the length is capped.
 *
 * Every function here is linear in its input, so a hostile page (unclosed tags, a flood of them) can't stall the worker.
 */

const NAMED = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', prime: '′', Prime: '″',
  laquo: '«', raquo: '»', euro: '€', pound: '£', cent: '¢', yen: '¥', sect: '§', para: '¶', plusmn: '±', micro: 'µ', zwj: '', zwnj: '',
});

/** Elements whose content is never text a person reads, dropped whole. */
const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'textarea', 'select', 'head', 'title']);
/** Elements that end a line of text. */
const BREAKS = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'dd', 'dt']);

function codePoint(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  return String.fromCodePoint(n);
}

/** &amp; &#39; &#x20B9; and the common named ones. Unknown names stay as written. */
export function decodeEntities(input) {
  return String(input).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (whole, body) => {
    if (body[0] === '#') return codePoint(body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10));
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole;
  });
}

const isNameStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** The tag name at `from` (just after '<' or '</'), lower-cased. */
function tagNameAt(s, from) {
  let end = from;
  while (end < s.length && end - from < 20 && /[a-zA-Z0-9-]/.test(s[end])) end++;
  return s.slice(from, end).toLowerCase();
}

/**
 * Markup to plain text, keeping line breaks where blocks end. Anything that isn't a tag ("Pack of <3", "a < b") stays as text.
 * `lower` is the same string lower-cased, so finding a closing tag never re-scans what is already behind us.
 */
function stripTags(s) {
  const lower = s.toLowerCase();
  let out = '';
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf('<', pos);
    if (lt === -1) {
      out += s.slice(pos);
      break;
    }
    out += s.slice(pos, lt);
    const next = s[lt + 1] ?? '';
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    const closing = next === '/';
    if (!(isNameStart(next) || (closing && isNameStart(s[lt + 2] ?? '')) || next === '!' || next === '?')) {
      out += '<';
      pos = lt + 1;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) break; // an unclosed tag runs to the end: nothing after it is text
    const name = next === '!' || next === '?' ? '' : tagNameAt(s, lt + (closing ? 2 : 1));
    pos = gt + 1;
    if (!closing && SKIPPED.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      if (end === -1) break;
      const endGt = s.indexOf('>', end);
      pos = endGt === -1 ? s.length : endGt + 1;
      continue;
    }
    if (BREAKS.has(name)) out += '\n';
  }
  return out;
}

/** Removes NUL and control characters (keeping new lines when asked) and any lone surrogate. */
function scrub(text, { keepLines }) {
  const cleaned = text.replace(/[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\uFEFF]/g, (c) => {
    if (c === '\n' || c === '\u2028' || c === '\u2029') return keepLines ? '\n' : ' ';
    if (c === '\t' || c === '\r') return ' ';
    return '';
  });
  return cleaned.toWellFormed();
}

/** Cuts to `max` characters (code points), never splitting a character, and trims. */
export function clip(text, max) {
  const chars = Array.from(text);
  return (chars.length > max ? chars.slice(0, max).join('') : text).trim();
}

/**
 * A paragraph of text from markup or text: tags dropped, entities decoded, blank lines collapsed. `max` caps the result; the
 * input is cut first at 20 times that, so no page can make this do much work.
 */
export function htmlToText(input, max = 5000) {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : typeof input === 'number' ? String(input) : '';
  if (!s) return '';
  s = s.slice(0, Math.max(max * 20, 2000));
  const text = scrub(decodeEntities(stripTags(s.replace(/\r\n?/g, '\n'))), { keepLines: true })
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(text, max);
}

/** One line of text (a product name, an option value): as htmlToText, with line breaks turned into spaces. */
export function cleanLine(input, max = 120) {
  return clip(htmlToText(input, max * 4).replace(/\s+/g, ' '), max);
}

/** Plain text that was never markup (a CSV cell): only control characters removed and whitespace tidied. */
export function plainLine(input, max = 120) {
  if (input === null || input === undefined) return '';
  return clip(scrub(String(input).slice(0, max * 4), { keepLines: false }).replace(/\s+/g, ' '), max);
}

/**
 * An absolute http(s) address, resolved against `base`, or null. No credentials, nothing over 2000 characters, nothing with
 * spaces or control characters, so `javascript:` and `data:` never become an image or a link.
 */
export function cleanUrl(input, base) {
  if (typeof input !== 'string' && !(input instanceof URL)) return null;
  const raw = String(input).trim();
  if (!raw || raw.length > 2000 || /[\s\u0000-\u001F\u007F]/.test(raw)) return null;
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
  url.hash = '';
  const href = url.href;
  return href.length <= 2000 && href.isWellFormed() ? href : null;
}

/** Up to `max` distinct clean addresses, in order. */
export function cleanUrls(list, base, max = 6) {
  const out = [];
  for (const item of list) {
    const href = cleanUrl(item, base);
    if (href && !out.includes(href)) out.push(href);
    if (out.length >= max) break;
  }
  return out;
}

/** Text the same for comparing two titles: lower case, single spaces, no surrounding punctuation. */
export const comparable = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').trim();
