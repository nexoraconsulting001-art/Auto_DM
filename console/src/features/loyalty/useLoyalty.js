import { useQuery } from '@tanstack/react-query';
import { staffWith } from '@contracts/access.js';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';

/** Plans whose price includes loyalty, and the plan it is an add-on for (9.21, migration 416). */
export const LOYALTY_PLANS = Object.freeze(['t4', 't5']);
export const LOYALTY_ADD_ON_PLAN = 't3';

/**
 * Is the loyalty add-on on for this business (9.21)? Tiers 4 and 5 have it; on tier 3 it is an add-on, and the API answers 403
 * without it, so only there is it asked, once a minute at most, never retried. On any other plan nothing is asked: the tab
 * that leads to the loyalty screens is simply not shown (S-91), and no page logs a refused request.
 */
export function useLoyaltyOn() {
  const allowed = useAllowed();
  const { session } = useSession();
  const plan = session?.business?.plan;
  const probe = useQuery({
    queryKey: ['loyalty', 'probe'],
    queryFn: () => api.loyalty.members({ limit: 1 }),
    enabled: plan === LOYALTY_ADD_ON_PLAN && allowed(staffWith('customers')),
    retry: false,
    staleTime: 60_000,
  });
  return LOYALTY_PLANS.includes(plan) || probe.isSuccess;
}
