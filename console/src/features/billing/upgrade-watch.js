import { isPlanProblem } from './contract.js';

/**
 * Wherever the server answers `plan.feature_off` or `plan.limit_reached`, the console shows one upgrade prompt. The server
 * has already refused: this only explains. It watches the console's own calls (every /api/v1 answer), so no screen has to
 * remember to ask.
 */
export const REFUSAL_EVENT = 'bhava:plan-refusal';
let installed = false;

export function installUpgradeWatch(target = globalThis) {
  if (installed || typeof target.fetch !== 'function' || typeof target.dispatchEvent !== 'function') return false;
  installed = true;
  const original = target.fetch.bind(target);
  target.fetch = async (...args) => {
    const response = await original(...args);
    try {
      if (response.status === 403 && String(response.url).includes('/api/v1/')) {
        const body = await response.clone().json();
        const error = { status: 403, code: body?.code, plan: body?.plan, feature: body?.feature, limit: body?.limit, used: body?.used, message: body?.error };
        if (isPlanProblem(error)) target.dispatchEvent(new CustomEvent(REFUSAL_EVENT, { detail: error }));
      }
    } catch {
      // An answer that is not JSON is not a plan refusal.
    }
    return response;
  };
  return true;
}
