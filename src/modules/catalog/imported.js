import { ValidationError } from '../../util.js';
import { cleanTags } from './repo.js';
import { checkOptionsAndVariants, isInStock, legacyOption } from './rules.js';

/**
 * How something read from outside (a page, a store's feed, an adapter, a CSV row) becomes a product, or changes one that is
 * already there (PRD 8.3, 8.5, 8.6, 8.8). `draft` is what the source says; a field it leaves undefined says nothing and changes
 * nothing.
 *
 * What the owner did by hand wins: fields named in owner_edited are left alone, and a price the owner typed (price_manual) is
 * never changed by an import or a re-check.
 */

const HOUR = 3_600_000;
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const says = (value) => value !== undefined && value !== null;
/** An MRP is kept only above the price (8.1). */
const mrpAbove = (price, mrp) => (says(mrp) && says(price) && mrp > price ? mrp : null);

/** The draft's options and variants as a set that fits together; nothing when they don't, so one odd variant never loses the product. */
function fittedSet(draft) {
  try {
    return checkOptionsAndVariants(draft.options ?? [], (draft.variants ?? []).map((v) => ({ ...v, mrpPaise: mrpAbove(v.pricePaise, v.mrpPaise), imageIndex: null })));
  } catch {
    return { options: [], variants: [] };
  }
}

/** A product with no options keeps one variant when it has a SKU, carrying the product's own price and stock. */
const soleVariant = (sku, sourceRef, pricePaise, mrpPaise, inStock) => [{ optionValues: [], sku, pricePaise, mrpPaise, inStock, imageIndex: null, sourceRef }];

const comparableSet = (options, variants) => JSON.stringify({
  options: options.map((o) => ({ name: o.name, values: o.values })),
  variants: variants.map((v) => ({ optionValues: v.optionValues ?? v.option_values, sku: v.sku, pricePaise: v.pricePaise ?? v.price_paise, mrpPaise: v.mrpPaise ?? v.mrp_paise ?? null, inStock: v.inStock ?? v.in_stock })),
});

/**
 * Adds the product a draft describes and returns its id. The draft needs a name and a price. `source` and `sourceRef` say
 * where it came from; a product with a web link and a source other than manual is re-checked every `recheckHours`.
 */
export async function createFromDraft(catalog, draft, { source, sourceRef = '', priceManual = false, recheckHours = 24, categoryIds = [], active = true, now = new Date() } = {}) {
  if (!says(draft.pricePaise)) throw new ValidationError('Add a price to save this product.');
  const price = draft.pricePaise;
  const mrp = mrpAbove(price, draft.mrpPaise);
  const inStock = draft.inStock !== false;
  const set = fittedSet(draft);
  const lone = set.variants.length === 1 && !set.variants[0].optionValues.length ? set.variants[0] : null;
  if (lone || !set.variants.length) {
    const sku = draft.sku || lone?.sku || '';
    set.variants = sku ? soleVariant(sku, lone?.sourceRef ?? '', price, mrp, inStock) : [];
  }
  const externalUrl = draft.externalUrl ?? '';
  const checked = source !== 'manual' && externalUrl !== '';
  const columns = {
    name: draft.name,
    description: draft.description ?? '',
    price_paise: price,
    mrp_paise: mrp,
    images: (draft.images ?? []).slice(0, 6),
    in_stock: inStock,
    stock: inStock ? null : 0,
    external_url: externalUrl,
    tags: draft.tags ?? [],
    source,
    source_ref: sourceRef,
    fetch_status: checked ? 'ok' : 'none',
    fetched_at: checked ? now : null,
    next_check_at: checked ? new Date(now.getTime() + recheckHours * HOUR) : null,
    price_manual: priceManual,
    active,
    ...legacyOption(set.options, set.variants),
  };
  const parts = {};
  if (set.options.length || set.variants.length) parts.variantSet = set;
  if (categoryIds.length) parts.categoryIds = categoryIds;
  return catalog.insert(columns, parts);
}

/**
 * Brings a product up to date with what its source says now. Returns null when the product is gone, else
 * { changed, priceChanged, stock: null | 'sold_out' | 'back_in_stock', pricePaise }.
 *
 *   text         also refresh the name, description, tags and images (an import does; a re-check doesn't)
 *   flagPrice    a changed price sets price_changed and keeps the old one (a re-check and a feed re-import)
 *   manualPrice  the price in the draft is the owner's own (a CSV row): it is applied and becomes a manual price
 *   mrpKnown     the source says what the MRP is, so no MRP there means none; false when it simply can't tell (a web page)
 *   claim        { source, sourceRef } to record on the product (a feed taking over a product first added by link)
 */
export async function applyImport(catalog, productId, draft, { text = true, flagPrice = false, manualPrice = false, mrpKnown = true, claim = null, addCategoryIds = [], recheckHours = 24, now = new Date() } = {}) {
  const current = await catalog.get(productId);
  if (!current) return null;
  const edited = new Set(current.owner_edited);
  const changes = {};
  const parts = {};

  if (text) {
    if (draft.name && !edited.has('name') && draft.name !== current.name) changes.name = draft.name;
    if (draft.description && !edited.has('description') && draft.description !== current.description) changes.description = draft.description;
    if (draft.tags?.length && !edited.has('tags') && !sameList(cleanTags(draft.tags), current.tags)) changes.tags = draft.tags;
    if (draft.images?.length && !edited.has('images')) {
      const images = draft.images.slice(0, 6);
      const sources = current.gallery.map((g) => g.source_url || `/media/${g.media_id}`);
      if (!sameList(images, sources) && !sameList(images, current.images)) {
        // An image already copied into the business's media keeps its copy.
        const copies = new Map(current.gallery.filter((g) => g.media_id && g.source_url).map((g) => [g.source_url, g]));
        const details = new Map();
        changes.images = images.map((url) => {
          const copy = copies.get(url);
          if (!copy) return url;
          const link = `/media/${copy.media_id}`;
          details.set(link, { sourceUrl: url, width: copy.width, height: copy.height });
          return link;
        });
        parts.gallery = { details };
      }
    }
  }

  let price = current.price_paise;
  let priceChanged = false;
  const mayPrice = manualPrice || !current.price_manual;
  if (says(draft.pricePaise) && mayPrice) {
    if (draft.pricePaise !== current.price_paise) {
      price = draft.pricePaise;
      priceChanged = true;
      changes.price_paise = price;
      if (!manualPrice && flagPrice) {
        changes.price_changed = true;
        changes.previous_price_paise = current.price_paise;
      }
    }
    if (manualPrice) {
      if (!current.price_manual) changes.price_manual = true;
      if (current.price_changed) {
        changes.price_changed = false;
        changes.previous_price_paise = null;
      }
    }
  }

  let mrp = current.mrp_paise;
  if (mrpKnown && draft.mrpPaise !== undefined && mayPrice) mrp = mrpAbove(price, draft.mrpPaise);
  if (mrp !== null && mrp < price) mrp = null;
  if (mrp !== current.mrp_paise) changes.mrp_paise = mrp;

  let stock = null;
  const wasInStock = isInStock(current);
  const inStock = typeof draft.inStock === 'boolean' ? draft.inStock : wasInStock;
  if (inStock !== wasInStock) {
    stock = inStock ? 'back_in_stock' : 'sold_out';
    changes.in_stock = inStock;
    if (!inStock) changes.stock = 0;
    else if (current.stock === 0) changes.stock = null;
  }

  if (!edited.has('options')) {
    // The product's own variant (no option values) holds its SKU; "real" variants are one per combination of options.
    const lone = current.variants.length === 1 && !current.variants[0].option_values.length ? current.variants[0] : null;
    const hasReal = current.variants.length > 0 && !lone;
    const options = draft.options?.length ? fittedSet({ options: draft.options }).options : null;
    const optionsChanged = options !== null && JSON.stringify(options) !== JSON.stringify(current.options);
    let set = null;
    if (draft.variants?.some((v) => v.optionValues?.length)) {
      set = fittedSet(draft);
      if (!set.options.length || !set.variants.length) set = null;
    } else if (!hasReal || optionsChanged) {
      // The source lists no variants of its own: the options as it gives them, and the one variant that holds the SKU.
      const sku = draft.sku || draft.variants?.[0]?.sku || lone?.sku || '';
      set = { options: options ?? current.options, variants: sku ? soleVariant(sku, draft.variants?.[0]?.sourceRef ?? lone?.source_ref ?? '', price, mrp, inStock) : [] };
    }
    if (set && comparableSet(set.options, set.variants) !== comparableSet(current.options, current.variants)) {
      parts.variantSet = set;
      const legacy = legacyOption(set.options, set.variants);
      if (legacy.option_label !== current.option_label || !sameList(legacy.option_values, current.option_values)) Object.assign(changes, legacy);
    }
  }

  if (claim && (current.source !== claim.source || current.source_ref !== claim.sourceRef)) Object.assign(changes, { source: claim.source, source_ref: claim.sourceRef });
  if (draft.externalUrl && draft.externalUrl !== current.external_url) changes.external_url = draft.externalUrl;
  // A product we archived because it left the feed comes back when the feed has it again.
  if (current.fetch_status === 'missing' && !current.active) changes.active = true;
  if (addCategoryIds.length && !edited.has('categories')) {
    const fresh = addCategoryIds.filter((id) => !current.category_ids.includes(id));
    if (fresh.length) parts.addCategoryIds = fresh;
  }

  const changed = Object.keys(changes).length > 0 || Boolean(parts.gallery || parts.variantSet || parts.addCategoryIds);
  if (changed) await catalog.update(current.id, changes, parts);
  const source = changes.source ?? current.source;
  const externalUrl = changes.external_url ?? current.external_url;
  const checked = source !== 'manual' && externalUrl !== '';
  await catalog.markFetched(current.id, { status: checked ? 'ok' : 'none', nextCheckAt: checked ? new Date(now.getTime() + recheckHours * HOUR) : null });
  return { changed, priceChanged, stock, pricePaise: price };
}
