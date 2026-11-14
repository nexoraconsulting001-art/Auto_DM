import { api } from './api.js';

/** The server answers 404 or 501 for a route it does not have yet. */
export const isMissing = (error) => error?.status === 404 || error?.status === 501;

/**
 * Every business, a page at a time. platform.businesses is the list; a server that has not got it yet is answered from the
 * onboarding list, which holds a row for each business, so the console stays usable.
 */
export async function listBusinesses({ query } = {}) {
  try {
    return await api.businesses({ query });
  } catch (error) {
    if (!isMissing(error)) throw error;
    // The health list has a row for every business; the onboarding team may not read it, and has the onboarding list.
    const health = await api.health({ query }).catch((failure) => (failure?.status === 403 ? null : Promise.reject(failure)));
    if (health) {
      return { items: health.items.map((item) => ({ id: item.tenantId, slug: '', name: item.tenantName, status: 'active', plan: '', createdAt: null })), nextCursor: health.nextCursor };
    }
    const page = await api.onboardingList({ query });
    return {
      items: page.items.map((item) => ({ id: item.tenantId, slug: '', name: item.tenantName, status: item.done ? 'active' : 'onboarding', plan: item.plan, createdAt: null })),
      nextCursor: page.nextCursor,
    };
  }
}

/** One business. Without platform.business, what the onboarding workspace and the pause list know, marked `partial`. */
export async function loadBusiness(id) {
  try {
    return await api.business({ params: { id } });
  } catch (error) {
    if (!isMissing(error)) throw error;
    const workspace = await api.onboarding({ params: { id } });
    const pauses = await api.pauses({ query: { tenantId: id, scope: 'business', engaged: 'true' } }).catch(() => ({ items: [] }));
    return {
      id: workspace.tenantId, slug: '', name: workspace.tenantName, status: workspace.done ? 'active' : 'onboarding', plan: workspace.plan, createdAt: null,
      website: '', legalName: '', paused: pauses.items.length > 0, pausedBy: pauses.items[0]?.actor ?? null, accessLevel: 'standard', reconnectNeeded: false, breaker: 'closed', score: null, partial: true,
    };
  }
}
