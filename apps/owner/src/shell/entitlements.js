/**
 * What this business's plan has, for the menu and for screens that offer only what the plan allows (a plan can hide a
 * feature: canOpen in @bhava/app-core/access). Read from billing.features, the same answer, under the same key, as the
 * Plan and billing screen's list. Until it is known (loading, offline, refused) the answer is null: every screen shows
 * and the server decides, as it does anyway.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { entitlementsOf } from '@bhava/app-core/access';
import { useServices, useSession } from './hooks.js';

export const PLAN_FEATURES_KEY = Object.freeze(['billing', 'features']);

export function usePlanEntitlements() {
  const { session } = useServices();
  const { status, tenantId } = useSession() ?? {};
  const query = useQuery({
    queryKey: PLAN_FEATURES_KEY,
    queryFn: () => session.api.billing.features(),
    enabled: Boolean(session) && status === 'signedIn' && Boolean(tenantId),
    staleTime: 60_000,
    retry: false,
  });
  return useMemo(() => entitlementsOf(query.data), [query.data]);
}
