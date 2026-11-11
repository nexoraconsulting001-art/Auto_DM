// What the Phase 3 console screens decide before they draw, and every request they build, checked against the API's own schemas so
// the console can't send what the server refuses. Pure functions only: no build and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS as L } from '../../../src/contracts/catalog.js';
import { CategoryRuleCreate, SequenceSave, SequenceSchedule } from '../../../src/contracts/api/categories.js';
import { CreatorPageUpdate } from '../../../src/contracts/api/creator.js';
import { BulkImport, DraftSave, LinkImport, ShopifyImport } from '../../../src/contracts/api/imports.js';
import { ConsentUpdate, LeadFormUpdate } from '../../../src/contracts/api/leads.js';
import { PageBlocksSave, PageCreate, PageSettingsUpdate, PageUpdate } from '../../../src/contracts/api/pages.js';
import { CatalogSettingsUpdate, ProductCreate, ProductUpdate } from '../../../src/contracts/api/products.js';
import { SiteReadCreate, ThemeText } from '../../../src/contracts/api/themes.js';
import {
  EMPTY_PRODUCT, cardPrice, changedFields, combinations, draftToForm, fetchNote, formToProduct, needsAttention, priceChangeNote, productBadges, productToForm, recheckBody,
  sourceText, variantsFor,
} from '../../../console/src/features/catalog/form.js';
import { fromLocalInput, toLocalInput } from '../../../console/src/features/catalog/shared/time.js';
import { bulkBody, csvProblem, isRunning, itemView, jobCounts, jobLine, jobState, linkBody, linkResultView, shopifyBody } from '../../../console/src/features/imports/form.js';
import {
  EMPTY_PAGE, addableBlocks, formToPage, formToSettings, layoutToRows, limitNote, newPageBody, newRow, pageLine, pageToForm, pageWarning, pickedProduct, productLimit, rowsToLayout,
  standardRows, templatePreview,
} from '../../../console/src/features/pages/form.js';
import { accentNote, lookStyles, lookWords, siteBody, siteReadView, textBody, themeToText } from '../../../console/src/features/themes/form.js';
import {
  EMPTY_RULE, canMove, inShownOrder, moveReel, orderChanged, reelNotes, reelTitle, ruleBody, ruleText, sequenceBody, windowBody,
} from '../../../console/src/features/categories/sequence.js';
import { creatorState, creatorToForm, formToCreator, slugNote, slugProblem, tidySlug } from '../../../console/src/features/creator/form.js';
import {
  activeChannels, consentBadges, consentBody, downloadView, formRowBody, formsToRows, leadContact, mayContact, sameChannels, sourceText as leadSource,
} from '../../../console/src/features/leads/form.js';

const ok = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  assert.equal(parsed.success, true, `${what}: ${JSON.stringify(parsed.error?.issues ?? [])}`);
  return parsed.data;
};
const form = (changes = {}) => ({ ...EMPTY_PRODUCT, name: 'Brass diya', price: '499', ...changes });

// ---- catalog -------------------------------------------------------------------------------------------------------------------

test('a product form becomes a body the API takes, with money in whole paise', () => {
  const { body, errors } = formToProduct(form({ price: '1,299.50', mrp: '1999', externalUrl: 'https://shop.example/p/diya', tags: ['festive'], stock: '4' }));
  assert.equal(errors, undefined);
  ok(ProductCreate, body, 'product');
  assert.equal(body.pricePaise, 129950);
  assert.equal(body.mrpPaise, 199900);
  assert.equal(body.stock, 4);
  assert.equal(body.whatsappOrder, null, 'follows the business setting until the owner says otherwise');
});

test('K-02: an MRP below the price is refused on the form, and one equal to it is not sent as a discount', () => {
  assert.match(formToProduct(form({ price: '500', mrp: '400' })).errors.mrp, /lower than the price/);
  assert.equal(formToProduct(form({ price: '500', mrp: '500' })).body.mrpPaise, null);
});

test('what is wrong with a product is said field by field, before anything is sent', () => {
  const { errors } = formToProduct(form({ name: ' ', price: 'abc', externalUrl: 'shop.example/p', stock: '1.5' }));
  assert.deepEqual(Object.keys(errors).sort(), ['externalUrl', 'name', 'price', 'stock']);
  assert.match(formToProduct(form({ price: '99999999999' })).errors.price, /too large/);
  assert.match(formToProduct(form({ name: 'x'.repeat(L.nameLength + 1) })).errors.name, /120/);
  assert.match(formToProduct(form({ inStock: true, stock: '0' })).errors.stock, /sold out/);
});

test('options make one variant per combination, and what the owner typed for a combination survives a change of options', () => {
  const options = [{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red', 'Blue'] }];
  assert.equal(combinations(options).length, 4);
  const first = variantsFor([options[0]], [], { price: '499', mrp: '' });
  assert.deepEqual(first.map((variant) => variant.optionValues), [['S'], ['M']]);
  first[1] = { ...first[1], price: '549', sku: 'DIYA-M' };
  const grown = variantsFor(options, first, { price: '499' });
  assert.equal(grown.length, 4);
  assert.deepEqual(grown.filter((variant) => variant.optionValues[0] === 'M').map((variant) => variant.price), ['549', '549'], 'each new combination starts from the variant it grew from');
  assert.equal(variantsFor(options, grown).find((variant) => variant.optionValues.join() === 'M,Red').sku, 'DIYA-M');
  assert.deepEqual(combinations([{ name: '', values: ['S'] }, { name: 'Size', values: [] }]), [], 'an option with no name or no values makes none');
});

test('K-01: a product with options is sent with its variants; too many, a repeat and a shared SKU are refused', () => {
  const options = [{ name: 'Size', values: ['S', 'M'] }];
  const variants = variantsFor(options, [], { price: '499' });
  const { body } = formToProduct(form({ options, variants: variants.map((variant, i) => ({ ...variant, sku: `D-${i}` })), images: ['/media/a', '/media/b'] }));
  ok(ProductCreate, body, 'product with variants');
  assert.equal(body.variants.length, 2);
  assert.match(formToProduct(form({ options, variants: variants.map((variant) => ({ ...variant, sku: 'SAME' })) })).errors.variants, /SKU SAME/);
  assert.match(formToProduct(form({ options, variants: [] })).errors.variants, /at least one variant/);
  assert.match(formToProduct(form({ options: [{ name: 'Size', values: ['S'] }, { name: 'size', values: ['M'] }] })).errors.options, /same name/);
  const many = [{ name: 'A', values: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { name: 'B', values: Array.from({ length: 10 }, (_, i) => `b${i}`) }];
  assert.match(formToProduct(form({ options: many, variants: [] })).errors.options, /110 variants/);
  assert.match(formToProduct(form({ options: [{ name: '', values: ['S'] }] })).errors.options, /Name each option/);
});

test('a product with no options keeps its SKU as one variant with no option values', () => {
  const { body } = formToProduct(form({ sku: 'DIYA-1' }));
  assert.deepEqual(body.variants, [{ optionValues: [], sku: 'DIYA-1', pricePaise: 49900, mrpPaise: null, inStock: true, imageIndex: null }]);
  ok(ProductCreate, body, 'product with a sku');
});

const fromApi = (changes = {}) => ({
  id: 7, name: 'Brass diya', description: 'A lamp', pricePaise: 49900, mrpPaise: 59900, externalUrl: 'https://shop.example/p/diya', inStock: true, stock: null, tags: ['festive'],
  images: ['/media/a'], gallery: [{ id: 1, url: '/media/a', alt: 'A lamp' }], options: [], variants: [], active: true, featured: false, categoryIds: [3], whatsappOrder: null,
  source: 'shopify', fetchStatus: 'ok', priceChanged: false, ownerEdited: [], ...changes,
});

test('8.8: saving sends only what changed, so an untouched price stays the importer\'s to update', () => {
  const before = formToProduct(productToForm(fromApi())).body;
  const edited = { ...productToForm(fromApi()), description: 'A brass lamp' };
  const changes = changedFields(before, formToProduct(edited).body);
  assert.deepEqual(Object.keys(changes), ['description']);
  ok(ProductUpdate, changes, 'update');
  assert.deepEqual(changedFields(before, before), {}, 'nothing changed sends nothing');
});

test('fields the server reads together are sent together', () => {
  const before = formToProduct(productToForm(fromApi())).body;
  const withPhoto = formToProduct({ ...productToForm(fromApi()), images: ['/media/a', '/media/b'] }).body;
  assert.deepEqual(Object.keys(changedFields(before, withPhoto)).sort(), ['imageAlts', 'images']);
  const withStock = formToProduct({ ...productToForm(fromApi()), stock: '3' }).body;
  assert.deepEqual(Object.keys(changedFields(before, withStock)).sort(), ['inStock', 'stock']);
  const withOption = formToProduct({ ...productToForm(fromApi()), options: [{ name: 'Size', values: ['S'] }], variants: variantsFor([{ name: 'Size', values: ['S'] }], [], { price: '499' }) }).body;
  assert.deepEqual(Object.keys(changedFields(before, withOption)).sort(), ['options', 'variants']);
});

test('a product from the API fills the form and comes back unchanged', () => {
  const product = fromApi({ options: [{ name: 'Size', values: ['S', 'M'] }], variants: [{ id: 1, optionValues: ['S'], sku: 'D-S', pricePaise: 49900, mrpPaise: null, inStock: true, imageId: 1 }, { id: 2, optionValues: ['M'], sku: '', pricePaise: 54900, mrpPaise: 59900, inStock: false, imageId: null }] });
  const filled = productToForm(product);
  assert.equal(filled.price, '499');
  assert.equal(filled.alts['/media/a'], 'A lamp');
  assert.equal(filled.variants[0].imageIndex, 0);
  assert.equal(filled.whatsappOrder, 'follow');
  const { body } = formToProduct(filled);
  ok(ProductCreate, body, 'round trip');
  assert.deepEqual(body.variants.map((variant) => [variant.pricePaise, variant.mrpPaise, variant.inStock]), [[49900, null, true], [54900, 59900, false]]);
  assert.equal(productToForm(fromApi({ whatsappOrder: false })).whatsappOrder, 'off');
  assert.equal(formToProduct({ ...filled, whatsappOrder: 'on' }).body.whatsappOrder, true);
});

test('8.7: a draft read from a page fills the form within the limits, and saves as the API takes it', () => {
  const draft = {
    name: 'x'.repeat(200), description: 'From the page', externalUrl: 'https://shop.example/p/1', pricePaise: 49900, mrpPaise: 39900, inStock: true,
    images: Array.from({ length: 9 }, (_, i) => `https://shop.example/img/${i}.jpg`), tags: ['a', 'a', 'b'], suggestedCategories: [], options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [{ optionValues: ['S'], sku: 'S1', pricePaise: 49900, mrpPaise: 39900, inStock: true }, { optionValues: ['M'], sku: 'M1', pricePaise: 52900, mrpPaise: null, inStock: false }], source: 'link', sourceRef: '',
  };
  const filled = draftToForm(draft);
  assert.equal(filled.name.length, L.nameLength);
  assert.equal(filled.images.length, L.images);
  assert.deepEqual(filled.tags, ['a', 'b']);
  assert.equal(filled.mrp, '', 'an MRP below the price is dropped, not shown as a discount');
  assert.equal(filled.variants[0].mrp, '');
  ok(DraftSave, formToProduct(filled).body, 'draft');
  assert.equal(draftToForm({ externalUrl: 'https://shop.example/p/2' }).price, '', 'a draft with no price asks the owner for one');
  assert.match(formToProduct(draftToForm({ externalUrl: 'https://shop.example/p/2' })).errors.price, /required/);
});

test('K-03: a card shows the price, the MRP with its discount, or Sold out', () => {
  assert.deepEqual(cardPrice({ display: { pricePaise: 49900, mrpPaise: 59900, discountPercent: 17, soldOut: false } }), { price: '₹499', strike: '₹599', off: '-17%', soldOut: false });
  assert.deepEqual(cardPrice({ pricePaise: 49900, mrpPaise: null, inStock: false }), { price: '₹499', strike: '', off: '', soldOut: true });
});

test('8.5, 8.8: a product that needs the owner says so first, in the owner\'s words', () => {
  const broken = fromApi({ fetchStatus: 'broken', priceChanged: true, previousPricePaise: 39900 });
  assert.equal(needsAttention(broken), true);
  assert.deepEqual(productBadges(broken).map((badge) => badge.text), ['Needs attention', 'Price changed']);
  assert.match(fetchNote(broken), /gone/);
  assert.match(fetchNote(fromApi({ fetchStatus: 'missing' })), /no longer in your store/);
  assert.equal(fetchNote(fromApi()), '');
  assert.equal(priceChangeNote(broken), 'The price on your site changed from ₹399 to ₹499. Check it is right.');
  assert.equal(priceChangeNote(fromApi()), '');
  assert.deepEqual(productBadges(fromApi()).map((badge) => badge.text), ['Active']);
  assert.deepEqual(productBadges(fromApi({ active: false })).map((badge) => badge.text), ['Archived']);
  assert.equal(sourceText('adapter:woo'), 'From your site’s service');
  assert.equal(sourceText('csv'), 'From a CSV file');
});

test('the re-check interval is whole hours from 1 to 720', () => {
  ok(CatalogSettingsUpdate, recheckBody('24').body, 're-check');
  for (const bad of ['', '0', '721', '2.5', 'soon']) assert.ok(recheckBody(bad).error, bad);
});

test('times go to a date-and-time field and back without moving', () => {
  const iso = '2026-11-05T09:30:00.000Z';
  assert.equal(fromLocalInput(toLocalInput(iso)), iso);
  assert.equal(toLocalInput(null), '');
  assert.equal(fromLocalInput(''), null);
  assert.equal(fromLocalInput('next week'), undefined);
});

// ---- imports -------------------------------------------------------------------------------------------------------------------

test('8.3, 8.5, 8.6: each way in builds a body the API takes, and says what is wrong before sending', () => {
  ok(LinkImport, linkBody(' shop.example/p/1 ').body, 'link');
  for (const bad of ['', 'two links here', 'nodots']) assert.ok(linkBody(bad).error, bad);
  const bulk = bulkBody('https://a.example/1\nhttps://a.example/2, https://a.example/1');
  assert.deepEqual(bulk.body.urls, ['https://a.example/1', 'https://a.example/2'], 'repeats are sent once');
  ok(BulkImport, bulk.body, 'bulk');
  const tooMany = Array.from({ length: L.bulkLinks + 1 }, (_, i) => `https://a.example/${i}`).join('\n');
  assert.match(bulkBody(tooMany).error, /up to 25 links.*You pasted 26/);
  ok(BulkImport, bulkBody(Array.from({ length: L.bulkLinks }, (_, i) => `https://a.example/${i}`).join('\n')).body, '25 links');
  assert.ok(bulkBody('').error);
  ok(ShopifyImport, shopifyBody('plants.example').body, 'shopify');
  assert.ok(shopifyBody('my store').error);
});

test('8.6: a CSV file is checked for its kind and size before it is uploaded', () => {
  assert.equal(csvProblem({ name: 'products.csv', type: 'text/csv', size: 1200 }), '');
  assert.equal(csvProblem({ name: 'products.csv', type: '', size: 1200 }), '', 'a phone often gives no type: the name is enough');
  assert.match(csvProblem({ name: 'products.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1200 }), /CSV/);
  assert.match(csvProblem({ name: 'big.csv', type: 'text/csv', size: L.csvBytes + 1 }), /2 MB/);
  assert.match(csvProblem({ name: 'empty.csv', type: 'text/csv', size: 0 }), /empty/);
  assert.equal(csvProblem(null), 'Choose a file');
});

const job = (changes = {}) => ({ id: 1, kind: 'bulk', status: 'done', total: 5, created: 2, updated: 1, unchanged: 0, refused: 1, failed: 1, archived: 0, message: '', ...changes });

test('an import says how far it is, and what happened once it ends', () => {
  assert.equal(jobLine(job({ status: 'running' })), '5 of 5 products so far');
  assert.equal(jobLine(job({ status: 'queued', total: 0, created: 0, updated: 0, refused: 0, failed: 0 })), 'Starting');
  assert.equal(jobLine(job()), '2 added · 1 updated · 1 need a look · 1 couldn’t be read');
  assert.equal(jobLine(job({ status: 'failed', message: 'This store’s product list isn’t public.' })), 'This store’s product list isn’t public.');
  assert.equal(jobLine(job({ created: 0, updated: 0, refused: 0, failed: 0 })), 'Nothing to import');
  assert.deepEqual(jobCounts(job({ archived: 3 })).at(-1), '3 archived');
  assert.equal(isRunning(job({ status: 'queued' })), true);
  assert.equal(isRunning(job()), false);
  assert.equal(jobState(job({ status: 'failed' })).tone, 'bad');
});

test('8.7: the quality gate\'s verdict is shown in words, and a refused item can still be saved by the owner', () => {
  const refused = itemView({ id: 4, status: 'refused', line: 3, url: 'https://shop.example/', message: 'This looks like the homepage, not a product.', gatePassed: false, readFrom: 'title', productId: null, draft: { name: 'Shop' } });
  assert.equal(refused.text, 'Needs a look');
  assert.equal(refused.gate, 'Stopped by the quality check');
  assert.equal(refused.canSave, true);
  assert.equal(refused.action, 'Add the details');
  assert.match(refused.where, /Row 3.*page title only/);
  const created = itemView({ id: 5, status: 'created', line: 0, url: 'https://shop.example/p/1', message: '', gatePassed: true, readFrom: 'json_ld', productId: 9, draft: { name: 'Diya' } });
  assert.equal(created.canSave, false);
  assert.equal(created.gate, 'Passed the quality check');
  assert.equal(created.productId, 9);
  assert.equal(itemView({ id: 6, status: 'failed', line: 0, url: 'https://shop.example/x', message: 'The page didn’t answer.', gatePassed: null, readFrom: '', productId: null, draft: null }).title, 'https://shop.example/x');
  assert.equal(itemView({ id: 7, status: 'draft', line: 0, url: '', sku: '', message: '', gatePassed: true, productId: null, draft: { name: 'Lamp' } }).action, 'Check and save');
});

test('8.3, K-11: one link answers with a draft to check, the product it already is, or why not', () => {
  assert.equal(linkResultView({ status: 'draft', itemId: 1, message: '' }).review, true);
  assert.deepEqual([linkResultView({ status: 'existing', productId: 4, message: 'Already there.' }).productId, linkResultView({ status: 'existing', productId: 4 }).review], [4, undefined]);
  const refused = linkResultView({ status: 'refused', itemId: 2, draft: { name: 'Shop' }, message: 'Only the page title was found.' });
  assert.deepEqual([refused.review, refused.manual, refused.tone], [true, true, 'warn']);
  const failed = linkResultView({ status: 'failed', itemId: null, draft: null, message: '' });
  assert.deepEqual([failed.manual, failed.review, failed.tone], [true, undefined, 'bad']);
  assert.ok(failed.text);
});

// ---- landing pages -------------------------------------------------------------------------------------------------------------

const picked = (id, changes = {}) => ({ id, name: `Product ${id}`, pricePaise: 49900, image: '', active: true, soldOut: false, ...changes });
const media = { channel: 'instagram', kind: 'reel', mediaId: '17900000000000001' };

test('8.10: a new page names its post and its products in the order they were picked (K-30)', () => {
  const { body } = newPageBody(media, { ...EMPTY_PAGE, products: [picked(3), picked(1), picked(2)], headline: ' Diwali picks ' });
  ok(PageCreate, body, 'new page');
  assert.deepEqual(body.productIds, [3, 1, 2]);
  assert.equal(body.headline, 'Diwali picks');
  assert.equal(body.slug, undefined, 'an empty link name is left for the server to make');
  assert.equal(body.leadForm, null);
  assert.match(newPageBody(null, { ...EMPTY_PAGE, products: [picked(1)] }).errors.media, /Pick a post/);
  assert.match(newPageBody(media, { ...EMPTY_PAGE }).errors.products, /at least 1/);
});

test('K-41: a page shows as many products as the plan allows, and the form says so before the server has to', () => {
  assert.equal(productLimit(1), 1);
  assert.equal(productLimit(50), L.landingProducts);
  assert.equal(productLimit(undefined), L.landingProducts);
  assert.match(limitNote(1), /Your plan shows 1 product/);
  assert.match(limitNote(20), /Up to 20 products/);
  assert.match(formToPage({ ...EMPTY_PAGE, products: [picked(1), picked(2)] }, { limit: 1 }).errors.products, /Your plan shows 1 product/);
  const full = Array.from({ length: L.landingProducts + 1 }, (_, i) => picked(i + 1));
  assert.match(formToPage({ ...EMPTY_PAGE, products: full }, { limit: 20 }).errors.products, /at most 20 products/);
  ok(PageUpdate, formToPage({ ...EMPTY_PAGE, products: full.slice(0, 20) }, { limit: 20 }).body, '20 products');
});

test('a page from the API fills the form with its products in page order, and saves as the API takes it', () => {
  const page = {
    slug: 'diwali', headline: 'Diwali', description: '', active: true, categoryIds: [2], coverUrl: '/media/cover', leadForm: false,
    products: [{ ...picked(5), position: 1 }, { ...picked(9), position: 0 }],
  };
  const filled = pageToForm(page);
  assert.deepEqual(filled.products.map((product) => product.id), [9, 5]);
  assert.equal(filled.leadForm, 'off');
  const { body } = formToPage(filled, { limit: 20 });
  ok(PageUpdate, body, 'page');
  assert.deepEqual([body.slug, body.leadForm, body.coverUrl], ['diwali', false, '/media/cover']);
  assert.match(formToPage({ ...filled, slug: 'Not A Slug!' }).errors.slug, /lower-case/);
  assert.deepEqual(pickedProduct({ id: 4, name: 'Lamp', pricePaise: 100, display: { pricePaise: 90, soldOut: true }, images: ['/media/x'], active: false }), { id: 4, name: 'Lamp', pricePaise: 90, image: '/media/x', active: false, soldOut: true });
});

test('K-31: a page that is on but shows nothing says why', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const story = { active: true, kind: 'story', expiresAt: '2026-11-10T10:00:00Z', coverUrl: '', products: [picked(1)] };
  assert.match(pageWarning(story, now), /Add a cover picture/);
  assert.match(pageWarning({ ...story, coverUrl: '/media/c' }, now), /see your cover picture/);
  assert.equal(pageWarning({ ...story, expiresAt: '2026-11-12T10:00:00Z' }, now), '');
  assert.match(pageWarning({ active: true, kind: 'reel', products: [picked(1, { active: false })] }, now), /archived/);
  assert.equal(pageWarning({ active: false, kind: 'reel', products: [] }, now), '');
  assert.equal(pageLine({ channel: 'facebook', kind: 'post', productCount: 1, visits: 12 }), 'Facebook post · 1 product · 12 visits');
  assert.equal(pageLine({ channel: 'instagram', kind: 'reel', productCount: 3, visits: null }), 'Instagram reel · 3 products');
});

test('8.11: the WhatsApp message keeps {product}, and the example shows what a shopper sends', () => {
  const settings = { whatsappOrder: true, whatsappTemplate: 'Hi, I want {product} ({price}) {url}', landingNoindex: true, moreReels: false };
  ok(PageSettingsUpdate, formToSettings(settings).body, 'page settings');
  assert.match(formToSettings({ ...settings, whatsappTemplate: 'Hi there' }).errors.whatsappTemplate, /Keep \{product\}/);
  assert.match(formToSettings({ ...settings, whatsappTemplate: ' ' }).errors.whatsappTemplate, /Write the message/);
  assert.equal(templatePreview('I want {product} at {price}'), 'I want Brass diya set at ₹499');
});

test('5.18: a layout is the shared blocks in the business\'s own order, and only blocks allowed on that page', () => {
  for (const surface of ['landing', 'creator', 'store_home']) {
    const rows = standardRows(surface);
    ok(PageBlocksSave, rowsToLayout(surface, rows).body, `standard ${surface}`);
    for (const block of addableBlocks(surface, rows)) ok(PageBlocksSave, { surface, blocks: [{ block, visible: true, settings: {} }] }, `${block} on ${surface}`);
  }
  const landing = standardRows('landing');
  assert.ok(!addableBlocks('landing', landing).includes('hero'), 'a block that is the page itself goes on once');
  assert.ok(addableBlocks('landing', landing).includes('faq'));
  assert.ok(!addableBlocks('landing', landing).includes('video'), 'a block of another page is not offered');
  assert.ok(addableBlocks('landing', []).includes('hero'));
});

test('a block\'s settings are read from what the owner typed, and what is missing is said', () => {
  const rows = [...standardRows('landing'), newRow('faq', []), newRow('countdown', [])];
  assert.match(rowsToLayout('landing', rows).error, /Questions and answers: questions can’t be empty/);
  rows.at(-2).values.items = 'Do you ship? | Yes, all over India\nReturns? | Within 7 days';
  assert.match(rowsToLayout('landing', rows).error, /Countdown: words can’t be empty/);
  rows.at(-1).values = { text: 'Sale ends soon', endsAt: '2026-12-01T18:00' };
  const { body } = rowsToLayout('landing', rows);
  ok(PageBlocksSave, body, 'layout with settings');
  assert.deepEqual(body.blocks.at(-2).settings.items, [{ q: 'Do you ship?', a: 'Yes, all over India' }, { q: 'Returns?', a: 'Within 7 days' }]);
  assert.match(body.blocks.at(-1).settings.endsAt, /^2026-12-01T/);
  rows.at(-2).values.items = 'A question with no answer';
  assert.match(rowsToLayout('landing', rows).error, /two parts/);
  rows.at(-2).values.items = 'Is it <b>good</b>? | Yes';
  assert.match(rowsToLayout('landing', rows).error, /plain words/);
  const back = layoutToRows({ blocks: body.blocks });
  assert.equal(back.at(-2).values.items, 'Do you ship? | Yes, all over India\nReturns? | Within 7 days');
  assert.equal(new Set(back.map((row) => row.key)).size, back.length, 'every row has its own key');
  assert.match(rowsToLayout('landing', Array.from({ length: 31 }, (_, i) => ({ ...newRow('faq', []), key: `k${i}`, values: { items: 'Q | A' } }))).error, /at most 30/);
});

// ---- looks ---------------------------------------------------------------------------------------------------------------------

test('F-106: the seller\'s own seal and ticker words are plain words within the limits; empty keeps the look\'s', () => {
  ok(ThemeText, textBody({ sealText: ' Handmade in Jaipur ', tickerItems: ['Free delivery', ' ', 'COD'] }).body, 'words');
  assert.deepEqual(textBody({ sealText: '', tickerItems: [] }).body, { sealText: '', tickerItems: [] });
  ok(ThemeText, textBody({ sealText: '', tickerItems: [] }).body, 'empty words');
  assert.match(textBody({ sealText: '<b>hi</b>', tickerItems: [] }).errors.sealText, /plain words/);
  assert.match(textBody({ sealText: 'x'.repeat(61), tickerItems: [] }).errors.sealText, /60/);
  assert.match(textBody({ sealText: '', tickerItems: Array.from({ length: 9 }, (_, i) => `line ${i}`) }).errors.tickerItems, /at most 8/);
  assert.match(textBody({ sealText: '', tickerItems: ['x'.repeat(41)] }).errors.tickerItems, /40/);
  assert.deepEqual(themeToText({ sealText: 'Hi', tickerItems: ['a'] }), { sealText: 'Hi', tickerItems: ['a'] });
});

test('8.9: a website to read is an address, and each read says what can be done with it', () => {
  ok(SiteReadCreate, siteBody(' yourshop.com ').body, 'site read');
  for (const bad of ['', 'my shop', 'x.y', 'nodots']) assert.ok(siteBody(bad).error, bad);
  const colors = { primary: '#112233', accent: '#445566' };
  assert.equal(siteReadView({ status: 'read', colors, appliedAt: null }).usable, true);
  assert.equal(siteReadView({ status: 'read', colors: {}, appliedAt: null }).usable, false, 'a read with no colours can\'t be used');
  assert.equal(siteReadView({ status: 'script_only', colors, appliedAt: null }).tone, 'warn');
  assert.equal(siteReadView({ status: 'failed', colors, appliedAt: null }).usable, false);
  assert.equal(siteReadView({ status: 'blocked', colors: {}, appliedAt: null }).usable, false);
  assert.equal(siteReadView({ status: 'read', colors, appliedAt: '2026-11-01T00:00:00Z' }).applied, true);
  assert.match(accentNote({ accentFrom: 'profile_photo' }), /Instagram photo/);
  assert.equal(accentNote({ accentFrom: '' }), '');
});

test('F-107: a look is drawn from its slot names, and a name the console has never seen still draws', () => {
  const look = { colors: { primary: '#B4340F', on_primary: '#FFFFFF', accent: '#F2B544', on_accent: '#2B1406', ground: '#FFF7EA', card: '#FFFFFF', ink: '#2B1406', muted: '#6B5A4E', line: '#E8D9C4', eyebrow: '#B4340F' }, slots: { reelFrame: 'tilted', photoShape: 'outlined', buttonStyle: 'hard_shadow', buttonCase: 'upper', radius: 10, displayWeight: 800, sealText: 'Asli swad', tickerItems: ['Fresh', 'Hot'] } };
  const styles = lookStyles(look);
  assert.equal(styles.hero.transform, 'rotate(-3deg)');
  assert.equal(styles.button.boxShadow, '3px 3px 0 #2B1406');
  assert.equal(styles.button.textTransform, 'uppercase');
  assert.equal(styles.button.borderRadius, '10px');
  assert.equal(lookStyles({ colors: look.colors, slots: { buttonStyle: 'pill', radius: 4 } }).button.borderRadius, '999px');
  const unknown = lookStyles({ colors: look.colors, slots: { reelFrame: 'hexagon', photoShape: 'star', buttonStyle: 'glass', radius: 'url(x)' } });
  assert.equal(unknown.hero.borderRadius, '8px');
  assert.equal(unknown.photo.borderRadius, '8px');
  assert.equal(unknown.button.borderRadius, '0px', 'a radius that is not a number never reaches a style');
  assert.doesNotThrow(() => lookStyles({}));
  assert.deepEqual(lookWords(look), { seal: 'Asli swad', ticker: ['Fresh', 'Hot'] });
  assert.deepEqual(lookWords(look, { sealText: 'Mine', tickerItems: ['Own'] }), { seal: 'Mine', ticker: ['Own'] });
  assert.deepEqual(lookWords(look, { sealText: '', tickerItems: [] }), { seal: 'Asli swad', ticker: ['Fresh', 'Hot'] });
});

// ---- reel order ----------------------------------------------------------------------------------------------------------------

const reel = (pageId, changes = {}) => ({ pageId, slug: `r${pageId}`, kind: 'reel', headline: `Reel ${pageId}`, thumbnailUrl: '', position: pageId, pinned: false, pinPosition: null, startsAt: null, endsAt: null, joinedBy: 'owner', live: true, hiddenReason: '', ...changes });
const order = (items) => items.map((item) => item.pageId);

test('8.13: the order is saved whole, pinned first in their own order, then the rest', () => {
  const items = [reel(1), reel(2, { pinned: true }), reel(3), reel(4, { pinned: true })];
  assert.deepEqual(order(inShownOrder(items)), [2, 4, 1, 3]);
  const body = sequenceBody(items);
  assert.deepEqual(body, { pinned: [2, 4], order: [1, 3] });
  ok(SequenceSave, body, 'sequence');
});

test('a reel moves among its own kind: a pinned reel never passes an unpinned one', () => {
  const items = [reel(2, { pinned: true }), reel(4, { pinned: true }), reel(1), reel(3)];
  assert.deepEqual(order(moveReel(items, 4, -1)), [4, 2, 1, 3]);
  assert.deepEqual(order(moveReel(items, 1, 1)), [2, 4, 3, 1]);
  assert.deepEqual(order(moveReel(items, 4, 1)), [2, 4, 1, 3], 'the last pinned reel stays above the rest');
  assert.deepEqual(order(moveReel(items, 1, -1)), [2, 4, 1, 3]);
  assert.deepEqual(order(moveReel(items, 99, 1)), [2, 4, 1, 3]);
  assert.deepEqual([canMove(items, 4, 1), canMove(items, 1, -1), canMove(items, 2, -1), canMove(items, 3, 1), canMove(items, 2, 1), canMove(items, 3, -1)], [false, false, false, false, true, true]);
  assert.equal(orderChanged(items, moveReel(items, 1, 1)), true);
  assert.equal(orderChanged(items, [...items]), false);
});

test('K-46: a window belongs to one category, ends after it starts, and both empty clears it', () => {
  const body = windowBody(7, '2026-11-05T09:00', '2026-11-12T21:00').body;
  ok(SequenceSchedule, body, 'window');
  assert.deepEqual(windowBody(7, '', '').body, { pageId: 7, startsAt: null, endsAt: null });
  ok(SequenceSchedule, windowBody(7, '', '').body, 'cleared window');
  ok(SequenceSchedule, windowBody(7, '2026-11-05T09:00', '').body, 'open-ended window');
  assert.match(windowBody(7, '2026-11-12T21:00', '2026-11-05T09:00').errors.endsAt, /after the start/);
  assert.ok(windowBody(7, 'soon', '').errors.startsAt);
});

test('a reel that shows nowhere keeps its place and says why', () => {
  assert.deepEqual(reelNotes(reel(1)), []);
  assert.match(reelNotes(reel(1, { live: false, hiddenReason: 'before_window', startsAt: '2026-11-05T03:30:00Z' }))[0], /^Shows from 5 Nov 2026$/);
  assert.match(reelNotes(reel(1, { live: false, hiddenReason: 'after_window', endsAt: '2026-11-05T03:30:00Z' }))[0], /^Stopped showing on/);
  assert.match(reelNotes(reel(1, { live: false, hiddenReason: 'inactive' }))[0], /keeps its place/);
  assert.match(reelNotes(reel(1, { live: false, hiddenReason: 'no_active_products' }))[0], /archived/);
  assert.deepEqual(reelNotes(reel(1, { joinedBy: 'rule' })), ['Added by a rule']);
  assert.equal(reelTitle(reel(1, { headline: '' })), '/r/r1');
});

test('K-47 to K-49: a rule is a caption word, a hashtag or a product category, and reads as a sentence', () => {
  ok(CategoryRuleCreate, ruleBody({ ...EMPTY_RULE, value: ' diwali ' }).body, 'caption rule');
  const hashtag = ruleBody({ match: 'hashtag', value: '#festive', productCategoryId: '', joinAt: 'bottom' }).body;
  assert.equal(hashtag.value, 'festive');
  ok(CategoryRuleCreate, hashtag, 'hashtag rule');
  const byCategory = ruleBody({ match: 'product_category', value: '', productCategoryId: '4', joinAt: 'top' }).body;
  assert.equal(byCategory.productCategoryId, 4);
  ok(CategoryRuleCreate, byCategory, 'product category rule');
  assert.ok(ruleBody({ ...EMPTY_RULE }).errors.value);
  assert.ok(ruleBody({ match: 'hashtag', value: 'two words', joinAt: 'top' }).errors.value);
  assert.ok(ruleBody({ match: 'product_category', value: '', productCategoryId: '', joinAt: 'top' }).errors.productCategoryId);
  assert.equal(ruleText({ match: 'caption_keyword', value: 'diwali', joinAt: 'top' }), 'New reels with “diwali” in the caption join at the top');
  assert.equal(ruleText({ match: 'hashtag', value: 'festive', joinAt: 'bottom' }), 'New reels with #festive join at the bottom');
  assert.equal(ruleText({ match: 'product_category', productCategoryId: 4, joinAt: 'top' }, [{ id: 4, name: 'Brass' }]), 'New reels with a product from Brass join at the top');
  assert.match(ruleText({ match: 'product_category', productCategoryId: 5, joinAt: 'top' }, []), /was deleted/);
});

// ---- creator page --------------------------------------------------------------------------------------------------------------

test('8.14: the creator page form becomes a body the API takes', () => {
  const filled = creatorToForm({ slug: 'kesar', enabled: true, displayName: 'Kesar Home', bio: 'Brass and more', photoUrl: '/media/p', websiteUrl: 'https://kesar.example', showWhatsapp: true, moreShelfTitle: 'More reels' });
  const { body } = formToCreator(filled);
  ok(CreatorPageUpdate, body, 'creator page');
  assert.equal(body.slug, 'kesar');
  const fresh = creatorToForm({ slug: '', enabled: false, displayName: '', bio: '', photoUrl: '', websiteUrl: '', showWhatsapp: true, moreShelfTitle: 'More reels' });
  assert.match(formToCreator(fresh).errors.slug, /Choose a name/);
  ok(CreatorPageUpdate, formToCreator({ ...fresh, slug: ' Kesar Home ' }).body, 'a typed name is tidied');
  assert.equal(formToCreator({ ...fresh, slug: ' Kesar Home ' }).body.slug, 'kesar-home');
});

test('K-50: a name of the wrong shape is refused on the form; whether it is free is the server\'s answer', () => {
  assert.equal(slugProblem('kesar-home'), '');
  for (const bad of ['-kesar', 'kesar_', 'x'.repeat(41), 'नाम', '']) assert.ok(slugProblem(bad), bad);
  assert.equal(tidySlug('  Kesar  Home '), 'kesar-home');
  assert.deepEqual(slugNote({ slug: 'shop', available: false, message: 'That name is taken by a page of the store' }, 'Shop'), { error: 'That name is taken by a page of the store', hint: '' });
  assert.deepEqual(slugNote({ slug: 'kesar', available: true, message: '' }, 'kesar'), { error: '', hint: 'That name is free.' });
  assert.deepEqual(slugNote({ slug: 'kesar', available: true, message: '' }, 'kesar2'), { error: '', hint: '' }, 'an answer about another name is not shown');
  assert.deepEqual(slugNote(null, 'kesar'), { error: '', hint: '' });
  assert.match(formToCreator({ ...creatorToForm({ slug: 'kesar', moreShelfTitle: 'More' }), websiteUrl: 'http://kesar.example' }).errors.websiteUrl, /https/);
  assert.match(formToCreator({ ...creatorToForm({ slug: 'kesar', moreShelfTitle: 'More' }), moreShelfTitle: ' ' }).errors.moreShelfTitle, /Name the last shelf/);
  assert.deepEqual([creatorState({ slug: '', enabled: false }).text, creatorState({ slug: 'k', enabled: false }).text, creatorState({ slug: 'k', enabled: true }).text], ['Not set up', 'Off', 'Live']);
});

// ---- leads ---------------------------------------------------------------------------------------------------------------------

const lead = (changes = {}) => ({
  id: 1, firstName: 'Asha', phone: '+919800000001', email: '', source: 'landing', sourceRef: 'diwali', utmCampaign: '', pageId: 3, consentVersion: 2, consentedAt: '2026-11-01T10:00:00Z', createdAt: '2026-11-01T10:00:00Z',
  consents: [{ channel: 'whatsapp', grantedAt: '2026-11-01T10:00:00Z', withdrawnAt: null }, { channel: 'email', grantedAt: '2026-11-01T10:00:00Z', withdrawnAt: '2026-11-03T10:00:00Z' }], ...changes,
});

test('K-58: a lead shows what they agreed to per channel, and a withdrawn channel is marked', () => {
  assert.deepEqual(consentBadges(lead()).map((badge) => [badge.text, badge.tone]), [['WhatsApp: agreed', 'good'], ['Email: withdrawn', 'bad']]);
  assert.deepEqual(activeChannels(lead()), ['whatsapp']);
  assert.equal(mayContact(lead()), true);
  assert.equal(mayContact(lead({ consents: [{ channel: 'sms', grantedAt: '2026-11-01T10:00:00Z', withdrawnAt: '2026-11-02T10:00:00Z' }] })), false);
  assert.equal(leadContact(lead({ email: 'asha@example.com' })), '+919800000001 · asha@example.com');
  assert.equal(leadSource(lead()), 'Landing page (diwali)');
  assert.equal(leadSource(lead({ source: 'bio', sourceRef: '', utmCampaign: 'launch' })), 'Bio link · launch');
});

test('8.15: each place the form shows is saved on its own, and a new wording names at least one channel', () => {
  const rows = formsToRows({ available: true, consent: null, items: [{ surface: 'creator', enabled: true, offerLine: 'Get first look' }] });
  assert.deepEqual(rows.map((row) => [row.surface, row.enabled]), [['landing', false], ['creator', true], ['store', false]]);
  for (const row of rows) ok(LeadFormUpdate, formRowBody(row).body, row.surface);
  assert.match(formRowBody({ surface: 'landing', enabled: true, offerLine: 'x'.repeat(161) }).error, /160/);
  assert.match(formRowBody({ surface: 'landing', enabled: true, offerLine: '<script>' }).error, /plain words/);
  assert.deepEqual(consentBody(['email', 'whatsapp']).body, { channels: ['whatsapp', 'email'] });
  ok(ConsentUpdate, consentBody(['email', 'whatsapp']).body, 'consent');
  assert.match(consentBody([]).error, /at least one/);
  assert.equal(sameChannels(['email', 'whatsapp'], ['whatsapp', 'email']), true);
  assert.equal(sameChannels(['email'], ['whatsapp', 'email']), false);
});

test('a download links to its file only while the file is there', () => {
  const ready = downloadView({ id: 1, format: 'xlsx', status: 'ready', rowCount: 1, fileUrl: '/lead-files/1', createdAt: '2026-11-01T10:00:00Z', expiresAt: '2026-11-08T10:00:00Z' });
  assert.equal(ready.href, '/lead-files/1');
  assert.equal(ready.title, 'Excel file · 1 lead');
  assert.match(ready.meta, /kept until/);
  for (const status of ['queued', 'failed', 'expired']) assert.equal(downloadView({ id: 2, format: 'csv', status, rowCount: 0, fileUrl: null, createdAt: '2026-11-01T10:00:00Z', expiresAt: null }).href, '', status);
  assert.equal(downloadView({ id: 3, format: 'csv', status: 'expired', rowCount: 4, fileUrl: '/lead-files/3', createdAt: '2026-11-01T10:00:00Z', expiresAt: null }).href, '', 'an expired file has no link even if one is sent');
});
