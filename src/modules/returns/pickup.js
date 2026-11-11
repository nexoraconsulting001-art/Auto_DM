import { ProviderError } from '../../adapters/http.js';
import { INDIAN_STATES } from '../../contracts/orders.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { changeRow } from '../orders/state.js';

/**
 * The reverse pickup of an approved return (PRD 9.17): on the same courier mode as the business's forward shipping (9.10),
 * managed on the platform's Shiprocket account or the seller's own API user.
 *
 *   reverseShipment(t, { ret, order })   inside the approval's transaction: the shipments row (kind 'reverse', status
 *                                        'created'), so the return names its parcel whatever the courier then says
 *   bookPickup(ctx, shipmentId, ret)     after commit: the courier's return order, its AWB and the pickup request. Never
 *                                        inside a transaction. Returns { booked, reason }
 *
 * The courier's tracking webhook moves the shipment (the shipping module's), and its shipment.* events move the return.
 */
const DEFAULT_WEIGHT_GRAMS = 500;
const DEFAULT_CM = 10;

/** The courier settings this business ships with. No row means the managed account, as for forward shipping. */
async function shippingOf(q) {
  const [row] = await q.query('SELECT mode, pickup_location, own_email, own_password_enc FROM shipping_settings WHERE tenant_id = $1', [tenantId()]);
  return row ?? { mode: 'managed', pickup_location: '', own_email: '', own_password_enc: '' };
}

export async function reverseShipment(t, { ret, order }) {
  const settings = await shippingOf(t);
  const lines = await t.query(
    `SELECT ri.qty, oi.weight_grams, p.length_cm, p.breadth_cm, p.height_cm
     FROM return_items ri JOIN order_items oi ON oi.tenant_id = ri.tenant_id AND oi.id = ri.order_item_id
     LEFT JOIN products p ON p.tenant_id = oi.tenant_id AND p.id = oi.product_id
     WHERE ri.tenant_id = $1 AND ri.return_id = $2`,
    [tenantId(), ret.id],
  );
  const weight = Math.max(1, lines.reduce((sum, l) => sum + (Number(l.weight_grams) || DEFAULT_WEIGHT_GRAMS) * l.qty, 0));
  const side = (key) => Math.max(1, ...lines.map((l) => Number(l[key]) || DEFAULT_CM));
  const [shipment] = await t.query(
    `INSERT INTO shipments (tenant_id, order_id, kind, mode, provider, weight_grams, length_cm, breadth_cm, height_cm, cod_paise, pickup_location)
     VALUES ($1, $2, 'reverse', $3, 'shiprocket', $4, $5, $6, $7, 0, $8) RETURNING *`,
    [tenantId(), order.id, settings.mode === 'own' ? 'own' : 'managed', weight, side('length_cm'), side('breadth_cm'), side('height_cm'), String(settings.pickup_location ?? '').slice(0, 36)],
  );
  return shipment;
}

/** The courier client for this business's mode. Throws when the seller's own account can't be used. */
async function courierFor(ctx, settings) {
  const shiprocket = ctx.providers?.shiprocket;
  if (!shiprocket) throw new Error('No courier adapter');
  if (settings.mode !== 'own') return shiprocket;
  if (!settings.own_email || !settings.own_password_enc) throw new Error('The seller’s own courier account isn’t connected');
  return shiprocket.forAccount({ email: settings.own_email, password: ctx.platform.secrets.decrypt(settings.own_password_enc) });
}

export async function bookPickup(ctx, shipmentId, ret) {
  const { db } = ctx;
  const [shipment] = await db.query('SELECT * FROM shipments WHERE tenant_id = $1 AND id = $2', [tenantId(), shipmentId]);
  if (!shipment || shipment.kind !== 'reverse') return { booked: false, reason: 'no_shipment' };
  if (!['created', 'awb_assigned'].includes(shipment.status)) return { booked: true, reason: 'already' };
  const [order] = await db.query('SELECT order_number, shipping_address FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), shipment.order_id]);
  const items = await db.query(
    `SELECT oi.id, oi.name, oi.sku, oi.hsn_code, oi.price_paise, ri.qty FROM return_items ri
     JOIN order_items oi ON oi.tenant_id = ri.tenant_id AND oi.id = ri.order_item_id
     WHERE ri.tenant_id = $1 AND ri.return_id = $2 ORDER BY ri.id`,
    [tenantId(), ret.id],
  );
  const a = order?.shipping_address ?? {};
  const from = {
    name: String(a.name ?? ''), phone: String(a.phone ?? ''), line1: String(a.line1 ?? ''), line2: [a.line2, a.landmark].filter(Boolean).join(', '),
    city: String(a.city ?? ''), state: INDIAN_STATES[a.stateCode] ?? '', pincode: String(a.pincode ?? ''),
  };
  const settings = await shippingOf(db);
  try {
    const courier = await courierFor(ctx, settings);
    let providerShipmentId = shipment.provider_shipment_id;
    if (!providerShipmentId) {
      const made = await courier.createReturn({
        orderNumber: `${order.order_number}-R${ret.id}`.slice(0, 50),
        pickupLocation: shipment.pickup_location || undefined,
        shipTo: from,
        items: items.map((i) => ({ id: i.id, name: i.name, sku: i.sku, hsnCode: i.hsn_code, qty: i.qty, pricePaise: Number(i.price_paise) })),
        weightGrams: shipment.weight_grams,
        lengthCm: shipment.length_cm,
        breadthCm: shipment.breadth_cm,
        heightCm: shipment.height_cm,
        codPaise: 0,
        subTotalPaise: items.reduce((sum, i) => sum + Number(i.price_paise) * i.qty, 0),
      });
      providerShipmentId = made.providerShipmentId;
      // Kept at once, so a retry after a later failure never makes a second return order at the courier.
      await db.query('UPDATE shipments SET provider_order_id = $3, provider_shipment_id = $4 WHERE tenant_id = $1 AND id = $2', [tenantId(), shipment.id, made.providerOrderId.slice(0, 60), providerShipmentId.slice(0, 60)]);
    }
    if (!shipment.awb) {
      const awb = await courier.assignAwb({ providerShipmentId });
      await db.tx((t) => changeRow(t, 'shipments', shipment.id, 'awb_assigned', {
        ifAllowed: true, set: { awb: awb.awb, courier_name: String(awb.courierName ?? '').slice(0, 80), charge_paise: Math.max(0, Number(awb.chargePaise) || 0) },
      }));
    }
    const pickup = await courier.requestPickup({ providerShipmentId });
    if (!pickup.scheduled) {
      ctx.orderEvents?.kick?.();
      log.warn('returns.pickup_failed', { returnId: Number(ret.id), shipmentId: Number(shipment.id), kind: 'not_scheduled' });
      return { booked: false, reason: 'not_scheduled' };
    }
    await db.tx(async (t) => {
      await changeRow(t, 'shipments', shipment.id, 'pickup_scheduled', { ifAllowed: true });
      await changeRow(t, 'returns', ret.id, 'pickup_scheduled', { ifAllowed: true });
    });
    ctx.orderEvents?.kick?.();
    log.info('returns.pickup_booked', { returnId: Number(ret.id), shipmentId: Number(shipment.id) });
    return { booked: true, reason: 'scheduled' };
  } catch (err) {
    const kind = err instanceof ProviderError ? err.kind : 'setup';
    log.warn('returns.pickup_failed', { returnId: Number(ret.id), shipmentId: Number(shipment.id), kind });
    return { booked: false, reason: kind };
  }
}
