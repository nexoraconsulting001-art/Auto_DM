/**
 * Shiprocket, base routes only: login, serviceability, create an order and track a shipment. Later phases add
 * AWB assignment, labels and webhooks. POST /__sim/track { shipmentId, status } moves a shipment along.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';

const shiprocketError = (status, message) => new SimError(status, { message, status_code: status });

export function createShiprocket({ email = 'sim@bhava.test', password = 'sim-shiprocket-password' } = {}) {
  let sessions;
  let shipments;
  let seq;
  const clear = () => {
    sessions = new Set();
    shipments = new Map();
    seq = 0;
  };
  clear();

  function requireSession(req) {
    const value = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!sessions.has(value)) throw shiprocketError(401, 'Token has expired or is not valid.');
  }

  return createSim({
    name: 'shiprocket',
    errorBody: ({ status, kind }) => ({ message: `Simulated ${kind}.`, status_code: status }),
    reset: clear,
    routes: (on) => {
      on('POST', '/v1/external/auth/login', (req) => {
        if (req.body?.email !== email || req.body?.password !== password) throw shiprocketError(403, 'Invalid email and password combination');
        const token = `sr-sim-${crypto.randomBytes(16).toString('hex')}`;
        sessions.add(token);
        return { id: 1, email, token };
      });
      on('GET', '/v1/external/courier/serviceability', (req) => {
        requireSession(req);
        const { pickup_postcode: pickup, delivery_postcode: delivery } = req.query;
        if (!/^\d{6}$/.test(pickup ?? '') || !/^\d{6}$/.test(delivery ?? '')) throw shiprocketError(422, 'pickup_postcode and delivery_postcode must be 6 digits.');
        return { status: 200, data: { available_courier_companies: [{ courier_company_id: 1, courier_name: 'Simulated Courier', rate: 4900, estimated_delivery_days: '3', cod: 1 }] } };
      });
      on('POST', '/v1/external/orders/create/adhoc', (req) => {
        requireSession(req);
        if (!req.body?.order_id || !Array.isArray(req.body?.order_items) || !req.body.order_items.length) throw shiprocketError(422, 'order_id and order_items are required.');
        const n = ++seq;
        const shipment = { order_id: 1000 + n, shipment_id: 2000 + n, channel_order_id: req.body.order_id, status: 'NEW', status_code: 1, onboarding_completed_now: 0, awb_code: '', courier_company_id: '', courier_name: '' };
        shipments.set(String(shipment.shipment_id), shipment);
        return shipment;
      });
      on('GET', '/v1/external/courier/track/shipment/:id', (req) => {
        requireSession(req);
        const shipment = shipments.get(req.params.id);
        if (!shipment) throw shiprocketError(404, 'Shipment not found.');
        return { tracking_data: { track_status: 1, shipment_status: shipment.status_code, shipment_track: [{ id: shipment.shipment_id, current_status: shipment.status }] } };
      });
    },
    controls: (on) => {
      on('POST', '/track', ({ body }) => {
        const shipment = shipments.get(String(body.shipmentId));
        if (!shipment) throw new SimError(404, { error: 'No such shipment.' });
        shipment.status = body.status ?? shipment.status;
        return { ok: true };
      });
    },
  });
}
