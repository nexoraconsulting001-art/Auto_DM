import { FONTS, contrastRatio } from '../brand/theme.js';
import { MIN_CONTRAST, mix, readableOn } from './accent.js';

/**
 * Reading a look from a business's own website (PRD 8.9): theme-color, CSS custom properties, button colours, Google Fonts and a
 * logo. Pure: it takes the text the fetcher already read and returns colours, fonts, logo candidates and notes. Everything it
 * returns has been through a strict check (a colour is #RRGGBB and nothing else, a font is one from the allow-list, a logo is an
 * http(s) address), so text from someone else's site can never reach a <style> tag or an attribute as anything but that (K-29).
 */

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;
const HEX8 = /^#[0-9a-f]{8}$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

/** A CSS colour as #RRGGBB, or null. Hex and rgb() only: a name, a variable, a gradient or anything with markup is refused. */
export function parseColor(value) {
  const text = String(value ?? '').trim().replace(/\s*!important$/i, '');
  if (text.length > 40) return null;
  if (HEX6.test(text)) return text.toUpperCase();
  if (HEX3.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`.toUpperCase();
  if (HEX8.test(text)) return text.slice(0, 7).toUpperCase();
  const rgb = RGB.exec(text);
  if (rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255)) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return null;
}

// Fonts sites commonly use that aren't offered, with the offered family closest in feel.
const NEAREST_FONT = Object.freeze({
  arial: 'Inter', helvetica: 'Inter', 'helvetica neue': 'Inter', 'segoe ui': 'Inter', 'sf pro display': 'Inter', 'sf pro text': 'Inter', verdana: 'Open Sans', tahoma: 'Open Sans',
  'source sans pro': 'Open Sans', 'source sans 3': 'Open Sans', ubuntu: 'Noto Sans', raleway: 'Montserrat', 'josefin sans': 'Jost', futura: 'Jost', 'century gothic': 'Jost',
  quicksand: 'Nunito', 'comic neue': 'Nunito', 'comic sans ms': 'Nunito', 'varela round': 'Nunito', rubik: 'DM Sans', karla: 'Work Sans', 'plus jakarta sans': 'Manrope', outfit: 'Figtree',
  urbanist: 'Figtree', oswald: 'Bricolage Grotesque', 'bebas neue': 'Bricolage Grotesque', anton: 'Bricolage Grotesque', 'space mono': 'Space Grotesk', 'ibm plex sans': 'Inter',
  georgia: 'Lora', 'times new roman': 'Noto Serif', times: 'Noto Serif', garamond: 'Cormorant Garamond', 'eb garamond': 'Cormorant Garamond', 'crimson text': 'Cormorant Garamond',
  cormorant: 'Cormorant Garamond', 'libre baskerville': 'Lora', baskerville: 'Lora', 'pt serif': 'Noto Serif', 'source serif pro': 'Noto Serif', 'roboto slab': 'Merriweather',
  'abril fatface': 'DM Serif Display', 'dm serif text': 'DM Serif Display', prata: 'DM Serif Display', 'playfair display sc': 'Playfair Display', 'noto sans devanagari': 'Noto Sans',
});
const ALLOWED_BY_LOWER = new Map(Object.keys(FONTS).map((name) => [name.toLowerCase(), name]));
const cleanName = (name) => String(name ?? '').replace(/["']/g, '').replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 60);

/**
 * The offered family for a font a site uses: itself when offered, the nearest when known, otherwise one chosen from the generic
 * family its stack ends in. Returns { font, exact }.
 */
export function mapFont(name, stack = '') {
  const lower = cleanName(name).toLowerCase();
  if (ALLOWED_BY_LOWER.has(lower)) return { font: ALLOWED_BY_LOWER.get(lower), exact: true };
  if (Object.hasOwn(NEAREST_FONT, lower)) return { font: NEAREST_FONT[lower], exact: false };
  const generic = String(stack).toLowerCase();
  if (/\bmonospace\b/.test(generic)) return { font: 'Space Grotesk', exact: false };
  if (/\bserif\b/.test(generic.replace(/sans-serif/g, ''))) return { font: 'Lora', exact: false };
  if (/\b(cursive|fantasy)\b/.test(generic)) return { font: 'Nunito', exact: false };
  return { font: 'Inter', exact: false };
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', 'ui-sans-serif', 'ui-serif', '-apple-system', 'blinkmacsystemfont']);
/** The first real family in a font-family value, or ''. */
function firstFamily(value) {
  for (const part of String(value ?? '').split(',')) {
    const name = cleanName(part);
    if (name && !GENERIC.has(name.toLowerCase()) && !/^var\b/i.test(part.trim())) return name;
  }
  return '';
}

// ---- reading the page -----------------------------------------------------------------------------------------------

// A site is someone else's text, up to 2 MB of it, and may be built to be slow to read. Everything below walks it once with
// indexOf and bounded slices: no pattern here can be made to look back over the page for each character of it.
const MAX_HTML = 600_000;
const MAX_CSS = 300_000;
const MAX_TAG = 2000;
const MAX_TAGS = 400;
const MAX_RULES = 4000;
const MAX_DECLARATIONS = 4000;

function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]{1,40})\s{0,8}=\s{0,8}(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] ??= m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** The opening tags called `name`, as attribute maps. A "tag" that doesn't close within MAX_TAG characters isn't one. */
function tags(html, name) {
  const lower = html.toLowerCase();
  const out = [];
  const needle = `<${name}`;
  for (let at = lower.indexOf(needle); at >= 0 && out.length < MAX_TAGS; at = lower.indexOf(needle, at + needle.length)) {
    if (/[a-z0-9-]/.test(lower[at + needle.length] ?? '')) continue; // <linkage>, <metadata>
    const chunk = html.slice(at, at + MAX_TAG);
    const end = chunk.indexOf('>');
    if (end > 0) out.push(attributes(chunk.slice(0, end + 1)));
  }
  return out;
}

/** Elements called `name` with their text: [{ attrs, body }]. One that never closes ends the search. */
function elements(html, name) {
  const lower = html.toLowerCase();
  const out = [];
  let at = 0;
  while (out.length < MAX_TAGS) {
    const open = lower.indexOf(`<${name}`, at);
    if (open < 0) break;
    const tagEnd = lower.indexOf('>', open);
    if (tagEnd < 0) break;
    const close = lower.indexOf(`</${name}`, tagEnd);
    if (close < 0) break;
    out.push({ attrs: attributes(html.slice(open, Math.min(tagEnd + 1, open + MAX_TAG))), body: html.slice(tagEnd + 1, close) });
    at = close + name.length + 2;
  }
  return out;
}

/** How much text a page shows without running anything: outside tags, and outside script, style and noscript. */
function visibleTextLength(html) {
  const lower = html.toLowerCase();
  let count = 0;
  let inTag = false;
  let lastSpace = true;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (inTag) {
      if (c === '>') inTag = false;
      continue;
    }
    if (c === '<') {
      const skipped = ['script', 'style', 'noscript'].find((name) => lower.startsWith(name, i + 1));
      if (skipped) {
        const close = lower.indexOf(`</${skipped}`, i);
        if (close < 0) break;
        i = close;
      }
      inTag = true;
      continue;
    }
    const space = c === ' ' || c === '\n' || c === '\t' || c === '\r';
    if (!space || !lastSpace) count++;
    lastSpace = space;
  }
  return count;
}

function declarations(block) {
  const out = {};
  for (const part of String(block).slice(0, MAX_DECLARATIONS).split(';')) {
    const at = part.indexOf(':');
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] ??= part.slice(at + 1).trim();
  }
  return out;
}

/**
 * Every `selector { declarations }` of a stylesheet, which is where a theme's colours and fonts are. A block that holds
 * other blocks (@media) is stepped into, so its rules are read as well.
 */
function rules(css) {
  const sheet = String(css).slice(0, MAX_CSS);
  const out = [];
  let start = 0;
  while (out.length < MAX_RULES) {
    const open = sheet.indexOf('{', start);
    if (open < 0) break;
    const close = sheet.indexOf('}', open);
    if (close < 0) break;
    const inner = sheet.indexOf('{', open + 1);
    const selector = sheet.slice(Math.max(start, open - 300), open);
    if (inner >= 0 && inner < close) {
      start = open + 1; // a wrapper such as @media: carry on inside it
      continue;
    }
    out.push({ selector: selector.replace(/\/\*.{0,300}?\*\//gs, ' ').replace(/[};]/g, ' ').trim().toLowerCase(), set: declarations(sheet.slice(open + 1, close)) });
    start = close + 1;
  }
  return out;
}

function absolute(link, pageUrl) {
  if (!String(link ?? '').trim()) return '';
  try {
    const url = new URL(String(link).trim(), pageUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2000 ? url.href : '';
  } catch {
    return '';
  }
}

function organisationLogo(html) {
  for (const script of elements(html, 'script')) {
    if (!/^application\/ld\+json$/i.test(String(script.attrs.type ?? '').trim())) continue;
    let data;
    try {
      data = JSON.parse(script.body);
    } catch {
      continue;
    }
    const nodes = [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])].slice(0, 200);
    for (const node of nodes) {
      const type = [node?.['@type']].flat().map(String);
      if (!type.some((t) => /^(Organization|LocalBusiness|Store|OnlineStore|Brand|Corporation)$/i.test(t))) continue;
      const logo = typeof node.logo === 'string' ? node.logo : node.logo?.url ?? node.logo?.contentUrl;
      if (typeof logo === 'string' && logo) return logo;
    }
  }
  return '';
}

/** Family names in a Google Fonts stylesheet link, in the order the site asked for them. */
function googleFamilies(html) {
  const names = [];
  for (const link of tags(html, 'link')) {
    const href = String(link.href ?? '').replace(/&amp;/g, '&');
    if (!/^https?:\/\/fonts\.googleapis\.com\/css/i.test(href)) continue;
    let params;
    try {
      params = new URL(href).searchParams;
    } catch {
      continue;
    }
    for (const value of params.getAll('family')) for (const one of value.split('|')) names.push(cleanName(one.split(':')[0]));
  }
  return [...new Set(names.filter(Boolean))];
}

const VAR_NAMES = Object.freeze({
  primary: /^(color-)?(primary|brand|button|btn|cta|main)(-color|-bg|-background)?$|^(brand|theme)(-primary)?$/,
  ground: /^(color-)?(background|bg|body-bg|page-bg|surface)(-color)?$/,
  ink: /^(color-)?(text|body-text|foreground|fg|ink|body)(-color)?$/,
  accent: /^(color-)?(accent|secondary|highlight)(-color)?$/,
});
const BUTTON_SELECTOR = /(^|[\s,>+~.#[])(btn|button|cta)[\w-]*/;
const HEADING_SELECTOR = /(^|[\s,>+~])(h1|h2|h3)\b|\.(heading|title)\b/;
const BODY_SELECTOR = /(^|[\s,])(body|html|:root)(?![\w-])/;

/**
 * What a page says about its look.
 *   html      the homepage
 *   css       the text of its stylesheets, already read
 *   manifest  its web app manifest as an object, when read
 *   pageUrl   the address the page was finally read from, for relative links
 * Returns { colors, headingFont, bodyFont, logoCandidates, stylesheets, manifestUrl, notes, scriptOnly, found }.
 */
export function extractLook({ html = '', css = [], manifest = null, pageUrl }) {
  const page = String(html).slice(0, MAX_HTML);
  const notes = [];
  const found = {};
  const inlineStyles = elements(page, 'style').map((el) => el.body);
  const sheets = [...inlineStyles, ...css].map((sheet) => String(sheet).slice(0, MAX_CSS));
  const allRules = sheets.flatMap(rules);

  // Custom properties, wherever they are set.
  const variables = {};
  for (const sheet of sheets) {
    for (const m of sheet.matchAll(/--([\w-]{1,60})\s{0,20}:\s{0,20}([^;{}]{1,200})/g)) variables[m[1].toLowerCase()] ??= m[2];
  }
  const fromVariable = (pattern) => {
    for (const [name, value] of Object.entries(variables)) {
      if (!pattern.test(name)) continue;
      const colour = parseColor(value);
      if (colour) return colour;
    }
    return null;
  };

  // Button colours: a stylesheet rule for a button, or a button's own style attribute.
  let button = null;
  for (const rule of allRules) {
    if (!BUTTON_SELECTOR.test(rule.selector)) continue;
    const background = parseColor(rule.set['background-color'] ?? rule.set.background);
    if (background) {
      button = { background, color: parseColor(rule.set.color) };
      break;
    }
  }
  if (!button) {
    for (const el of [...tags(page, 'button'), ...tags(page, 'a').filter((a) => BUTTON_SELECTOR.test(` .${String(a.class ?? '').toLowerCase().split(/\s+/).join(' .')}`))]) {
      const set = declarations(el.style ?? '');
      const background = parseColor(set['background-color'] ?? set.background);
      if (background) {
        button = { background, color: parseColor(set.color) };
        break;
      }
    }
  }

  const metas = tags(page, 'meta');
  const metaContent = (name) => metas.find((m) => (m.name ?? m.property ?? '').toLowerCase() === name)?.content ?? '';
  const bodyRule = allRules.find((r) => BODY_SELECTOR.test(r.selector) && (r.set.color || r.set.background || r.set['background-color']));

  found.primary = button?.background ?? fromVariable(VAR_NAMES.primary) ?? parseColor(metaContent('theme-color')) ?? parseColor(manifest?.theme_color);
  found.on_primary = button?.color ?? null;
  found.ground = fromVariable(VAR_NAMES.ground) ?? parseColor(bodyRule?.set['background-color'] ?? bodyRule?.set.background) ?? parseColor(manifest?.background_color);
  found.ink = fromVariable(VAR_NAMES.ink) ?? parseColor(bodyRule?.set.color);
  found.accent = fromVariable(VAR_NAMES.accent);

  // Fonts: what headings and body text are set in, else the Google Fonts the page loads (headings first).
  const families = googleFamilies(page);
  const headingRule = allRules.find((r) => HEADING_SELECTOR.test(r.selector) && firstFamily(r.set['font-family']));
  const bodyFontRule = allRules.find((r) => BODY_SELECTOR.test(r.selector) && firstFamily(r.set['font-family']));
  const wanted = {
    heading: headingRule ? { name: firstFamily(headingRule.set['font-family']), stack: headingRule.set['font-family'] } : families[0] ? { name: families[0], stack: '' } : null,
    body: bodyFontRule ? { name: firstFamily(bodyFontRule.set['font-family']), stack: bodyFontRule.set['font-family'] } : families[1] ?? families[0] ? { name: families[1] ?? families[0], stack: '' } : null,
  };
  const fonts = {};
  for (const [slot, want] of Object.entries(wanted)) {
    if (!want) continue;
    const { font, exact } = mapFont(want.name, want.stack);
    fonts[slot] = font;
    const note = `${cleanName(want.name)} isn’t available, so ${font} is used instead.`;
    if (!exact && !notes.includes(note)) notes.push(note);
  }

  // Logo, in the order of 8.9: JSON-LD Organization.logo, apple-touch-icon, the manifest's largest icon, og:image.
  const links = tags(page, 'link');
  const manifestIcon = [...(Array.isArray(manifest?.icons) ? manifest.icons : [])]
    .filter((i) => typeof i?.src === 'string' && !/svg/i.test(String(i.type ?? i.src)))
    .sort((a, b) => (parseInt(b.sizes, 10) || 0) - (parseInt(a.sizes, 10) || 0))[0]?.src;
  const manifestHref = links.find((l) => /(^|\s)manifest(\s|$)/i.test(l.rel ?? ''))?.href ?? '';
  const manifestUrl = absolute(manifestHref, pageUrl);
  const logoCandidates = [
    absolute(organisationLogo(page), pageUrl),
    absolute(links.find((l) => /apple-touch-icon/i.test(l.rel ?? ''))?.href ?? '', pageUrl),
    manifestIcon ? absolute(manifestIcon, manifestUrl || pageUrl) : '',
    absolute(metaContent('og:image'), pageUrl),
  ].filter((url, i, all) => url && !/\.svg(\?|$)/i.test(url) && all.indexOf(url) === i);

  const stylesheets = links
    .filter((l) => /(^|\s)stylesheet(\s|$)/i.test(l.rel ?? ''))
    .map((l) => absolute(String(l.href ?? '').replace(/&amp;/g, '&'), pageUrl))
    .filter(Boolean);

  // A page that is all script has nothing to read: no colours, almost no text of its own, and a bundle to run.

  const anyColour = Boolean(found.primary || found.ground || found.ink || found.accent);
  const scriptOnly = !anyColour && !fonts.heading && tags(page, 'script').some((script) => script.src) && visibleTextLength(page) < 200;

  return { found, fonts, logoCandidates, stylesheets, manifestUrl, notes, scriptOnly, anyColour };
}

/**
 * The colours to save from what was found, as brand kit keys. Text and button pairs that miss 4.5:1 move to black or white, each
 * with a note (K-28); the colours a site doesn't state are derived from the ones it does. `base` is the preset the business is
 * on, used for anything the site says nothing about. Returns { colors, notes, adjusted }.
 */
export function lookColors(found, base = {}) {
  const colors = {};
  const notes = [];
  let adjusted = false;
  const fix = (textKey, groundKey, what) => {
    const ratio = contrastRatio(colors[textKey], colors[groundKey]);
    if (ratio >= MIN_CONTRAST) return;
    const moved = readableOn(colors[groundKey]);
    notes.push(`${what} was ${ratio.toFixed(1)}:1 against its background, so it was changed to ${moved === '#000000' ? 'black' : 'white'} to be readable.`);
    colors[textKey] = moved;
    adjusted = true;
  };

  if (found.ground || found.ink) {
    colors.ground = found.ground ?? base.ground ?? '#FFFFFF';
    colors.ink = found.ink ?? readableOn(colors.ground);
    fix('ink', 'ground', 'The text colour');
    const light = contrastRatio(colors.ground, '#000000') > 10;
    colors.card = light ? '#FFFFFF' : mix(colors.ground, '#FFFFFF', 0.08);
    if (contrastRatio(colors.ink, colors.card) < MIN_CONTRAST) colors.card = colors.ground;
    colors.muted = mix(colors.ink, colors.ground, 0.3);
    if (contrastRatio(colors.muted, colors.ground) < MIN_CONTRAST || contrastRatio(colors.muted, colors.card) < MIN_CONTRAST) colors.muted = colors.ink;
    colors.line = mix(colors.ground, colors.ink, 0.15);
  }
  const ground = colors.ground ?? base.ground ?? '#FFFFFF';
  if (found.primary) {
    colors.primary = found.primary;
    colors.on_primary = found.on_primary ?? readableOn(colors.primary);
    fix('on_primary', 'primary', 'The button text');
    colors.eyebrow = contrastRatio(colors.primary, ground) >= MIN_CONTRAST ? colors.primary : colors.ink ?? base.ink ?? readableOn(ground);
    if (!found.accent) {
      colors.accent = colors.primary;
      colors.on_accent = colors.on_primary;
    }
  }
  if (found.accent) {
    colors.accent = found.accent;
    colors.on_accent = readableOn(colors.accent);
    fix('on_accent', 'accent', 'The text on the accent colour');
  }
  return { colors, notes, adjusted };
}
