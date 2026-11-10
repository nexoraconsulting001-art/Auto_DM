import { z } from 'zod';
import { CATALOG_LIMITS as L, FETCH_STATUSES, IMPORT_REASONS, OWNER_EDITABLE } from '../catalog.js';
import { staffWith } from './access.js';
import { Count, Id, IdParams, IdText, ListQuery, MediaLink, Paise, PaiseInput, Quantity, Timestamp, page, required, text } from './common.js';

/**
 * The catalog (PRD 8.1), answered by src/modules/catalog. Phase 0's fields stay as they were, so the console and the Phase 0
 * store keep working; Phase 3's are added with defaults, so an answer that lacks one still parses.
 * Money is integer paise. An MRP is kept only above the price, and one below it is refused (K-02).
 */
const access = staffWith('catalog');

/** A web link for a product's page on the seller's own site: http(s), no spaces, no NUL. */
const WebLink = z.string().trim().max(2000).regex(/^https?:\/\/[^\s\0]+$/i, 'Use a web link starting with http:// or https://')
  .refine((s) => s.isWellFormed(), 'Contains a character that isn’t allowed');

export const ProductOption = z.object({ name: z.string(), values: z.array(z.string()) });
export const ProductVariant = z.object({
  id: Id,
  optionValues: z.array(z.string()),
  sku: z.string(),
  pricePaise: Paise,
  mrpPaise: Paise.nullable(),
  inStock: z.boolean(),
  imageId: Id.nullable(),
  position: Count,
});
export const ProductImage = z.object({
  id: Id,
  url: z.string(), // /media/<id> when copied to the business's media, else the original address
  sourceUrl: z.string(),
  alt: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  position: Count,
});
/** What a card shows (K-03): the lowest in-stock variant's price, the MRP struck through and its "-N%", or Sold out. */
export const ProductDisplay = z.object({ pricePaise: Paise, mrpPaise: Paise.nullable(), discountPercent: z.number().int().min(1).max(100).nullable(), soldOut: z.boolean() });

export const Product = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  pricePaise: Paise,
  mrpPaise: Paise.nullable(),
  images: z.array(z.string()),
  optionLabel: z.string(),
  optionValues: z.array(z.string()),
  stock: Count.nullable(), // null is unlimited
  active: z.boolean(),
  featured: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  // Phase 3
  externalUrl: z.string().default(''),
  inStock: z.boolean().default(true),
  source: z.string().default('manual'), // manual, link, shopify, csv or adapter:<name>
  sourceRef: z.string().default(''),
  fetchStatus: z.enum(FETCH_STATUSES).default('none'),
  fetchedAt: Timestamp.nullable().default(null),
  priceChanged: z.boolean().default(false),
  previousPricePaise: Paise.nullable().default(null),
  priceManual: z.boolean().default(true),
  ownerEdited: z.array(z.enum(OWNER_EDITABLE)).default([]),
  tags: z.array(z.string()).default([]),
  whatsappOrder: z.boolean().nullable().default(null), // null follows the business setting (8.11)
  display: ProductDisplay.nullable().default(null),
});
export const ProductSummary = Product.extend({ reelCount: Count, categoryNames: z.array(z.string()) });
export const ProductDetail = Product.extend({
  categoryIds: z.array(Id),
  options: z.array(ProductOption).default([]),
  variants: z.array(ProductVariant).default([]),
  gallery: z.array(ProductImage).default([]),
  lastCheck: z.object({ at: Timestamp, outcome: z.string(), httpStatus: z.number().int().nullable() }).nullable().default(null),
});

const mrpNotBelowPrice = (body, ctx) => {
  if (body.mrpPaise !== null && body.mrpPaise !== undefined && body.pricePaise !== undefined && body.mrpPaise < body.pricePaise) {
    ctx.addIssue({ code: 'custom', path: ['mrpPaise'], message: IMPORT_REASONS.mrp_below_price });
  }
};

export const ProductOptionInput = z.object({
  name: required(40, 'Name the option, like Size'),
  values: z.array(required(60)).min(1, 'Add at least one value').max(L.optionValues),
});
export const ProductVariantInput = z.object({
  optionValues: z.array(required(60)).max(L.options).default([]),
  sku: text(100).default(''),
  pricePaise: PaiseInput,
  mrpPaise: PaiseInput.nullable().default(null),
  inStock: z.boolean().default(true),
  /** Which of the product's images (by its place in `images`) shows for this variant. */
  imageIndex: z.number().int().min(0).max(L.images - 1).nullable().default(null),
}).superRefine(mrpNotBelowPrice);

const ProductFields = {
  name: required(L.nameLength, 'Name is required'),
  pricePaise: PaiseInput,
  description: text(L.descriptionLength).optional(),
  mrpPaise: PaiseInput.nullable().optional(),
  images: z.array(MediaLink).max(L.images, 'A product can have at most 6 images').optional(),
  optionLabel: text(40).optional(),
  optionValues: z.array(required(40)).max(50).optional(),
  stock: Quantity.nullable().optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
  categoryIds: z.array(Id).max(100).optional(),
  // Phase 3
  externalUrl: z.union([z.literal(''), WebLink]).optional(),
  inStock: z.boolean().optional(),
  tags: z.array(required(40)).max(L.tags).optional(),
  options: z.array(ProductOptionInput).max(L.options).optional(),
  variants: z.array(ProductVariantInput).max(L.variants).optional(),
  imageAlts: z.array(text(200)).max(L.images).optional(),
  whatsappOrder: z.boolean().nullable().optional(),
};

export const ProductCreate = z.object(ProductFields).superRefine(mrpNotBelowPrice);
/** Fields left out stay as they are. The MRP is checked against the price the product will have (the handler does it). */
export const ProductUpdate = z.object(ProductFields).partial().superRefine(mrpNotBelowPrice);

export const ProductListQuery = ListQuery.extend({
  search: text(80).optional(),
  /** attention: broken or gone from the store's feed (8.5, 8.8). */
  status: z.enum(['all', 'active', 'archived', 'featured', 'attention', 'sold_out', 'price_changed']).default('all'),
  category: IdText.optional(),
  /** Left out means every source. */
  source: z.enum(['manual', 'link', 'shopify', 'csv', 'adapter']).optional(),
});

export const CatalogSettings = z.object({
  recheckHours: z.number().int(),
  attentionCount: Count,
  lastRecheckAt: Timestamp.nullable(),
});
export const CatalogSettingsUpdate = z.object({
  recheckHours: z.number().int('Use whole hours').min(1, 'At least 1 hour').max(720, 'At most 720 hours'),
}).partial();

export const productRoutes = {
  'products.list': { method: 'GET', path: '/products', access, query: ProductListQuery, response: page(ProductSummary) },
  'products.create': { method: 'POST', path: '/products', access, body: ProductCreate, status: 201, response: ProductDetail },
  'products.get': { method: 'GET', path: '/products/:id', access, params: IdParams, response: ProductDetail },
  'products.update': { method: 'PATCH', path: '/products/:id', access, params: IdParams, body: ProductUpdate, response: ProductDetail },
  'products.remove': { method: 'DELETE', path: '/products/:id', access, params: IdParams, status: 204, response: null },
  /** Re-check one imported product now (8.8), in the worker. A manual product has nothing to re-check: 409. */
  'products.recheck': { method: 'POST', path: '/products/:id/recheck', access, params: IdParams, status: 202, response: z.object({ queued: z.boolean() }) },
  'catalogSettings.get': { method: 'GET', path: '/catalog/settings', access, response: CatalogSettings },
  'catalogSettings.update': { method: 'PATCH', path: '/catalog/settings', access, body: CatalogSettingsUpdate, response: CatalogSettings },
};
