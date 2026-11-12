import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/** The queue an unanswered DM waits on. Its worker is started by the automations module's jobs(ctx). */
export const UNMATCHED_QUEUE = 'inbound.unmatched';

/**
 * ctx.inbound: what a module registers with to hear about an inbound DM that no keyword rule answered (PRD 6.11).
 *
 *   ctx.inbound.onUnmatched(handler)     in a module's setup(ctx), in the app and in the worker
 *   handler({ channel, threadId, messageId })
 *       channel    'instagram' or 'facebook'
 *       threadId   inbox_threads.id
 *       messageId  the provider's id of the DM (inbox_messages.mid), which is what the one-reply-per-DM key is made from
 *
 * Rules always run first: the automations engine calls unmatched() only after every dm_keyword rule and the welcome
 * have had the message, and never for a thread a person has taken over, a tester's code, an opt-out, a request for a
 * person or a complaint (the compliance worker has already dealt with those).
 *
 * A handler never runs inside the webhook request, nor inside the engine's own turn: unmatched() only puts ids on the
 * platform queue, and a worker calls the handlers inside the business. The message text is not in the job; a handler
 * reads it from the inbox by id. One job per DM (the dedupe key), and a handler that throws is reported, not retried:
 * a handler must itself be safe to run once and never twice.
 */
export function createInboundHooks({ platform }) {
  const handlers = [];

  return {
    onUnmatched(handler) {
      if (typeof handler !== 'function') throw new Error('onUnmatched needs a function');
      if (!handlers.includes(handler)) handlers.push(handler);
    },

    /** Called by the automations engine, inside the business. Returns the job's id, or null when nobody listens or it is already queued. */
    async unmatched({ channel, threadId, messageId }) {
      const business = tenantId();
      if (!handlers.length || !threadId || !messageId) return null;
      return platform.queue.enqueue(UNMATCHED_QUEUE, { channel, threadId, messageId: String(messageId) }, { tenantId: business, dedupeKey: `${business}:${channel}:${messageId}`, maxAttempts: 1 });
    },

    /** One job from the queue: every handler, inside the business the queue has already entered. */
    async run(job) {
      tenantId();
      const { channel, threadId, messageId } = job?.payload ?? {};
      const event = Object.freeze({ channel, threadId, messageId });
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          reportError(err, { msg: 'inbound.unmatched_handler_failed', thread: threadId });
        }
      }
    },

    /** How many handlers are registered, for tests and the health page. */
    listeners: () => handlers.length,
  };
}
