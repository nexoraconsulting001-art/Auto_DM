import { plural } from '../../lib/format.js';
import { BLOCKS, CATALOG, DEFAULT_BLOCKS } from '../catalog/shared/limits.js';
import { fromLocalInput, toLocalInput } from '../catalog/shared/time.js';

export const PAGE_TABS = Object.freeze([['/pages', 'Pages'], ['/pages/settings', 'Settings'], ['/pages/layout', 'Layout']]);
export const KIND_TABS = Object.freeze([['all', 'All'], ['reel', 'Reels'], ['post', 'Posts'], ['story', 'Stories']]);
export const STATUS_TABS = Object.freeze([['all', 'All'], ['active', 'Live'], ['inactive', 'Off']]);

const CHANNEL = { instagram: 'Instagram', facebook: 'Facebook' };
/** "Instagram reel", "Facebook post": which post a page belongs to. */
export const kindText = (page) => `${CHANNEL[page.channel] ?? 'Instagram'} ${page.kind}`;

const SLUG = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;

/** The lead form on this page: the business's setting, or this page's own answer. */
export const LEAD_CHOICES = Object.freeze([['follow', 'Same as my other pages'], ['on', 'Show the form'], ['off', 'Hide the form']]);
const leadToForm = (value) => (value === null || value === undefined ? 'follow' : value ? 'on' : 'off');
const leadToApi = (value) => (value === 'follow' ? null : value === 'on');

export const EMPTY_PAGE = Object.freeze({ slug: '', headline: '', description: '', active: true, products: [], categoryIds: [], coverUrl: '', leadForm: 'follow' });

/** A landing page from the API as the form holds it. Its products keep their order: it is the order the page shows them (K-30). */
export function pageToForm(page) {
  return {
    slug: page.slug,
    headline: page.headline,
    description: page.description,
    active: page.active,
    products: [...page.products].sort((a, b) => a.position - b.position).map((product) => ({ id: product.id, name: product.name, pricePaise: product.pricePaise, image: product.image, active: product.active, soldOut: product.soldOut })),
    categoryIds: [...page.categoryIds],
    coverUrl: page.coverUrl,
    leadForm: leadToForm(page.leadForm),
  };
}

/** A product from the catalog list as the picker and the form hold it. */
export const pickedProduct = (product) => ({ id: product.id, name: product.name, pricePaise: product.display?.pricePaise ?? product.pricePaise, image: product.images[0] ?? '', active: product.active, soldOut: product.display?.soldOut ?? false });

/** How many products this page may show: the plan's number, never more than the catalog's own limit. */
export const productLimit = (limit) => Math.min(limit ?? CATALOG.landingProducts, CATALOG.landingProducts);

export function limitNote(limit) {
  const max = productLimit(limit);
  return max <= 1 ? 'Your plan shows 1 product on a page. A higher plan shows up to 20.' : `Up to ${max} products, in the order they appear in the post.`;
}

/** The form as the API wants it (PageUpdate), or `errors` by field. `limit` is the page's productLimit, when known. */
export function formToPage(form, { limit } = {}) {
  const errors = {};
  const slug = form.slug.trim().toLowerCase();
  if (slug && !SLUG.test(slug)) errors.slug = 'Use lower-case letters, numbers and dashes';
  if (form.headline.trim().length > 200) errors.headline = 'Use 200 characters or fewer';
  if (form.description.trim().length > 300) errors.description = 'Use 300 characters or fewer';
  const max = productLimit(limit);
  if (!form.products.length) errors.products = 'Pick at least 1 product';
  else if (form.products.length > max) errors.products = max <= 1 ? 'Your plan shows 1 product on a page. Remove the others, or ask about a higher plan.' : `A page can show at most ${plural(max, 'product')}`;
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      ...(slug ? { slug } : {}),
      headline: form.headline.trim(),
      description: form.description.trim(),
      active: form.active,
      productIds: form.products.map((product) => product.id),
      categoryIds: form.categoryIds,
      coverUrl: form.coverUrl,
      leadForm: leadToApi(form.leadForm),
    },
  };
}

/** A new page for the post the owner picked (PageCreate). */
export function newPageBody(media, form) {
  if (!media) return { errors: { media: 'Pick a post from your account' } };
  const { body, errors } = formToPage(form);
  if (errors) return { errors };
  return { body: { channel: media.channel, kind: media.kind, mediaId: media.mediaId, ...body } };
}

/** API field names that the form calls something else. */
export const RENAME = { productIds: 'products', mediaId: 'media' };

/** One line about a page in the list. */
export function pageLine(page) {
  return [kindText(page), plural(page.productCount, 'product'), page.visits === null || page.visits === undefined ? '' : plural(page.visits, 'visit')].filter(Boolean).join(' · ');
}

/** Why a page that is on may still show nothing, in the owner's words. */
export function pageWarning(page, now = Date.now()) {
  if (!page.active) return '';
  if (page.kind === 'story' && page.expiresAt && Date.parse(page.expiresAt) <= now) return page.coverUrl ? 'The story has ended. Shoppers now see your cover picture.' : 'The story has ended. Add a cover picture so the page still has something to show.';
  if (page.products && !page.products.some((product) => product.active)) return 'Every product on this page is archived, so shoppers see none.';
  return '';
}

// ---- the WhatsApp order button and page settings (8.11, 8.12) --------------------------------------------------------------

export function settingsToForm(settings) {
  return { whatsappOrder: settings.whatsappOrder, whatsappTemplate: settings.whatsappTemplate, landingNoindex: settings.landingNoindex, moreReels: settings.moreReels };
}

export function formToSettings(form) {
  const errors = {};
  const template = form.whatsappTemplate.trim();
  if (!template) errors.whatsappTemplate = 'Write the message';
  else if (template.length > 500) errors.whatsappTemplate = 'Use 500 characters or fewer';
  else if (!template.includes('{product}')) errors.whatsappTemplate = 'Keep {product} in the message';
  if (Object.keys(errors).length) return { errors };
  return { body: { whatsappOrder: form.whatsappOrder, whatsappTemplate: template, landingNoindex: form.landingNoindex, moreReels: form.moreReels } };
}

/** The message a shopper's WhatsApp opens with, for one example product. */
export const templatePreview = (template, product = 'Brass diya set') => String(template).replaceAll('{product}', product).replaceAll('{price}', '₹499').replaceAll('{url}', 'the link to this page');

// ---- the blocks of a page (5.18 level 3) -----------------------------------------------------------------------------------

export const SURFACES = Object.freeze([['landing', 'Reel and post pages'], ['creator', 'Creator page'], ['store_home', 'Store home']]);

export const BLOCK_TEXT = Object.freeze({
  hero: ['Top of the page', 'Your name, the reel or post, and its headline'],
  ticker: ['Moving strip', 'The short lines of your look'],
  products: ['Products', 'The products of this page, in your order'],
  more_reels: ['More reels', 'Other reels from the same category'],
  shelves: ['Shelves', 'A row of reels for each category'],
  lead_form: ['Lead form', 'Name and phone or email, with consent'],
  trust: ['Trust row', 'Up to three short promises'],
  banner: ['Banner', 'A line of words, with a picture if you like'],
  countdown: ['Countdown', 'A line of words and when it ends'],
  testimonials: ['Customer words', 'What your customers say'],
  faq: ['Questions and answers', 'The questions you are asked most'],
  video: ['Video', 'A video from a web link'],
  bulk_order: ['Bulk orders', 'A line inviting large orders'],
  whatsapp: ['WhatsApp button', 'Chat with you on WhatsApp'],
});

/** Blocks that are the page itself: one each, at most. */
const ONCE = new Set(['hero', 'products', 'more_reels', 'shelves', 'lead_form', 'whatsapp', 'ticker']);

/** The fields each block's settings take, as the form asks for them. `lines` fields hold one item per line. */
export const BLOCK_FIELDS = Object.freeze({
  trust: [{ name: 'items', label: 'Promises', kind: 'lines', hint: 'One per line, up to 3. Leave empty for the usual ones.', parts: ['label'], max: 3 }],
  banner: [{ name: 'text', label: 'Words', required: true, max: 120 }, { name: 'imageUrl', label: 'Picture link', hint: 'Optional. An uploaded picture or a link starting with https://' }, { name: 'linkUrl', label: 'Where it goes', hint: 'Optional. A page of your shop, like /c/festive, or a link starting with https://' }],
  countdown: [{ name: 'text', label: 'Words', required: true, max: 80 }, { name: 'endsAt', label: 'Ends at', kind: 'time', required: true }],
  testimonials: [{ name: 'items', label: 'Customer words', kind: 'lines', required: true, hint: 'One per line: what they said | their name', parts: ['quote', 'name'], max: 6 }],
  faq: [{ name: 'items', label: 'Questions', kind: 'lines', required: true, hint: 'One per line: the question | the answer', parts: ['q', 'a'], max: 10 }],
  video: [{ name: 'url', label: 'Video link', required: true, hint: 'A link starting with https://' }],
  bulk_order: [{ name: 'text', label: 'Words', required: true, max: 200 }],
});

const fieldsOf = (block) => BLOCK_FIELDS[block] ?? [];

function settingsToValues(block, settings = {}) {
  const values = {};
  for (const field of fieldsOf(block)) {
    const value = settings[field.name];
    if (field.kind === 'lines') values[field.name] = Array.isArray(value) ? value.map((item) => field.parts.map((part) => item[part] ?? '').join(' | ')).join('\n') : '';
    else if (field.kind === 'time') values[field.name] = toLocalInput(value);
    else values[field.name] = value ?? '';
  }
  return values;
}

/** A surface's layout from the API as the editor holds it: one row per block, in order. */
export function layoutToRows(layout) {
  return layout.blocks.map((block, index) => ({ key: `${block.block}-${index}`, block: block.block, visible: block.visible, values: settingsToValues(block.block, block.settings) }));
}

/** The blocks that can still be added to this surface: allowed there, and not a once-only block already placed. */
export function addableBlocks(surface, rows) {
  const placed = new Set(rows.map((row) => row.block));
  return Object.keys(BLOCKS).filter((block) => BLOCKS[block].surfaces.includes(surface) && !(ONCE.has(block) && placed.has(block)));
}

export const newRow = (block, rows) => ({ key: `${block}-new-${rows.length}-${rows.filter((row) => row.block === block).length}`, block, visible: true, values: settingsToValues(block) });

const PLAIN = /^[^<>{}\0]*$/;

function valuesToSettings(row) {
  const settings = {};
  for (const field of fieldsOf(row.block)) {
    const text = String(row.values[field.name] ?? '').trim();
    if (!text) {
      if (field.required) return { error: `${BLOCK_TEXT[row.block][0]}: ${field.label.toLowerCase()} can’t be empty` };
      continue;
    }
    if (field.kind === 'lines') {
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length > field.max) return { error: `${BLOCK_TEXT[row.block][0]}: use at most ${field.max} lines` };
      const items = [];
      for (const line of lines) {
        const parts = line.split('|').map((part) => part.trim());
        if (parts.length !== field.parts.length || parts.some((part) => !part)) return { error: `${BLOCK_TEXT[row.block][0]}: write each line as ${field.parts.length > 1 ? 'two parts with | between them' : 'a few words'}` };
        if (!PLAIN.test(line)) return { error: `${BLOCK_TEXT[row.block][0]}: use plain words only` };
        items.push(Object.fromEntries(field.parts.map((part, i) => [part, parts[i]])));
      }
      settings[field.name] = items;
    } else if (field.kind === 'time') {
      const at = fromLocalInput(text);
      if (!at) return { error: `${BLOCK_TEXT[row.block][0]}: pick a date and time` };
      settings[field.name] = at;
    } else {
      if (field.max && text.length > field.max) return { error: `${BLOCK_TEXT[row.block][0]}: use ${field.max} characters or fewer` };
      settings[field.name] = text;
    }
  }
  return { settings };
}

/** The whole layout of one surface as the API takes it (PageBlocksSave), or the first thing wrong with it. */
export function rowsToLayout(surface, rows) {
  const blocks = [];
  for (const row of rows) {
    const { settings, error } = valuesToSettings(row);
    if (error) return { error };
    blocks.push({ block: row.block, visible: row.visible, settings });
  }
  if (blocks.length > 30) return { error: 'A page can have at most 30 blocks' };
  return { body: { surface, blocks } };
}

/** The surface's standard blocks, for "Back to the standard layout". */
export const standardRows = (surface) => DEFAULT_BLOCKS[surface].map((block, index) => ({ key: `${block}-${index}`, block, visible: true, values: settingsToValues(block) }));
