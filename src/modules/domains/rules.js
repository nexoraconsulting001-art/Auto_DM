import net from 'node:net';
import { domainToASCII } from 'node:url';
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

/** True for the neutral domain, anything under it, and the console host: addresses that are the platform's own. */
export function isPlatformAddress(host, config) {
  const under = (root) => Boolean(root) && (host === root || host.endsWith(`.${root}`));
  return under(normalizeHost(config.platformDomain)) || under(platformHostOf(config));
}

/** A host that can never be given a certificate or a store through a business. */
export function isReservedHost(host, config) {
  const root = normalizeHost(config.platformDomain);
  if (host === root || host === platformHostOf(config)) return true;
  return Boolean(root) && host.endsWith(`.${root}`) && RESERVED_LABELS.has(host.slice(0, -(root.length + 1)));
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
