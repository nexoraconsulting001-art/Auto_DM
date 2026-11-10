/** Pure: what the connect screen says about each state of a connection. */

/** Where Meta sends the owner back to, on this site. */
export const RETURN_TO = '/admin/connect';

export const SCOPE_LABELS = Object.freeze([
  { scope: 'instagram_business_basic', label: 'Profile', detail: 'Your username and posts' },
  { scope: 'instagram_business_manage_messages', label: 'Messages', detail: 'Send and receive DMs' },
  { scope: 'instagram_business_manage_comments', label: 'Comments', detail: 'See comments and reply to them' },
  { scope: 'instagram_business_manage_insights', label: 'Insights', detail: 'Read reach and engagement' },
]);

const accountName = (connection) => (connection.username ? `@${connection.username}` : 'Instagram account');

/** The heading, the badge, and the one button a manager is offered. */
export function connectionView(connection) {
  switch (connection.status) {
    case 'active':
      return { title: accountName(connection), badge: 'Connected', tone: connection.health === 'red' ? 'bad' : connection.health === 'amber' ? 'warn' : 'good', action: connection.missingScopes.length ? 'Reconnect Instagram' : null, connected: true };
    case 'reconnect_needed':
      return { title: accountName(connection), badge: 'Needs reconnecting', tone: 'bad', action: 'Reconnect Instagram', connected: false };
    case 'deauthorized':
      return { title: accountName(connection), badge: 'Access removed', tone: 'bad', action: 'Reconnect Instagram', connected: false };
    default:
      return { title: 'No account connected', badge: 'Not connected', tone: 'neutral', action: 'Connect Instagram', connected: false };
  }
}

const RETURNS = Object.freeze({
  connected: { tone: 'good', text: 'Instagram is connected.' },
  missing_scopes: { tone: 'warn', text: 'Connected, but a permission was left off. Reconnect and allow everything on the list.' },
  denied: { tone: 'warn', text: 'You cancelled on Instagram, so nothing changed.' },
  taken: { tone: 'bad', text: 'That Instagram account is already connected to another business.' },
  forbidden: { tone: 'bad', text: 'Only the owner or a manager can connect Instagram.' },
  failed: { tone: 'bad', text: 'Instagram didn’t finish connecting. Please try again.' },
});

/** The banner for the ?instagram= word Meta's callback adds on the way back. An unknown word is a failure, never a success. */
export function returnBanner(word) {
  if (!word) return null;
  return Object.hasOwn(RETURNS, word) ? RETURNS[word] : RETURNS.failed;
}
