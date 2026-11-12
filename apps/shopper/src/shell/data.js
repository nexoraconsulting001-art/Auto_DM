/**
 * How the browsing screens read the store: one set of query helpers over @bhava/store-client's `createBrowse`. Answers
 * are kept by react-query (and on the device, see offline.js), so a screen opened before shows with no connection.
 * Browsing sends no token and asks for nothing: no sign-in, no notification permission.
 */
import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createBrowse } from '@bhava/store-client';
import { useServices } from '../services.js';
import { reportUpdateRequired } from './gate.js';

export function useBrowse() {
  const { client } = useServices();
  return useMemo(() => createBrowse(client), [client]);
}

function watch(error) {
  useEffect(() => {
    if (error?.code === 'update_required') reportUpdateRequired(error);
  }, [error]);
}

/** `key` is an array naming the question; `read(browse)` asks it. */
export function useBrowseQuery(key, read, options = {}) {
  const browse = useBrowse();
  const query = useQuery({ queryKey: ['browse', ...key], queryFn: () => read(browse), ...options });
  watch(query.error);
  return query;
}

/** A list that loads page by page: `read(browse, cursor)` answers a page with `nextCursor`, wherever it sits in the answer. */
export function useBrowsePages(key, read, { nextOf = (page) => page.nextCursor, ...options } = {}) {
  const browse = useBrowse();
  const query = useInfiniteQuery({
    queryKey: ['browse', ...key],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => read(browse, pageParam),
    getNextPageParam: (last) => nextOf(last) ?? undefined,
    ...options,
  });
  watch(query.error);
  return query;
}

export const useBootstrap = () => useBrowseQuery(['bootstrap'], (browse) => browse.bootstrap(), { staleTime: 5 * 60_000 });
