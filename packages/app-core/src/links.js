/**
 * Deep links (PRD 10.5, 10.3). A push, an email and the browser sign-in all come back to the app as
 * `<scheme>://<path>`: the server writes a path ("/orders/12") and each client opens its own form of it. The same
 * parsing serves the owner app and a shopper app, which passes its own schemes.
 */
/** The owner app's scheme: OWNER_APP_SCHEME in src/contracts/api/provider.js, which the server writes into links. A test keeps the two equal. */
export const OWNER_APP_SCHEME = 'bhavabusiness';
/** Where a browser sign-in returns to the owner app. */
export const OWNER_APP_CALLBACK = `${OWNER_APP_SCHEME}://auth/callback`;

const PATH = /^\/[A-Za-z0-9][A-Za-z0-9/_-]{0,190}$/;
export const isLinkPath = (path) => typeof path === 'string' && (path === '/' || (PATH.test(path) && !path.includes('//')));

/**
 * What a link asks for, or null for one this app does not open:
 *   { kind: 'auth', code, error }     the end of a browser sign-in: send `code` with the PKCE verifier to auth.exchange
 *   { kind: 'screen', path, tenantId } a record; `tenantId` (when given) is switched to first
 */
export function parseLink(url, { schemes = [OWNER_APP_SCHEME] } = {}) {
  const match = /^([a-z][a-z0-9+.-]*):\/{0,3}([^?#]*)(?:\?([^#]*))?/i.exec(String(url ?? ''));
  if (!match || !schemes.includes(match[1].toLowerCase())) return null;
  const path = `/${match[2]}`.replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(match[3] ?? '');
  if (path === '/auth/callback') {
    const code = query.get('code') ?? '';
    const error = query.get('error') ?? '';
    return { kind: 'auth', code: /^[\w-]{1,200}$/.test(code) ? code : '', error: ['denied', 'failed', 'expired'].includes(error) ? error : code ? '' : 'failed' };
  }
  if (!isLinkPath(path)) return null;
  const tenant = Number(query.get('tenantId'));
  return { kind: 'screen', path, tenantId: Number.isInteger(tenant) && tenant > 0 ? tenant : null };
}

/**
 * The screen a path opens. `screens` is [{ name, path }] with paths like "orders/:id"; the answer is
 * { name, params } or null. A literal part beats a parameter, so "orders/files" wins over "orders/:id".
 */
export function matchPath(path, screens) {
  if (!isLinkPath(path)) return null;
  const parts = path.split('/').filter(Boolean);
  let best = null;
  for (const screen of screens) {
    if (typeof screen.path !== 'string') continue;
    const pattern = screen.path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params = {};
    let literals = 0;
    const fits = pattern.every((piece, i) => {
      if (piece.startsWith(':')) {
        params[piece.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      }
      literals++;
      return piece === parts[i];
    });
    if (fits && (!best || literals > best.literals)) best = { name: screen.name, params, literals };
  }
  return best ? { name: best.name, params: best.params } : null;
}

/**
 * Links that open the app from outside: the one it was opened with, and any that arrive while it runs. `linking` is
 * react-native's Linking; each URL goes to `router.openUrl`, which ignores anything not in the app's own scheme.
 * The URL the app was opened with is handled once, however often this is set up again (after a switch of business).
 * Returns the way to stop.
 */
const launchHandled = new WeakSet();

export function watchLinks({ linking, router }) {
  if (!linking || !router) return () => {};
  const handle = (url) => {
    if (typeof url === 'string' && url) router.openUrl(url);
  };
  if (!launchHandled.has(linking)) {
    launchHandled.add(linking);
    Promise.resolve(linking.getInitialURL?.()).then(handle).catch(() => {});
  }
  const subscription = linking.addEventListener?.('url', (event) => handle(event?.url));
  return () => subscription?.remove?.();
}
