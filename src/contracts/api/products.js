import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Id, IdParams, IdText, ListQuery, MediaLink, Paise, PaiseInput, Quantity, Timestamp, page, required, text } from './common.js';

const access = staffWith('catalog');

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
});
export const ProductSummary = Product.extend({ reelCount: Count, categoryNames: z.array(z.string()) });
export const ProductDetail = Product.extend({ categoryIds: z.array(Id) });

export const ProductCreate = z.object({
  name: required(120, 'Name is required'),
  pricePaise: PaiseInput,
  description: text(5000).optional(),
  mrpPaise: PaiseInput.nullable().optional(),
  images: z.array(MediaLink).max(6, 'A product can have at most 6 images').optional(),
  optionLabel: text(40).optional(),
  optionValues: z.array(required(40)).max(50).optional(),
  stock: Quantity.nullable().optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
  categoryIds: z.array(Id).max(100).optional(),
});
/** Fields left out stay as they are. */
export const ProductUpdate = ProductCreate.partial();

export const ProductListQuery = ListQuery.extend({
  search: text(80).optional(),
  status: z.enum(['all', 'active', 'archived', 'featured']).default('all'),
  category: IdText.optional(),
});

export const productRoutes = {
  'products.list': { method: 'GET', path: '/products', access, query: ProductListQuery, response: page(ProductSummary) },
  'products.create': { method: 'POST', path: '/products', access, body: ProductCreate, status: 201, response: ProductDetail },
  'products.get': { method: 'GET', path: '/products/:id', access, params: IdParams, response: ProductDetail },
  'products.update': { method: 'PATCH', path: '/products/:id', access, params: IdParams, body: ProductUpdate, response: ProductDetail },
  'products.remove': { method: 'DELETE', path: '/products/:id', access, params: IdParams, status: 204, response: null },
};
