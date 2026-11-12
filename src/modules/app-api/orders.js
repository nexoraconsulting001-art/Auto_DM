import { INDIAN_STATES } from '../../contracts/orders.js';
import { APP_ROUTES, AppPageQuery, PricedLine } from '../../contracts/store-routes.js';
import { currentTenant, tenantId } from '../../tenancy.js';
import { loadBuyerLayout } from '../../views/buyer/index.js';
import { cartRepo } from '../cart/repo.js';
import { buyable, priceLines, publicLine } from '../checkout/pricing.js';
import { loyaltyFor } from '../loyalty/index.js';
import { shopperServices } from '../shoppers/index.js';
import { trackingToken } from '../shipping/util.js';
import { parseBody } from '../storefront/http.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { appCall, cursorNumber, notFound } from './http.js';

/**
 * The shopper's own orders in the app (PRD 10.7, 10.14): the list, one order, an order by its token (for the payment tab and a
 * guest), reorder and rewards. Only this shopper's orders at this business: a shared profile (9.22) never brings another
 * brand's orders (P-70). Reorder prices every line from today's catalog and stock through the cart's own pricing, names what
 * is gone, never copies an old price and never places an order: it only fills the cart (P-64).
 */
const CANCELLABLE = new Set(['pending', 'new', 'packed', 'ready_to_ship']);
const PAID = new Set(['paid', 'cod_due', 'advance_paid', 'partially_refunded', 'refunded']);
const STEP_WORDS = Object.freeze({
  created: 'Order received by the courier', awb_assigned: 'Packed', pickup_scheduled: 'Pickup scheduled', picked_up: 'Picked up', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', undelivered: 'Delivery attempted', delivered: 'Delivered', rto_initiated: 'Returning to the seller',
  rto_delivered: 'Returned to the seller', cancelled: 'Shipment cancelled', lost: 'Delayed',
});
const ORDER_COLS = `id, order_number, public_token, flow, fulfilment_status, payment_status, payment_mode, subtotal_paise, discount_paise, loyalty_paise, shipping_paise,
  cod_fee_paise, tax_paise, total_paise, advance_paise, balance_paise, shipping_address, customer_name, address, city, state, pincode, created_at, shipped_at`;

const n = (value) => Number(value ?? 0);
const addressKey = (a) => `${String(a?.line1 ?? '').trim()}|${String(a?.pincode ?? '').trim()}|${String(a?.name ?? '').trim()}`.toLowerCase();

function nextStep(order) {
  if (PAID.has(order.payment_status)) return 'done';
  if (order.fulfilment_status === 'cancelled' || order.payment_status === 'voided') return 'failed';
  if (order.payment_status === 'unpaid' && order.fulfilment_status === 'pending' && order.payment_mode !== 'cod') return 'pay';
  return 'pending';
}

function describe(entry) {
  const on = entry.order_number ? ` ${entry.order_number}` : '';
  switch (entry.kind) {
    case 'earn': return entry.status === 'void' ? `Order${on} was cancelled or refunded` : entry.status === 'pending' ? `Earned on order${on}, usable after the return window` : `Earned on order${on}`;
    case 'redeem': return `Used on order${on}`;
    case 'reverse': return `Taken back: order${on} was refunded`;
    case 'restore': return `Given back: order${on} was cancelled`;
    case 'expire': return 'Expired';
    case 'referral': return entry.status === 'pending' ? 'A friend’s first order, usable after their return window' : 'A friend’s first order';
    default: return 'From the store';
  }
}

export function mountOrderRoutes(app, ctx) {
  const { db, repos } = ctx;
  const carts = cartRepo(db);

  async function ownOrder(shopperId, orderNumber) {
    const number = String(orderNumber ?? '');
    // No order number is that long or holds a control character (a NUL would be the database's error, not a 404).
    if (!number || number.length > 40 || /[\u0000-\u001f\u007f]/.test(number)) return null;
    const [order] = await db.query(`SELECT ${ORDER_COLS} FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND order_number = $3 AND erased_at IS NULL`, [tenantId(), shopperId, number]);
    return order ?? null;
  }
  const itemsOf = (orderId) => db.query(
    `SELECT i.product_id, i.variant_id, i.name, i.option_value, i.qty, i.price_paise, i.image, p.slug
     FROM order_items i LEFT JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id WHERE i.tenant_id = $1 AND i.order_id = $2 ORDER BY i.id`,
    [tenantId(), orderId],
  );

  app.get(APP_ROUTES.appOrders.path, appCall(async (req) => {
    const query = parseBody(AppPageQuery, req.query);
    const before = cursorNumber(query.cursor, 0) || null;
    const rows = await db.query(
      `SELECT o.id, o.order_number, o.public_token, o.fulfilment_status, o.payment_status, o.total_paise, o.created_at,
              (SELECT COALESCE(sum(i.qty), 0)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count,
              (SELECT i.image FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id ORDER BY i.id LIMIT 1) AS image
       FROM orders o WHERE o.tenant_id = $1 AND o.shopper_id = $2 AND o.erased_at IS NULL AND ($3::int IS NULL OR o.id < $3)
       ORDER BY o.id DESC LIMIT $4`,
      [tenantId(), req.appSession.shopperId, before, query.limit + 1],
    );
    const shown = rows.slice(0, query.limit);
    return {
      body: {
        items: shown.map((o) => ({
          orderNumber: o.order_number, token: o.public_token ?? '', placedAt: o.created_at, fulfilmentStatus: o.fulfilment_status, paymentStatus: o.payment_status,
          totalPaise: n(o.total_paise), itemCount: o.item_count, image: o.image ?? '',
        })),
        nextCursor: rows.length > query.limit ? String(shown.at(-1).id) : null,
      },
    };
  }));

  app.get(APP_ROUTES.appOrder.path, appCall(async (req) => {
    const order = await ownOrder(req.appSession.shopperId, req.params.orderNumber);
    if (!order) throw notFound('We couldn’t find that order in your account.');
    const tid = tenantId();
    const [items, events, shipments, invoices, returnsOn] = await Promise.all([
      itemsOf(order.id),
      db.query(`SELECT to_status, created_at FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND entity = 'order' AND to_status <> '' ORDER BY id`, [tid, order.id]),
      db.query(`SELECT id, status, awb, courier_name FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = 'forward' ORDER BY id`, [tid, order.id]),
      db.query('SELECT number FROM invoices WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tid, order.id]),
      repos.entitlements.can('store.returns'),
    ]);
    const scans = shipments.length
      ? await db.query(`SELECT shipment_id, status, location, occurred_at FROM shipment_events WHERE tenant_id = $1 AND shipment_id = ANY($2::bigint[]) AND status <> '' ORDER BY occurred_at DESC, id DESC`, [tid, shipments.map((s) => s.id)])
      : [];
    const a = order.shipping_address ?? { name: order.customer_name, line1: order.address, city: order.city, state: order.state, pincode: order.pincode };
    const token = order.public_token ?? '';
    const track = token ? trackingToken(tid, order.id, token) : null;
    const timeline = [{ status: 'placed', at: order.created_at }];
    for (const e of events) if (timeline.at(-1).status !== e.to_status) timeline.push({ status: e.to_status, at: e.created_at });
    return {
      body: {
        orderNumber: order.order_number, token, placedAt: order.created_at, fulfilmentStatus: order.fulfilment_status, paymentStatus: order.payment_status,
        totalPaise: n(order.total_paise), itemCount: items.reduce((sum, i) => sum + i.qty, 0), image: items[0]?.image ?? '', paymentMode: order.payment_mode,
        lines: items.map((i) => ({ name: i.name, option: i.option_value ?? '', qty: i.qty, unitPaise: n(i.price_paise), linePaise: n(i.price_paise) * i.qty, image: i.image ?? '', productSlug: i.slug ?? '' })),
        totals: {
          subtotalPaise: n(order.subtotal_paise), discountPaise: n(order.discount_paise), loyaltyPaise: n(order.loyalty_paise), shippingPaise: n(order.shipping_paise),
          codFeePaise: n(order.cod_fee_paise), taxPaise: n(order.tax_paise), totalPaise: n(order.total_paise), advancePaise: n(order.advance_paise), balancePaise: n(order.balance_paise),
        },
        address: {
          name: a.name ?? '', line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', state: a.state || INDIAN_STATES[a.stateCode] || '', pincode: a.pincode ?? '',
        },
        timeline,
        shipments: shipments.map((s) => ({
          courier: s.courier_name ?? '', awb: s.awb ?? '', status: s.status, expectedAt: null, trackingPath: track ? `/track/${track}` : '',
          scans: scans.filter((e) => e.shipment_id === s.id).map((e) => ({ at: e.occurred_at, text: STEP_WORDS[e.status] ?? '', location: e.location ?? '' })).filter((e) => e.text),
        })),
        invoices: token ? invoices.map((inv) => ({ number: inv.number, path: `/order/${encodeURIComponent(token)}/invoice/${encodeURIComponent(inv.number)}` })) : [],
        canCancel: order.flow === 'checkout' && CANCELLABLE.has(order.fulfilment_status) && !order.shipped_at,
        canReturn: returnsOn && order.fulfilment_status === 'delivered',
        canReorder: items.some((i) => i.product_id !== null),
      },
    };
  }));

  // An order by its unguessable token: the payment tab's answer, with no name, phone or address.
  app.get(APP_ROUTES.appOrderByToken.path, appCall(async (req) => {
    const token = String(req.params.token ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(token)) throw notFound('We couldn’t find that order.');
    const [order] = await db.query('SELECT order_number, fulfilment_status, payment_status, payment_mode, total_paise FROM orders WHERE tenant_id = $1 AND public_token = $2 AND erased_at IS NULL', [tenantId(), token]);
    if (!order) throw notFound('We couldn’t find that order.');
    return {
      body: {
        orderNumber: order.order_number, fulfilmentStatus: order.fulfilment_status, paymentStatus: order.payment_status, totalPaise: n(order.total_paise),
        next: nextStep(order), payPath: `/order/${encodeURIComponent(token)}`,
      },
    };
  }));

  // Reorder: today's catalog, today's prices, today's stock. Fills the cart and nothing else.
  app.post(APP_ROUTES.appReorder.path, appCall(async (req) => {
    const shopperId = req.appSession.shopperId;
    const order = await ownOrder(shopperId, req.params.orderNumber);
    if (!order) throw notFound('We couldn’t find that order in your account.');
    const items = await itemsOf(order.id);
    const missing = [];
    const wanted = [];
    for (const item of items) {
      // A line whose product (or its chosen option) no longer exists can't be bought again.
      if (item.product_id === null || (item.option_value && item.variant_id === null)) missing.push({ name: item.name, option: item.option_value ?? '', reason: 'removed' });
      else wanted.push({ productId: item.product_id, variantId: item.variant_id, qty: item.qty, item });
    }
    const priced = await priceLines(db, wanted);
    const add = [];
    let priceChanged = false;
    priced.lines.forEach((line, i) => {
      const item = wanted.find((w) => w.productId === line.productId && (w.variantId === null || w.variantId === line.variantId))?.item ?? wanted[i]?.item;
      if (!buyable(line)) {
        missing.push({ name: line.name || item?.name || '', option: line.option || item?.option_value || '', reason: line.state === 'sold_out' ? 'sold_out' : 'inactive' });
        return;
      }
      if (item && Number(item.price_paise) !== line.unitPaise) priceChanged = true;
      add.push({ productId: line.productId, variantId: line.stockVariantId ?? null, qty: line.qty });
    });
    const kept = add.length ? await carts.add(shopperId, add, { visitorId: visitorIdFrom(req) }) : await carts.lines(shopperId);
    const cart = await priceLines(db, kept);
    // A line this reorder touched that today's stock (or the per-line cap) holds below what the bag asks for.
    const touched = new Set(add.map((l) => `${l.productId}:${l.variantId ?? ''}`));
    const capped = cart.lines.filter((l) => l.state === 'capped' && touched.has(`${l.productId}:${l.stockVariantId ?? ''}`)).map((l) => ({ name: l.name, qty: l.qty }));
    const notices = [];
    if (missing.length) notices.push(missing.length === 1 ? `${missing[0].name} can’t be ordered again right now.` : `${missing.length} items can’t be ordered again right now.`);
    for (const c of capped) notices.push(`${c.name}: only ${c.qty} can be ordered right now.`);
    if (priceChanged) notices.push('Some prices have changed since this order. Your bag shows today’s prices.');

    const { service } = shopperServices(ctx);
    const own = await service.addresses.list(shopperId);
    const before = addressKey(order.shipping_address ?? { name: order.customer_name, line1: order.address, pincode: order.pincode });
    const match = own.find((a) => addressKey(a) === before) ?? own.find((a) => a.isDefault) ?? own[0] ?? null;
    return {
      body: {
        lines: cart.lines.map((l) => PricedLine.parse(publicLine(l))),
        added: add.length,
        missing,
        capped,
        addressId: match?.id ?? null,
        notices,
      },
    };
  }));

  app.get(APP_ROUTES.appRewards.path, appCall(async (req) => {
    const shopperId = req.appSession.shopperId;
    const loyalty = loyaltyFor(ctx);
    const settings = await loyalty.active();
    if (!settings) return { body: { enabled: false, pointsBalance: 0, pendingPoints: 0, valuePaise: 0, expiring: null, history: [], referral: null } };
    const [account, history, [soon]] = await Promise.all([
      loyalty.account(shopperId),
      loyalty.history(shopperId, 20),
      db.query(
        `SELECT expires_at, sum(points)::int AS points FROM loyalty_ledger WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'posted' AND points > 0 AND expires_at > now()
         GROUP BY expires_at ORDER BY expires_at LIMIT 1`,
        [tenantId(), shopperId],
      ),
    ]);
    let referral = null;
    if (settings.referralEnabled) {
      const code = await loyalty.referrals.codeFor(shopperId);
      // The business's own address: its verified primary domain, else the address its app opens links for, else this host.
      const host = currentTenant()?.primary_domain || req.appRequest.config.shop_domain || req.hostname;
      const url = `https://${host}/refer/${encodeURIComponent(code)}`;
      const { business } = await loadBuyerLayout(repos);
      referral = { code, url, text: `Shop at ${business.name || 'my favourite store'} with my link: ${url}` };
    }
    return {
      body: {
        enabled: true,
        pointsBalance: account.balance,
        pendingPoints: account.pending,
        valuePaise: account.balance * settings.pointValuePaise,
        expiring: soon && account.balance > 0 ? { points: Math.min(soon.points, account.balance), at: soon.expires_at } : null,
        history: history.map((e) => ({ at: e.created_at, points: e.points, reason: describe(e), orderNumber: e.order_number ?? null })),
        referral,
      },
    };
  }));
}
