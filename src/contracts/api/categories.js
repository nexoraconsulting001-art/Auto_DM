import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, MediaLinkOrEmpty, page, required, text } from './common.js';

const access = staffWith('catalog');

export const Category = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  imageUrl: z.string(),
  description: z.string(),
  position: z.number().int(),
  visible: z.boolean(),
  productCount: Count,
});

export const CategoryCreate = z.object({
  name: required(60, 'Name is required'),
  slug: text(60).optional(),
  imageUrl: MediaLinkOrEmpty.optional(),
  description: text(400).optional(),
  position: z.number().int().min(-1000000).max(1000000).optional(),
  visible: z.boolean().optional(),
});
/** Fields left out stay as they are. */
export const CategoryUpdate = CategoryCreate.partial();

export const categoryRoutes = {
  'categories.list': { method: 'GET', path: '/categories', access, query: ListQuery, response: page(Category) },
  'categories.create': { method: 'POST', path: '/categories', access, body: CategoryCreate, status: 201, response: Category },
  'categories.get': { method: 'GET', path: '/categories/:id', access, params: IdParams, response: Category },
  'categories.update': { method: 'PATCH', path: '/categories/:id', access, params: IdParams, body: CategoryUpdate, response: Category },
  'categories.remove': { method: 'DELETE', path: '/categories/:id', access, params: IdParams, status: 204, response: null },
};
