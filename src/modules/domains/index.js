import { notBuilt } from '../not-built.js';

/** PRD 5.2, 5.4: custom domains, the DNS check, the TLS "ask" answer for Caddy, and primary-domain redirects. */
export const domains = {
  name: 'domains',
  api: () => notBuilt('domains.list', 'domains.add', 'domains.check', 'domains.setPrimary', 'domains.remove'),
};
