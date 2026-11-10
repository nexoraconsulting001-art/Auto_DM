import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * safeFetch (PRD 8.2): the one fetcher for reading other people's websites. Imports (8.3 to 8.8), theme reads (8.9, 5.5) and
 * link checks (4.11) use it, and only from the worker or the seller's own actions: never while a shopper waits.
 *
 * At every hop the name is resolved, every answer must be a public address, and the request connects to the address that was
 * checked, so a DNS answer that changes between two lookups changes nothing (K-05). http and https on ports 80 and 443, GET only,
 * no cookies or credentials, and a neutral User-Agent. Each profile below sets the redirects, the total time across every hop
 * and the body, the size cap and the content types it accepts. One host gets at most one request a second across every
 * business and process (hostGate).
 *
 *   const fetcher = createSafeFetch({ hostGate });
 *   const { html, url } = await fetcher.page('https://shop.example/products/pot');
 *   const { data } = await fetcher.json('https://shop.example/products.json?page=2', { profile: 'feed' });
 *   const { buffer, contentType } = await fetcher.image(link);
 *
 * Every refusal is a SafeFetchError with a `code` from FETCH_ERRORS; BlockedAddressError is the 'blocked' one.
 */

/** The limits per use. linkCheck is implemented by src/modules/links/check.js on fetch; it is listed here so the numbers live in one place. */
export const FETCH_PROFILES = Object.freeze({
  page: Object.freeze({ maxRedirects: 3, timeoutMs: 8000, maxBytes: 2_000_000, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', types: Object.freeze(['text/html', 'application/xhtml+xml']) }),
  json: Object.freeze({ maxRedirects: 3, timeoutMs: 8000, maxBytes: 2_000_000, accept: 'application/json', types: Object.freeze(['application/json', '+json']) }),
  /** A Shopify store's public /products.json, page by page (8.5). Same caps as json; its own name so callers and logs say what it was. */
  feed: Object.freeze({ maxRedirects: 3, timeoutMs: 8000, maxBytes: 2_000_000, accept: 'application/json', types: Object.freeze(['application/json', '+json']) }),
  stylesheet: Object.freeze({ maxRedirects: 3, timeoutMs: 8000, maxBytes: 2_000_000, accept: 'text/css,*/*;q=0.1', types: Object.freeze(['text/css']) }),
  image: Object.freeze({ maxRedirects: 3, timeoutMs: 8000, maxBytes: 3_000_000, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', types: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']) }),
  linkCheck: Object.freeze({ maxRedirects: 1, timeoutMs: 5000, maxBytes: 0, accept: 'text/html,*/*', types: null }),
});

export const MAX_PAGE_BYTES = FETCH_PROFILES.page.maxBytes;
export const MAX_IMAGE_BYTES = FETCH_PROFILES.image.maxBytes;

/** Owner-facing wording for each refusal. `retryable` ones are worth another try later (8.8: timeouts and 5xx retry next run). */
export const FETCH_ERRORS = Object.freeze({
  blocked: Object.freeze({ message: 'That address isn’t a public website', retryable: false }),
  too_many_redirects: Object.freeze({ message: 'Too many redirects', retryable: false }),
  timeout: Object.freeze({ message: 'That site took too long to answer', retryable: true }),
  too_large: Object.freeze({ message: 'That page is too large to read', retryable: false }),
  wrong_type: Object.freeze({ message: 'That address didn’t give us what we expected', retryable: false }),
  http_status: Object.freeze({ message: 'That site answered with an error', retryable: false }),
  network: Object.freeze({ message: 'We couldn’t reach that site', retryable: true }),
  host_busy: Object.freeze({ message: 'That site is busy; we’ll try again shortly', retryable: true }),
});

export class SafeFetchError extends Error {
  /** `status` is the site's HTTP status for http_status; `url` is the address that failed, for the caller's own log (never logged here). */
  constructor(code, { status = null, message, url = '' } = {}) {
    const known = FETCH_ERRORS[code] ?? FETCH_ERRORS.network;
    super(message ?? known.message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.retryable = code === 'http_status' ? status === 429 || (status >= 500 && status <= 599) : known.retryable;
    /** 404 and 410: the page is gone (8.8 marks the product broken). */
    this.gone = code === 'http_status' && (status === 404 || status === 410);
  }
}

/** The address is not a public website: private, loopback, metadata, an odd port, or not http(s). Never retried. */
export class BlockedAddressError extends SafeFetchError {
  constructor(message = FETCH_ERRORS.blocked.message) {
    super('blocked', { message });
    this.name = 'BlockedAddressError';
  }
}

export const USER_AGENT = 'Mozilla/5.0 (compatible; SitePreview/1.0)';
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
    url = new URL(String(input));
  } catch {
    throw new BlockedAddressError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port)) throw new BlockedAddressError();
  const host = bareHost(url.hostname).toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedAddressError();
  } else if (!host.includes('.') || PRIVATE_NAME.test(host)) {
    throw new BlockedAddressError();
  }
  return url;
}

const systemLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** A public address for this host, looked up once. Refuses it if any answer is private, so a name can't hide one behind a public one. */
async function resolvePublic(url, lookup) {
  const host = bareHost(url.hostname);
  const family = net.isIP(host);
  if (family) return { address: host, family };
  let answers;
  try {
    answers = await lookup(host);
  } catch {
    throw new SafeFetchError('network', { url: url.href });
  }
  if (!answers?.length || answers.some((a) => !isPublicAddress(a.address))) throw new BlockedAddressError();
  return { address: answers[0].address, family: answers[0].family ?? net.isIP(answers[0].address) };
}

const mediaType = (header) => String(header ?? '').split(';')[0].trim().toLowerCase();

function typeAllowed(type, allowed) {
  if (!allowed) return true;
  return allowed.some((t) => (t.startsWith('+') ? type.endsWith(t) : type === t));
}

function decoderFor(encoding) {
  const name = String(encoding ?? '').trim().toLowerCase();
  if (!name || name === 'identity') return null;
  if (name === 'gzip' || name === 'x-gzip') return zlib.createGunzip();
  if (name === 'deflate') return zlib.createInflate();
  if (name === 'br') return zlib.createBrotliDecompress();
  return undefined; // unknown: refused
}

/**
 * One GET. Without `dial` it connects to the pinned address under the site's own name (TLS checks the real name). With `dial`
 * (tests only) it goes over plain HTTP to whatever dial(url, pinned) returns, still sending the site's name as Host.
 * Resolves { status, headers, body: Buffer } with redirects handed back unread. Rejects with SafeFetchError for too_large,
 * wrong_type or network. `types` null skips the content-type check; maxBytes 0 reads no body.
 */
export function requestRaw(url, pinned, { signal, maxBytes = MAX_PAGE_BYTES, accept = FETCH_PROFILES.page.accept, types = null, dial = null, userAgent = USER_AGENT } = {}) {
  const headers = { 'user-agent': userAgent, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en-IN,en;q=0.8' };
  let options;
  let transport;
  if (dial) {
    const target = dial(url, pinned);
    options = { host: target.host, port: target.port, path: `${url.pathname}${url.search}`, method: 'GET', headers: { ...headers, host: url.host }, agent: false, signal };
    transport = http;
  } else {
    const lookup = (_host, opts, done) => (opts?.all ? done(null, [pinned]) : done(null, pinned.address, pinned.family));
    options = { method: 'GET', headers, lookup, signal, agent: false };
    transport = url.protocol === 'https:' ? https : http;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof SafeFetchError ? err : new SafeFetchError(signal?.aborted ? 'timeout' : 'network', { url: url.href }));
    };
    const req = (dial ? transport.request(options) : transport.request(url, options)).on('response', (res) => {
      if (REDIRECTS.has(res.statusCode) || res.statusCode < 200 || res.statusCode > 299 || maxBytes === 0) {
        res.resume();
        settled = true;
        return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
      }
      if (!typeAllowed(mediaType(res.headers['content-type']), types)) {
        req.destroy();
        return fail(new SafeFetchError('wrong_type', { url: url.href }));
      }
      const declared = Number(res.headers['content-length']);
      const decoder = decoderFor(res.headers['content-encoding']);
      if (decoder === undefined) {
        req.destroy();
        return fail(new SafeFetchError('wrong_type', { url: url.href }));
      }
      if (!decoder && Number.isFinite(declared) && declared > maxBytes) {
        req.destroy();
        return fail(new SafeFetchError('too_large', { url: url.href }));
      }
      // The cap counts what arrives and what it unpacks to, so a small compressed bomb can't grow past it.
      let wire = 0;
      let size = 0;
      const chunks = [];
      const body = decoder ? res.pipe(decoder) : res;
      res.on('data', (chunk) => {
        wire += chunk.length;
        if (wire > maxBytes) {
          req.destroy();
          fail(new SafeFetchError('too_large', { url: url.href }));
        }
      });
      body.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          decoder?.destroy();
          return fail(new SafeFetchError('too_large', { url: url.href }));
        }
        chunks.push(chunk);
        return undefined;
      });
      body.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      body.on('error', () => fail(new SafeFetchError(decoder ? 'wrong_type' : 'network', { url: url.href })));
      res.on('aborted', () => fail(new SafeFetchError('network', { url: url.href })));
      return undefined;
    });
    req.on('error', fail);
    req.end();
  });
}

/** One host, one request a second, in this process only. Fine for tests and a single server; createPlatform uses pgHostGate. */
export function memoryHostGate({ gapMs = 1000, now = () => Date.now() } = {}) {
  const next = new Map();
  return {
    /** Resolves with the milliseconds to wait before calling `host`, having reserved that slot; null when that is longer than maxWaitMs. */
    async reserve(host, { maxWaitMs = 2000 } = {}) {
      const at = Math.max(next.get(host) ?? 0, now());
      const wait = at - now();
      if (wait > maxWaitMs) return null;
      next.set(host, at + gapMs);
      if (next.size > 10_000) next.delete(next.keys().next().value);
      return wait;
    },
  };
}

/**
 * The same, shared by every process through Postgres (fetch_hosts, platform only), so the limit holds across businesses,
 * the web process and every worker (8.2, K-26). The reservation is one statement, so two callers can't take one slot.
 */
export function pgHostGate(db, { gapMs = 1000 } = {}) {
  const platform = db.platform ?? db;
  const gap = `${Math.max(0, Math.round(gapMs))} milliseconds`;
  return {
    async reserve(host, { maxWaitMs = 2000 } = {}) {
      const rows = await platform.query(
        `INSERT INTO fetch_hosts AS f (host, next_at) VALUES ($1, clock_timestamp() + $2::interval)
         ON CONFLICT (host) DO UPDATE SET next_at = GREATEST(f.next_at, clock_timestamp()) + $2::interval
           WHERE GREATEST(f.next_at, clock_timestamp()) <= clock_timestamp() + $3::interval
         RETURNING GREATEST(0, (extract(epoch FROM (next_at - $2::interval - clock_timestamp())) * 1000))::int AS wait`,
        [host, gap, `${Math.max(0, Math.round(maxWaitMs))} milliseconds`],
      );
      return rows.length ? rows[0].wait : null;
    },
  };
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new SafeFetchError('timeout'));
  }, { once: true });
  return undefined;
});

/**
 * Builds the fetcher. `lookup(host) -> [{ address, family }]` and `dial(url, pinned) -> { host, port }` are test seams that
 * point it at tools/sim/sites; dial is refused when NODE_ENV=production. `hostGate` spaces out requests to one host.
 */
export function createSafeFetch({ lookup = systemLookup, dial = null, hostGate = memoryHostGate(), maxHostWaitMs = 2000, userAgent = USER_AGENT, env = process.env } = {}) {
  if (dial && String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error('safeFetch: a test transport (dial) is refused when NODE_ENV=production.');
  }

  /** Every hop checked and pinned, within the profile's total time. Resolves { url, status, headers, contentType, body }. */
  async function fetchWith(input, profileName, { signal } = {}) {
    const profile = FETCH_PROFILES[profileName];
    if (!profile || profileName === 'linkCheck') throw new Error(`safeFetch: unknown profile "${profileName}"`);
    let url = assertFetchable(input);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    // Raced as well as aborted, so a transport that ignores the signal still can't take longer than the profile allows (K-07).
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SafeFetchError('timeout', { url: url.href }));
      }, profile.timeoutMs);
    });
    const walk = async () => {
      for (let hop = 0; ; hop++) {
        const host = bareHost(url.hostname).toLowerCase();
        const wait = await hostGate.reserve(host, { maxWaitMs: maxHostWaitMs });
        if (wait === null) throw new SafeFetchError('host_busy', { url: url.href });
        await delay(wait, controller.signal);
        const pinned = await resolvePublic(url, lookup);
        const res = await requestRaw(url, pinned, { signal: controller.signal, maxBytes: profile.maxBytes, accept: profile.accept, types: profile.types, dial, userAgent });
        if (REDIRECTS.has(res.status)) {
          if (!res.headers?.location) throw new SafeFetchError('http_status', { status: res.status, url: url.href });
          if (hop >= profile.maxRedirects) throw new SafeFetchError('too_many_redirects', { url: url.href });
          let next;
          try {
            next = new URL(String(res.headers.location), url);
          } catch {
            throw new BlockedAddressError();
          }
          url = assertFetchable(next.href);
          continue;
        }
        if (res.status < 200 || res.status > 299) throw new SafeFetchError('http_status', { status: res.status, url: url.href });
        return { url: url.href, status: res.status, headers: res.headers, contentType: mediaType(res.headers['content-type']), body: res.body };
      }
    };
    try {
      return await Promise.race([walk(), timedOut]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    profiles: FETCH_PROFILES,
    fetch: fetchWith,
    /** An HTML page as text (8.3, 8.9). */
    async page(url, options) {
      const res = await fetchWith(url, 'page', options);
      return { url: res.url, status: res.status, contentType: res.contentType, html: res.body.toString('utf8') };
    },
    /** JSON, parsed. A body that isn't JSON is wrong_type. `profile: 'feed'` for a store's paged product feed. */
    async json(url, { profile = 'json', ...options } = {}) {
      if (profile !== 'json' && profile !== 'feed') throw new Error(`safeFetch.json: profile must be json or feed, not "${profile}"`);
      const res = await fetchWith(url, profile, options);
      try {
        return { url: res.url, status: res.status, data: JSON.parse(res.body.toString('utf8')) };
      } catch {
        throw new SafeFetchError('wrong_type', { url: res.url });
      }
    },
    /** A stylesheet as text, for the theme read (8.9). */
    async stylesheet(url, options) {
      const res = await fetchWith(url, 'stylesheet', options);
      return { url: res.url, css: res.body.toString('utf8') };
    },
    /** Image bytes, checked against what they claim to be. Store them with platform.images.ingest, never as they came. */
    async image(url, options) {
      const res = await fetchWith(url, 'image', options);
      const sniffed = sniffImageType(res.body);
      if (!sniffed || sniffed !== res.contentType.replace('image/jpg', 'image/jpeg')) throw new SafeFetchError('wrong_type', { url: res.url });
      return { url: res.url, contentType: sniffed, buffer: res.body };
    },
  };
}

/** The image type the bytes really are: jpeg, png, gif or webp, or null. */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buffer.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ---- The Phase 1 reader, kept for the Platform Console's site read (5.5). New code uses createSafeFetch. ----

/** One GET with the body as text, as Phase 1 used it. Rejects with an Error whose message says "page too large" past the cap. */
export async function requestOnce(url, pinned, { signal, maxBytes = MAX_PAGE_BYTES } = {}) {
  try {
    const res = await requestRaw(url, pinned, { signal, maxBytes: maxBytes || 1, accept: 'text/html,application/xhtml+xml', types: null });
    return { status: res.status, headers: res.headers, body: res.body.toString('utf8') };
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === 'too_large') throw new Error('page too large');
    throw err;
  }
}

/**
 * The fetcher for reading a business's own website (PRD 5.5, 8.2), as Phase 1 built it: every hop is checked and pinned, at
 * most 3 redirects. The caller sets the 8 second limit through `signal`. Throws BlockedAddressError for an address that isn't
 * a public website.
 */
export async function safeFetch(input, { signal, lookup = systemLookup, request = requestOnce, maxRedirects = FETCH_PROFILES.page.maxRedirects } = {}) {
  let url = assertFetchable(input);
  for (let hop = 0; ; hop++) {
    const res = await request(url, await resolvePublic(url, lookup), { signal });
    if (!REDIRECTS.has(res.status) || !res.headers?.location) return res;
    if (hop >= maxRedirects) throw new Error('Too many redirects');
    url = assertFetchable(new URL(res.headers.location, url).href);
  }
}
