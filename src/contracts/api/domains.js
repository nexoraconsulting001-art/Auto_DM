import { z } from 'zod';
import { OWNER_ONLY, staffWith } from './access.js';
import { ListQuery, Timestamp, page, required } from './common.js';

/** A domain is its own id, as in tenant_domains. */
export const DomainParams = z.object({ id: z.string().regex(/^[a-z0-9.-]{1,253}$/) });

export const DOMAIN_STATUSES = Object.freeze(['pending', 'verified', 'failed', 'stopped']);

/** The records the owner adds. Nothing in them names the platform (PRD 5.4). */
export const DnsRecord = z.object({ type: z.enum(['TXT', 'CNAME', 'A', 'AAAA']), name: z.string(), value: z.string() });

export const Domain = z.object({
  id: z.string(),
  domain: z.string(),
  status: z.enum(DOMAIN_STATUSES),
  isPrimary: z.boolean(),
  records: z.array(DnsRecord),
  verifiedAt: Timestamp.nullable(),
  lastCheckedAt: Timestamp.nullable(),
});
export const DomainName = z.object({ domain: required(253, 'Enter a domain') });

export const domainRoutes = {
  'domains.list': { method: 'GET', path: '/domains', access: staffWith('catalog'), query: ListQuery, response: page(Domain) },
  'domains.add': { feature: 'custom_domain', method: 'POST', path: '/domains', access: OWNER_ONLY, body: DomainName, status: 201, response: Domain },
  'domains.setPrimary': { method: 'PUT', path: '/domains/primary', access: OWNER_ONLY, body: DomainName, response: Domain },
  'domains.check': { method: 'POST', path: '/domains/:id/check', access: OWNER_ONLY, params: DomainParams, response: Domain },
  'domains.remove': { method: 'DELETE', path: '/domains/:id', access: OWNER_ONLY, params: DomainParams, status: 204, response: null },
};
