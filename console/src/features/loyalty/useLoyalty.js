import { useQuery } from '@tanstack/react-query';
import { staffWith } from '@contracts/access.js';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { loyaltyFromFeatures } from './entitled.js';

/** Plans whose price includes loyalty, and the plan it is an add-on for (9.21, migration 416). */
export const LOYALTY_PLANS = Object.freeze(['t4', 't5']);
export const LOYALTY_ADD_ON_PLAN = 't3';

/**
 * Is the loyalty add-on on for this business (9.21)? Tiers 4 and 5 have it; on tier 3 it is an add-on, so only there is billing.features
 * read (once a minute at most, never retried). It is read, not probed with loyalty.members: that refusal would raise the console-wide
 * "not on your plan" bar on every page. On any other plan nothing is asked: the tab that leads to the loyalty screens is simply not shown (S-91).
 */
export function useLoyaltyOn() {
  const allowed = useAllowed();
  const { session } = useSession();
  const plan = session?.business?.plan;
  const probe = useQuery({
    queryKey: ['loyalty', 'features'],
    queryFn: () => api.billing.features(),
    enabled: plan === LOYALTY_ADD_ON_PLAN && allowed(staffWith('customers')),
    retry: false,
    staleTime: 60_000,
  });
  return LOYALTY_PLANS.includes(plan) || (probe.isSuccess && loyaltyFromFeatures(probe.data));
}
