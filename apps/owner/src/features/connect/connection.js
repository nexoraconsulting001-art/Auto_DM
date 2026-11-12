/** Pure: what the connect screen says about each state of a connection, as string keys. Same rules as the console's. */

/** Where Meta sends the browser back to once the person has finished there: the console's own page on this business's address. */
export const RETURN_TO = '/admin/connect';

/** The heading's key and values, the badge, its tone, and the one button a manager is offered (or null). */
export function connectionView(connection) {
  const name = connection?.username ? { key: 'connect.ig.handle', values: { username: connection.username } } : { key: 'connect.ig.account', values: {} };
  switch (connection?.status) {
    case 'active': {
      const tone = connection.health === 'red' ? 'bad' : connection.health === 'amber' ? 'warn' : 'good';
      return { title: name, badge: 'connect.badge.connected', tone, action: connection.missingScopes?.length ? 'connect.ig.reconnect' : null, connected: true };
    }
    case 'reconnect_needed':
      return { title: name, badge: 'connect.badge.reconnect', tone: 'bad', action: 'connect.ig.reconnect', connected: false };
    case 'deauthorized':
      return { title: name, badge: 'connect.badge.removed', tone: 'bad', action: 'connect.ig.reconnect', connected: false };
    default:
      return { title: { key: 'connect.ig.none', values: {} }, badge: 'connect.badge.notConnected', tone: 'neutral', action: 'connect.ig.connect', connected: false };
  }
}

/** The Page's badge and button, for a Facebook connection that is switched on. */
export function pageView(page) {
  if (page?.status === 'active') return { badge: 'connect.badge.connected', tone: 'good', action: null, connected: true };
  if (page?.status === 'reconnect_needed' || page?.status === 'deauthorized') return { badge: 'connect.badge.reconnect', tone: 'bad', action: 'connect.fb.reconnect', connected: false };
  return { badge: 'connect.badge.notConnected', tone: 'neutral', action: 'connect.fb.connect', connected: false };
}

/**
 * Only an address on Meta's own login pages is opened in the browser: the server builds it, and anything else
 * (a server answering junk, a test stub) opens nothing rather than a page that could ask for a password.
 */
export function isMetaLogin(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) return false;
    return /(^|\.)(instagram\.com|facebook\.com)$/.test(parsed.hostname) || /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}
