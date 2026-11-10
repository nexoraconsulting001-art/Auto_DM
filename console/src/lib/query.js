import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { isAllowed } from '@contracts/access.js';
import { SESSION_KEY, allPages } from './api/index.js';
import { useSession } from './session.jsx';

/** One list from the API, page by page. `key` names the kind of thing, so saving one refreshes every list of it. */
export function usePagedList(key, list, filters = {}, options = {}) {
  const query = useInfiniteQuery({
    queryKey: [key, 'list', filters],
    queryFn: ({ pageParam }) => list({ ...filters, cursor: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData, // the old rows stay up while a new filter loads
    ...options,
  });
  return Object.assign(query, { items: query.data?.pages.flatMap((page) => page.items) ?? [] });
}

/** Every row of a list, for pickers that need the whole catalog at once. */
export async function fetchAll(list, query = {}) {
  const items = [];
  for await (const item of allPages(list, { limit: 100, ...query })) items.push(item);
  return items;
}

/**
 * After a change: refetch whatever is on screen, because the dashboard and the checklist read the same data.
 * After a delete pass { leaving: true }: nothing refetches now, so the page that's closing doesn't ask for the thing
 * it just deleted, and the next page loads fresh.
 */
export function useRefresh() {
  const queries = useQueryClient();
  return useCallback(({ leaving = false } = {}) => queries.invalidateQueries({
    predicate: (query) => query.queryKey[0] !== SESSION_KEY[0],
    refetchType: leaving ? 'none' : 'active',
  }), [queries]);
}

/** The same check the server makes, so nobody is offered something the API would refuse. */
export function useAllowed() {
  const { session } = useSession();
  return useCallback((access) => isAllowed(session.user, access), [session]);
}

/** A list's filters live in the address, so the back button and a shared link both keep them. */
export function useFilters() {
  const [params, setParams] = useSearchParams();
  const setFilter = useCallback((name, value) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: true });
  }, [setParams]);
  return [params, setFilter];
}

/** A search box: updates as you type and tells the list once you pause. */
export function useSearchBox(committed, commit, delay = 300) {
  const [text, setText] = useState(committed);
  useEffect(() => setText(committed), [committed]);
  useEffect(() => {
    if (text === committed) return undefined;
    const timer = setTimeout(() => commit(text), delay);
    return () => clearTimeout(timer);
  }, [text, committed, commit, delay]);
  return [text, setText];
}
