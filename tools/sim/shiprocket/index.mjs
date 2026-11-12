/**
 * Shiprocket: login, serviceability, pickup locations, orders, AWB, pickup, label, tracking, cancel and returns, and the
 * tracking webhook Shiprocket sends. Rates are integer paise in the simulator's own data and rupees on the wire, as real.
 *
 * API (what src/adapters/shiprocket calls), all under /v1/external with a Bearer session token except login:
 *   POST auth/login                            GET  courier/serviceability?pickup_postcode=&delivery_postcode=&cod=
 *   POST settings/company/addpickup            POST orders/create/adhoc          POST orders/create/return
 *   GET  settings/company/pickup               the account's pickup locations
 *   POST courier/assign/awb                    POST courier/generate/pickup      POST courier/generate/label
 *   GET  courier/track/awb/:awb                GET  courier/track/shipment/:id   POST orders/cancel/shipment/awbs
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   POST /serviceability { pincode, serviceable?, cod? }   a delivery PIN that isn't served, or has no cash on delivery
 *   POST /sessions/expire                                  every session token stops working (the adapter logs in again)
 *   POST /track { shipmentId | awb, status, location?, at?, webhook?, hold?, duplicates?, signature? }
 *       Moves a shipment to a status as Shiprocket words it ('PICKED UP', 'IN TRANSIT', 'OUT FOR DELIVERY', 'DELIVERED',
 *       'RTO INITIATED', 'RTO DELIVERED', ...). With webhook true (the default once a webhook URL is set and the shipment has
 *       an AWB) the tracking webhook is sent, carrying the token in x-api-key. duplicates sends the same event again; hold
 *       keeps it back so POST /webhooks/flush { order: 'reverse' } can deliver "delivered" before "in transit".
 *   POST /webhooks/url { url }    POST /webhooks/flush { order? }    POST /webhooks/redeliver { id, times? }    GET /webhooks
 *   GET  /state
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';
import { createWebhooks, webhookControls } from '../webhooks.mjs';

const shiprocketError = (status, message) => new SimError(status, { message, status_code: status });
const STATUS_CODES = { NEW: 1, 'AWB ASSIGNED': 3, 'PICKUP SCHEDULED': 4, 'PICKED UP': 42, SHIPPED: 6, 'IN TRANSIT': 18, 'OUT FOR DELIVERY': 17, UNDELIVERED: 21, DELIVERED: 7, 'RTO INITIATED': 9, 'RTO DELIVERED': 10, CANCELED: 5, LOST: 12 };
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function createShiprocket({ email = 'sim@bhava.test', password = 'sim-shiprocket-password', webhookToken = 'sim-shiprocket-webhook-token', webhookUrl = null, users = [] } = {}) {
  let sessions;
  let shipments;
  let pickups;
  let unserved;
  let seq;
  const logins = new Map([[email, password], ...users.map((u) => [u.email, u.password])]);
  const clear = () => {
    sessions = new Map();
    shipments = new Map();
    pickups = new Map();
    unserved = new Map();
    seq = 0;
  };
  clear();

  function requireSession(req) {
    const value = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!sessions.has(value)) throw shiprocketError(401, 'Token has expired or is not valid.');
    return sessions.get(value);
  }
  const byAwb = (awb) => [...shipments.values()].find((s) => s.awb_code && s.awb_code === String(awb));

  let sim = null;
  const hooks = createWebhooks({
    clock: { now: () => sim.clock.now() },
    url: webhookUrl,
    sign: (_raw, _payload, { bad }) => ({ 'x-api-key': bad ? `${webhookToken}-wrong` : webhookToken }),
  });

  function create(req, kind) {
    const owner = requireSession(req);
    const body = req.body ?? {};
    if (!body.order_id || !Array.isArray(body.order_items) || !body.order_items.length) throw shiprocketError(422, 'order_id and order_items are required.');
    if (body.pickup_location !== undefined && kind === 'forward' && !pickups.has(`${owner}:${body.pickup_location}`)) throw shiprocketError(422, 'Wrong Pickup location entered.');
    const n = ++seq;
    const shipment = {
      order_id: 1000 + n, shipment_id: 2000 + n, channel_order_id: body.order_id, status: 'NEW', status_code: 1, onboarding_completed_now: 0, awb_code: '', courier_company_id: '', courier_name: '',
      owner, kind, pickup_location: body.pickup_location ?? '', payment_method: body.payment_method ?? 'Prepaid', cod_amount: body.payment_method === 'COD' ? Number(body.sub_total) || 0 : 0,
      weight: Number(body.weight) || 0, shipper: body.pickup_location ? pickups.get(`${owner}:${body.pickup_location}`) ?? null : null, scans: [],
    };
    shipments.set(String(shipment.shipment_id), shipment);
    const { owner: _owner, scans: _scans, shipper: _shipper, kind: _kind, ...view } = shipment;
    return view;
  }

  sim = createSim({
    name: 'shiprocket',
    errorBody: ({ status, kind }) => ({ message: `Simulated ${kind}.`, status_code: status }),
    reset: () => {
      clear();
      hooks.reset();
    },
    routes: (on) => {
      on('POST', '/v1/external/auth/login', (req) => {
        if (!req.body?.email || logins.get(req.body.email) !== req.body.password) throw shiprocketError(403, 'Invalid email and password combination');
        const token = `sr-sim-${crypto.randomBytes(16).toString('hex')}`;
        sessions.set(token, req.body.email);
        return { id: 1, email: req.body.email, token };
      });
      on('GET', '/v1/external/courier/serviceability', (req) => {
        requireSession(req);
        const { pickup_postcode: pickup, delivery_postcode: delivery } = req.query;
        if (!/^\d{6}$/.test(pickup ?? '') || !/^\d{6}$/.test(delivery ?? '')) throw shiprocketError(422, 'pickup_postcode and delivery_postcode must be 6 digits.');
        const rule = unserved.get(delivery) ?? { serviceable: true, cod: true };
        if (!rule.serviceable) return { status: 404, message: 'No courier is serviceable for this pincode.', data: { available_courier_companies: [] } };
        return { status: 200, data: { available_courier_companies: [{ courier_company_id: 1, courier_name: 'Simulated Courier', rate: 49, estimated_delivery_days: '3', cod: rule.cod ? 1 : 0 }] } };
      });
      on('POST', '/v1/external/settings/company/addpickup', (req) => {
        const owner = requireSession(req);
        const { pickup_location: code, name, address, city, state, pin_code: pin, phone } = req.body ?? {};
        if (!code || !name || !address || !/^\d{6}$/.test(String(pin ?? ''))) throw shiprocketError(422, 'pickup_location, name, address and pin_code are required.');
        if (pickups.has(`${owner}:${code}`)) throw shiprocketError(422, 'Address nick name already in use');
        pickups.set(`${owner}:${code}`, { code, name, address, city: city ?? '', state: state ?? '', pin_code: String(pin), phone: phone ?? '' });
        return { success: true, address: { pickup_code: code } };
      });
      on('GET', '/v1/external/settings/company/pickup', (req) => {
        const owner = requireSession(req);
        const mine = [...pickups.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, p], i) => ({ id: i + 1, pickup_location: p.code, name: p.name, address: p.address, city: p.city, state: p.state, pin_code: p.pin_code, phone: p.phone, status: 2 }));
        return { data: { shipping_address: mine } };
      });
      on('POST', '/v1/external/orders/create/adhoc', (req) => create(req, 'forward'));
      on('POST', '/v1/external/orders/create/return', (req) => create(req, 'reverse'));
      on('POST', '/v1/external/courier/assign/awb', (req) => {
        const owner = requireSession(req);
        const shipment = shipments.get(String(req.body?.shipment_id));
        if (!shipment || shipment.owner !== owner) throw shiprocketError(404, 'Shipment not found.');
        if (!shipment.weight) throw shiprocketError(422, 'Weight is required to assign a courier.');
        if (!shipment.awb_code) Object.assign(shipment, { awb_code: `SIM${String(shipment.shipment_id).padStart(9, '0')}`, courier_company_id: 1, courier_name: 'Simulated Courier', status: 'AWB ASSIGNED', status_code: 3, freight_charges: 49 });
        return { awb_assign_status: 1, response: { data: { awb_code: shipment.awb_code, courier_name: shipment.courier_name, courier_company_id: 1, shipment_id: shipment.shipment_id, freight_charges: shipment.freight_charges } } };
      });
      on('POST', '/v1/external/courier/generate/pickup', (req) => {
        const owner = requireSession(req);
        const shipment = shipments.get(String([].concat(req.body?.shipment_id ?? [])[0]));
        if (!shipment || shipment.owner !== owner) throw shiprocketError(404, 'Shipment not found.');
        if (!shipment.awb_code) throw shiprocketError(422, 'Assign an AWB first.');
        if (shipment.status === 'AWB ASSIGNED') Object.assign(shipment, { status: 'PICKUP SCHEDULED', status_code: 4 });
        return { pickup_status: 1, response: { pickup_scheduled_date: stamp(sim.clock.now()) } };
      });
      on('POST', '/v1/external/courier/generate/label', (req) => {
        const owner = requireSession(req);
        const shipment = shipments.get(String([].concat(req.body?.shipment_id ?? [])[0]));
        if (!shipment || shipment.owner !== owner) throw shiprocketError(404, 'Shipment not found.');
        if (!shipment.awb_code) return { label_created: 0, response: 'AWB not assigned' };
        return { label_created: 1, label_url: `${sim.url}/labels/${shipment.shipment_id}.pdf`, shipper: shipment.shipper, cod_amount: shipment.cod_amount };
      });
      on('GET', '/labels/:file', (req) => {
        const shipment = shipments.get(String(req.params.file).replace(/\.pdf$/, ''));
        if (!shipment) throw shiprocketError(404, 'No such label.');
        return { awb: shipment.awb_code, shipper: shipment.shipper, cod_amount: shipment.cod_amount, payment_method: shipment.payment_method };
      });
      const tracking = (shipment) => ({ tracking_data: { track_status: 1, shipment_status: shipment.status_code, shipment_track: [{ id: shipment.shipment_id, awb_code: shipment.awb_code, current_status: shipment.status }], shipment_track_activities: shipment.scans } });
      on('GET', '/v1/external/courier/track/shipment/:id', (req) => {
        requireSession(req);
        const shipment = shipments.get(req.params.id);
        if (!shipment) throw shiprocketError(404, 'Shipment not found.');
        return tracking(shipment);
      });
      on('GET', '/v1/external/courier/track/awb/:awb', (req) => {
        requireSession(req);
        const shipment = byAwb(req.params.awb);
        if (!shipment) throw shiprocketError(404, 'AWB not found.');
        return tracking(shipment);
      });
      on('POST', '/v1/external/orders/cancel/shipment/awbs', (req) => {
        const owner = requireSession(req);
        for (const awb of [].concat(req.body?.awbs ?? [])) {
          const shipment = byAwb(awb);
          if (!shipment || shipment.owner !== owner) throw shiprocketError(404, 'AWB not found.');
          if (['DELIVERED', 'RTO DELIVERED'].includes(shipment.status)) throw shiprocketError(422, 'A delivered shipment cannot be cancelled.');
          Object.assign(shipment, { status: 'CANCELED', status_code: 5 });
        }
        return { message: 'Bulk Shipment cancellation is in progress.' };
      });
    },
    controls: (on) => {
      webhookControls(on, hooks);
      on('POST', '/serviceability', ({ body }) => {
        if (!/^\d{6}$/.test(String(body.pincode ?? ''))) throw new SimError(400, { error: 'pincode must be 6 digits.' });
        unserved.set(String(body.pincode), { serviceable: body.serviceable ?? true, cod: body.cod ?? true });
        return { ok: true };
      });
      on('POST', '/sessions/expire', () => {
        sessions.clear();
        return { ok: true };
      });
      on('POST', '/track', async ({ body }) => {
        const shipment = body.awb ? byAwb(body.awb) : shipments.get(String(body.shipmentId));
        if (!shipment) throw new SimError(404, { error: 'No such shipment.' });
        const status = String(body.status ?? shipment.status).toUpperCase();
        const at = body.at ?? stamp(sim.clock.now());
        Object.assign(shipment, { status, status_code: STATUS_CODES[status] ?? 0 });
        shipment.scans.unshift({ date: at, activity: status, 'sr-status-label': status, location: body.location ?? 'Simulated hub' });
        const wants = body.webhook ?? Boolean(hooks.url && shipment.awb_code);
        if (!wants) return { ok: true };
        const payload = {
          awb: shipment.awb_code, courier_name: shipment.courier_name, current_status: status, current_status_id: STATUS_CODES[status] ?? 0, shipment_status: status, shipment_status_id: STATUS_CODES[status] ?? 0,
          current_timestamp: at, order_id: shipment.channel_order_id, sr_order_id: shipment.order_id, pickup_location: shipment.pickup_location, is_return: shipment.kind === 'reverse' ? 1 : 0,
          scans: shipment.scans.slice(0, 5),
        };
        return { ok: true, webhook: await hooks.send(payload, { duplicates: body.duplicates, hold: body.hold, signature: body.signature }) };
      });
      on('GET', '/state', () => ({ shipments: [...shipments.values()], pickups: [...pickups.entries()].map(([key, value]) => ({ key, ...value })) }));
    },
  });

  return Object.assign(sim, { webhooks: hooks, webhookToken });
}
