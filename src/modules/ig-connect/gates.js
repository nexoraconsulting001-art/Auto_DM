import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { log } from '../../platform/log.js';

export const PRIVACY_PATH = '/privacy';
/** Sent to the deletion callback as a health check. It is not a valid signed_request, so it is refused without touching anything. */
export const HEALTH_PROBE = 'health.check';

const PROBE_TIMEOUT_MS = 10_000;
const CACHE_KEY = 'ig-connect:public-urls-ok';
const CACHE_SECONDS = 3600;
/** How long a failure is remembered, so a page that reads the gates can't wait on a dead address every time. */
const CACHE_FAILURE_SECONDS = 60;

/**
 * Meta's release gates (PRD 4.15). evaluate() is the only thing that sets compliance_settings.gate_passed_at: run after anything that can
 * change a gate, and hourly. The two health checks fetch what Meta would fetch, over the public address registered with Meta.
 */
export function createGates({ repos, config, cache, fetchImpl = globalThis.fetch }) {
  const publicBase = () => config.metaCallbackBaseUrl || config.publicBaseUrl || '';

  async function probe(url, init, accept) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...init });
      return await accept(res);
    } catch (err) {
      log.warn('ig_connect.health_check_failed', { path: new URL(url).pathname, name: err.name });
      return false;
    }
  }

  async function publicUrlsOk() {
    const hit = await cache.get(CACHE_KEY);
    if (hit) return hit;
    const base = publicBase();
    if (!base) return { privacy: false, deletion: false };
    const [privacy, deletion] = await Promise.all([
      probe(`${base}${PRIVACY_PATH}`, {}, async (res) => res.status === 200 && /delet/i.test(await res.text())),
      probe(`${base}${PROVIDER_PATHS.deletion}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ signed_request: HEALTH_PROBE }),
      }, (res) => res.status === 400),
    ]);
    const result = { privacy, deletion };
    await cache.set(CACHE_KEY, result, privacy && deletion ? CACHE_SECONDS : CACHE_FAILURE_SECONDS);
    return result;
  }

  return {
    /** The current business's gates, as of now. { passed, gates: [{ code, passed }] } */
    async evaluate() {
      const [account, health] = await Promise.all([repos.igAccounts.primary(), publicUrlsOk()]);
      return repos.igConnect.recordGates({ account, health });
    },
  };
}
