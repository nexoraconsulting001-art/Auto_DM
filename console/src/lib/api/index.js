import { createApiClient } from '@bhava/api-client';
import { QueryClient } from '@tanstack/react-query';

export { ApiError, allPages } from '@bhava/api-client';

export const SESSION_KEY = ['session'];

const worthRetrying = (error) => error?.status === 0 || (error?.status >= 500 && error?.status !== 501);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (failures, error) => failures < 2 && worthRetrying(error), refetchOnWindowFocus: false },
  },
});

/** The one client the console uses. A session that ends mid-use sends the person back to sign-in. */
export const api = createApiClient({ onUnauthorized: () => queryClient.setQueryData(SESSION_KEY, null) });
