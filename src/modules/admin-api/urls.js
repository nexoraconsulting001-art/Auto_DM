import { currentTenant } from '../../tenancy.js';

/** Public address of the current business. PUBLIC_BASE_URL applies to the default business only. */
export const baseUrlFor = (req, config) => {
  const t = currentTenant();
  if (config.publicBaseUrl && (!t?.slug || !config.defaultTenant || t.slug === config.defaultTenant)) return config.publicBaseUrl;
  return `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
};

/** Public address of a business when there is no request from its own site (e.g. in a webhook). */
export const tenantBaseUrl = (tenant, config) => {
  if (tenant.slug === config.defaultTenant && config.publicBaseUrl) return config.publicBaseUrl;
  return config.platformDomain ? `https://${tenant.slug}.${config.platformDomain}` : config.publicBaseUrl;
};

/** Where buyers are sent: the verified primary domain when there is one. A seller's own pages stay on tenantBaseUrl. */
export const buyerBaseUrl = (tenant, config) => (tenant?.primary_domain ? `https://${tenant.primary_domain}` : tenantBaseUrl(tenant, config));

/**
 * The address DM links are built on, chosen the way the webhook chooses it. A bearer token can arrive on
 * any web address, so the request's own address is only the last resort.
 */
export const storeBaseUrl = (req, config) => buyerBaseUrl(currentTenant(), config) || baseUrlFor(req, config);

/** The direct link a DM sends for a reel. */
export const reelStoreUrl = (base, slug) => `${base}/r/${encodeURIComponent(slug)}?src=dm`;
