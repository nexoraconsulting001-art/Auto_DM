import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { reportError } from '../../platform/log.js';
import { domainsRepo } from './repo.js';
import { createDomainService } from './service.js';

const CHECK_EVERY_MS = 5 * 60_000;

/** PRD 5.2, 5.4: custom domains, the DNS check, the TLS "ask" answer for Caddy, and primary-domain redirects. */
export const domains = {
  name: 'domains',
  repos: (db) => ({ domains: domainsRepo(db) }),

  beforeTenant(app, ctx) {
    const service = createDomainService(ctx);
    app.get(PROVIDER_PATHS.tlsAsk, (req, res) => service.tlsAsk(req, res));
    app.use((req, res, next) => service.redirect(req, res, next));
  },

  // The console host ends every request itself, so Caddy reaching the app by that name needs the answer there too.
  platformRoutes(router, ctx) {
    const service = createDomainService(ctx);
    router.get(PROVIDER_PATHS.tlsAsk, (req, res) => service.tlsAsk(req, res));
  },

  api(ctx) {
    const service = createDomainService(ctx);
    return {
      'domains.list': ({ query }) => service.list(query),
      'domains.add': ({ body, user }) => service.add(body.domain, user),
      'domains.check': ({ params }) => service.check(params.id),
      'domains.setPrimary': ({ body, user }) => service.setPrimary(body.domain, user),
      'domains.remove': ({ params, user }) => service.remove(params.id, user),
    };
  },

  // Safe on every worker at once: a domain checked in the last few minutes isn't due, and the owner is told once.
  jobs(ctx) {
    const service = createDomainService(ctx);
    let nextCheck = 0;
    return async function schedule() {
      if (Date.now() < nextCheck) return;
      nextCheck = Date.now() + CHECK_EVERY_MS;
      await service.checkDue().catch((err) => reportError(err, { msg: 'domains.check_due_failed' }));
    };
  },
};
