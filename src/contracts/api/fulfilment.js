import { z } from 'zod';
import { RETURN_STATUSES, SHIPMENT_STATUSES } from '../orders.js';
import { MANAGERS, OWNER_ONLY, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, PaiseInput, Quantity, Timestamp, page, required, text } from './common.js';

/**
 * Shipping (PRD 9.10), stock (9.12), GST invoices (9.13) and returns (9.17), answered by src/modules/shipping, inventory,
 * invoices and returns.
 */
const orders = staffWith('orders');
const catalog = staffWith('catalog');
const Pincode = z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit PIN code');
const StateCode = z.string().regex(/^[0-9]{2}$/, 'Pick a state');

// ---- shipping ----
export const ShippingSettings = z.object({
  mode: z.enum(['managed', 'own']),
  pickupName: z.string(),
  pickupPhone: z.string(),
  pickupLine1: z.string(),
  pickupLine2: z.string(),
  pickupCity: z.string(),
  pickupStateCode: z.string(),
  pickupPincode: z.string(),
  pickupRegistered: z.boolean(),
  ownEmail: z.string(),
  /** Never the password itself: only whether one is saved. */
  ownPasswordSet: z.boolean(),
  chargeBilling: z.enum(['payout', 'monthly']),
});
export const ShippingSettingsUpdate = z.object({
  mode: z.enum(['managed', 'own']),
  pickupName: required(80),
  pickupPhone: required(16),
  pickupLine1: required(200),
  pickupLine2: text(200),
  pickupCity: required(60),
  pickupStateCode: StateCode,
  pickupPincode: Pincode,
  ownEmail: z.union([z.literal(''), z.email('Enter a valid email')]),
  ownPassword: z.string().min(1).max(200),
  chargeBilling: z.enum(['payout', 'monthly']),
}).partial();

export const Shipment = z.object({
  id: Id,
  orderId: Id,
  kind: z.enum(['forward', 'reverse']),
  mode: z.enum(['managed', 'own', 'self']),
  status: z.enum(SHIPMENT_STATUSES),
  awb: z.string().nullable(),
  courierName: z.string(),
  weightGrams: Count,
  lengthCm: Count,
  breadthCm: Count,
  heightCm: Count,
  /** What the courier collects at the door: the order's balance (S-21). */
  codPaise: Paise,
  /** What the courier charged, at cost (S-77). */
  chargePaise: Paise,
  /** The seller-branded tracking page on the seller's own domain (S-78), never the courier's. */
  trackingUrl: z.string(),
  hasLabel: z.boolean(),
  events: z.array(z.object({ status: z.string(), providerStatus: z.string(), location: z.string(), at: Timestamp })).optional(),
  createdAt: Timestamp,
  deliveredAt: Timestamp.nullable(),
});
/** "Ready to ship". Weight and size default to the products' own; a product with no weight is refused by name (S-34). */
export const ShipmentCreate = z.object({
  weightGrams: z.number().int().min(1).max(500000).optional(),
  lengthCm: z.number().int().min(1).max(500).optional(),
  breadthCm: z.number().int().min(1).max(500).optional(),
  heightCm: z.number().int().min(1).max(500).optional(),
});
export const ShipmentFile = z.object({ url: z.string() });
export const Serviceability = z.object({ pincode: z.string(), serviceable: z.boolean(), cod: z.boolean(), message: z.string() });

export const shippingRoutes = {
  'shippingSettings.get': { method: 'GET', path: '/shipping-settings', access: MANAGERS, response: ShippingSettings },
  'shippingSettings.update': { method: 'PATCH', path: '/shipping-settings', access: MANAGERS, fresh: true, body: ShippingSettingsUpdate, response: ShippingSettings },
  'shipping.serviceability': { method: 'GET', path: '/shipping/serviceability', access: orders, query: z.object({ pincode: Pincode }), response: Serviceability },
  'shipments.forOrder': { method: 'GET', path: '/orders/:id/shipments', access: orders, params: IdParams, response: z.object({ items: z.array(Shipment) }) },
  'shipments.create': { method: 'POST', path: '/orders/:id/shipments', access: orders, params: IdParams, body: ShipmentCreate, status: 201, response: Shipment },
  'shipments.get': { method: 'GET', path: '/shipments/:id', access: orders, params: IdParams, response: Shipment },
  'shipments.cancel': { method: 'POST', path: '/shipments/:id/cancel', access: orders, params: IdParams, response: Shipment },
  'shipments.label': { method: 'GET', path: '/shipments/:id/label', access: orders, params: IdParams, response: ShipmentFile },
};

// ---- stock ----
export const StockLine = z.object({
  productId: Id,
  variantId: Id.nullable(),
  name: z.string(),
  option: z.string(),
  sku: z.string(),
  /** Null means unlimited. */
  stock: z.number().int().nullable(),
  reserved: Count,
  available: z.number().int().nullable(),
  lowStockThreshold: z.number().int().nullable(),
  low: z.boolean(),
});
export const StockQuery = ListQuery.extend({ search: text(80).optional(), show: z.enum(['all', 'low', 'out']).default('all') });
/** Sets stock on hand to `stock` (null for unlimited), or moves it by `delta`. Exactly one of the two. */
export const StockAdjust = z.object({
  productId: Id,
  variantId: Id.nullable().default(null),
  stock: Quantity.nullable().optional(),
  delta: z.number().int().min(-1000000).max(1000000).optional(),
  lowStockThreshold: Quantity.nullable().optional(),
  note: text(200).optional(),
}).refine((b) => (b.stock !== undefined) !== (b.delta !== undefined) || (b.stock === undefined && b.delta === undefined && b.lowStockThreshold !== undefined), 'Give the new stock or a change, not both');
export const StockMovement = z.object({ id: Id, productId: Id, variantId: Id.nullable(), delta: z.number().int(), reason: z.string(), orderId: Id.nullable(), actor: z.string(), at: Timestamp });
export const InventorySettings = z.object({ lowStockThreshold: Count });

export const inventoryRoutes = {
  'inventory.list': { method: 'GET', path: '/inventory', access: catalog, query: StockQuery, response: page(StockLine) },
  'inventory.adjust': { method: 'POST', path: '/inventory/adjust', access: catalog, body: StockAdjust, response: StockLine },
  'inventory.movements': { method: 'GET', path: '/inventory/movements', access: catalog, query: ListQuery.extend({ productId: z.coerce.number().int().positive().optional() }), response: page(StockMovement) },
  'inventorySettings.get': { method: 'GET', path: '/inventory/settings', access: catalog, response: InventorySettings },
  'inventorySettings.update': { method: 'PATCH', path: '/inventory/settings', access: MANAGERS, body: z.object({ lowStockThreshold: Quantity }), response: InventorySettings },
};

// ---- invoices ----
export const InvoiceSettings = z.object({ legalName: z.string(), gstin: z.string(), stateCode: z.string(), address: z.string(), invoicePrefix: z.string() });
export const InvoiceSettingsUpdate = z.object({
  legalName: text(200),
  gstin: z.union([z.literal(''), z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN')]),
  stateCode: z.union([z.literal(''), StateCode]),
  address: text(400),
  invoicePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, 'Use up to 4 capital letters or digits'),
}).partial();
export const Invoice = z.object({
  id: Id,
  orderId: Id,
  docType: z.enum(['invoice', 'bill_of_supply', 'credit_note']),
  number: z.string(),
  issuedAt: Timestamp,
  taxablePaise: Paise,
  cgstPaise: Paise,
  sgstPaise: Paise,
  igstPaise: Paise,
  totalPaise: Paise,
  advancePaise: Paise,
  balancePaise: Paise,
  originalInvoiceId: Id.nullable(),
  fileUrl: z.string().nullable(),
});

export const invoiceRoutes = {
  'invoiceSettings.get': { method: 'GET', path: '/invoice-settings', access: MANAGERS, response: InvoiceSettings },
  'invoiceSettings.update': { method: 'PATCH', path: '/invoice-settings', access: OWNER_ONLY, body: InvoiceSettingsUpdate, response: InvoiceSettings },
  'invoices.list': { method: 'GET', path: '/invoices', access: orders, query: ListQuery.extend({ orderId: z.coerce.number().int().positive().optional() }), response: page(Invoice) },
  'invoices.get': { method: 'GET', path: '/invoices/:id', access: orders, params: IdParams, response: Invoice },
};

// ---- returns ----
export const ReturnSettings = z.object({ enabled: z.boolean(), windowDays: Count, eligibleCategoryIds: z.array(Id), proof: z.enum(['photo', 'video', 'either']) });
export const ReturnSettingsUpdate = z.object({ enabled: z.boolean(), windowDays: z.number().int().min(0).max(90), eligibleCategoryIds: z.array(Id).max(500), proof: z.enum(['photo', 'video', 'either']) }).partial();
export const ReturnRequest = z.object({
  id: Id,
  orderId: Id,
  orderNumber: z.string(),
  status: z.enum(RETURN_STATUSES),
  resolution: z.enum(['refund', 'exchange']),
  reason: z.string(),
  condition: z.enum(['good', 'not_restockable']).nullable(),
  restocked: z.boolean(),
  items: z.array(z.object({ orderItemId: Id, name: z.string(), qty: Count })),
  /** Shown only to the owner and staff with order access. Each fileUrl is short-lived and private. */
  proofs: z.array(z.object({ id: Id, kind: z.enum(['photo', 'video']), fileUrl: z.string() })),
  shipmentId: Id.nullable(),
  refundId: Id.nullable(),
  createdAt: Timestamp,
});
export const ReturnDecline = z.object({ note: required(500, 'Say why, for the shopper') });
/** Only 'good' goes back into stock (S-58). */
export const ReturnReceive = z.object({ condition: z.enum(['good', 'not_restockable']) });
export const ReturnClose = z.object({ resolution: z.enum(['refund', 'exchange']), refundPaise: PaiseInput.optional() });

export const returnRoutes = {
  'returnSettings.get': { method: 'GET', path: '/return-settings', access: MANAGERS, response: ReturnSettings },
  'returnSettings.update': { method: 'PATCH', path: '/return-settings', access: MANAGERS, body: ReturnSettingsUpdate, response: ReturnSettings },
  'returns.list': { method: 'GET', path: '/returns', access: orders, query: ListQuery.extend({ status: z.enum(RETURN_STATUSES).optional() }), response: page(ReturnRequest) },
  'returns.get': { method: 'GET', path: '/returns/:id', access: orders, params: IdParams, response: ReturnRequest },
  /** Approving books the reverse pickup on the same courier mode as forward shipping. */
  'returns.approve': { method: 'POST', path: '/returns/:id/approve', access: orders, params: IdParams, response: ReturnRequest },
  'returns.decline': { method: 'POST', path: '/returns/:id/decline', access: orders, params: IdParams, body: ReturnDecline, response: ReturnRequest },
  'returns.receive': { method: 'POST', path: '/returns/:id/receive', access: orders, params: IdParams, body: ReturnReceive, response: ReturnRequest },
  /** Marks it refunded or exchanged. The refund itself is the owner's, through refunds.create with returnId. */
  'returns.close': { method: 'POST', path: '/returns/:id/close', access: orders, params: IdParams, body: ReturnClose, response: ReturnRequest },
};
