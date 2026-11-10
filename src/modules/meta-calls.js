import { reportError } from '../platform/log.js';

/**
 * Tells modules about every call made to Meta, so Account Health can see error rates and throttling (PRD 7.7). A module with onMetaCall(call, ctx) receives
 * { method, pathname, channel, accountId, status, code, subcode, usage, kind, ms }: ids and numbers only, with the current business in tenancy.js when the call
 * had one. A listener can never change the outcome of a call.
 */
export function createMetaCallObserver(modules) {
  const listeners = modules.filter((m) => typeof m.onMetaCall === 'function');
  let context = null;
  const failed = (err) => reportError(err, { msg: 'meta_calls.listener_failed' });

  return {
    bind(ctx) {
      context = ctx;
    },
    onCall(call) {
      if (!context) return;
      for (const module of listeners) {
        try {
          Promise.resolve(module.onMetaCall(call, context)).catch(failed);
        } catch (err) {
          failed(err);
        }
      }
    },
  };
}
