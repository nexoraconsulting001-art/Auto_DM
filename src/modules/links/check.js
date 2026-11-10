import dns from 'node:dns';
import { hostOf, isPublicAddress, isWhatsappLink, linkProblem, parseHttps } from './rules.js';

/**
 * The link check before going live and daily (PRD 4.11): safeFetch's link-check profile (PRD 8.2) is HTTPS on port 443, a 200 within
 * 5 s, at most one redirect and none to another site. The answer is { ok, reason, httpStatus }, and also unavailable: true when this
 * machine couldn't reach the internet at all, which says nothing about the seller's link and so never pauses anything.
 *
 * The request goes through the global fetch, and config.linkCheckFetch replaces that in tests, the way createCompliance takes complianceNow.
 */

const TIMEOUT_MS = 5000;
const MAX_REQUESTS = 2; // the first, and the one redirect the profile allows
const HOST_GAP_SECONDS = 1;
const USER_AGENT = 'Mozilla/5.0 (compatible; LinkCheck/1.0)';

/** No route out of this machine, or tools/net-guard in a test run. The site was never asked. */
const OUR_SIDE = new Set(['EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'ENETGUARD']);

/**
 * net.connect's lookup, so that the address checked is the address connected to. A DNS answer that changes between two lookups has
 * nothing to change, because there is only the one lookup (PRD 8.2, K-05).
 */
export function publicOnlyLookup(hostname, options, callback) {
  const reply = typeof options === 'function' ? options : callback;
  const wanted = typeof options === 'function' ? {} : options;
  dns.lookup(hostname, { all: true, verbatim: true, family: wanted.family ?? 0 }, (err, addresses) => {
    if (err) return reply(err);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return reply(Object.assign(new Error('That address isn\'t a public website'), { code: 'ENOTPUBLIC' }));
    }
    return wanted.all ? reply(null, addresses) : reply(null, addresses[0].address, addresses[0].family);
  });
}

let pinned = null;

/** A dispatcher for fetch that connects through publicOnlyLookup. Node doesn't export undici's Agent, but the global dispatcher is one. */
export function pinnedDispatcher(lookup = publicOnlyLookup) {
  if (lookup === publicOnlyLookup && pinned) return pinned;
  void globalThis.Response; // loads Node's undici, which registers the global dispatcher
  const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')]?.constructor;
  if (!Agent) throw new Error('This version of Node has no undici Agent to pin link checks with');
  const agent = new Agent({ keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000, connect: { lookup } });
  if (lookup === publicOnlyLookup) pinned = agent;
  return agent;
}

const isRedirect = (status) => status >= 300 && status < 400;
const stripWww = (host) => host.replace(/^www\./, '');
const sameSite = (a, b) => stripWww(hostOf(a)) === stripWww(hostOf(b));
const onStandardPort = (parsed) => parsed.port === '' || parsed.port === '443';

const failed = (reason, httpStatus = null) => ({ ok: false, reason, httpStatus });

/** { fetch, cache }. fetch(url, init) answers as the global one does; cache spaces out requests to one host. */
export function createLinkChecker({ fetch: fetchImpl, cache } = {}) {
  const request = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const dispatcher = fetchImpl ? undefined : pinnedDispatcher();

  async function get(url, signal) {
    const res = await request(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' }, signal, ...(dispatcher ? { dispatcher } : {}) });
    await res.body?.cancel().catch(() => {});
    return { status: res.status, location: res.headers.get('location') };
  }

  async function walk(start, signal) {
    let current = start;
    let status = null;
    for (let requests = 0; requests < MAX_REQUESTS; requests++) {
      const answer = await get(current.href, signal);
      status = answer.status;
      if (!isRedirect(status)) return status === 200 ? { ok: true, reason: null, httpStatus: 200 } : failed('link.check_failed', status);
      const next = URL.canParse(answer.location ?? '', current) && answer.location ? new URL(answer.location, current) : null;
      if (!next) return failed('link.check_failed', status);
      if (!sameSite(start, next)) return failed('link.redirect', status);
      if (next.protocol !== 'https:') return failed('link.scheme', status);
      if (!onStandardPort(next)) return failed('link.check_failed', status);
      current = next;
    }
    return failed('link.check_failed', status);
  }

  /** At most one request a second to a host, across businesses (PRD 8.2, to confirm). */
  async function spaceOut(host) {
    if (!cache) return;
    const key = `links:host:${host}`;
    if (await cache.get(key)) await new Promise((resolve) => setTimeout(resolve, HOST_GAP_SECONDS * 1000));
    await cache.set(key, 1, HOST_GAP_SECONDS);
  }

  /** The whole check for an address that has already passed linkProblem. */
  return async function checkReachable(url) {
    const start = parseHttps(url);
    if (!start) return failed('link.scheme');
    if (!onStandardPort(start)) return failed('link.check_failed');
    await spaceOut(hostOf(start));

    const controller = new AbortController();
    let timer;
    // Raced as well as aborted, so an answer that ignores the signal still can't take longer than the limit.
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failed('link.check_failed'));
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([walk(start, controller.signal), timedOut]);
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      return OUR_SIDE.has(code) ? { ...failed('link.check_failed'), unavailable: true } : failed('link.check_failed');
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The destination rules, then the request. A WhatsApp target gets a number-format check only (PRD 4.11). */
export async function verifyLink(url, context, checkReachable) {
  const reason = linkProblem(url, context);
  if (reason) return failed(reason);
  if (isWhatsappLink(url)) return { ok: true, reason: null, httpStatus: null };
  return checkReachable(url);
}
