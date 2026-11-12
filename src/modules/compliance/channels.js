import { CHANNELS, META_CHANNELS } from '../../contracts/compliance.js';

/**
 * Channels the gate sends on beside Instagram and Facebook (PRD 6.12: WhatsApp). A module registers its channel in
 * setup(ctx), in the app and in the worker, with ctx.compliance.registerChannel(name, definition). From then on
 * compliance.send(), enqueue() and check() treat an action on that channel exactly as one on Instagram: the same queue
 * and token bucket (per budgetKey), the 24 hour window, opt-outs, caps, content and link checks, pauses, the kill
 * switch, the breaker, the log and its reason codes. Until a channel is registered nothing can be sent on it: its
 * account is unknown, so a job is refused with paused.reconnect.
 *
 * definition:
 *   send(action, account, options) -> { messageId, status?, usage? }
 *       The one call to the provider. `action.message` is the final message (the seller's note already added). Throw
 *       to refuse: the engine reads `kind` as it does Meta's ('token_invalid', 'throttled', 'window_closed',
 *       'recipient_unavailable', 'permission', 'not_found'), `status`, `code`, and `delivery`: 'none' when the answer
 *       proves nothing went out. Anything else is an unknown outcome and is never sent again.
 *   windowState({ action, subject, thread }) -> { lastUserMessageAt?, optedIn? }
 *       When this person last wrote (a Date, or null), if the channel knows better than the inbox thread it is handed;
 *       and whether they said yes to messages the business starts. A message with `template` goes only to someone who
 *       opted in (wa.no_optin) and needs no open window; any other message needs the window (window.closed).
 *   budgetKey(action) -> string
 *       What the token bucket is counted per: the phone number id.
 *   account(action) -> { token, status, tokenVersion? } | null
 *       The business's own account for action.accountId, read inside the business. null when it is not this
 *       business's; a status other than 'active', or an empty token, holds the job with paused.reconnect.
 *   tokenRejected?(action)
 *       Called when send() threw kind 'token_invalid': mark the account for reconnecting.
 */
const REQUIRED = Object.freeze(['send', 'windowState', 'budgetKey', 'account']);

export function createChannels() {
  const registered = new Map();
  return {
    register(name, definition) {
      if (!CHANNELS.includes(name)) throw new Error(`"${name}" is not a channel of the compliance contract`);
      if (META_CHANNELS.includes(name)) throw new Error(`${name} is built into the gate and cannot be replaced`);
      for (const key of REQUIRED) {
        if (typeof definition?.[key] !== 'function') throw new Error(`The ${name} channel needs ${key}()`);
      }
      if (definition.tokenRejected !== undefined && typeof definition.tokenRejected !== 'function') throw new Error(`The ${name} channel's tokenRejected is a function`);
      registered.set(name, Object.freeze({ ...definition }));
    },
    /** The definition, or null for Instagram, Facebook and a channel nobody registered. */
    get: (name) => registered.get(name) ?? null,
    names: () => [...registered.keys()],
  };
}
