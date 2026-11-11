import { DEFAULT_TIMEOUT_MS, createHttp, hmac, providerUrl, sameBytes } from '../http.js';

/**
 * WhatsApp Business (Cloud API), on each business's own account and number (PRD 9.3, 9.16). There is no SMS.
 *
 * NOTHING calls this except the shopper-message gate (src/modules/shopper-messages, ctx.shopperMessages), which checks
 * consent, quiet hours and the template's review status first. A test keeps it so, the way one does for Meta's send calls.
 *
 * `account` is { phoneNumberId, wabaId, accessToken } from whatsapp_accounts, the token decrypted by the caller.
 *
 *   sendTemplate(account, { to, name, language, components })   -> { messageId }
 *       `to` is digits only, international. Outside the 24 hour window only an approved template can be sent.
 *   templates(account)                                          -> [{ id, name, language, category, status }]
 *   createTemplate(account, { name, language, category, components }) -> { id, status }
 *   phoneNumber(account)                                        -> { id, displayNumber, verifiedName, quality }
 *
 * A send whose answer was lost is ProviderError with delivery 'unknown': it is never sent again on a guess. Every call has a
 * 10 s timeout. WHATSAPP_BASE_URL points at tools/sim/whatsapp, refused when NODE_ENV=production.
 *
 * verifyWebhook(rawBody, signatureHeader, appSecret): X-Hub-Signature-256 as "sha256=<hex>" over the exact bytes. Never throws.
 * parseStatuses(body) -> [{ messageId, status: 'sent' | 'delivered' | 'read' | 'failed', at, errorCode, phoneNumberId, costCategory }]
 * parseInbound(body)  -> [{ phoneNumberId, from, text }]  for STOP replies; `from` is a phone number: never log it.
 */
export const WHATSAPP_HOST = 'https://graph.facebook.com';

export function verifyWebhook(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  return sameBytes(signatureHeader.slice(7), hmac(appSecret, rawBody));
}

const changes = (body) => (Array.isArray(body?.entry) ? body.entry : []).flatMap((e) => (Array.isArray(e?.changes) ? e.changes : [])).map((c) => c?.value).filter(Boolean);

export function parseStatuses(body) {
  return changes(body).flatMap((value) => (Array.isArray(value.statuses) ? value.statuses : []).map((s) => ({
    messageId: String(s.id ?? ''),
    status: String(s.status ?? ''),
    at: new Date(Number(s.timestamp) * 1000 || Date.now()),
    errorCode: String(s.errors?.[0]?.code ?? ''),
    phoneNumberId: String(value.metadata?.phone_number_id ?? ''),
    costCategory: String(s.pricing?.category ?? ''),
  }))).filter((s) => s.messageId);
}

export function parseInbound(body) {
  return changes(body).flatMap((value) => (Array.isArray(value.messages) ? value.messages : []).map((m) => ({
    phoneNumberId: String(value.metadata?.phone_number_id ?? ''),
    from: String(m.from ?? ''),
    text: String(m.text?.body ?? m.button?.text ?? ''),
  }))).filter((m) => m.from);
}

export function createWhatsApp(config = {}, { env = process.env } = {}) {
  const baseUrl = providerUrl({ value: config.whatsappBaseUrl, real: WHATSAPP_HOST, name: 'WHATSAPP_BASE_URL', env });
  const version = config.whatsappGraphVersion || config.graphVersion || 'v23.0';
  const request = createHttp({ provider: 'whatsapp', baseUrl: `${baseUrl}/${version}`, timeoutMs: config.providerTimeoutMs || DEFAULT_TIMEOUT_MS, codeOf: (body) => body?.error?.code ?? '' });
  const auth = (account) => {
    if (!account?.accessToken || !account?.phoneNumberId) throw new Error('WhatsApp needs the business’s own account: a phone number id and an access token');
    return { authorization: `Bearer ${account.accessToken}` };
  };

  return {
    async sendTemplate(account, { to, name, language = 'en', components = [] }) {
      if (!/^[1-9][0-9]{7,14}$/.test(String(to))) throw new Error('WhatsApp needs the number in international format, digits only');
      // No retry: a send that may have gone out is not repeated.
      const { body } = await request('POST', `/${encodeURIComponent(account.phoneNumberId)}/messages`, {
        headers: auth(account),
        json: { messaging_product: 'whatsapp', to: String(to), type: 'template', template: { name, language: { code: language }, components } },
      });
      return { messageId: body?.messages?.[0]?.id ?? '' };
    },
    async templates(account) {
      const { body } = await request('GET', `/${encodeURIComponent(account.wabaId)}/message_templates`, { headers: auth(account), query: { limit: 200 }, retries: 2 });
      return (body?.data ?? []).map((t) => ({ id: String(t.id), name: t.name, language: t.language, category: String(t.category ?? '').toLowerCase(), status: String(t.status ?? '').toLowerCase() }));
    },
    async createTemplate(account, { name, language = 'en', category, components }) {
      const { body } = await request('POST', `/${encodeURIComponent(account.wabaId)}/message_templates`, { headers: auth(account), json: { name, language, category: String(category).toUpperCase(), components } });
      return { id: String(body.id), status: String(body.status ?? 'PENDING').toLowerCase() };
    },
    async phoneNumber(account) {
      const { body } = await request('GET', `/${encodeURIComponent(account.phoneNumberId)}`, { headers: auth(account), retries: 2 });
      return { id: String(body.id), displayNumber: body.display_phone_number ?? '', verifiedName: body.verified_name ?? '', quality: body.quality_rating ?? '' };
    },
    verifyWebhook,
    parseStatuses,
    parseInbound,
  };
}
