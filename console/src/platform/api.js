import { PLATFORM_ROUTES, createPlatformClient } from '@bhava/api-client/platform';
import { QueryClient } from '@tanstack/react-query';

export { PlatformError, allPlatformPages } from '@bhava/api-client/platform';

export const SESSION_KEY = ['platform-session'];

const worthRetrying = (error) => error?.status === 0 || (error?.status >= 500 && error?.status !== 501);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (failures, error) => failures < 2 && worthRetrying(error), refetchOnWindowFocus: false },
  },
});

/**
 * The one client the Platform Console uses, built from the route table (PLATFORM_ROUTES, plain data: no schema reaches the page): api.businesses({ query }), api.pauseBusiness({ params, body }).
 * A session that ends mid-use sends the person back to sign-in.
 */
export const api = createPlatformClient({ onUnauthorized: () => queryClient.setQueryData(SESSION_KEY, null) });

/** True when a platform route is one this role may call: hides what the server would refuse anyway. */
export const mayCall = (user, routeId) => Boolean(user) && Boolean(PLATFORM_ROUTES[routeId]?.platformRoles?.includes(user.role));
