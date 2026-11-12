import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where the current request came from, for orders.channel and app-only coupons (PRD 10.7, P-63). 'web' unless something set
 * it; only the shopper app's gate (src/modules/app-api/gate.js) calls withChannel('app', ...), and only for a request that
 * carries a valid app access token. A header alone never makes a request the app's.
 *
 *   withChannel(channel, fn)   runs fn, and everything it awaits, with that channel
 *   currentChannel()           'web' or 'app'
 */
export const ORDER_CHANNELS = Object.freeze(['web', 'app']);
const storage = new AsyncLocalStorage();

export function withChannel(channel, fn) {
  if (!ORDER_CHANNELS.includes(channel)) throw new Error(`Unknown order channel: ${String(channel).slice(0, 20)}`);
  return storage.run({ channel }, fn);
}

export const currentChannel = () => storage.getStore()?.channel ?? 'web';
