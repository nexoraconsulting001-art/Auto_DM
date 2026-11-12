/** Pure: what an alert opens. No React, so the server's tests load it too. */
const ID = /^[1-9]\d{0,17}$/;

/**
 * Where an alert's "Open" leads, from its kind and target, or null. Pure. `target` is what raised it: a chat's id, an
 * automation's id or a domain; anything else opens nothing rather than a wrong screen.
 */
export function alertLink(alert) {
  const kind = String(alert?.kind ?? '');
  const target = String(alert?.target ?? '');
  if (kind.startsWith('thread.') && ID.test(target)) return `/inbox/threads/${target}`;
  if ((kind.startsWith('content.') || kind.startsWith('link.') || kind.startsWith('automation')) && ID.test(target)) return `/automations/${target}`;
  if (kind.startsWith('token.') || kind === 'paused.reconnect' || kind.startsWith('gate.')) return '/connect';
  if (kind.startsWith('paused.') || kind.startsWith('breaker')) return '/compliance';
  if (kind.startsWith('domain')) return '/domains';
  if (kind.startsWith('reach_guard.')) return '/reach-guard';
  return null;
}
