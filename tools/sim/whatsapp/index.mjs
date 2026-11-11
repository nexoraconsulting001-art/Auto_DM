/**
 * WhatsApp Cloud API: send a message, read the phone number, message templates and their review, and the webhooks WhatsApp
 * sends (delivery reports with their pricing category, and replies such as STOP).
 *
 * API (what src/adapters/whatsapp calls):
 *   POST /:version/:phoneId/messages                   a template outside the 24 hour window must be approved, or it is refused (132001)
 *   GET  /:version/:phoneId
 *   GET  /:version/:wabaId/message_templates           POST /:version/:wabaId/message_templates    (new ones start PENDING)
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   GET  /sent                                         what went out
 *   POST /templates { name, language?, category?, status }       adds one or sets its status: APPROVED, PENDING, REJECTED, PAUSED
 *   POST /templates/enforce { on }                     off by default, so earlier tests send any template; on makes sends need an approved one
 *   POST /status { messageId, status, errorCode?, category?, hold?, duplicates?, signature? }   sends a delivery report: sent, delivered, read, failed
 *   POST /inbound { phoneId, from, text, hold?, duplicates?, signature? }                       a shopper's reply
 *   POST /webhooks/url { url }    POST /webhooks/flush { order? }    POST /webhooks/redeliver { id, times? }    GET /webhooks
 *
 * Webhooks are signed with the app secret in X-Hub-Signature-256, as Meta signs them. duplicates repeats one; hold and
 * flush deliver them out of order ("delivered" before "sent").
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';
import { createWebhooks, webhookControls } from '../webhooks.mjs';

const whatsappError = (status, code, message) => new SimError(status, { error: { message, type: 'OAuthException', code, fbtrace_id: crypto.randomBytes(8).toString('base64url') } });

export function createWhatsApp({ token = 'sim-whatsapp-token', appSecret = 'sim-whatsapp-app-secret', webhookUrl = null } = {}) {
  let sent = [];
  let templates = [];
  let enforce = false;
  let seq = 0;

  function requireToken(req) {
    if (req.headers.authorization !== `Bearer ${token}`) throw whatsappError(401, 190, 'Invalid OAuth access token.');
  }

  let sim = null;
  const hooks = createWebhooks({
    clock: { now: () => sim.clock.now() },
    url: webhookUrl,
    sign: (raw, _payload, { bad }) => ({ 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', bad ? `${appSecret}-wrong` : appSecret).update(raw).digest('hex')}` }),
  });
  const envelope = (phoneId, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'sim-waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000000', phone_number_id: phoneId }, ...value } }] }] });

  sim = createSim({
    name: 'whatsapp',
    errorBody: ({ status, kind, fault }) => ({ error: { message: `Simulated ${kind}.`, type: 'OAuthException', code: fault.code ?? (kind === 'rate_limit' ? 130429 : 131000), fbtrace_id: crypto.randomBytes(8).toString('base64url') }, status }),
    reset: () => {
      sent = [];
      templates = [];
      enforce = false;
      seq = 0;
      hooks.reset();
    },
    routes: (on) => {
      on('POST', '/:version/:phoneId/messages', (req) => {
        requireToken(req);
        const { messaging_product: product, to, type = 'text' } = req.body ?? {};
        if (product !== 'whatsapp') throw whatsappError(400, 100, 'messaging_product must be whatsapp.');
        if (typeof to !== 'string' || !/^\d{8,15}$/.test(to)) throw whatsappError(400, 131009, 'to must be a phone number in international format, digits only.');
        if (!['text', 'template', 'image', 'document', 'interactive'].includes(type)) throw whatsappError(400, 100, `Unsupported message type ${type}.`);
        if (enforce && type === 'template') {
          const template = templates.find((t) => t.name === req.body.template?.name && t.language === (req.body.template?.language?.code ?? 'en'));
          if (!template) throw whatsappError(404, 132001, 'Template name does not exist in the translation.');
          if (template.status !== 'APPROVED') throw whatsappError(400, 132015, 'Template is paused or not approved.');
        }
        const id = `wamid.sim${++seq}`;
        sent.push({ id, phoneId: req.params.phoneId, to, type, body: req.body, at: sim.clock.now() });
        return { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] };
      });
      on('GET', '/:version/:wabaId/message_templates', (req) => {
        requireToken(req);
        return { data: templates.map((t) => ({ ...t })), paging: {} };
      });
      on('POST', '/:version/:wabaId/message_templates', (req) => {
        requireToken(req);
        const { name, language = 'en', category, components = [] } = req.body ?? {};
        if (!/^[a-z0-9_]{1,512}$/.test(String(name ?? ''))) throw whatsappError(400, 100, 'A template name is lower case letters, digits and underscores.');
        if (!['UTILITY', 'AUTHENTICATION', 'MARKETING'].includes(category)) throw whatsappError(400, 100, 'category must be UTILITY, AUTHENTICATION or MARKETING.');
        if (templates.some((t) => t.name === name && t.language === language)) throw whatsappError(400, 2388024, 'A template with this name and language already exists.');
        const template = { id: String(700000 + ++seq), name, language, category, status: 'PENDING', components };
        templates.push(template);
        return { id: template.id, status: template.status, category };
      });
      on('GET', '/:version/:phoneId', (req) => {
        requireToken(req);
        return { id: req.params.phoneId, display_phone_number: '+91 90000 00000', verified_name: 'Simulated sender', quality_rating: 'GREEN' };
      });
    },
    controls: (on) => {
      webhookControls(on, hooks);
      on('GET', '/sent', () => ({ sent }));
      on('POST', '/templates', ({ body }) => {
        const language = body.language ?? 'en';
        let template = templates.find((t) => t.name === body.name && t.language === language);
        if (!template) {
          template = { id: String(700000 + ++seq), name: body.name, language, category: body.category ?? 'UTILITY', status: 'PENDING', components: [] };
          templates.push(template);
        }
        if (body.status) template.status = String(body.status).toUpperCase();
        if (body.category) template.category = String(body.category).toUpperCase();
        return template;
      });
      on('POST', '/templates/enforce', ({ body }) => {
        enforce = body.on !== false;
        return { enforce };
      });
      on('POST', '/status', async ({ body }) => {
        const message = sent.find((m) => m.id === body.messageId);
        if (!message) throw new SimError(404, { error: 'No such message.' });
        if (!['sent', 'delivered', 'read', 'failed'].includes(body.status)) throw new SimError(400, { error: 'status is sent, delivered, read or failed.' });
        const status = {
          id: message.id, status: body.status, timestamp: String(Math.floor(sim.clock.now() / 1000)), recipient_id: message.to,
          ...(body.status === 'failed' ? { errors: [{ code: body.errorCode ?? 131026, title: 'Message undeliverable' }] } : { pricing: { billable: true, pricing_model: 'PMP', category: body.category ?? 'utility' } }),
        };
        return hooks.send(envelope(message.phoneId, { statuses: [status] }), { duplicates: body.duplicates, hold: body.hold, signature: body.signature });
      });
      on('POST', '/inbound', ({ body }) => {
        if (!body.phoneId || !/^\d{8,15}$/.test(String(body.from ?? ''))) throw new SimError(400, { error: 'phoneId and from (digits) are required.' });
        const message = { from: String(body.from), id: `wamid.in${++seq}`, timestamp: String(Math.floor(sim.clock.now() / 1000)), type: 'text', text: { body: String(body.text ?? '') } };
        return hooks.send(envelope(body.phoneId, { contacts: [{ wa_id: message.from }], messages: [message] }), { duplicates: body.duplicates, hold: body.hold, signature: body.signature });
      });
    },
  });

  return Object.assign(sim, { webhooks: hooks, appSecret });
}
