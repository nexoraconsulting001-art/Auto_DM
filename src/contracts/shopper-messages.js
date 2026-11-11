/**
 * Messages to shoppers (PRD 9.3, 9.15, 9.16, 9.18): the rules of the one gate every such message passes,
 * ctx.shopperMessages (src/modules/shopper-messages). It is to WhatsApp and email what the compliance gate is to
 * Instagram and Facebook: nothing else may call the WhatsApp or email adapter's send. A test keeps it so.
 *
 * There is no SMS channel and no Instagram DM here: an abandoned cart is never chased by DM, even inside an open window (S-51).
 * Everything a shopper receives is in the seller's brand: the gate refuses a message that names the platform.
 *
 *   send(message) -> result          never throws for a refusal or a provider failure
 *   check(message) -> result         the same rules with nothing sent
 *
 * message:
 *   channel     'whatsapp' | 'email'
 *   purpose     'authentication'   a login or cash-on-delivery code the person just asked for: no consent needed
 *               'order_update'     placed, paid, shipped, delivered, cancelled, refunded, a return's progress: needs the
 *                                  shopper's yes to order updates on that channel
 *               'marketing'        a cart reminder, a review request, loyalty news: needs the shopper's yes to marketing on
 *                                  that channel, and never goes out between 9 pm and 9 am India time (S-50)
 *   to          { shopperId?, phone?, email? }: who, for the consent question and the address. The gate reads no table for
 *               an address: the caller passes the phone or email from the order or the shopper row.
 *   template    WhatsApp: { purpose, params } - purpose is a whatsapp_templates.purpose ('order_paid', 'otp', 'cart_reminder'...),
 *               params the body's values in order (text only)
 *   email       Email: { subject, html, text, unsubscribeUrl? } - unsubscribeUrl is required for marketing
 *   orderId?    for the log
 *   dedupeKey?  the email provider's idempotency key
 *   now?        a Date, for tests
 *
 * result: { outcome, reason, messageId?, until?, retryable? }
 *   outcome 'sent'      it went out; messageId is the provider's
 *           'skipped'   it must not go, and trying again later won't change that until something else does (see reason)
 *           'deferred'  it may go at `until` (quiet hours)
 *           'failed'    the provider refused or could not be reached; `retryable` says whether to try again
 */
export const MESSAGE_CHANNELS = Object.freeze(['whatsapp', 'email']);
export const MESSAGE_PURPOSES = Object.freeze(['authentication', 'order_update', 'marketing']);
export const MESSAGE_OUTCOMES = Object.freeze(['sent', 'skipped', 'deferred', 'failed']);

export const MESSAGE_REASONS = Object.freeze({
  ok: 'ok',
  /** The shopper has not said yes to this purpose on this channel, or took it back (S-60, S-64). */
  noConsent: 'no_consent',
  /** Shopper consent isn't built or can't be read: the answer is no. */
  consentUnknown: 'consent_unknown',
  /** The business has no WhatsApp account connected, or no way to send email. */
  noChannel: 'no_channel',
  /** No phone number or email address to send to. */
  noAddress: 'no_address',
  /** The WhatsApp template is still waiting for review, was rejected, or is paused: the admin shows "Template pending" (S-53). */
  templatePending: 'template_pending',
  quietHours: 'quiet_hours',
  /** The text names the platform. Buyer messages carry the seller's brand only. */
  platformName: 'content.platform_name',
  /** A marketing email with no unsubscribe link. */
  noUnsubscribe: 'content.no_unsubscribe',
  invalid: 'invalid',
  provider: 'provider',
  /** The provider may have sent it and the answer was lost: never sent again on a guess. */
  unknownDelivery: 'unknown_delivery',
});

/** What consent a purpose asks for: the consent ledger's purpose (src/platform/consent.js), or null for none. */
export const CONSENT_FOR = Object.freeze({ authentication: null, order_update: 'order_updates', marketing: 'marketing' });

/** The platform's own name must not reach a shopper (S-101). */
export const PLATFORM_NAME = /\bbhava\b/i;

/**
 * Quiet hours for marketing: 9 pm to 9 am shopper time, which is India time for every store here. Returns null when `at`
 * is outside them, or the Date of the next 9 am when inside.
 */
export function quietUntil(at = new Date(), { fromHour = 21, toHour = 9 } = {}) {
  const IST_MS = 5.5 * 3_600_000;
  const local = new Date(at.getTime() + IST_MS);
  const hour = local.getUTCHours();
  if (hour >= toHour && hour < fromHour) return null;
  const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (hour >= fromHour ? 1 : 0), toHour));
  return new Date(next.getTime() - IST_MS);
}
