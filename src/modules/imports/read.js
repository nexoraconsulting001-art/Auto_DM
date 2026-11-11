import { canonicalProductUrl } from '../../contracts/catalog.js';
import { log } from '../../platform/log.js';
import { SafeFetchError } from '../../platform/safe-fetch.js';
import { currentTenant } from '../../tenancy.js';
import { draftFromAdapter } from './adapters.js';
import { readHome, readPage } from './extract.js';
import { availabilityFromJs, fromShopify, productJsUrl, productJsonUrl, shopifyHandle } from './shopify.js';

/**
 * Reads one product address (PRD 8.3), in order: the site's adapter when the business has one (8.4), a Shopify store's
 * /products/<handle>.json, then the page's JSON-LD, its Open Graph tags, and last its <title>. Everything goes through safeFetch
 * (ctx.platform.fetcher); nothing here opens a connection itself.
 *
 * read() answers { ok: true, readFrom, draft, source, sourceRef, finalUrl, mrpKnown, page, home } or { ok: false, reason, status },
 * reason being a code from IMPORT_REASONS. It never throws for what a website did.
 */

const hostOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
/** The address without its query, for a log line: a query string can carry anything. */
const forLog = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return '';
  }
};

const failure = (err) => ({ ok: false, reason: err.code, status: err.status ?? null, gone: err.gone === true, retryable: err.retryable === true });

export function createReader({ fetcher, adapters }) {
  /** A Shopify product by its handle: the .json has the product, the .js says which variants are available. Null when it isn't one. */
  async function shopifyProduct(origin, handle) {
    const { data } = await fetcher.json(productJsonUrl(origin, handle));
    if (!data || typeof data !== 'object' || !data.product) return null;
    let availability = null;
    try {
      availability = availabilityFromJs((await fetcher.json(productJsUrl(origin, handle))).data);
    } catch (err) {
      if (!(err instanceof SafeFetchError)) throw err;
    }
    const draft = fromShopify(data.product, origin, { availability });
    return draft && { draft, sourceRef: `${hostOf(origin)}/${draft.handle}` };
  }

  /** The homepage's title, site names and logos, for the gate (8.7). Read once per site in `cache`; null when it can't be read. */
  async function homeOf(origin, cache) {
    if (cache.has(origin)) return cache.get(origin);
    let home = null;
    try {
      const res = await fetcher.page(`${origin}/`);
      home = readHome(res.html, res.url);
    } catch (err) {
      if (!(err instanceof SafeFetchError)) throw err;
    }
    cache.set(origin, home);
    return home;
  }

  async function viaAdapter(adapter, url) {
    try {
      const draft = draftFromAdapter(await adapter.fetchProduct(url, { fetcher }), url);
      return { ok: true, readFrom: 'adapter', draft, source: `adapter:${adapter.name}`, sourceRef: draft.ref || draft.externalUrl, finalUrl: url, mrpKnown: true, page: null, home: null };
    } catch (err) {
      // 8.4: shown and logged with the business and the address, and never a fall back to reading the page.
      log.warn('imports.adapter_failed', { tenantId: currentTenant()?.id ?? null, adapter: adapter.name, url: forLog(url), code: err?.code ?? 'error', status: err?.status ?? null });
      return { ok: false, reason: 'adapter_error', status: err?.status ?? null, gone: err?.gone === true, retryable: err?.retryable === true };
    }
  }

  return {
    homeOf,

    /**
     * `enabledAdapters` are the names this business may use. `homes` is a Map shared by a run, so each site's homepage is read once.
     * `withHome: false` skips the homepage (a re-check has no gate to feed); `shopify: false` skips asking for Shopify JSON.
     */
    async read(input, { enabledAdapters = [], homes = new Map(), withHome = true, shopify = true } = {}) {
      const url = canonicalProductUrl(input);
      if (!url) return { ok: false, reason: 'blocked', status: null, gone: false, retryable: false };
      const adapter = adapters.find(url, enabledAdapters);
      if (adapter) return viaAdapter(adapter, url);

      const origin = new URL(url).origin;
      const handle = shopify ? shopifyHandle(url) : null;
      if (handle) {
        try {
          const found = await shopifyProduct(origin, handle);
          if (found) return { ok: true, readFrom: 'shopify', draft: found.draft, source: 'link', sourceRef: found.sourceRef, finalUrl: url, mrpKnown: true, page: null, home: null };
        } catch (err) {
          if (!(err instanceof SafeFetchError)) throw err;
          if (err.code === 'blocked') return failure(err);
          // Not a Shopify store, or its JSON is switched off: the page itself is next.
        }
      }

      let res;
      try {
        res = await fetcher.page(url);
      } catch (err) {
        if (!(err instanceof SafeFetchError)) throw err;
        return failure(err);
      }
      const page = readPage(res.html, res.url);
      const finalUrl = canonicalProductUrl(res.url) ?? url;
      const draft = page.draft && { ...page.draft, externalUrl: finalUrl };
      let home = null;
      if (withHome && draft && page.readFrom !== 'title') home = await homeOf(new URL(finalUrl).origin, homes);
      return { ok: true, readFrom: page.readFrom, draft, source: 'link', sourceRef: '', finalUrl, mrpKnown: false, page: { siteNames: page.siteNames, logos: page.logos }, home };
    },

    /**
     * Reads a product that is already in the catalog again (8.8), the way it was first read. Answers like read(), with
     * `skipped: true` when its adapter is no longer one the business may use.
     */
    async reread(product, { enabledAdapters = [] } = {}) {
      const url = product.external_url;
      if (product.source.startsWith('adapter:')) {
        const name = product.source.slice('adapter:'.length);
        const adapter = enabledAdapters.includes(name) ? adapters.get(name) : null;
        if (!adapter) return { ok: false, skipped: true, reason: 'adapter_error', status: null, gone: false, retryable: false };
        return viaAdapter(adapter, url);
      }
      const handle = shopifyHandle(url);
      if (handle && (product.source === 'shopify' || product.source_ref)) {
        try {
          const found = await shopifyProduct(new URL(url).origin, handle);
          if (found) return { ok: true, readFrom: 'shopify', draft: found.draft, mrpKnown: true };
          return { ok: false, reason: 'wrong_type', status: null, gone: false, retryable: false };
        } catch (err) {
          if (!(err instanceof SafeFetchError)) throw err;
          return failure(err);
        }
      }
      // It was read from its page the first time, so the page is asked again, and only the page.
      return this.read(url, { enabledAdapters: [], withHome: false, shopify: false });
    },
  };
}
