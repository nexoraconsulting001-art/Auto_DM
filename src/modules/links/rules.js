import net from 'node:net';

/**
 * Direct links (PRD 4.11, 6.6). Automations and compliance import directLink and linkProblem from here, so this file stays pure:
 * no database, no clock, no network. A DM link is the destination itself. Tags are added to the address as written and nothing
 * else in it changes, because an address that has been through a URL serialiser is not always the address the seller pasted.
 */

const HOP_CATEGORIES = new Set(['shortener', 'redirector']);
const AMAZON_HOST = /^(?:[a-z0-9-]+\.)*amazon\.(?:in|com|ca|de|es|fr|it|nl|pl|se|sg|ae|sa|eg|co\.uk|co\.jp|com\.au|com\.br|com\.mx|com\.tr|com\.be)$/;
const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal)$/;
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const WHATSAPP_DIGITS = /^\d{6,15}$/;
const PARAM_NAME = /^[A-Za-z_][\w.-]{0,39}$/;
const DEFAULT_SUB_ID_PARAM = 'subid';

/** Each network's own sub-ID parameter (PRD 6.6: names are to check per network before it is offered). */
const SUB_ID_PARAMS = new Map([['cuelinks', 'subid'], ['admitad', 'subid'], ['vcommission', 'aff_sub'], ['impact', 'subId1'], ['awin', 'clickref']]);

const PRIVATE_RANGES = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
// 64:ff9b::/96, 2001::/32 and 2002::/16 carry an IPv4 address inside, which could be a private one.
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');

/** False for private, loopback, link-local, CGNAT, multicast and metadata addresses (PRD 8.2), and for anything that isn't an address. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && !PRIVATE_RANGES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The parsed address when `url` is an https link written the plain way, otherwise null. */
export function parseHttps(url) {
  if (typeof url !== 'string' || !url.isWellFormed() || SPACE_OR_CONTROL.test(url) || !/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Lower case, without a trailing dot or IPv6 brackets, so that bit.ly. and BIT.LY are bit.ly. */
export const hostOf = (parsed) => parsed.hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');

const isWhatsappHost = (host) => host === 'wa.me' || host.endsWith('.wa.me') || host === 'whatsapp.com' || host.endsWith('.whatsapp.com');

export function isWhatsappLink(url) {
  const parsed = parseHttps(url);
  return Boolean(parsed) && isWhatsappHost(hostOf(parsed));
}

/** The blocklist category of a host or of any domain above it. */
function blockedCategory(host, blockedHosts) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    const category = blockedHosts.get(labels.slice(i).join('.'));
    if (category) return category;
  }
  return null;
}

const isInternalHost = (host) => (net.isIP(host) ? !isPublicAddress(host) : !host.includes('.') || INTERNAL_NAME.test(host));

/** The number a WhatsApp link opens a chat with, or '' for any other shape of link. PRD 4.11 allows only these two. */
function whatsappNumberIn(parsed, host) {
  if (host === 'wa.me') {
    const number = /^\/(\d+)\/?$/.exec(parsed.pathname)?.[1] ?? '';
    return WHATSAPP_DIGITS.test(number) ? number : '';
  }
  if (host === 'api.whatsapp.com' && /^\/send\/?$/.test(parsed.pathname)) {
    const phones = parsed.searchParams.getAll('phone');
    return phones.length === 1 && WHATSAPP_DIGITS.test(phones[0]) ? phones[0] : '';
  }
  return '';
}

/**
 * Why this destination can't be used, as a reason code, or null when it can.
 * context: { whatsappNumber, blockedHosts }, with blockedHosts as a Map of host to category from link_blocked_hosts.
 */
export function linkProblem(url, { whatsappNumber = '', blockedHosts = new Map() } = {}) {
  const parsed = parseHttps(url);
  if (!parsed) return 'link.scheme';
  const host = hostOf(parsed);
  const category = blockedCategory(host, blockedHosts);
  if (category) return HOP_CATEGORIES.has(category) ? 'link.shortener' : 'link.blocked';
  if (parsed.username || parsed.password) return 'link.scheme'; // https://real-shop.example@elsewhere.example shows one site and opens another
  if (isInternalHost(host)) return 'link.blocked';
  if (isWhatsappHost(host)) {
    const number = whatsappNumberIn(parsed, host);
    const saved = String(whatsappNumber ?? '').replace(/\D/g, '');
    if (!number || number !== saved) return 'link.not_allowlisted';
  }
  return null;
}

// ---- tags, added to the address as written ----------------------------------------------------------------------

/** encodeURIComponent throws on a lone surrogate. */
const encode = (value) => encodeURIComponent(String(value).toWellFormed());

function paramName(pair) {
  const raw = pair.split('=', 1)[0].replaceAll('+', ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function splitAddress(url) {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);
  return { base: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt), pairs: query ? query.split('&') : [], fragment: hashAt < 0 ? '' : url.slice(hashAt) };
}

const joinAddress = ({ base, pairs, fragment }) => `${base}${pairs.length ? `?${pairs.join('&')}` : ''}${fragment}`;

/** Sets one parameter, in place if it is already there. */
function setParam(url, name, value) {
  const address = splitAddress(url);
  const pair = `${encode(name)}=${encode(value)}`;
  const at = address.pairs.findIndex((p) => paramName(p) === name);
  if (at < 0) return joinAddress({ ...address, pairs: [...address.pairs, pair] });
  return joinAddress({ ...address, pairs: address.pairs.flatMap((p, i) => (i === at ? [pair] : paramName(p) === name ? [] : [p])) });
}

/** Adds each tag that has a value and isn't on the link already. Tags already there win (PRD 6.6). */
function addMissing(url, tags) {
  const address = splitAddress(url);
  const present = new Set(address.pairs.map(paramName));
  const added = Object.entries(tags).filter(([name, value]) => value && !present.has(name)).map(([name, value]) => `${name}=${encode(value)}`);
  return added.length ? joinAddress({ ...address, pairs: [...address.pairs, ...added] }) : url;
}

function subIdParam({ subIdParam: named, network }) {
  if (named && PARAM_NAME.test(named)) return named;
  return SUB_ID_PARAMS.get(String(network ?? '').toLowerCase()) ?? DEFAULT_SUB_ID_PARAM;
}

/** What the host says the link is, or null when the host says nothing. An Amazon tag goes only on Amazon's own hosts, whatever the builder was told. */
export function hostLinkType(url) {
  const parsed = parseHttps(url);
  if (!parsed) return null;
  const host = hostOf(parsed);
  if (isWhatsappHost(host)) return 'whatsapp';
  return AMAZON_HOST.test(host) ? 'amazon' : null;
}

/**
 * The exact address the shopper will open: the destination with its tags, never a Bhava hop.
 * link: { url, linkType, channel, automationSlug, mediaId, variantLabel, utmEnabled, measurement: { amazonTag?, subId?, subIdParam?, network? } }
 */
export function directLink({ url, linkType, channel = 'instagram', automationSlug = '', mediaId = '', variantLabel = '', utmEnabled = true, measurement = {} }) {
  if (!parseHttps(url)) return url;
  const type = hostLinkType(url) ?? (['amazon', 'whatsapp'].includes(linkType) ? null : linkType ?? 'seller_site');
  if (type === 'amazon') return measurement.amazonTag ? setParam(url, 'tag', measurement.amazonTag) : url;
  if (type === 'affiliate') return measurement.subId ? setParam(url, subIdParam(measurement), measurement.subId) : url;
  if (type !== 'seller_site' && type !== 'bhava_page') return url; // WhatsApp carries no tags, and neither does a link that isn't what it was saved as
  if (!utmEnabled) return url;
  return addMissing(url, { utm_source: channel, utm_medium: 'dm', utm_campaign: automationSlug, utm_content: mediaId || variantLabel });
}
