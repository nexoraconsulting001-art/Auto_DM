import net from 'node:net';
import { domainToASCII } from 'node:url';
import { platformAppHostOf } from '../../config.js';
import { RESERVED_SLUGS } from '../../repos/tenants.js';
import { normalizeHost } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { platformHostOf } from '../platform-console/host.js';

/** Labels under the neutral domain no business can have: the reserved slugs, and the host custom domains point at. */
export const RESERVED_LABELS = new Set([...RESERVED_SLUGS, 'edge']);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_TLDS = new Set(['arpa', 'corp', 'home', 'internal', 'intranet', 'invalid', 'lan', 'local', 'localhost', 'onion']);
// Where a registrable name has three labels. Only decides which DNS records a seller is shown, so a miss is harmless.
const TWO_PART_SUFFIXES = new Set([
  'ac.in', 'co.in', 'edu.in', 'firm.in', 'gen.in', 'gov.in', 'ind.in', 'net.in', 'nic.in', 'org.in', 'res.in',
  'co.uk', 'me.uk', 'org.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'net.nz', 'org.nz', 'com.sg', 'co.za', 'co.jp', 'com.br', 'com.my',
]);

export const edgeHost = (config) => (config.platformDomain ? `edge.${normalizeHost(config.platformDomain)}` : '');
export const verificationName = (domain) => `_site-verification.${domain}`;
export const fallbackHost = (tenant, config) => (config.platformDomain ? `${tenant.slug}.${normalizeHost(config.platformDomain)}` : '');

/** What someone typed, as the lower-case ASCII host we store. Empty when it can't be one. */
export function toAsciiHost(input) {
  const typed = String(input ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  return normalizeHost(domainToASCII(normalizeHost(typed)));
}

const hostOfUrl = (url) => {
  try {
    return url ? normalizeHost(new URL(url).hostname) : '';
  } catch {
    return '';
  }
};

/** Where each business gets its own address, <slug>.<root>: PLATFORM_DOMAIN and SIGNUP_HOST_SUFFIX. */
const fallbackRoots = (config) => [...new Set([config.platformDomain, config.signupHostSuffix].map(normalizeHost).filter(Boolean))];

/**
 * Every other host the platform itself answers on (atk-tenancy-3): the console, the host sellers sign in on, the public and
 * Meta callback base addresses, the marketing site, the neutral email domain and the edge host custom domains point at.
 */
const platformHosts = (config) => [...new Set([
  platformHostOf(config), normalizeHost(platformAppHostOf(config)), hostOfUrl(config.publicBaseUrl), hostOfUrl(config.metaCallbackBaseUrl),
  hostOfUrl(config.platformSiteUrl), normalizeHost(config.emailNeutralDomain), edgeHost(config),
].filter(Boolean))];

const under = (host, root) => host === root || host.endsWith(`.${root}`);

/** True for every host the platform answers on and anything under one: addresses that are the platform's own, never a business's domain. */
export function isPlatformAddress(host, config) {
  return [...fallbackRoots(config), ...platformHosts(config)].some((root) => under(host, root));
}

/**
 * A host that can never be given a certificate or a store through a business: a platform host or anything under one, a fallback
 * root, and a reserved label under a fallback root. A business's own fallback address (<slug>.<root>) is not reserved here.
 */
export function isReservedHost(host, config) {
  const hosts = platformHosts(config);
  if (hosts.includes(host)) return true;
  for (const root of fallbackRoots(config)) {
    if (host === root) return true;
    const label = host.endsWith(`.${root}`) ? host.slice(0, -(root.length + 1)) : '';
    if (label && !label.includes('.')) return RESERVED_LABELS.has(label);
  }
  return hosts.some((root) => host.endsWith(`.${root}`));
}

/** The domain a seller may add, normalised, or a ValidationError saying why not. */
export function cleanDomain(input, config) {
  const domain = toAsciiHost(input);
  const labels = domain.split('.');
  const valid = domain.length <= 253 && labels.length >= 2 && labels.every((label) => LABEL.test(label))
    && !/^\d+$/.test(labels.at(-1)) && !PRIVATE_TLDS.has(labels.at(-1)) && !net.isIP(domain);
  if (!valid) throw new ValidationError('Enter a domain like shop.yourbrand.in');
  if (isPlatformAddress(domain, config)) throw new ValidationError('That address is already part of the platform. Use a domain you own.');
  return domain;
}

/** True when `domain` is the registered name itself, where DNS doesn't allow a CNAME. */
export function isApex(domain) {
  const labels = domain.split('.');
  return labels.length === 2 || (labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join('.')));
}

/** The www form of an apex and the apex of a www form: the pair where the non-primary always redirects (PRD 5.4). */
export function siblingOf(domain) {
  if (domain.startsWith('www.')) return domain.slice(4);
  return isApex(domain) ? `www.${domain}` : '';
}

/** What the seller adds at their DNS host. Nothing here may name the platform (F-19). */
export function dnsRecords(domain, token, edge, edgeAddresses = []) {
  const ownership = token ? [{ type: 'TXT', name: verificationName(domain), value: token }] : [];
  if (isApex(domain) && edgeAddresses.length) {
    return [...ownership, ...edgeAddresses.map((ip) => ({ type: net.isIPv6(ip) ? 'AAAA' : 'A', name: domain, value: ip }))];
  }
  return [...ownership, { type: 'CNAME', name: domain, value: edge }];
}
