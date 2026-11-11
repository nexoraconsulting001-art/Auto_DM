import { decodeEntities } from './text.js';

/**
 * Reads the parts of a web page an import needs (PRD 8.3): the <title>, the <meta> and <link> tags and the JSON-LD blocks. It
 * is a forward-only scanner, not a browser: it never runs anything, never builds a tree, and every step moves on through the
 * page, so a 2 MB page of unclosed tags or a hundred thousand meta tags is read in one pass. Only so many of each are kept.
 */

export const HTML_LIMITS = Object.freeze({ metaTags: 2000, linkTags: 500, jsonLdBlocks: 20, jsonLdBytes: 1_000_000, titleChars: 500, attributeChars: 4000 });

const SKIP_BODY = new Set(['style', 'textarea', 'template', 'noscript']);
const isNameChar = (c) => /[a-zA-Z0-9:_-]/.test(c);
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/**
 * Attributes from just after the tag name to the end of the tag. Returns { attrs, end } where end is just past '>' (or the end
 * of the page for an unclosed tag).
 */
function readAttributes(s, from) {
  const attrs = {};
  let pos = from;
  let count = 0;
  while (pos < s.length) {
    while (pos < s.length && isSpace(s[pos])) pos++;
    if (pos >= s.length) break;
    if (s[pos] === '>') return { attrs, end: pos + 1 };
    if (s[pos] === '/' ) {
      pos++;
      continue;
    }
    const nameStart = pos;
    while (pos < s.length && !isSpace(s[pos]) && s[pos] !== '=' && s[pos] !== '>' && s[pos] !== '/') pos++;
    const name = s.slice(nameStart, pos).toLowerCase();
    if (!name) {
      pos++;
      continue;
    }
    while (pos < s.length && isSpace(s[pos])) pos++;
    let value = '';
    if (s[pos] === '=') {
      pos++;
      while (pos < s.length && isSpace(s[pos])) pos++;
      const quote = s[pos];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, pos + 1);
        if (close === -1) return { attrs, end: s.length };
        value = s.slice(pos + 1, close);
        pos = close + 1;
      } else {
        const valueStart = pos;
        while (pos < s.length && !isSpace(s[pos]) && s[pos] !== '>') pos++;
        value = s.slice(valueStart, pos);
      }
    }
    if (count++ < 50 && !Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value.slice(0, HTML_LIMITS.attributeChars));
  }
  return { attrs, end: s.length };
}

/** Lower-cased copy, made once, for finding closing tags without re-scanning. */
function findClose(lower, name, from) {
  return lower.indexOf(`</${name}`, from);
}

/**
 * The page's title, metas ({ property|name|itemprop: [contents] }), links ([{ rel, href }]) and JSON-LD texts.
 */
export function scanHtml(html) {
  const s = String(html ?? '');
  const lower = s.toLowerCase();
  const meta = new Map();
  const links = [];
  const jsonLd = [];
  let title = '';
  let metaCount = 0;
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf('<', pos);
    if (lt === -1) break;
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < s.length && nameEnd - lt < 30 && isNameChar(s[nameEnd])) nameEnd++;
    const name = s.slice(lt + 1, nameEnd).toLowerCase();
    if (!name) {
      pos = lt + 1;
      continue;
    }
    const { attrs, end } = readAttributes(s, nameEnd);
    pos = end;
    if (name === 'meta') {
      const key = (attrs.property || attrs.name || attrs.itemprop || '').trim().toLowerCase();
      if (key && Object.hasOwn(attrs, 'content') && metaCount < HTML_LIMITS.metaTags) {
        metaCount++;
        if (!meta.has(key)) meta.set(key, []);
        if (meta.get(key).length < 10) meta.get(key).push(attrs.content.trim());
      }
    } else if (name === 'link') {
      if (links.length < HTML_LIMITS.linkTags && attrs.href) links.push({ rel: String(attrs.rel ?? '').toLowerCase(), href: attrs.href.trim() });
    } else if (name === 'title') {
      const close = findClose(lower, 'title', pos);
      const raw = s.slice(pos, close === -1 ? Math.min(s.length, pos + HTML_LIMITS.titleChars) : close);
      if (!title) title = decodeEntities(raw.slice(0, HTML_LIMITS.titleChars)).replace(/\s+/g, ' ').trim();
      if (close === -1) break;
      pos = close;
    } else if (name === 'script') {
      const close = findClose(lower, 'script', pos);
      const body = s.slice(pos, close === -1 ? s.length : close);
      if (/ld\+json/i.test(attrs.type ?? '') && jsonLd.length < HTML_LIMITS.jsonLdBlocks && body.length <= HTML_LIMITS.jsonLdBytes) jsonLd.push(body);
      if (close === -1) break;
      pos = close;
    } else if (SKIP_BODY.has(name)) {
      const close = findClose(lower, name, pos);
      if (close === -1) break;
      pos = close;
    }
  }
  return { title, meta, links, jsonLd };
}

/** The first content of a meta, or ''. */
export const metaValue = (scan, ...keys) => {
  for (const key of keys) {
    const found = scan.meta.get(key)?.find((v) => v);
    if (found) return found;
  }
  return '';
};

/** Every content of these metas, in order. */
export const metaValues = (scan, ...keys) => keys.flatMap((key) => scan.meta.get(key) ?? []).filter(Boolean);

/** JSON-LD blocks parsed, the broken ones skipped. HTML comments some sites wrap them in are dropped first. */
export function parseJsonLd(scan) {
  const out = [];
  for (const text of scan.jsonLd) {
    const body = text.trim().replace(/^<!--/, '').replace(/-->$/, '').replace(/^\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>$/, '').trim();
    try {
      out.push(JSON.parse(body));
    } catch {
      // A broken block is not a product; the page may still have Open Graph.
    }
  }
  return out;
}

/** The short form of a schema.org type: "Product" for "Product", "schema:Product" or "https://schema.org/Product". */
export const shortType = (value) => String(value ?? '').replace(/^.*[/:#]/, '');
export const typesOf = (node) => [].concat(node?.['@type'] ?? []).map(shortType);

/**
 * Every object reachable through arrays, @graph and mainEntity, breadth first, at most `maxNodes` of them and `maxDepth` deep,
 * so deeply nested or enormous JSON can't make this recurse without end.
 */
export function jsonLdNodes(roots, { maxNodes = 2000, maxDepth = 6 } = {}) {
  const out = [];
  const queue = roots.map((value) => ({ value, depth: 0 }));
  while (queue.length && out.length < maxNodes) {
    const { value, depth } = queue.shift();
    if (depth > maxDepth || value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    out.push(value);
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
      if (value[key] && typeof value[key] === 'object') queue.push({ value: value[key], depth: depth + 1 });
    }
  }
  return out;
}
