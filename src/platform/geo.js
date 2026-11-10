/**
 * City and state from an IP address, read once at ingest and never stored with the IP (PRD 7.10). No provider is chosen yet, so with no table every
 * lookup comes back empty and those two dimensions stay blank. config.geoTable maps an IP to { city, state }, for tests and local runs.
 *
 *   lookup(ip) -> { city, state }
 */
export function createGeo(config = {}) {
  const table = config.geoTable ?? {};
  const EMPTY = Object.freeze({ city: '', state: '' });
  return {
    lookup(ip) {
      return Object.hasOwn(table, String(ip)) ? table[String(ip)] : EMPTY;
    },
  };
}
