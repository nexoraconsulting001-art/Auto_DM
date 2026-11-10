/**
 * WhatsApp Cloud API, base routes only: send a message and read the phone number. Later phases add templates and
 * webhooks. GET /__sim/sent lists what went out.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';

const whatsappError = (status, code, message) => new SimError(status, { error: { message, type: 'OAuthException', code, fbtrace_id: crypto.randomBytes(8).toString('base64url') } });

export function createWhatsApp({ token = 'sim-whatsapp-token' } = {}) {
  let sent = [];
  let seq = 0;

  function requireToken(req) {
    if (req.headers.authorization !== `Bearer ${token}`) throw whatsappError(401, 190, 'Invalid OAuth access token.');
  }

  return createSim({
    name: 'whatsapp',
    errorBody: ({ status, kind, fault }) => ({ error: { message: `Simulated ${kind}.`, type: 'OAuthException', code: fault.code ?? (kind === 'rate_limit' ? 130429 : 131000), fbtrace_id: crypto.randomBytes(8).toString('base64url') }, status }),
    reset: () => {
      sent = [];
      seq = 0;
    },
    routes: (on) => {
      on('POST', '/:version/:phoneId/messages', (req) => {
        requireToken(req);
        const { messaging_product: product, to, type = 'text' } = req.body ?? {};
        if (product !== 'whatsapp') throw whatsappError(400, 100, 'messaging_product must be whatsapp.');
        if (typeof to !== 'string' || !/^\d{8,15}$/.test(to)) throw whatsappError(400, 131009, 'to must be a phone number in international format, digits only.');
        if (!['text', 'template', 'image', 'document', 'interactive'].includes(type)) throw whatsappError(400, 100, `Unsupported message type ${type}.`);
        const id = `wamid.sim${++seq}`;
        sent.push({ id, phoneId: req.params.phoneId, to, type, body: req.body });
        return { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] };
      });
      on('GET', '/:version/:phoneId', (req) => {
        requireToken(req);
        return { id: req.params.phoneId, display_phone_number: '+91 90000 00000', verified_name: 'Simulated sender', quality_rating: 'GREEN' };
      });
    },
    controls: (on) => {
      on('GET', '/sent', () => ({ sent }));
    },
  });
}
