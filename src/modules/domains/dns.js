import { Resolver } from 'node:dns/promises';
import { normalizeHost } from '../../tenancy.js';
import { verificationName } from './rules.js';

const EDGE_TTL_MS = 5 * 60_000;

/**
 * Looks at public DNS for a domain's proof and routing. `config.dnsResolver` replaces the real resolver in tests.
 * A failed lookup is the same as a record not being there yet: the check simply stays pending.
 */
export function createDnsChecks(config, edge) {
  const resolver = config.dnsResolver ?? new Resolver({ timeout: 3000, tries: 2 });
  const ask = async (method, name) => {
    if (typeof resolver[method] !== 'function') return [];
    try {
      return await resolver[method](name);
    } catch {
      return [];
    }
  };

  let known = { until: 0, addresses: [] };
  async function edgeAddresses() {
    if (Date.now() < known.until) return known.addresses;
    const addresses = [...await ask('resolve4', edge), ...await ask('resolve6', edge)];
    if (addresses.length) known = { until: Date.now() + EDGE_TTL_MS, addresses }; // a lookup that failed isn't remembered
    return addresses;
  }

  async function ownershipProved(domain, token) {
    if (!token) return false;
    const records = await ask('resolveTxt', verificationName(domain));
    return records.some((chunks) => [].concat(chunks).join('').trim() === token);
  }

  async function routesToEdge(domain) {
    const aliases = await ask('resolveCname', domain);
    if (aliases.some((alias) => normalizeHost(alias) === edge)) return true;
    const ours = new Set(await edgeAddresses());
    if (!ours.size) return false;
    const addresses = [...await ask('resolve4', domain), ...await ask('resolve6', domain)];
    return addresses.some((ip) => ours.has(ip));
  }

  return {
    edgeAddresses,
    /** Both halves of PRD 5.4: the TXT proves it is theirs, and the routing record means links to it will work. */
    verified: async (domain, token) => (await ownershipProved(domain, token)) && routesToEdge(domain),
  };
}
