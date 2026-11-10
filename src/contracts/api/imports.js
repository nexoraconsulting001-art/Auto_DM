import { z } from 'zod';
import { CATALOG_LIMITS as L, IMPORT_ITEM_STATUSES, IMPORT_JOB_STATUSES, IMPORT_KINDS, IMPORT_READ_FROM, IMPORT_REASON_CODES, IMPORT_REASONS } from '../catalog.js';
import { staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, Timestamp, page } from './common.js';
import { ProductCreate } from './products.js';

/**
 * Imports (PRD 8.3 to 8.8), answered by src/modules/imports. Everything outside is read through platform.fetcher (safeFetch);
 * images through platform.images into tenant media. A single link answers at once with a draft; bulk links, CSV files and
 * Shopify feeds are jobs the worker runs, with a report per item. Nothing imported is live until the owner saves it, and an
 * automatic import must pass the quality gate (8.7); a manual save skips it.
 */
const access = staffWith('catalog');

const WebLink = z.string().trim().min(1, 'Paste a link').max(2000).regex(/^[^\s\0]+$/, 'Paste one link without spaces')
  .refine((s) => s.isWellFormed(), 'Contains a character that isn’t allowed');

/** A product as read from a page or feed, before the owner saves it. Prices are paise; images are the original addresses. */
export const ProductDraft = z.object({
  name: z.string(),
  description: z.string(),
  externalUrl: z.string(),
  pricePaise: Paise.nullable(),
  mrpPaise: Paise.nullable(),
  inStock: z.boolean(),
  images: z.array(z.string()),
  tags: z.array(z.string()),
  /** Category names the source suggests (Shopify tags, a CSV column); none is created until the owner saves. */
  suggestedCategories: z.array(z.string()),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(z.object({ optionValues: z.array(z.string()), sku: z.string(), pricePaise: Paise, mrpPaise: Paise.nullable(), inStock: z.boolean() })),
  source: z.string(),
  sourceRef: z.string(),
});

const Reason = z.enum(IMPORT_REASON_CODES);

/**
 * draft: read and passed the gate, waiting for the owner to check and save. existing: the business already has this address
 * (K-11), productId says which. refused: the gate said no; the draft prefills the manual form. failed: nothing could be read.
 */
export const LinkImportResult = z.object({
  status: z.enum(['draft', 'existing', 'refused', 'failed']),
  itemId: Id.nullable(),
  productId: Id.nullable(),
  readFrom: z.enum(['', ...IMPORT_READ_FROM]),
  reason: Reason.nullable(),
  message: z.string(),
  draft: ProductDraft.nullable(),
});

export const ImportJob = z.object({
  id: Id,
  kind: z.enum(IMPORT_KINDS),
  status: z.enum(IMPORT_JOB_STATUSES),
  source: z.string(),
  total: Count,
  created: Count,
  updated: Count,
  unchanged: Count,
  refused: Count,
  failed: Count,
  archived: Count,
  errorCode: Reason.nullable(),
  message: z.string(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});

export const ImportItem = z.object({
  id: Id,
  line: Count,
  url: z.string(),
  sku: z.string(),
  status: z.enum(IMPORT_ITEM_STATUSES),
  readFrom: z.enum(['', ...IMPORT_READ_FROM]),
  gatePassed: z.boolean().nullable(),
  reason: Reason.nullable(),
  message: z.string(),
  productId: Id.nullable(),
  draft: ProductDraft.nullable(),
});
export const ImportItemsQuery = ListQuery.extend({ status: z.enum(['all', ...IMPORT_ITEM_STATUSES]).default('all') });

export const LinkImport = z.object({ url: WebLink });
export const BulkImport = z.object({
  urls: z.array(WebLink).min(1, 'Paste at least one link').max(L.bulkLinks, IMPORT_REASONS.too_many_links),
});
export const ShopifyImport = z.object({ storeUrl: WebLink });
/** Saving a draft: the owner's corrections over what was read. Owner-confirmed, so the quality gate doesn't apply. */
export const DraftSave = ProductCreate;

export const SiteAdapter = z.object({ name: z.string(), label: z.string(), enabled: z.boolean() });

export const CSV_UPLOAD = Object.freeze({ field: 'file', maxBytes: L.csvBytes, mimeTypes: Object.freeze(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'application/octet-stream']) });

export const importRoutes = {
  'imports.link': { method: 'POST', path: '/imports/link', access, body: LinkImport, response: LinkImportResult },
  'imports.bulk': { method: 'POST', path: '/imports/bulk', access, body: BulkImport, status: 202, response: ImportJob },
  'imports.csv': { method: 'POST', path: '/imports/csv', access, upload: CSV_UPLOAD, status: 202, response: ImportJob },
  'imports.shopify': { method: 'POST', path: '/imports/shopify', access, body: ShopifyImport, status: 202, response: ImportJob },
  'imports.list': { method: 'GET', path: '/imports', access, query: ListQuery, response: page(ImportJob) },
  'imports.adapters': { method: 'GET', path: '/import-adapters', access, response: z.object({ items: z.array(SiteAdapter) }) },
  'imports.get': { method: 'GET', path: '/imports/:id', access, params: IdParams, response: ImportJob },
  'imports.items': { method: 'GET', path: '/imports/:id/items', access, params: IdParams, query: ImportItemsQuery, response: page(ImportItem) },
  /** Saves one item's draft as a product (created) or opens the existing one. Answers the product's id. */
  'importItems.save': { method: 'POST', path: '/import-items/:id/save', access, params: IdParams, body: DraftSave, status: 201, response: z.object({ productId: Id }) },
};
