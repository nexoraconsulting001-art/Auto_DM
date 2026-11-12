import crypto from 'node:crypto';
import { DEFAULT_TIMEOUT_MS, ProviderError, createHttp, providerUrl, sameBytes } from '../http.js';

/**
 * Shiprocket (PRD 9.10). One client; `account` says whose courier account a call runs on:
 *   managed  Bhava's master account (SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD), one pickup location per seller
 *   own      the seller's own API user: { email, password }, decrypted by the caller from shipping_settings
 * ctx.providers.shiprocket.forAccount(account) binds one; called directly, it is the managed account.
 *
 *   serviceability({ pickupPincode, deliveryPincode, weightGrams, cod }) -> { serviceable, cod, couriers: [{ id, name, ratePaise, days, cod }] }
 *   addPickupLocation({ code, name, phone, email, line1, line2, city, state, pincode })   -> { code }
 *       On the managed account this is how a seller's pickup address joins Bhava's master account (PRD 5.6): `code` is the
 *       business's own (unique on the account), and a code already there with the same pincode is answered as added.
 *   pickupLocations()                                 -> [{ code, name, city, state, pincode, phone }]: what the account holds now,
 *       which is what the onboarding checklist's shipping step reads
 *   createOrder({ orderNumber, pickupLocation, shipTo, items, weightGrams, lengthCm, breadthCm, heightCm, codPaise, subTotalPaise })
 *       -> { providerOrderId, providerShipmentId }
 *       shipTo is the order's address snapshot. codPaise is what the courier collects: the order's balance, 0 for prepaid (S-21).
 *   assignAwb({ providerShipmentId, courierId? })     -> { awb, courierName, chargePaise }
 *   requestPickup({ providerShipmentId })             -> { scheduled }
 *   label({ providerShipmentId })                     -> { url }
 *   track({ awb })                                    -> { status, events: [{ status, providerStatus, location, at }] }
 *   cancel({ awb })                                   -> { cancelled }
 *   createReturn({ ...like createOrder, with pickup from the shopper })  -> { providerOrderId, providerShipmentId }
 *
 * The session token is fetched on first use, kept in memory per account and refreshed before it expires (and once more on
 * a 401). Every call has a 10 s timeout; reads retry with backoff, writes do not (look the shipment up before trying again).
 * SHIPROCKET_BASE_URL points at tools/sim/shiprocket, refused when NODE_ENV=production.
 *
 * Tracking webhooks: verifyWebhook(headerValue, token) compares the x-api-key header with the token set for the webhook
 * (SHIPROCKET_WEBHOOK_TOKEN for the managed account). mapStatus(providerStatus) gives one of SHIPMENT_STATUSES, or '' for a
 * scan that changes nothing.
 */
export const SHIPROCKET_HOST = 'https://apiv2.shiprocket.in';
const TOKEN_TTL_MS = 9 * 86_400_000; // Shiprocket's token lasts 10 days (to confirm); refresh a day early
const rupees = (paise) => Number((paise / 100).toFixed(2));
const toPaise = (value) => Math.round(Number(value || 0) * 100);

/** Shiprocket's status text, as it arrives in tracking and webhooks, to ours. Unknown text maps to ''. */
const STATUS_MAP = Object.freeze({
  'AWB ASSIGNED': 'awb_assigned', 'LABEL GENERATED': 'awb_assigned', 'PICKUP SCHEDULED': 'pickup_scheduled', 'PICKUP GENERATED': 'pickup_scheduled', 'OUT FOR PICKUP': 'pickup_scheduled',
  'PICKED UP': 'picked_up', SHIPPED: 'in_transit', 'IN TRANSIT': 'in_transit', 'REACHED AT DESTINATION HUB': 'in_transit', 'OUT FOR DELIVERY': 'out_for_delivery',
  UNDELIVERED: 'undelivered', DELIVERED: 'delivered', 'RTO INITIATED': 'rto_initiated', 'RTO IN TRANSIT': 'rto_initiated', 'RTO OFD': 'rto_initiated', 'RTO DELIVERED': 'rto_delivered',
  CANCELED: 'cancelled', CANCELLED: 'cancelled', LOST: 'lost',
});
export const mapStatus = (providerStatus) => STATUS_MAP[String(providerStatus ?? '').trim().toUpperCase()] ?? '';

export function verifyWebhook(headerValue, token) {
  return Boolean(token) && typeof headerValue === 'string' && sameBytes(headerValue, token);
}

export function createShiprocket(config = {}, { env = process.env, now = () => Date.now() } = {}) {
  const baseUrl = providerUrl({ value: config.shiprocketBaseUrl, real: SHIPROCKET_HOST, name: 'SHIPROCKET_BASE_URL', env });
  const request = createHttp({ provider: 'shiprocket', baseUrl, timeoutMs: config.providerTimeoutMs || DEFAULT_TIMEOUT_MS, codeOf: (body) => body?.status_code ?? '' });
  const sessions = new Map();

  function forAccount(account) {
    const creds = account?.email ? { email: account.email, password: account.password } : { email: config.shiprocketEmail, password: config.shiprocketPassword };
    // A session belongs to an email and its password together, so a changed password never rides on an old session.
    const key = `${creds.email ?? ''}\n${crypto.createHash('sha256').update(String(creds.password ?? '')).digest('hex')}`;

    async function token(fresh = false) {
      const held = sessions.get(key);
      if (!fresh && held && held.expiresAt > now()) return held.token;
      if (!creds.email || !creds.password) throw new Error('Shiprocket needs an account: SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD, or the seller’s own API user');
      const { body } = await request('POST', '/v1/external/auth/login', { json: creds, retries: 1 });
      if (!body?.token) throw new ProviderError({ provider: 'shiprocket', kind: 'malformed', delivery: 'none' });
      sessions.set(key, { token: body.token, expiresAt: now() + TOKEN_TTL_MS });
      return body.token;
    }

    async function call(method, path, options = {}) {
      try {
        return await request(method, path, { ...options, headers: { authorization: `Bearer ${await token()}` } });
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'auth') throw err;
        // The token was refused: get a new one, once. A refused call did nothing, so repeating it is safe.
        return request(method, path, { ...options, headers: { authorization: `Bearer ${await token(true)}` } });
      }
    }

    const orderBody = ({ orderNumber, pickupLocation, shipTo, items, weightGrams, lengthCm, breadthCm, heightCm, codPaise = 0, subTotalPaise }) => ({
      order_id: orderNumber,
      order_date: new Date(now()).toISOString().slice(0, 16).replace('T', ' '),
      pickup_location: pickupLocation,
      billing_customer_name: shipTo.name,
      billing_address: shipTo.line1,
      billing_address_2: shipTo.line2 ?? '',
      billing_city: shipTo.city,
      billing_state: shipTo.state,
      billing_pincode: shipTo.pincode,
      billing_country: 'India',
      billing_phone: shipTo.phone,
      shipping_is_billing: true,
      order_items: items.map((i) => ({ name: i.name, sku: i.sku || `item-${i.id}`, units: i.qty, selling_price: rupees(i.pricePaise), hsn: i.hsnCode || undefined })),
      payment_method: codPaise > 0 ? 'COD' : 'Prepaid',
      sub_total: rupees(codPaise > 0 ? codPaise : subTotalPaise),
      weight: weightGrams / 1000,
      length: lengthCm,
      breadth: breadthCm,
      height: heightCm,
    });

    return {
      async serviceability({ pickupPincode, deliveryPincode, weightGrams = 500, cod = false }) {
        const { body } = await call('GET', '/v1/external/courier/serviceability', { query: { pickup_postcode: pickupPincode, delivery_postcode: deliveryPincode, weight: weightGrams / 1000, cod: cod ? 1 : 0 }, retries: 2 });
        const couriers = (body?.data?.available_courier_companies ?? []).map((c) => ({ id: c.courier_company_id, name: c.courier_name, ratePaise: toPaise(c.rate), days: Number(c.estimated_delivery_days) || null, cod: Boolean(Number(c.cod)) }));
        return { serviceable: couriers.length > 0, cod: couriers.some((c) => c.cod), couriers };
      },
      async addPickupLocation({ code, name, phone, email, line1, line2 = '', city, state, pincode }) {
        try {
          await call('POST', '/v1/external/settings/company/addpickup', { json: { pickup_location: code, name, email, phone, address: line1, address_2: line2, city, state, country: 'India', pin_code: pincode } });
        } catch (err) {
          // Asked twice (a retry, a second tab): the location is there already, which is what was wanted. A different address under the same code is still refused.
          const existing = (await this.pickupLocations().catch(() => [])).find((location) => location.code === code);
          if (!existing || existing.pincode !== String(pincode)) throw err;
        }
        return { code };
      },
      async pickupLocations() {
        const { body } = await call('GET', '/v1/external/settings/company/pickup', { retries: 2 });
        const list = body?.data?.shipping_address ?? [];
        return list.map((a) => ({ code: String(a.pickup_location ?? ''), name: String(a.name ?? ''), city: String(a.city ?? ''), state: String(a.state ?? ''), pincode: String(a.pin_code ?? ''), phone: String(a.phone ?? '') }));
      },
      async createOrder(input) {
        const { body } = await call('POST', '/v1/external/orders/create/adhoc', { json: orderBody(input) });
        return { providerOrderId: String(body.order_id), providerShipmentId: String(body.shipment_id) };
      },
      async createReturn(input) {
        const { body } = await call('POST', '/v1/external/orders/create/return', { json: orderBody(input) });
        return { providerOrderId: String(body.order_id), providerShipmentId: String(body.shipment_id) };
      },
      async assignAwb({ providerShipmentId, courierId }) {
        const { body } = await call('POST', '/v1/external/courier/assign/awb', { json: { shipment_id: providerShipmentId, ...(courierId ? { courier_id: courierId } : {}) } });
        const data = body?.response?.data ?? {};
        if (!data.awb_code) throw new ProviderError({ provider: 'shiprocket', kind: 'rejected', code: 'no_awb', delivery: 'none' });
        return { awb: String(data.awb_code), courierName: data.courier_name ?? '', chargePaise: toPaise(data.freight_charges ?? data.applied_weight_charges) };
      },
      async requestPickup({ providerShipmentId }) {
        const { body } = await call('POST', '/v1/external/courier/generate/pickup', { json: { shipment_id: [providerShipmentId] } });
        return { scheduled: Boolean(body?.pickup_status ?? body?.response) };
      },
      async label({ providerShipmentId }) {
        const { body } = await call('POST', '/v1/external/courier/generate/label', { json: { shipment_id: [providerShipmentId] } });
        return { url: body?.label_url ?? '' };
      },
      async track({ awb }) {
        const { body } = await call('GET', `/v1/external/courier/track/awb/${encodeURIComponent(awb)}`, { retries: 2 });
        const data = body?.tracking_data ?? {};
        const events = (data.shipment_track_activities ?? []).map((a) => ({ status: mapStatus(a['sr-status-label'] ?? a.activity), providerStatus: String(a['sr-status-label'] ?? a.activity ?? ''), location: a.location ?? '', at: new Date(a.date) }));
        return { status: mapStatus(data.shipment_track?.[0]?.current_status), events };
      },
      async cancel({ awb }) {
        await call('POST', '/v1/external/orders/cancel/shipment/awbs', { json: { awbs: [awb] } });
        return { cancelled: true };
      },
    };
  }

  return { forAccount, ...forAccount(null), mapStatus, verifyWebhook };
}
