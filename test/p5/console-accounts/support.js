// What the console-accounts tests share: an app with Bhava's WhatsApp number on the simulator (the accounts track's
// accountsApp), and a stand-in for the browser page the console runs in, whose fetch reaches that app as a browser
// on one address would, with the cookie the sign-in set.
import { QueryClient } from '@tanstack/react-query';
import { createApiClient } from '../../../shared/api-client/index.js';
import { createWorkspace } from '../../../console/src/features/account/workspace.js';
import { APP_HOST, OWNER, accountsApp, call, codeSignIn, freshIp, otherBusiness, testDevice, typedAccount } from '../accounts/support.js';

export { APP_HOST, OWNER, accountsApp, call, codeSignIn, freshIp, otherBusiness, testDevice, typedAccount };

/** In-memory Storage, as sessionStorage is in a tab. */
export function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

/** Lets earlier codes and limits go, so the same number can sign in again at once (a resend inside 30 s sends nothing). */
export async function freshCodes(app) {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
}

/**
 * A browser tab on `host` signed in as `session` (codeSignIn with transport cookie): `target` is its window (fetch,
 * location, events), `seen` every request it sent as { path, headers }. Requests to another origin are answered 204
 * here and never leave the test.
 */
export function browserTab(app, session, { host = APP_HOST } = {}) {
  const origin = `http://${host}`;
  const seen = [];
  const listeners = new Map();
  const target = {
    location: { href: `${origin}/admin`, origin },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    async fetch(input, init = {}) {
      const url = new URL(input, origin);
      const headers = new Headers(init.headers ?? {});
      seen.push({ url: url.href, path: url.pathname, method: init.method ?? 'GET', tenant: headers.get('x-tenant-id') });
      if (url.origin !== origin) return new Response(null, { status: 204 });
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-for', session.ip ?? '10.99.0.1');
      if (session.cookie) headers.set('cookie', session.cookie);
      return fetch(`${app.base}${url.pathname}${url.search}`, { ...init, headers, redirect: 'manual' });
    },
  };
  return { target, seen, listeners };
}

/** The console's own pieces on that tab: the shared API client, the query cache with the session in it, and the workspace. */
export async function consoleOn(app, session, options = {}) {
  const tab = browserTab(app, session, options);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryStorage();
  const workspace = createWorkspace({ target: tab.target, storage, queries, sessionKey: ['session'], pollMs: 60_000 });
  const api = createApiClient({ fetch: (...args) => tab.target.fetch(...args), onUnauthorized: () => queries.setQueryData(['session'], null) });
  // The console's session query (console/src/lib/session.jsx): a 401 is no one signed in.
  const currentSession = async () => {
    try {
      return await api.auth.me();
    } catch (error) {
      if (error.status === 401) return null;
      throw error;
    }
  };
  await queries.fetchQuery({ queryKey: ['session'], queryFn: currentSession });
  return { ...tab, queries, storage, workspace, api, close: () => workspace.stop() };
}
