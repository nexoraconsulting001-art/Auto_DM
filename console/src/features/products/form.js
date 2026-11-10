import { paiseToRupees, rupeesToPaise } from '../../lib/format.js';
import { splitList } from '../../lib/lists.js';

export const MAX_PHOTOS = 6;

/** API field names that the form calls something else. */
export const RENAME = { pricePaise: 'price', mrpPaise: 'mrp' };

export const EMPTY_PRODUCT = Object.freeze({
  name: '', description: '', price: '', mrp: '', images: [], optionLabel: 'Size', optionValues: '', stock: '', active: true, featured: false, categoryIds: [],
});

/** A product from the API as the form holds it: amounts in rupees as typed, lists as text. */
export function productToForm(product) {
  return {
    name: product.name,
    description: product.description,
    price: paiseToRupees(product.pricePaise),
    mrp: paiseToRupees(product.mrpPaise),
    images: product.images,
    optionLabel: product.optionLabel,
    optionValues: product.optionValues.join(', '),
    stock: product.stock === null ? '' : String(product.stock),
    active: product.active,
    featured: product.featured,
    categoryIds: product.categoryIds,
  };
}

/** The form as the API wants it, or `errors` by field when it isn't ready to send. */
export function formToProduct(form) {
  const errors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Name is required';

  const pricePaise = rupeesToPaise(form.price);
  if (pricePaise === null) errors.price = 'Price is required';
  else if (Number.isNaN(pricePaise)) errors.price = 'Enter a price like 499 or 499.50';

  const mrpPaise = rupeesToPaise(form.mrp);
  if (Number.isNaN(mrpPaise)) errors.mrp = 'Enter an MRP like 999 or 999.50';
  else if (mrpPaise !== null && !errors.price && mrpPaise < pricePaise) errors.mrp = 'MRP must be the same as or higher than the price';

  const stockText = form.stock.trim();
  if (stockText !== '' && !/^\d+$/.test(stockText)) errors.stock = 'Stock must be a whole number, or empty for unlimited';

  const optionValues = splitList(form.optionValues);
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      name,
      description: form.description.trim(),
      pricePaise,
      mrpPaise,
      images: form.images,
      optionLabel: optionValues.length ? form.optionLabel.trim() || 'Option' : '',
      optionValues,
      stock: stockText === '' ? null : Number(stockText),
      active: form.active,
      featured: form.featured,
      categoryIds: form.categoryIds,
    },
  };
}
