/**
 * Outside websites, for importing products and reading a business's look (PRD 8.2 to 8.9), so no test reaches a real site.
 * One loopback server serves every fixture site, chosen by the Host header; fixtures.mjs lists them, the hostile ones too.
 * Other simulators can be mounted under a site name (a Shopify storefront at plants.example, say).
 *
 * safeFetch never connects to loopback, so tests give it this simulator's transport, which keeps every one of its rules:
 *
 *   const sites = createSites();
 *   await sites.start();
 *   sites.mount('plants.example', shopify);            // optional: another simulator under a site name
 *   const fetcher = createSafeFetch({ ...sites.transport(), hostGate: memoryHostGate({ gapMs: 0 }) });
 *   startApp({ overrides: { safeFetchTransport: sites.transport(), fetchHostGapMs: 0 } });
 *
 * transport().lookup is the DNS the fetcher sees (each fixture's `dns`); transport().dial sends the request to this server
 * (or the mounted one) over plain HTTP with the site's own name as Host, and records the address safeFetch pinned, so a test
 * can prove it connected only to the address it checked (K-05). Unknown names don't resolve.
 *
 * Controls, besides the shared ones in base.mjs:
 *   POST /__sim/sites          { host, dns?, pages }   adds or replaces a site (string bodies only)
 *   POST /__sim/pages          { host, path, ...page } adds or replaces one page
 *   GET  /__sim/lookups        how many times each name was looked up
 *   GET  /__sim/dials          every connection: { host, address }
 * In process: sites.site(host, spec), sites.page(host, path, page), sites.mount(host, sim), sites.lookups, sites.dials.
 */
import { createSim, reply, SimError } from '../base.mjs';
import { fixtureSites } from './fixtures.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostOf = (header) => String(header ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '');
const familyOf = (address) => (address.includes(':') ? 6 : 4);

function findPage(site, path) {
  if (Object.hasOwn(site.pages, path)) return { page: site.pages[path], rest: '' };
  let best = null;
  for (const [pattern, page] of Object.entries(site.pages)) {
    if (!pattern.endsWith('/*')) continue;
    const prefix = pattern.slice(0, -1);
    if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, page, rest: path.slice(prefix.length) };
  }
  return best;
}

async function* chunks({ bytes, chunk = 64 * 1024, everyMs = 0 }) {
  const piece = Buffer.alloc(chunk, 'x');
  for (let sent = 0; sent < bytes; sent += chunk) {
    if (everyMs) await sleep(everyMs);
    yield sent + chunk > bytes ? piece.subarray(0, bytes - sent) : piece;
  }
}

export function createSites({ sites: initial = fixtureSites } = {}) {
  let sites;
  const mounts = new Map(); // kept across a reset: it is wiring, not data
  const lookups = new Map();
  const dials = [];

  const reset = () => {
    sites = typeof initial === 'function' ? initial() : structuredClone(initial);
    lookups.clear();
    dials.length = 0;
  };
  reset();

  async function serve(req) {
    const host = hostOf(req.headers.host);
    const site = sites[host];
    if (!site) return reply(404, `No such site ${host}.`, { 'content-type': 'text/plain' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method not allowed', { 'content-type': 'text/plain' });
    const found = findPage(site, req.path);
    if (!found) return reply(404, '<!doctype html><title>Not found</title><h1>Not found</h1>', { 'content-type': 'text/html; charset=utf-8' });
    const { page, rest } = found;
    if (page.hang) await new Promise(() => {});
    if (page.delayMs) await sleep(page.delayMs);
    const target = page.redirect ?? page.redirectFrom?.(rest) ?? null;
    if (target) return reply(page.status ?? 302, '', { location: target, ...page.headers });
    const type = page.type ?? 'text/html; charset=utf-8';
    const headers = { ...(type ? { 'content-type': type } : {}), ...page.headers };
    if (page.stream) return reply(page.status ?? 200, chunks(page.stream), headers);
    const body = typeof page.body === 'function' ? page.body({ ...req, rest }) : page.body ?? '';
    return reply(page.status ?? 200, body, headers);
  }

  const sim = createSim({
    name: 'sites',
    anyHost: true,
    reset,
    routes: () => {},
    notFound: serve,
    controls: (on) => {
      on('POST', '/sites', ({ body }) => {
        if (typeof body.host !== 'string' || !body.host.includes('.')) throw new SimError(400, { error: 'host is required' });
        sim.site(body.host, { dns: body.dns, pages: body.pages ?? {} });
        return { ok: true };
      });
      on('POST', '/pages', ({ body }) => {
        const { host, path, ...page } = body;
        if (!sites[host]) throw new SimError(404, { error: `No site ${host}` });
        sim.page(host, path, page);
        return { ok: true };
      });
      on('GET', '/lookups', () => ({ lookups: Object.fromEntries(lookups) }));
      on('GET', '/dials', () => ({ dials }));
    },
  });

  /** The DNS answer for a name, as dns.lookup({ all: true }) gives it. Every call is counted. */
  async function lookup(hostname) {
    const host = hostOf(hostname);
    const count = (lookups.get(host) ?? 0) + 1;
    lookups.set(host, count);
    const site = sites[host];
    const dns = site?.dns ?? (mounts.has(host) ? [mounts.get(host).address] : null);
    if (!dns) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const answer = Array.isArray(dns) ? dns : dns.sequence[Math.min(count, dns.sequence.length) - 1];
    return answer.map((address) => ({ address, family: familyOf(address) }));
  }

  /** Where the fetcher's connection for `url` really goes: this server, or the simulator mounted under that name. */
  function dial(url, pinned) {
    const host = hostOf(url.hostname);
    dials.push({ host, address: pinned.address });
    const mounted = mounts.get(host);
    const port = mounted ? mounted.sim.port : sim.port;
    if (!port) throw new Error('The sites simulator is not running.');
    return { host: '127.0.0.1', port };
  }

  return Object.assign(sim, {
    lookups,
    dials,
    transport: () => ({ lookup, dial }),
    /** Adds or replaces a whole site. `dns` defaults to one public address. */
    site(host, { dns, pages = {} } = {}) {
      sites[hostOf(host)] = { dns: dns ?? ['93.184.216.34'], pages: { ...pages } };
      return sim;
    },
    /** Adds or replaces one page of a site. */
    page(host, path, page) {
      const site = sites[hostOf(host)];
      if (!site) throw new Error(`No site ${host}`);
      site.pages[path] = page;
      return sim;
    },
    /** Serves another simulator (already started) under a site name, at one public address. */
    mount(host, other, { address = '93.184.216.35' } = {}) {
      mounts.set(hostOf(host), { sim: other, address });
      return sim;
    },
  });
}
