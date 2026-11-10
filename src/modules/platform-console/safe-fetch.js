import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** The address is not a public website: private, loopback, metadata, an odd port, or not http(s). Never retried. */
export class BlockedAddressError extends Error {
  constructor(message = 'That address isn’t a public website') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

export const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; SitePreview/1.0)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|onion)$/;

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

/** False for private, loopback, link-local, carrier-grade NAT, multicast and metadata ranges, and for IPv6 forms that hide an IPv4 address. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const bareHost = (hostname) => hostname.replace(/^\[|\]$/g, '');

/** The URL as a URL, when it is one we may fetch at all. Needs no network, so it refuses literal addresses before anything connects. */
export function assertFetchable(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new BlockedAddressError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port)) throw new BlockedAddressError();
  const host = bareHost(url.hostname).toLowerCase().replace(/\.$/, '');
  if (net.isIP(host) ? !isPublicAddress(host) : (!host.includes('.') || PRIVATE_NAME.test(host))) throw new BlockedAddressError();
  return url;
}

const systemLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** A public address for this host. Refuses it if any answer is private, so a name can't hide one behind a public one. */
async function resolvePublic(url, lookup) {
  const host = bareHost(url.hostname);
  const family = net.isIP(host);
  if (family) return { address: host, family };
  const answers = await lookup(host);
  if (!answers.length || answers.some((a) => !isPublicAddress(a.address))) throw new BlockedAddressError();
  return answers[0];
}

/** One GET, connected to the address already checked, so a DNS answer that changes can't redirect it (PRD 8.2). No cookies, no credentials. */
export function requestOnce(url, pinned, { signal, maxBytes = MAX_PAGE_BYTES } = {}) {
  const lookup = (_host, options, done) => (options?.all ? done(null, [pinned]) : done(null, pinned.address, pinned.family));
  const headers = { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity' };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', headers, lookup, signal, agent: false }, (res) => {
      if (REDIRECTS.has(res.statusCode)) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, body: '' });
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('page too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
      return undefined;
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The fetcher for reading a business's own website (PRD 5.5, 8.2): every hop is checked and pinned, at most 3 redirects.
 * The caller sets the 8 second limit through `signal`. Throws BlockedAddressError for an address that isn't a public website.
 */
export async function safeFetch(input, { signal, lookup = systemLookup, request = requestOnce, maxRedirects = MAX_REDIRECTS } = {}) {
  let url = assertFetchable(input);
  for (let hop = 0; ; hop++) {
    const res = await request(url, await resolvePublic(url, lookup), { signal });
    if (!REDIRECTS.has(res.status) || !res.headers?.location) return res;
    if (hop >= maxRedirects) throw new Error('Too many redirects');
    url = assertFetchable(new URL(res.headers.location, url).href);
  }
}
