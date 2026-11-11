import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The business (tenant) a piece of work belongs to. Web requests get it from the domain; webhooks
 * and jobs set it explicitly with withTenant(). Every business repo reads it on each query and
 * refuses to run without one, so no code path can read or write across businesses by forgetting a filter.
 */
const context = new AsyncLocalStorage();

export class NoTenantError extends Error {
  constructor() {
    super('tenant context missing: business data can only be used inside withTenant()');
  }
}

/** Runs fn with `tenant` ({ id, slug, name, ... } or just an id) as the current business. */
export function withTenant(tenant, fn) {
  const t = typeof tenant === 'object' ? tenant : { id: Number(tenant) };
  if (!Number.isInteger(t.id) || t.id <= 0) throw new Error(`Invalid business id: ${tenant}`);
  return context.run({ tenant: t }, fn);
}

/** The current business id. Throws when there is none. */
export function tenantId() {
  const id = context.getStore()?.tenant?.id;
  if (!id) throw new NoTenantError();
  return id;
}

/** The current business, or null outside withTenant(). */
export const currentTenant = () => context.getStore()?.tenant ?? null;

export const normalizeHost = (host) =>
  String(host || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');

/**
 * Finds the business for a hostname, in this order:
 *   1. an exact match in tenant_domains (custom domains, extra hostnames)
 *   2. <slug>.<platformDomain>
 *   3. the default business, when DEFAULT_TENANT is set (single-store setups, local runs, tests)
 * Results are cached for `ttlMs`.
 */
export function createTenantResolver({ tenants, platformDomain = '', defaultTenant = '', ttlMs = 60_000 }) {
  const cache = new Map();
  const platform = normalizeHost(platformDomain);

  // `own` is false when the address only falls back to the default business.
  async function lookup(host) {
    const byDomain = await tenants.getByDomain(host);
    if (byDomain) return { tenant: byDomain, own: true };
    if (platform && host.endsWith(`.${platform}`)) {
      const slug = host.slice(0, -(platform.length + 1));
      if (!slug.includes('.')) {
        const bySlug = await tenants.getBySlug(slug);
        if (bySlug) return { tenant: bySlug, own: true };
      }
    }
    return { tenant: defaultTenant ? await tenants.getBySlug(defaultTenant) : null, own: false };
  }

  async function find(rawHost) {
    const host = normalizeHost(rawHost);
    const hit = cache.get(host);
    if (hit && hit.exp > Date.now()) return hit;
    const found = { ...(await lookup(host)), exp: Date.now() + ttlMs };
    cache.set(host, found);
    return found;
  }

  return {
    resolve: async (rawHost) => (await find(rawHost)).tenant,
    /** The business this address belongs to (its custom domain or <slug>.<platformDomain>), or null: a fallback to the default business is not ownership. */
    async owner(rawHost) {
      const found = await find(rawHost);
      return found.own ? found.tenant : null;
    },
    clear: () => cache.clear(),
  };
}
