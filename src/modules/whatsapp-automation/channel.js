import { WHATSAPP_CHANNEL, WHATSAPP_WINDOW_CLOSED_CODE } from '../../contracts/addons.js';
import { ProviderError } from '../../adapters/http.js';
import { tenantId } from '../../tenancy.js';

/**
 * WhatsApp as a channel of the compliance gate (PRD 6.12): what registerChannel('whatsapp', ...) is given. This file is
 * the only caller of the adapter's sendText, and it is called only by the gate, after every rule has passed.
 *
 *   action.accountId    the business's phone number id (whatsapp_accounts.phone_number_id)
 *   action.recipientId  the person's wa_id: their number, digits only. Never logged.
 *   action.message      { text } inside the window, or { text, template } for a message the business starts
 *
 * Meta's refusals are handed to the engine in its own words: 131047 is 'window_closed' (window.closed), a rejected token
 * 'token_invalid' (the account is marked for reconnecting and its jobs wait), a throttle 'throttled'.
 */
const KIND = Object.freeze({ auth: 'token_invalid', throttled: 'throttled' });

/** A ProviderError as the engine reads a refusal: kind, status, code, and delivery 'none' when nothing went out. */
function refusal(err) {
  const windowClosed = String(err.code) === String(WHATSAPP_WINDOW_CLOSED_CODE);
  return Object.assign(new Error(err.message), { kind: windowClosed ? 'window_closed' : KIND[err.kind] ?? err.kind, status: err.status, code: Number(err.code) || undefined, delivery: err.delivery });
}

export function whatsappChannel({ db, platform, providers }) {
  const accountRow = async (phoneNumberId) => (await db.query(
    'SELECT waba_id, phone_number_id, access_token_enc, status FROM whatsapp_accounts WHERE tenant_id = $1 AND phone_number_id = $2',
    [tenantId(), phoneNumberId],
  ))[0] ?? null;

  return {
    async account(action) {
      const row = await accountRow(action.accountId);
      if (!row) return null;
      const token = row.access_token_enc ? platform.secrets.decrypt(row.access_token_enc) : '';
      return { token, status: row.status, tokenVersion: null, phoneNumberId: row.phone_number_id, wabaId: row.waba_id, accessToken: token };
    },

    /** The inbox thread already says when the person last wrote; this adds whether they said yes to what a template is for. */
    async windowState({ action, subject }) {
      if (!action.message.template || !subject) return {};
      const [row] = await db.query(
        'SELECT 1 AS yes FROM whatsapp_optins WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = $3 AND withdrawn_at IS NULL',
        [tenantId(), subject, action.message.template.purpose ?? 'marketing'],
      );
      return { optedIn: Boolean(row) };
    },

    budgetKey: (action) => action.accountId,

    async send(action, account) {
      const { text, template } = action.message;
      try {
        const sent = template
          ? await providers.whatsapp.sendTemplate(account, {
            to: action.recipientId, name: template.name, language: template.language,
            components: template.params?.length ? [{ type: 'body', parameters: template.params.map((value) => ({ type: 'text', text: String(value) })) }] : [],
          })
          : await providers.whatsapp.sendText(account, { to: action.recipientId, text });
        return { messageId: sent.messageId || null };
      } catch (err) {
        throw err instanceof ProviderError ? refusal(err) : err;
      }
    },

    async tokenRejected(action) {
      await db.query(`UPDATE whatsapp_accounts SET status = 'reconnect', updated_at = now() WHERE tenant_id = $1 AND phone_number_id = $2 AND status = 'active'`, [tenantId(), action.accountId]);
    },
  };
}

export { WHATSAPP_CHANNEL };
