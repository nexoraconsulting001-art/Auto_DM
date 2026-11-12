/**
 * WhatsApp Cloud API: send a message, read the phone number, message templates and their review, and the webhooks WhatsApp
 * sends (delivery reports with their pricing category, and replies such as STOP).
 *
 * API (what src/adapters/whatsapp calls):
 *   POST /:version/:phoneId/messages                   a template outside the 24 hour window must be approved, or it is refused (132001)
 *   GET  /:version/:phoneId
 *   GET  /:version/:wabaId/message_templates           POST /:version/:wabaId/message_templates    (new ones start PENDING)
 *   POST /:version/oauth/access_token                  embedded signup: { client_id, client_secret, code } for a token; a code works once
 *   POST /:version/:wabaId/subscribed_apps
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   GET  /sent                                         what went out
 *   POST /templates { name, language?, category?, status }       adds one or sets its status: APPROVED, PENDING, REJECTED, PAUSED
 *   POST /templates/enforce { on }                     off by default, so earlier tests send any template; on makes sends need an approved one
 *   POST /status { messageId, status, errorCode?, category?, hold?, duplicates?, signature? }   sends a delivery report: sent, delivered, read, failed
 *   POST /inbound { phoneId, from, text, name?, messageId?, at?, hold?, duplicates?, signature? }   a shopper's message, signed, with
 *        the business it is for named only by phoneId (metadata.phone_number_id): any id works, so a webhook for another business's
 *        number is this with that number's id. messageId repeats an id (a duplicate that is a new delivery); `at` (ms) sets its timestamp.
 *   POST /window/enforce { on }                        off by default; on makes free-form text need a message from that person in
 *                                                      the last 24 hours on the controlled clock, or it is refused with 131047
 *   POST /numbers { phoneId, displayName?, displayNumber? }   what GET /:version/:phoneId answers for that number
 *   POST /signup/codes { code, token? }                a code embedded signup would hand the browser, and the token it buys
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
  let enforceWindow = false;
  let seq = 0;
  let numbers = new Map();
  let codes = new Map();
  let issued = new Set();
  let lastInbound = new Map();
  const DAY_MS = 24 * 60 * 60 * 1000;

  function requireToken(req) {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (given !== token && !issued.has(given)) throw whatsappError(401, 190, 'Invalid OAuth access token.');
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
      enforceWindow = false;
      seq = 0;
      numbers = new Map();
      codes = new Map();
      issued = new Set();
      lastInbound = new Map();
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
        if (type === 'text' && (typeof req.body.text?.body !== 'string' || !req.body.text.body)) throw whatsappError(400, 100, 'text.body is required.');
        if (enforceWindow && type !== 'template') {
          const last = lastInbound.get(`${req.params.phoneId}:${to}`);
          if (last === undefined || sim.clock.now() - last >= DAY_MS) throw whatsappError(400, 131047, 'Re-engagement message: more than 24 hours have passed since the customer last replied.');
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
      on('POST', '/:version/oauth/access_token', (req) => {
        const { client_id: clientId, client_secret: clientSecret, code } = req.body ?? {};
        if (!clientId || clientSecret !== appSecret) throw whatsappError(400, 101, 'Error validating client secret.');
        if (!codes.has(code)) throw whatsappError(400, 100, 'This authorization code has been used or has expired.');
        const bought = codes.get(code);
        codes.delete(code);
        issued.add(bought);
        return { access_token: bought, token_type: 'bearer' };
      });
      on('POST', '/:version/:wabaId/subscribed_apps', (req) => {
        requireToken(req);
        return { success: true };
      });
      on('GET', '/:version/:phoneId', (req) => {
        requireToken(req);
        const number = numbers.get(req.params.phoneId) ?? {};
        return { id: req.params.phoneId, display_phone_number: number.displayNumber ?? '+91 90000 00000', verified_name: number.displayName ?? 'Simulated sender', quality_rating: 'GREEN' };
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
      on('POST', '/window/enforce', ({ body }) => {
        enforceWindow = body.on !== false;
        return { enforce: enforceWindow };
      });
      on('POST', '/numbers', ({ body }) => {
        if (!body.phoneId) throw new SimError(400, { error: 'phoneId is required.' });
        numbers.set(String(body.phoneId), { displayName: body.displayName, displayNumber: body.displayNumber });
        return { phoneId: String(body.phoneId), ...numbers.get(String(body.phoneId)) };
      });
      on('POST', '/signup/codes', ({ body }) => {
        if (!body.code) throw new SimError(400, { error: 'code is required.' });
        const bought = body.token ?? `sim-wa-token-${++seq}`;
        codes.set(String(body.code), bought);
        return { code: String(body.code), token: bought };
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
        const at = Number.isFinite(body.at) ? body.at : sim.clock.now();
        const message = { from: String(body.from), id: body.messageId ? String(body.messageId) : `wamid.in${++seq}`, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: String(body.text ?? '') } };
        const key = `${body.phoneId}:${message.from}`;
        lastInbound.set(key, Math.max(lastInbound.get(key) ?? 0, at));
        return hooks.send(envelope(body.phoneId, { contacts: [{ wa_id: message.from, ...(body.name ? { profile: { name: String(body.name) } } : {}) }], messages: [message] }), { duplicates: body.duplicates, hold: body.hold, signature: body.signature });
      });
    },
  });

  return Object.assign(sim, { webhooks: hooks, appSecret });
}
