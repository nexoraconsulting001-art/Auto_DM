import { DEFAULT_TIMEOUT_MS, ProviderError, ProviderHostBlockedError, createHttp } from '../http.js';
import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';

/**
 * Email to shoppers (PRD 9.16, 5.4): order alerts, cart reminders, review requests. From the business's own domain when
 * its SPF and DKIM are verified, otherwise from the neutral sending domain; never from an address with the platform's name.
 *
 * NOTHING calls this except the shopper-message gate (ctx.shopperMessages), which checks consent first.
 *
 *   send({ from, fromName, replyTo?, to, subject, html, text, headers?, idempotencyKey }) -> { messageId }
 *       `headers` carries List-Unsubscribe for anything that isn't about an order (9.15).
 *
 * Drivers (EMAIL_DRIVER):
 *   none  the default: nothing is configured, and send() answers ProviderError kind 'rejected', code 'not_configured', so
 *         the caller records the alert as failed and moves on. No provider is chosen yet (5.4).
 *   http  POSTs JSON { from, to, subject, html, text, headers } with a bearer key (EMAIL_API_KEY) to EMAIL_BASE_URL:
 *         the shape of the simulator at tools/sim/email, and of the HTTP mail APIs. The host must be on EMAIL_HOSTS
 *         (comma-separated origins) or a simulator; a simulator is refused when NODE_ENV=production.
 *
 * A send whose answer was lost has delivery 'unknown' and is repeated only with the same idempotency key.
 */

export const neutralFrom = (config, local = 'orders') => (config.emailNeutralDomain ? `${local}@${config.emailNeutralDomain}` : '');

export function createEmail(config = {}, { env = process.env } = {}) {
  const driver = config.emailDriver || 'none';
  if (driver === 'none') {
    return {
      driver,
      async send() {
        throw new ProviderError({ provider: 'email', kind: 'rejected', code: 'not_configured', delivery: 'none' });
      },
    };
  }
  if (driver !== 'http') throw new Error(`Unknown EMAIL_DRIVER "${driver}" (use none or http)`);

  const raw = String(config.emailBaseUrl || '').trim().replace(/\/+$/, '');
  refuseSimulatorUrl(raw, { env, name: 'EMAIL_BASE_URL' });
  const allowed = String(config.emailHosts || '').split(',').map((h) => h.trim().replace(/\/+$/, '')).filter(Boolean);
  let origin = '';
  try {
    origin = new URL(raw).origin;
  } catch {
    // Not a URL.
  }
  if (!raw || (!isSimulatorUrl(raw) && !allowed.includes(origin))) throw new ProviderHostBlockedError('EMAIL_BASE_URL');
  const request = createHttp({ provider: 'email', baseUrl: raw, timeoutMs: config.providerTimeoutMs || DEFAULT_TIMEOUT_MS, codeOf: (body) => body?.error?.code ?? body?.code ?? '' });

  return {
    driver,
    async send({ from, fromName = '', replyTo = '', to, subject, html, text, headers = {}, idempotencyKey }) {
      if (!from || !to || !subject) throw new Error('An email needs from, to and subject');
      const { body } = await request('POST', '/messages', {
        headers: { authorization: `Bearer ${config.emailApiKey ?? ''}`, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        json: { from: fromName ? `${fromName} <${from}>` : from, reply_to: replyTo || undefined, to: [to], subject, html, text, headers },
        retries: idempotencyKey ? 2 : 0,
      });
      return { messageId: String(body?.id ?? '') };
    },
  };
}
