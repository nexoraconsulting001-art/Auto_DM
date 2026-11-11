import { CONSENT_FOR, MESSAGE_CHANNELS, MESSAGE_PURPOSES, MESSAGE_REASONS as R, PLATFORM_NAME, quietUntil } from '../../contracts/shopper-messages.js';
import { neutralFrom } from '../../adapters/email/index.js';
import { ProviderError } from '../../adapters/http.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * The shopper-message gate (ctx.shopperMessages): the only path to WhatsApp or email for a message to a shopper. The rules
 * and the shapes are in src/contracts/shopper-messages.js. Order alerts, login codes, cart reminders and review requests
 * all call send(); none of them calls an adapter.
 *
 * In order, a message is refused when: its shape is wrong; its text names the platform; a marketing email has no
 * unsubscribe link; the shopper has not said yes to that purpose on that channel (a login code needs no yes); it is
 * marketing inside quiet hours (deferred, not dropped); there is no address; the business has no account for the channel;
 * the WhatsApp template isn't approved. Only then is the provider called, once: a send whose answer was lost is reported
 * as failed with reason 'unknown_delivery' and retryable false, so nobody sends it twice on a guess.
 *
 * Logs carry ids and reasons only: never a number, an address or a word of the message.
 */
const digits = (phone) => String(phone ?? '').replace(/[^0-9]/g, '');
const result = (outcome, reason, extra = {}) => ({ outcome, reason, ...extra });

export function createShopperMessages({ db, platform, providers, config = {} }) {
  const textOf = (message) => (message.channel === 'email' ? [message.email?.subject, message.email?.html, message.email?.text] : (message.template?.params ?? [])).map((v) => String(v ?? '')).join('\n');

  function shapeProblem(message) {
    if (!message || !MESSAGE_CHANNELS.includes(message.channel) || !MESSAGE_PURPOSES.includes(message.purpose)) return R.invalid;
    if (message.channel === 'whatsapp' && (typeof message.template?.purpose !== 'string' || !Array.isArray(message.template.params ?? []))) return R.invalid;
    if (message.channel === 'email' && (!message.email?.subject || (!message.email.html && !message.email.text))) return R.invalid;
    if (PLATFORM_NAME.test(textOf(message))) return R.platformName;
    if (message.channel === 'email' && message.purpose === 'marketing' && !message.email.unsubscribeUrl) return R.noUnsubscribe;
    return null;
  }

  async function whatsappReady(message) {
    const [account] = await db.query(`SELECT waba_id, phone_number_id, access_token_enc FROM whatsapp_accounts WHERE tenant_id = $1 AND status = 'active'`, [tenantId()]);
    if (!account?.access_token_enc) return { refusal: R.noChannel };
    const [template] = await db.query(
      `SELECT name, language, status FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = $2 ORDER BY (status = 'approved') DESC, (language = $3) DESC, id LIMIT 1`,
      [tenantId(), message.template.purpose, message.template.language ?? 'en'],
    );
    if (!template || template.status !== 'approved') return { refusal: R.templatePending };
    return { account: { wabaId: account.waba_id, phoneNumberId: account.phone_number_id, accessToken: platform.secrets.decrypt(account.access_token_enc) }, template };
  }

  async function emailReady() {
    if (!providers?.email || providers.email.driver === 'none') return { refusal: R.noChannel };
    const [settings] = await db.query('SELECT email_from, email_from_local, email_reply_to FROM alert_settings WHERE tenant_id = $1', [tenantId()]);
    const [business] = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId()]);
    const local = settings?.email_from_local ?? 'orders';
    let from = '';
    if (settings?.email_from === 'own') {
      const [domain] = await db.query(`SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_primary LIMIT 1`, [tenantId()]).catch(() => []);
      if (domain?.domain) from = `${local}@${domain.domain}`;
    }
    from ||= neutralFrom(config, local);
    if (!from || PLATFORM_NAME.test(from)) return { refusal: R.noChannel };
    return { from, fromName: business?.name ?? '', replyTo: settings?.email_reply_to ?? '' };
  }

  /** Every rule, with nothing sent. `ready` is what send() needs to go on. */
  async function decide(message) {
    tenantId();
    const problem = shapeProblem(message);
    if (problem) return { verdict: result('skipped', problem) };
    const to = message.to ?? {};
    const address = message.channel === 'whatsapp' ? digits(to.phone) : String(to.email ?? '').trim();

    const consentPurpose = CONSENT_FOR[message.purpose];
    if (consentPurpose) {
      let answer;
      try {
        answer = await platform.consent.allows({ purpose: consentPurpose, channel: message.channel, shopperId: to.shopperId, phone: to.phone, email: to.email });
      } catch {
        return { verdict: result('skipped', R.consentUnknown) };
      }
      if (answer?.granted !== true) return { verdict: result('skipped', answer?.reason === 'consent.not_built' ? R.consentUnknown : R.noConsent) };
    }
    if (message.purpose === 'marketing') {
      const until = quietUntil(message.now ?? new Date());
      if (until) return { verdict: result('deferred', R.quietHours, { until }) };
    }
    if (!address || (message.channel === 'whatsapp' && !/^[1-9][0-9]{7,14}$/.test(address))) return { verdict: result('skipped', R.noAddress) };

    const ready = message.channel === 'whatsapp' ? await whatsappReady(message) : await emailReady();
    if (ready.refusal) return { verdict: result('skipped', ready.refusal) };
    return { verdict: result('sent', R.ok), ready, address };
  }

  async function send(message) {
    const { verdict, ready, address } = await decide(message);
    const ids = { channel: message?.channel, purpose: message?.purpose, orderId: message?.orderId ?? null };
    if (verdict.outcome !== 'sent') {
      log.info('shopper_message.not_sent', { ...ids, outcome: verdict.outcome, reason: verdict.reason });
      return verdict;
    }
    try {
      const sent = message.channel === 'whatsapp'
        ? await providers.whatsapp.sendTemplate(ready.account, {
          to: address,
          name: ready.template.name,
          language: ready.template.language,
          components: message.template.params?.length ? [{ type: 'body', parameters: message.template.params.map((text) => ({ type: 'text', text: String(text) })) }] : [],
        })
        : await providers.email.send({
          from: ready.from,
          fromName: ready.fromName,
          replyTo: ready.replyTo,
          to: address,
          subject: message.email.subject,
          html: message.email.html,
          text: message.email.text,
          headers: message.email.unsubscribeUrl ? { 'List-Unsubscribe': `<${message.email.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
          idempotencyKey: message.dedupeKey,
        });
      log.info('shopper_message.sent', ids);
      return result('sent', R.ok, { messageId: sent.messageId });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const unknown = err.delivery === 'unknown';
      log.warn('shopper_message.failed', { ...ids, kind: err.kind, status: err.status, code: err.code, delivery: err.delivery });
      return result('failed', unknown ? R.unknownDelivery : R.provider, { retryable: !unknown && err.retryable, kind: err.kind, code: err.code });
    }
  }

  return {
    send,
    async check(message) {
      return (await decide(message)).verdict;
    },
  };
}
