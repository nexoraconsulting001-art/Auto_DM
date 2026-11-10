import { createContext, useCallback, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_KEY, api } from './api/index.js';

const SessionContext = createContext(null);

async function currentSession() {
  try {
    return await api.auth.me();
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

/** Who is signed in. `session` is { user, business } or null; `status` is loading, error or ready. */
export function SessionProvider({ children }) {
  const queries = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery({ queryKey: SESSION_KEY, queryFn: currentSession, staleTime: 5 * 60_000 });

  const signIn = useCallback(async ({ phone, password }) => {
    queries.setQueryData(SESSION_KEY, await api.auth.login({ phone, password, transport: 'cookie' }));
  }, [queries]);

  const signOut = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    queries.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] }); // nothing of this business stays in memory
    queries.setQueryData(SESSION_KEY, null);
  }, [queries]);

  const value = useMemo(() => ({
    status: isPending ? 'loading' : isError && data === undefined ? 'error' : 'ready',
    session: data ?? null,
    retry: refetch,
    signIn,
    signOut,
  }), [data, isPending, isError, refetch, signIn, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
