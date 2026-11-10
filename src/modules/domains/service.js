import crypto from 'node:crypto';
import net from 'node:net';
import { ApiError, isApiV1Url } from '../../contracts/api/index.js';
import { TlsAskQuery } from '../../contracts/api/provider.js';
import { log, reportError } from '../../platform/log.js';
import { currentTenant, normalizeHost, tenantId, withTenant } from '../../tenancy.js';
import { pageOf } from '../admin-api/paging.js';
import { createDnsChecks } from './dns.js';
import { cleanDomain, dnsRecords, edgeHost, fallbackHost, isApex, isPlatformAddress, isReservedHost, siblingOf, toAsciiHost } from './rules.js';

const MAX_DOMAINS = 20;
const ROUTE_CACHE_SECONDS = 60;
const CHECKS_AT_ONCE = 5;

const routeKey = (host) => `domain-route:${host}`;

/** One token per business, the same every time it is asked for, so a TXT record already in DNS keeps working if the domain is added again. */
const ownershipToken = (secret, tenant) => crypto.createHmac('sha256', String(secret)).update(`domain-ownership:${tenant}`).digest('hex').slice(0, 40);

/** Custom domains: what the API, the scheduled check and the routing in front of the store all share. */
export function createDomainService({ repos, platform, config }) {
  const edge = edgeHost(config);
  const dns = createDnsChecks(config, edge);
  // After the change has been saved, so failing here must not make it look as if the change failed. The entry expires by itself.
  const forget = (hosts) => Promise.all(hosts.map((host) => platform.cache.del(routeKey(host)).catch((err) => reportError(err, { msg: 'domains.forget_failed' }))));

  async function toDomain(row) {
    const addresses = isApex(row.domain) ? await dns.edgeAddresses() : [];
    return {
      id: row.domain,
      domain: row.domain,
      status: row.status,
      isPrimary: row.is_primary,
      records: dnsRecords(row.domain, row.verify_token, edge, addresses),
      verifiedAt: row.verified_at,
      lastCheckedAt: row.last_checked_at,
    };
  }

  /** Seller mail, so it carries the platform's name. An owner with no email on file still has the alert; a transport drops mail with no address. */
  async function emailOwner(domain) {
    if (!config.mailTransport) return;
    try {
      const owner = (await repos.users.listTeam()).find((u) => u.role === 'owner');
      const text = `We could not find the DNS records for your domain ${domain} after 72 hours, so we stopped checking. Add the records at your DNS host, then add the domain again in Bhava.`;
      await config.mailTransport.send({ from: `Bhava <alerts@${config.platformDomain}>`, to: owner?.email ?? '', subject: `Your domain ${domain} could not be verified`, text, html: `<p>${text}</p>` });
    } catch (err) {
      reportError(err, { msg: 'domains.owner_mail_failed', tenant: tenantId() });
    }
  }

  /** The owner and the console hear once, even if two checks reach the same domain together. Alerts come first, so a crash can't lose them. */
  async function stop(row) {
    const dedupeKey = `domain-stopped:${row.domain}:${new Date(row.created_at).getTime()}`;
    const told = await repos.alerts.raise({
      kind: 'domain.stopped', target: row.domain, dedupeKey,
      message: `We could not find the DNS records for ${row.domain} after 72 hours, so we stopped checking. Add the records, then add the domain again.`,
    });
    await repos.alerts.raise({
      kind: 'domain.stopped', target: row.domain, dedupeKey, audience: 'ops',
      message: `DNS checks stopped after 72 hours for ${row.domain} (business ${tenantId()}).`,
    });
    const stopped = await repos.domains.markStopped(row.domain);
    if (told) await emailOwner(row.domain);
    return stopped;
  }

  async function check(domain) {
    const row = await repos.domains.get(domain);
    if (!row) return null;
    if (row.status !== 'pending') return row;
    if (row.expired) return stop(row);
    const updated = await repos.domains.recordCheck(domain, await dns.verified(domain, row.verify_token));
    if (updated?.status === 'verified') await forget([domain]);
    return updated;
  }

  async function redirectFor(host) {
    const cached = await platform.cache.get(routeKey(host));
    if (cached) return cached.to;
    const row = await repos.domains.routeOf(host);
    let to = null;
    if (row && !row.is_primary) {
      if (row.redirect_to && row.redirect_live) to = row.redirect_to;
      else if (row.primary_domain && row.primary_domain === siblingOf(host)) to = row.primary_domain;
    }
    await platform.cache.set(routeKey(host), { to }, ROUTE_CACHE_SECONDS);
    return to;
  }

  /**
   * Caddy's on-demand TLS "ask" (PRD 5.4). Verified custom domains of businesses that aren't closed, and the fallback hosts, which the
   * platform itself controls. Never a reserved host, even if a row claims it.
   */
  async function mayIssueCertificate(raw) {
    const host = normalizeHost(raw);
    if (!host || isReservedHost(host, config)) return false;
    const root = normalizeHost(config.platformDomain);
    if (root && host.endsWith(`.${root}`)) {
      const slug = host.slice(0, -(root.length + 1));
      return !slug.includes('.') && repos.domains.servesFallback(slug);
    }
    return !isPlatformAddress(host, config) && repos.domains.servesCustomDomain(host);
  }

  return {
    async list(query) {
      const shown = pageOf(await repos.domains.list(), query, (row) => [row.domain]);
      return { items: await Promise.all(shown.items.map(toDomain)), nextCursor: shown.nextCursor };
    },

    async add(input, user) {
      if (!(await repos.entitlements.can('custom_domain'))) throw new ApiError('forbidden', 'Custom domains aren’t included in your plan.');
      if (!edge) throw new ApiError('conflict', 'Custom domains aren’t available yet.');
      const domain = cleanDomain(input, config);
      if ((await repos.domains.countOthers(domain)) >= MAX_DOMAINS) throw new ApiError('conflict', `A business can have up to ${MAX_DOMAINS} domains. Remove one first.`);
      const audit = { actor: `user:${user.id}`, action: 'domain.add', target: domain };
      if (!(await repos.domains.claim(domain, ownershipToken(config.sessionSecret, tenantId()), audit))) {
        throw new ApiError('conflict', (await repos.domains.heldByAnother(domain)) ? 'This domain is already connected to another business.' : 'You’ve already verified this domain.');
      }
      await forget([domain]);
      return toDomain(await repos.domains.get(domain));
    },

    async check(domain) {
      const row = await check(domain);
      return row ? toDomain(row) : null;
    },

    async setPrimary(input, user) {
      const fallback = fallbackHost(currentTenant(), config);
      const domain = toAsciiHost(input);
      if (!domain) throw new ApiError('not_found', 'Add this domain first.');
      const toFallback = domain === fallback;
      const audit = (from) => ({ actor: `user:${user.id}`, action: 'domain.primary', target: domain, details: { from, to: domain } });
      const { result, hosts } = await repos.domains.setPrimary(toFallback ? '' : domain, domain, audit);
      if (result === 'not_found') throw new ApiError('not_found', 'Add this domain first.');
      if (result === 'not_verified') throw new ApiError('conflict', 'Verify this domain before making it the primary.');
      await forget(hosts);
      if (toFallback) return { id: fallback, domain: fallback, status: 'verified', isPrimary: true, records: [], verifiedAt: null, lastCheckedAt: null };
      return toDomain(await repos.domains.get(domain));
    },

    async remove(domain, user) {
      const { result } = await repos.domains.remove(domain, { actor: `user:${user.id}`, action: 'domain.remove', target: domain });
      if (result === 'not_found') throw new ApiError('not_found');
      if (result === 'primary') throw new ApiError('conflict', 'This is your primary domain. Choose another primary first.');
      await forget([domain]);
    },

    /** The scheduled check: every pending domain, each inside its own business, one failure never stopping the rest. */
    async checkDue() {
      const due = await repos.domains.dueForCheck();
      let next = 0;
      async function lane() {
        while (next < due.length) {
          const { domain, ...tenant } = due[next++];
          try {
            await withTenant(tenant, () => check(domain));
          } catch (err) {
            reportError(err, { msg: 'domains.check_failed', tenant: tenant.id });
          }
        }
      }
      await Promise.all(Array.from({ length: CHECKS_AT_ONCE }, lane));
      if (due.length) log.info('domains.checked', { count: due.length });
    },

    /** 200 allows a certificate; anything else refuses it. */
    async tlsAsk(req, res) {
      const query = TlsAskQuery.safeParse(req.query);
      if (!query.success) return res.sendStatus(400);
      return res.sendStatus((await mayIssueCertificate(query.data.domain)) ? 200 : 403);
    },

    /** A replaced primary, or the non-primary of www and the apex, answers 301 to the same path on the primary (PRD 5.4). Pages only: an API call keeps working. */
    async redirect(req, res, next) {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiV1Url(req.originalUrl)) return next();
      const host = normalizeHost(req.hostname);
      if (!host || net.isIP(host) || isPlatformAddress(host, config)) return next();
      let to = null;
      try {
        to = await redirectFor(host);
      } catch (err) {
        reportError(err, { msg: 'domains.redirect_lookup_failed' }); // a page that can't be redirected can still be served
      }
      if (!to) return next();
      res.set('Cache-Control', 'public, max-age=3600'); // a primary can change back, so browsers mustn't keep this forever
      return res.redirect(301, `https://${to}${req.originalUrl.startsWith('/') ? req.originalUrl : '/'}`);
    },
  };
}
