import { createContext, useCallback, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_KEY, api } from './api.js';

const SessionContext = createContext(null);

async function currentSession() {
  try {
    return await api.me();
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

/** Who of Bhava's team is signed in. `session` is { user: { id, email, name, role } } or null. */
export function PlatformSessionProvider({ children }) {
  const queries = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery({ queryKey: SESSION_KEY, queryFn: currentSession, staleTime: 5 * 60_000 });

  const signedIn = useCallback((session) => queries.setQueryData(SESSION_KEY, session), [queries]);
  const signOut = useCallback(async () => {
    await api.signOut().catch(() => {});
    queries.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] }); // nothing of any business stays in memory
    queries.setQueryData(SESSION_KEY, null);
  }, [queries]);

  const value = useMemo(() => ({
    status: isPending ? 'loading' : isError && data === undefined ? 'error' : 'ready',
    session: data ?? null,
    retry: refetch,
    signedIn,
    signOut,
  }), [data, isPending, isError, refetch, signedIn, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const usePlatformSession = () => useContext(SessionContext);
