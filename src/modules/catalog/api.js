import { ApiError } from '../../contracts/api/index.js';
import { IMPORT_REASONS, canonicalProductUrl } from '../../contracts/catalog.js';
import { tenantId } from '../../tenancy.js';
import { invalidField, refusedByState, retryOnRace } from '../admin-api/errors.js';
import { isRowId, readCursor, writeCursor } from '../admin-api/paging.js';
import { violated } from './repo.js';
import { cardPrice, checkOptionsAndVariants, isInStock, legacyOption } from './rules.js';

/**
 * The seller API's product routes (PRD 8.1), in place of the Phase 0 handlers: the same fields and answers as before, plus
 * options, variants, images with alt text, the product's own web link, tags and the WhatsApp order switch.
 *
 * An imported product remembers what the owner changed by hand (owner_edited), so a later import leaves those fields alone,
 * and a price the owner typed is never changed by an import or a re-check (price_manual).
 */

export const RECHECK_ONE = 'catalog.recheck-one';

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const toProduct = (p) => ({
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
  externalUrl: p.external_url,
  inStock: isInStock(p),
  source: p.source,
  sourceRef: p.source_ref,
  fetchStatus: p.fetch_status,
  fetchedAt: p.fetched_at,
  priceChanged: p.price_changed,
  previousPricePaise: p.previous_price_paise,
  priceManual: p.price_manual,
  ownerEdited: p.owner_edited,
  tags: p.tags,
  whatsappOrder: p.whatsapp_order,
  display: cardPrice(p, p.variants ?? []),
});

const toVariant = (v) => ({ id: v.id, optionValues: v.option_values, sku: v.sku, pricePaise: v.price_paise, mrpPaise: v.mrp_paise, inStock: v.in_stock, imageId: v.image_id, position: v.position });
const toImage = (i) => ({ id: i.id, url: i.media_id ? `/media/${i.media_id}` : i.source_url, sourceUrl: i.source_url, alt: i.alt, width: i.width, height: i.height, position: i.position });

export const toProductDetail = (p) => ({
  ...toProduct(p),
  categoryIds: p.category_ids,
  options: p.options,
  variants: p.variants.map(toVariant),
  gallery: p.gallery.map(toImage),
  lastCheck: p.last_check ? { at: p.last_check.checked_at, outcome: p.last_check.outcome, httpStatus: p.last_check.http_status } : null,
});
const toProductSummary = (p) => ({ ...toProduct(p), reelCount: p.reel_count, categoryNames: p.category_names });

/** A product's variants in the shape the API takes them, each keeping the image it shows. */
const variantsAsInput = (variants) => variants.map((v) => ({ optionValues: v.option_values, sku: v.sku, pricePaise: v.price_paise, mrpPaise: v.mrp_paise, inStock: v.in_stock, imageIndex: null, sourceRef: v.source_ref }));

/** The product's own web link in the form two pastes of one page share (K-11), or a 400 naming the field. */
function externalUrl(value) {
  if (!value) return '';
  const url = canonicalProductUrl(value);
  if (!url) throw invalidField('externalUrl', 'Use a web link starting with http:// or https://');
  return url;
}

/** The repo's own refusals keep their words; the database's become a message about the field that clashed. */
async function saving(write) {
  try {
    return await write();
  } catch (err) {
    if (violated(err, 'products_external_url_idx')) throw invalidField('externalUrl', IMPORT_REASONS.duplicate);
    if (violated(err, 'product_variants_sku_idx')) throw invalidField('variants', 'That SKU is already used by another product');
    throw err;
  }
}

/**
 * Stock in both forms the catalog keeps: the Phase 0 count (null is unlimited) and the in-stock flag. A count of zero is sold
 * out whatever the flag says; turning the flag off empties an unlimited product, and turning it on refills an empty one.
 */
function stockColumns(body, current = { stock: null, in_stock: true }) {
  const out = {};
  if (body.stock !== undefined) out.stock = body.stock;
  const stock = body.stock !== undefined ? body.stock : current.stock;
  if (body.inStock !== undefined) {
    out.in_stock = body.inStock && stock !== 0;
    if (!body.inStock && body.stock === undefined && stock !== 0) out.stock = 0;
    if (body.inStock && body.stock === undefined && stock === 0) {
      out.stock = null;
      out.in_stock = true;
    }
  } else if (body.stock !== undefined) {
    out.in_stock = stock !== 0;
  }
  return out;
}

/** The Phase 0 option list: a comma inside a value was never allowed there, and the old store still splits on it. */
function checkLegacyValues(values) {
  if (values.some((value) => value.includes(','))) throw invalidField('optionValues', 'An option can’t contain a comma');
}

function checkedSet(options, variants) {
  try {
    return checkOptionsAndVariants(options, variants);
  } catch (err) {
    throw invalidField(variants.length ? 'variants' : 'options', err.message);
  }
}

export function productHandlers(ctx) {
  const catalog = () => ctx.repos.catalog;

  return {
    'products.list': async ({ query }) => {
      const cursor = query.cursor ? readCursor(query.cursor, (key) => key.length === 3 && (key[0] === 0 || key[0] === 1) && Number.isSafeInteger(key[1]) && isRowId(key[2])) : null;
      const { rows, more } = await catalog().list({ search: query.search ?? '', status: query.status, category: query.category ?? 0, source: query.source ?? '', cursor, limit: query.limit });
      const last = rows.at(-1);
      return { items: rows.map(toProductSummary), nextCursor: more ? writeCursor([last.active ? 0 : 1, Number(last.at_micros), last.id]) : null };
    },

    'products.get': async ({ params }) => {
      const product = await catalog().get(params.id);
      return product && toProductDetail(product);
    },

    'products.create': async ({ body }) => {
      const columns = {
        name: body.name,
        description: body.description ?? '',
        price_paise: body.pricePaise,
        mrp_paise: body.mrpPaise ?? null,
        images: body.images ?? [],
        active: body.active ?? true,
        featured: body.featured ?? false,
        external_url: externalUrl(body.externalUrl),
        tags: body.tags ?? [],
        whatsapp_order: body.whatsappOrder ?? null,
        ...stockColumns(body),
      };
      const parts = { gallery: { alts: body.imageAlts ?? null } };
      if (body.categoryIds) parts.categoryIds = body.categoryIds;
      if (body.options !== undefined || body.variants !== undefined) {
        const set = checkedSet(body.options ?? [], body.variants ?? []);
        Object.assign(columns, legacyOption(set.options, set.variants));
        parts.variantSet = set;
      } else if (body.optionValues?.length) {
        checkLegacyValues(body.optionValues);
        columns.option_label = body.optionLabel || 'Option';
        columns.option_values = body.optionValues;
        parts.variantSet = checkedSet([{ name: columns.option_label, values: body.optionValues }], []);
      }
      const id = await retryOnRace(() => saving(() => catalog().insert(columns, parts)));
      return toProductDetail(await catalog().get(id));
    },

    'products.update': async ({ params, body }) => {
      const current = await catalog().get(params.id);
      if (!current) return null;
      const changes = {};
      const parts = {};
      const edited = new Set(current.owner_edited);
      const imported = current.source !== 'manual';

      if (body.name !== undefined) changes.name = body.name;
      if (body.description !== undefined) changes.description = body.description;
      if (body.active !== undefined) changes.active = body.active;
      if (body.featured !== undefined) changes.featured = body.featured;
      if (body.whatsappOrder !== undefined) changes.whatsapp_order = body.whatsappOrder;
      if (body.mrpPaise !== undefined) changes.mrp_paise = body.mrpPaise;
      if (body.tags !== undefined) changes.tags = body.tags;
      if (body.images !== undefined) changes.images = body.images;
      if (body.imageAlts !== undefined || body.images !== undefined) parts.gallery = { alts: body.imageAlts ?? null };
      if (body.categoryIds !== undefined) parts.categoryIds = body.categoryIds;
      Object.assign(changes, stockColumns(body, current));

      if (body.pricePaise !== undefined) {
        changes.price_paise = body.pricePaise;
        // The owner has seen the price: the flag goes, and a price they changed is theirs from now on (8.8).
        changes.price_changed = false;
        changes.previous_price_paise = null;
        if (body.pricePaise !== current.price_paise) changes.price_manual = true;
      }

      if (body.externalUrl !== undefined) {
        changes.external_url = externalUrl(body.externalUrl);
        if (imported && changes.external_url !== current.external_url) changes.next_check_at = changes.external_url ? new Date() : null;
      }

      if (body.options !== undefined || body.variants !== undefined) {
        const set = checkedSet(body.options ?? current.options, body.variants ?? variantsAsInput(current.variants));
        Object.assign(changes, legacyOption(set.options, set.variants));
        parts.variantSet = set;
        if (!sameJson(set.options, current.options)) edited.add('options');
      } else if (body.optionLabel !== undefined || body.optionValues !== undefined) {
        const values = body.optionValues ?? current.option_values;
        checkLegacyValues(values);
        const label = values.length ? (body.optionLabel ?? current.option_label) || 'Option' : '';
        if (label !== current.option_label || !sameList(values, current.option_values)) {
          changes.option_label = label;
          changes.option_values = values;
          parts.variantSet = checkedSet(values.length ? [{ name: label, values }] : [], []);
          edited.add('options');
        }
      }

      if (imported) {
        if (body.name !== undefined && body.name !== current.name) edited.add('name');
        if (body.description !== undefined && body.description !== current.description) edited.add('description');
        if (body.tags !== undefined && !sameList(body.tags, current.tags)) edited.add('tags');
        if (body.images !== undefined && !sameList(body.images, current.images)) edited.add('images');
        if (body.categoryIds !== undefined && !sameList([...body.categoryIds].sort((a, b) => a - b), current.category_ids)) edited.add('categories');
        if (!sameList([...edited], current.owner_edited)) changes.owner_edited = [...edited];
      }

      const found = await retryOnRace(() => saving(() => catalog().update(current.id, changes, parts)));
      if (!found) return null;
      return toProductDetail(await catalog().get(current.id));
    },

    // A product in an order can only be archived, so the repo refusing here is a 409 and not bad input.
    'products.remove': async ({ params }) => {
      if (!(await catalog().get(params.id))) throw new ApiError('not_found');
      await refusedByState(() => catalog().remove(params.id));
    },
  };
}

export function catalogHandlers(ctx) {
  const catalog = () => ctx.repos.catalog;
  return {
    /** Re-check one imported product now (8.8). The worker does the reading; asking twice in a minute queues it once. */
    'products.recheck': async ({ params }) => {
      const product = await catalog().get(params.id);
      if (!product) return null;
      if (product.source === 'manual' || !product.external_url) throw new ApiError('conflict', 'This product was added by hand, so there is no page to re-check.');
      const slot = Math.floor(Date.now() / 60_000);
      const id = await ctx.platform.queue.enqueue(RECHECK_ONE, { productId: product.id }, { tenantId: tenantId(), dedupeKey: `recheck:${tenantId()}:${product.id}:${slot}`, maxAttempts: 2, retryInFlight: true });
      return { queued: id !== null };
    },

    'catalogSettings.get': () => catalog().settings(),

    'catalogSettings.update': async ({ body }) => {
      await catalog().saveSettings(body);
      return catalog().settings();
    },
  };
}
