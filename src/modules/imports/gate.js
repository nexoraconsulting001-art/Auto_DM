import { isSiteRoot } from '../../contracts/catalog.js';
import { comparable } from './text.js';

/**
 * The import quality gate (PRD 8.7): junk is refused so pages show no empty cards. An automatic import is accepted only with a
 * name of two characters or more plus a price or a product photo that isn't the site's logo. It is refused when the address is
 * the site's root, when the page's <title> was all there was, or when the name is just the shop's name or its homepage's title.
 * A save the owner makes by hand skips the gate.
 */

const LOGO_PATH = /(^|[/_.-])(logo|favicon|placeholder|no-?image|default-?image)s?([/_.-]|$)/i;

const pathOf = (link) => {
  try {
    return new URL(link).pathname;
  } catch {
    return '';
  }
};
const sameAddress = (a, b) => {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
};

/** True when the image is the site's logo: one the site names as its logo, or a file called one. */
export function isLogo(link, logos = []) {
  return logos.some((logo) => sameAddress(logo, link)) || LOGO_PATH.test(pathOf(link));
}

/**
 * The verdict on one read: { passed, reason } with reason a code from IMPORT_REASONS, or null when it passed.
 *   url       the address asked for, and finalUrl where it ended after redirects
 *   readFrom  adapter, shopify, feed, csv, json_ld, open_graph or title
 *   draft     the product as read
 *   page      what the page says about its site: { siteNames, logos }
 *   home      what the site's homepage says: { title, siteNames, logos }, or null when it couldn't be read
 */
export function qualityGate({ url = '', finalUrl = '', readFrom, draft, page = null, home = null }) {
  if ((url && isSiteRoot(url)) || (finalUrl && isSiteRoot(finalUrl))) return { passed: false, reason: 'homepage' };
  const name = String(draft?.name ?? '').trim();
  if (Array.from(name).length < 2) return { passed: false, reason: 'no_title' };
  if (readFrom === 'title') return { passed: false, reason: 'title_only' };
  const key = comparable(name);
  const siteNames = [...(page?.siteNames ?? []), ...(home?.siteNames ?? [])].map(comparable).filter(Boolean);
  if (siteNames.includes(key)) return { passed: false, reason: 'site_name' };
  if (home?.title && comparable(home.title) === key) return { passed: false, reason: 'homepage' };
  const logos = [...(page?.logos ?? []), ...(home?.logos ?? [])];
  const hasPrice = draft.pricePaise !== null && draft.pricePaise !== undefined;
  const hasPhoto = (draft.images ?? []).some((link) => !isLogo(link, logos));
  if (!hasPrice && !hasPhoto) return { passed: false, reason: 'no_price_or_image' };
  return { passed: true, reason: null };
}
