/**
 * Which business this tab works in, and whether its session is still alive (PRD 10.2, 10.3; P-08, P-09, P-10, F-47).
 * Plain JavaScript with its dependencies passed in, so node's test runner can drive it.
 *
 * The switcher. One person can work at several businesses with one sign-in. The API serves another of them when a
 * request carries X-Tenant-Id, and checks the membership on every call. The console's API client is shared by every
 * screen and takes no business of its own, so this wraps the page's fetch: every same-site /api/v1 call from this tab
 * carries the business chosen here. The choice is per tab (sessionStorage) and is forgotten at sign-out. Switching
 * cancels and drops every cached answer before the session is read again in the new business, so no row of the old
 * one can be shown under the new one's name.
 *
 * The watch. Removing someone from the team or signing a device out ends its sessions on the server at once; this
 * notices without a reload. While a session is open and the tab is visible it asks who is signed in every `pollMs`
 * (and when the tab comes back into view or online). A 401 there clears the session, so the sign-in page shows,
 * and the sign-in page says why: ended elsewhere, or deleted from here.
 */
export const WORKSPACE_KEY = 'bhava.workspace';
export const POLL_MS = 15_000;
const API_PREFIX = '/api/v1/';
const BUSINESS_ID = /^[1-9]\d{0,9}$/;

export function createWorkspace({ target = globalThis, storage = null, queries, sessionKey = ['session'], pollMs = POLL_MS, now = () => Date.now() }) {
  const doc = target.document ?? null;
  let chosen = read();
  let signingOut = false;
  let ended = '';
  let timer = null;
  let lastCheck = 0;

  function read() {
    try {
      const value = storage?.getItem(WORKSPACE_KEY) ?? '';
      return BUSINESS_ID.test(value) ? value : '';
    } catch {
      return '';
    }
  }

  function remember(value) {
    chosen = value;
    try {
      if (value) storage?.setItem(WORKSPACE_KEY, value);
      else storage?.removeItem(WORKSPACE_KEY);
    } catch {
      // kept in memory for this page
    }
  }

  /** The path under /api/v1 of a same-site call ('/auth/me'), or null for anything else. */
  function apiPath(input) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    if (raw === null) return null;
    let url;
    try {
      url = new URL(raw, target.location?.href ?? 'http://localhost/');
    } catch {
      return null;
    }
    if (target.location?.origin && url.origin !== target.location.origin) return null;
    return url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length - 1) : null;
  }

  const hasSession = () => Boolean(queries.getQueryData(sessionKey));

  const original = target.fetch.bind(target);
  async function fetchInWorkspace(input, init = {}) {
    const path = apiPath(input);
    if (path === null) return original(input, init);
    const method = String(init.method ?? 'GET').toUpperCase();
    if (path === '/auth/logout' && method === 'POST') {
      signingOut = true;
      remember('');
    }
    if (!chosen) return original(input, init);
    const sent = chosen;
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('x-tenant-id')) headers.set('x-tenant-id', sent);
    const response = await original(input, { ...init, headers });
    if (response.status !== 403 || chosen !== sent) return response;
    const body = await response.clone().json().catch(() => null);
    if (body?.code !== 'forbidden') return response;
    if (path === '/auth/me') {
      // No longer at that business (removed, or it closed): back to the business this session belongs to.
      remember('');
      queries.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      return original(input, init);
    }
    // Any other refusal may be the same thing: look again now rather than at the next poll.
    lastCheck = 0;
    Promise.resolve().then(check);
    return response;
  }
  target.fetch = fetchInWorkspace;

  // From signed in to signed out without this tab asking to sign out: the session ended somewhere else.
  let had = hasSession();
  const unsubscribe = queries.getQueryCache().subscribe((event) => {
    if (event?.query?.queryKey?.[0] !== sessionKey[0]) return;
    const has = Boolean(event.query.state.data);
    if (had && !has) {
      if (!signingOut && !ended) ended = 'elsewhere';
      remember('');
    }
    if (!had && has) {
      signingOut = false;
      ended = '';
    }
    had = has;
  });

  async function check() {
    if (!hasSession() || doc?.visibilityState === 'hidden') return;
    if (now() - lastCheck < 3000) return;
    lastCheck = now();
    await queries.refetchQueries({ queryKey: sessionKey, exact: true }).catch(() => {});
  }

  const onVisible = () => {
    if (doc?.visibilityState !== 'hidden') check();
  };

  return {
    /** The business chosen in this tab, as an id string, or '' for the session's own. */
    current: () => chosen,

    /**
     * Works in business `id` from now on: drops every cached answer, then reads the session there through `me`
     * (auth.me). Answers that session; if the person is no longer at that business, it is the session's own one.
     */
    async choose(id, me) {
      if (!BUSINESS_ID.test(String(id))) throw new Error('Not a business');
      await queries.cancelQueries();
      remember(String(id));
      queries.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      const session = await me();
      queries.setQueryData(sessionKey, session);
      return session;
    },

    /** Back to the session's own business, with nothing cached (a new sign-in). */
    forget() {
      remember('');
    },

    /** Why the last session ended without a sign-out here: 'elsewhere', 'deleted', or ''. */
    endedBecause: () => ended,
    clearEnded() {
      ended = '';
    },

    /** The account was deleted from this tab: its sessions are over everywhere, this one included. */
    deleted() {
      ended = 'deleted';
      remember('');
      queries.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      queries.setQueryData(sessionKey, null);
    },

    check,

    start() {
      if (timer) return;
      timer = setInterval(check, pollMs);
      target.addEventListener?.('focus', onVisible);
      target.addEventListener?.('online', onVisible);
      doc?.addEventListener?.('visibilitychange', onVisible);
    },

    stop() {
      clearInterval(timer);
      timer = null;
      target.removeEventListener?.('focus', onVisible);
      target.removeEventListener?.('online', onVisible);
      doc?.removeEventListener?.('visibilitychange', onVisible);
      unsubscribe();
      if (target.fetch === fetchInWorkspace) target.fetch = original;
    },
  };
}
