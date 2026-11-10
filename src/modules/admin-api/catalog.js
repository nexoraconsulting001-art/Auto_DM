import { ApiError } from '../../contracts/api/index.js';
import { invalidField, refusedByState, retryOnRace } from './errors.js';
import { mapPage, pageOf } from './paging.js';

const millis = (time) => new Date(time).getTime();

/** Paise as the "499.50" text the catalog repo parses, with no floating point on the way. */
const rupeesText = (paise) => (paise === null || paise === undefined ? '' : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`);

const toProduct = (p) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  description: p.description,
  pricePaise: p.price_paise,
  mrpPaise: p.mrp_paise,
  images: p.images,
  optionLabel: p.option_label,
  optionValues: p.option_values,
  stock: p.stock,
  active: p.active,
  featured: p.featured,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});
const toProductDetail = (p) => ({ ...toProduct(p), categoryIds: p.category_ids });
const toProductSummary = (p) => ({ ...toProduct(p), reelCount: p.reel_count, categoryNames: p.category_names });

/** The repo keeps option values as comma-separated text, so a comma inside one would turn it into two. */
function productInput(product, categoryIds) {
  if (product.optionValues.some((value) => value.includes(','))) throw invalidField('optionValues', 'An option can’t contain a comma');
  return {
    name: product.name,
    description: product.description,
    price: rupeesText(product.pricePaise),
    mrp: rupeesText(product.mrpPaise),
    images: product.images,
    option_label: product.optionLabel,
    option_values: product.optionValues.join(','),
    stock: product.stock ?? '',
    active: product.active,
    featured: product.featured,
    categoryIds,
  };
}

const NEW_PRODUCT = { description: '', mrpPaise: null, images: [], optionLabel: '', optionValues: [], stock: null, active: true, featured: false };

const toCategory = (c) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  imageUrl: c.image_url,
  description: c.description,
  position: c.position,
  visible: c.visible,
  productCount: c.product_count,
});

const categoryInput = (c) => ({ name: c.name, slug: c.slug, image_url: c.imageUrl, description: c.description, position: c.position, visible: c.visible });

export function catalogApi({ repos }) {
  async function nextCategoryPosition() {
    const all = await repos.categories.list();
    return all.length ? Math.max(...all.map((c) => c.position)) + 1 : 1;
  }

  return {
    'products.list': async ({ query }) => {
      const rows = await repos.products.list({ search: query.search, status: query.status, category: query.category });
      return mapPage(pageOf(rows, query, (p) => [p.active ? 0 : 1, -millis(p.updated_at), -p.id]), toProductSummary);
    },

    'products.get': async ({ params }) => {
      const product = await repos.products.get(params.id);
      return product && toProductDetail(product);
    },

    'products.create': async ({ body }) => {
      const created = await retryOnRace(() => repos.products.create(productInput({ ...NEW_PRODUCT, ...body }, body.categoryIds)));
      return toProductDetail(await repos.products.get(created.id));
    },

    'products.update': async ({ params, body }) => {
      const current = await repos.products.get(params.id);
      if (!current) return null;
      await retryOnRace(() => repos.products.update(current.id, productInput({ ...toProduct(current), ...body }, body.categoryIds)));
      return toProductDetail(await repos.products.get(current.id));
    },

    // A product in an order can only be archived, so the repo refusing here is a 409 and not bad input.
    'products.remove': async ({ params }) => {
      if (!(await repos.products.get(params.id))) throw new ApiError('not_found');
      await refusedByState(() => repos.products.remove(params.id));
    },

    'categories.list': async ({ query }) => {
      const rows = await repos.categories.list();
      return mapPage(pageOf(rows, query, (c) => [c.position, c.name.toLowerCase(), c.id]), toCategory);
    },

    'categories.get': async ({ params }) => {
      const category = await repos.categories.get(params.id);
      return category && toCategory(category);
    },

    'categories.create': async ({ body }) => {
      const position = body.position ?? (await nextCategoryPosition());
      const saved = await retryOnRace(() => repos.categories.save(null, categoryInput({ imageUrl: '', description: '', visible: true, ...body, position })));
      return toCategory(await repos.categories.get(saved.id));
    },

    'categories.update': async ({ params, body }) => {
      const current = await repos.categories.get(params.id);
      if (!current) return null;
      await retryOnRace(() => repos.categories.save(current.id, categoryInput({ ...toCategory(current), ...body })));
      return toCategory(await repos.categories.get(current.id));
    },

    'categories.remove': async ({ params }) => {
      if (!(await repos.categories.get(params.id))) throw new ApiError('not_found');
      await repos.categories.remove(params.id);
    },

    'media.upload': async ({ file }) => {
      const id = await repos.media.save(file.buffer, file.mimetype);
      return { id, url: `/media/${id}` };
    },
  };
}
