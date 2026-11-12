// The owner app's catalog screens (PRD 10.4, 8.1 to 8.15): the pure rules they run on, loaded here without React
// Native, and held equal to the server's contract. The screens themselves are tested with jest beside the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS, FETCH_STATUSES, IMPORT_ITEM_STATUSES, IMPORT_JOB_STATUSES, formatRupees as contractFormat, parseRupees as contractParse } from '../../../src/contracts/catalog.js';
import { ProductCreate, ProductListQuery, ProductUpdate } from '../../../src/contracts/api/products.js';
import { RULE_MATCHES as CONTRACT_RULES, SequenceItem, SequenceSave, SequenceSchedule } from '../../../src/contracts/api/categories.js';
import { BrandKitUpdate } from '../../../src/contracts/api/brand-kit.js';
import { CreatorPageUpdate } from '../../../src/contracts/api/creator.js';
import { CONSENT_CHANNELS as CONTRACT_CHANNELS, Lead } from '../../../src/contracts/api/leads.js';
import { LANDING_KINDS as CONTRACT_KINDS } from '../../../src/contracts/api/pages.js';
import { BUYER_BLOCKS, LEAD_SURFACES as CONTRACT_LEAD_SURFACES, PAGE_SURFACES as CONTRACT_SURFACES, RESERVED_PATHS } from '../../../src/contracts/buyer-pages.js';
import { SEAL_TEXT_MAX, TICKER_ITEMS_MAX, TICKER_ITEM_LENGTH } from '../../../src/contracts/themes.js';
import { IMAGE_UPLOAD } from '../../../src/contracts/api/media.js';
import { CSV_UPLOAD } from '../../../src/contracts/api/imports.js';
import { DESTINATION_UPLOAD } from '../../../src/contracts/api/insights.js';
import * as limits from '../../../apps/owner/src/features/products/limits.js';
import { MAX_INPUT_PAISE, MAX_PRICE_PAISE, formatMoney, formatRupees, moneyInput, mrpProblem, parseRupees, readMoney } from '../../../apps/owner/src/features/products/money.js';
import { changedFields, combinations, draftToForm, formToProduct, priceLine, productBadges, productToForm, recheckBody, splitList, variantsFor } from '../../../apps/owner/src/features/products/form.js';
import { CSV_RULE, IMAGE_RULE, REPORT_RULE, UploadRefused, fileProblem, refusalText, typeOf, uploadFile, uploadImage } from '../../../apps/owner/src/features/products/upload.js';
import { arrange, indexAfterDrag, moveItem, optimistic, pin, reorder, saveBody, splitSequence, unpin } from '../../../apps/owner/src/features/categories/sequence.js';
import { dayToIso, isoToDay } from '../../../apps/owner/src/features/categories/dates.js';
import { brandKitBody } from '../../../apps/owner/src/features/brand-kit/rules.js';
import { creatorBody } from '../../../apps/owner/src/features/creator/rules.js';

const t = (key) => `«${key}»`;

// ---- Money: the shared formatter, never a sum ----

test('the app’s paise formatter and parser are the contract’s, value for value', () => {
  const amounts = [0, 1, 9, 10, 99, 100, 101, 999, 1000, 99_900, 1_29_950, 12_34_567, 1_00_00_000, 99_99_99_999, 100_000_000_000, -5000, -1];
  for (const paise of amounts) assert.equal(formatRupees(paise), contractFormat(paise), `formatRupees(${paise})`);
  for (const text of ['1299', '1,299', '₹1,299.00', 'Rs. 1,299', 'INR 1299', '1299/-', '1,29,900.50', '0.5', '  ₹ 49 ', '', null, 12.5, 0]) {
    assert.equal(parseRupees(text), contractParse(text), `parseRupees(${JSON.stringify(text)})`);
  }
  for (const bad of ['-5', '(5)', '1.234', 'abc', '1,2,3', Number.NaN, -1, '10000000001']) {
    assert.throws(() => contractParse(bad));
    assert.throws(() => parseRupees(bad), (error) => error.code === 'negative_price' || error.code === 'bad_price', `parseRupees(${String(bad)})`);
  }
  assert.equal(MAX_PRICE_PAISE, CATALOG_LIMITS.maxPricePaise);
  assert.equal(MAX_INPUT_PAISE, 2147483647);
});

test('money shows the server’s paise and nothing else, and a typed price is read with no floating point', () => {
  assert.equal(formatMoney(129950), '₹1,299.50');
  assert.equal(formatMoney(1234567), '₹12,345.67');
  assert.equal(formatMoney(1234.56), '₹12.35', 'a rate in paise (revenue per session) shows to the nearest paisa');
  for (const notMoney of ['1299', null, undefined, Number.NaN, Infinity]) assert.equal(formatMoney(notMoney), '');
  assert.deepEqual(readMoney('1,299.50'), { paise: 129950 });
  assert.deepEqual(readMoney('0.29'), { paise: 29 }); // 0.29 * 100 is 28.999… in floating point
  assert.deepEqual(readMoney(''), { error: 'products.money.required' });
  assert.deepEqual(readMoney('', { optional: true }), { paise: null });
  assert.deepEqual(readMoney('-4'), { error: 'products.money.negative' });
  assert.deepEqual(readMoney('21474837'), { error: 'products.money.tooLarge' });
  assert.equal(moneyInput(129950), '1299.50');
  assert.equal(moneyInput(129900), '1299');
  assert.equal(mrpProblem(50000, 40000), 'products.money.mrpBelow');
  assert.equal(mrpProblem(50000, null), null);
});

// ---- The contract's numbers, written out for the app ----

test('the catalog limits and names the app holds are the server’s', () => {
  for (const key of ['images', 'options', 'optionValues', 'variants', 'tags', 'nameLength', 'descriptionLength', 'landingProducts', 'bulkLinks', 'csvBytes']) {
    assert.equal(limits.CATALOG[key], CATALOG_LIMITS[key], key);
  }
  assert.deepEqual(limits.FETCH_STATUSES, FETCH_STATUSES);
  assert.deepEqual([...limits.PRODUCT_STATUSES].sort(), [...ProductListQuery.shape.status.unwrap().options].sort());
  assert.deepEqual([...limits.PRODUCT_SOURCES].sort(), [...ProductListQuery.shape.source.unwrap().options].sort());
  assert.deepEqual(limits.IMPORT_JOB_STATUSES, IMPORT_JOB_STATUSES);
  assert.deepEqual(limits.IMPORT_ITEM_STATUSES, IMPORT_ITEM_STATUSES);
  assert.deepEqual(limits.RULE_MATCHES, CONTRACT_RULES);
  assert.deepEqual([...limits.HIDDEN_REASONS, ''].sort(), [...SequenceItem.shape.hiddenReason.options].sort());
  assert.deepEqual(limits.LANDING_KINDS, CONTRACT_KINDS);
  assert.deepEqual(limits.PAGE_SURFACES, CONTRACT_SURFACES);
  assert.deepEqual(Object.fromEntries(Object.entries(BUYER_BLOCKS).map(([name, b]) => [name, [...b.surfaces]])), limits.BLOCK_SURFACES);
  assert.deepEqual(limits.CONSENT_CHANNELS, CONTRACT_CHANNELS);
  assert.deepEqual(limits.LEAD_SURFACES, CONTRACT_LEAD_SURFACES);
  assert.deepEqual(limits.LEAD_SOURCES, Lead.shape.source.options);
  assert.deepEqual(limits.THEME_TEXT, { sealMax: SEAL_TEXT_MAX, tickerItems: TICKER_ITEMS_MAX, tickerItemLength: TICKER_ITEM_LENGTH });
});

test('the upload limits are the web’s: 5 MB of JPG, PNG, WebP or GIF; CSV 2 MB; reports 5 MB', () => {
  assert.equal(IMAGE_RULE.maxBytes, IMAGE_UPLOAD.maxBytes);
  assert.deepEqual(IMAGE_RULE.mimeTypes, IMAGE_UPLOAD.mimeTypes);
  assert.equal(CSV_RULE.maxBytes, CSV_UPLOAD.maxBytes);
  assert.deepEqual([...CSV_RULE.mimeTypes].sort(), [...CSV_UPLOAD.mimeTypes].sort());
  assert.equal(REPORT_RULE.maxBytes, DESTINATION_UPLOAD.maxBytes);
  assert.deepEqual([...REPORT_RULE.mimeTypes].sort(), [...DESTINATION_UPLOAD.mimeTypes].sort());
});

// ---- Uploads checked before anything is sent ----

test('a photo is checked on the phone: over 5 MB, the wrong type, or of unknown size is never sent', async () => {
  const photo = (over) => ({ uri: 'file:///p/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 1000, ...over });
  assert.equal(fileProblem(photo()), null);
  assert.equal(fileProblem(photo({ fileSize: 5 * 1024 * 1024 })), null);
  assert.equal(fileProblem(photo({ fileSize: 5 * 1024 * 1024 + 1 })), 'products.upload.imageTooLarge');
  assert.equal(fileProblem(photo({ mimeType: 'image/heic', fileName: 'a.heic' })), 'products.upload.imageType');
  assert.equal(fileProblem(photo({ mimeType: 'image/svg+xml', fileName: 'a.svg' })), 'products.upload.imageType');
  assert.equal(fileProblem(photo({ fileSize: undefined })), 'products.upload.sizeUnknown');
  assert.equal(fileProblem(photo({ fileSize: 0 })), 'products.upload.empty');
  assert.equal(fileProblem(null), 'products.upload.none');
  assert.equal(typeOf(photo({ mimeType: 'image/jpg' })), 'image/jpeg');
  assert.equal(typeOf({ uri: 'file:///x.webp', fileName: 'x.webp' }), 'image/webp');

  let sent = 0;
  const api = { media: { upload: async (part) => { sent++; return { id: 'm', url: `/media/${part.name}` }; } } };
  await assert.rejects(uploadImage(api, photo({ fileSize: 6 * 1024 * 1024 })), (e) => e instanceof UploadRefused && e.key === 'products.upload.imageTooLarge');
  assert.equal(sent, 0);
  assert.deepEqual(await uploadImage(api, photo()), { id: 'm', url: '/media/a.jpg' });
  assert.equal(sent, 1);

  await assert.rejects(uploadFile({ uri: 'file:///c.csv', name: 'c.csv', size: 2_000_001 }, CSV_RULE, async () => assert.fail('sent')), (e) => e.key === 'products.upload.csvTooLarge');
  assert.equal(await uploadFile({ uri: 'file:///c.csv', name: 'c.csv', mimeType: 'application/octet-stream', size: 10 }, CSV_RULE, async (part) => part.type), 'text/csv');
});

test('a refusal shows the server’s own sentence for the content, and the app’s words for anything else', () => {
  assert.equal(refusalText(t, new UploadRefused('products.upload.imageType')), '«products.upload.imageType»');
  assert.equal(refusalText(t, { code: 'payload_too_large', status: 413, message: 'That file is too large' }), 'That file is too large');
  assert.equal(refusalText(t, { code: 'validation_failed', status: 400, message: 'Check the fields', fields: { mrpPaise: 'MRP can’t be lower than the price' } }), 'MRP can’t be lower than the price');
  assert.equal(refusalText(t, { code: 'internal', status: 500, message: 'stack trace here' }), '«error.saveFailed»');
  assert.equal(refusalText(t, { code: 'network', status: 0 }), '«error.network»');
  assert.equal(refusalText(t, { code: 'cancelled' }), '');
  assert.equal(refusalText(t, null), '');
});

// ---- Products with options, variants and photos ----

test('options make one variant per combination, and changing them keeps what was typed', () => {
  const options = [{ name: 'Size', values: 'S, M, m' }, { name: 'Colour', values: 'Red, Blue' }];
  assert.deepEqual(splitList('S, M, m, , L'), ['S', 'M', 'L']);
  assert.deepEqual(combinations(options), [['S', 'Red'], ['S', 'Blue'], ['M', 'Red'], ['M', 'Blue']]);
  const one = variantsFor([{ name: 'Size', values: 'S, M' }], [], { price: '499' });
  assert.deepEqual(one.map((v) => [v.optionValues, v.price]), [[['S'], '499'], [['M'], '499']]);
  one[1].price = '549';
  const two = variantsFor(options, one, { price: '499' });
  assert.deepEqual(two.map((v) => [v.optionValues.join('/'), v.price]), [['S/Red', '499'], ['S/Blue', '499'], ['M/Red', '549'], ['M/Blue', '549']]);
});

test('a product form becomes a body the server’s own schema accepts, in paise', () => {
  const form = { ...draftToForm({}), name: ' Tee ', price: '499', mrp: '699', tags: 'cotton, summer', images: ['/media/abc', 'https://cdn.example.com/t.jpg'], options: [{ name: 'Size', values: 'S, M' }] };
  form.variants = variantsFor(form.options, [], { price: '499' });
  form.variants[1] = { ...form.variants[1], price: '549', sku: 'TEE-M', imageIndex: 1 };
  const { body, errors } = formToProduct(form);
  assert.equal(errors, undefined);
  assert.equal(body.pricePaise, 49900);
  assert.equal(body.mrpPaise, 69900);
  assert.deepEqual(body.variants.map((v) => [v.optionValues, v.pricePaise, v.sku, v.imageIndex]), [[['S'], 49900, '', null], [['M'], 54900, 'TEE-M', 1]]);
  assert.equal(ProductCreate.safeParse(body).success, true, JSON.stringify(ProductCreate.safeParse(body).error?.issues));
  assert.equal(ProductUpdate.safeParse(body).success, true);
});

test('a product form catches what the server would refuse, before anything is sent', () => {
  const base = { ...draftToForm({}), name: 'Tee', price: '499' };
  assert.equal(formToProduct({ ...base, name: '' }).errors.name, 'products.form.nameRequired');
  assert.equal(formToProduct({ ...base, mrp: '399' }).errors.mrp, 'products.money.mrpBelow');
  assert.equal(formToProduct({ ...base, price: 'abc' }).errors.price, 'products.money.invalid');
  assert.equal(formToProduct({ ...base, stock: '0' }).errors.stock, 'products.form.stockZero');
  assert.equal(formToProduct({ ...base, externalUrl: 'shop.example.com' }).errors.externalUrl, 'products.form.webLink');
  assert.equal(formToProduct({ ...base, images: Array.from({ length: 7 }, (_, i) => `/media/p${i}`) }).errors.images, 'products.form.tooManyPhotos');
  assert.equal(formToProduct({ ...base, options: [{ name: 'Size', values: '' }] }).errors.options, 'products.form.optionValues');
  assert.equal(formToProduct({ ...base, options: [{ name: 'Size', values: 'a' }, { name: 'size', values: 'b' }] }).errors.options, 'products.form.optionTwice');
  const many = Array.from({ length: 11 }, (_, i) => `v${i}`).join(',');
  assert.equal(formToProduct({ ...base, options: [{ name: 'A', values: many }, { name: 'B', values: many }] }).errors.options, 'products.form.tooManyVariants');
  const options = [{ name: 'Size', values: 'S, M' }];
  const variants = variantsFor(options, [], { price: '499' }).map((v) => ({ ...v, sku: 'SAME' }));
  const read = formToProduct({ ...base, options, variants });
  assert.equal(read.errors.variants, 'products.form.skuTwice');
  assert.equal(read.variantLabel, 'M');
  const mrpLow = variantsFor(options, [], { price: '499', mrp: '100' });
  assert.equal(formToProduct({ ...base, options, variants: mrpLow }).errors.variants, 'products.money.mrpBelow');
});

test('saving a product sends only what changed, so an untouched imported price stays the site’s', () => {
  const saved = {
    id: 1, name: 'Lamp', description: '', pricePaise: 50000, mrpPaise: null, images: ['/media/a'], stock: null, active: true, featured: false, externalUrl: 'https://shop.example.com/lamp',
    inStock: true, tags: [], whatsappOrder: null, categoryIds: [], options: [], variants: [], gallery: [],
  };
  const before = formToProduct(productToForm(saved)).body;
  const after = formToProduct({ ...productToForm(saved), description: 'Hand-cast brass' }).body;
  assert.deepEqual(changedFields(before, after), { description: 'Hand-cast brass' });
  const withOptions = formToProduct({ ...productToForm(saved), options: [{ name: 'Size', values: 'S' }], variants: [{ optionValues: ['S'], price: '500', mrp: '', sku: '', inStock: true, imageIndex: null }] }).body;
  assert.deepEqual(Object.keys(changedFields(before, withOptions)).sort(), ['options', 'variants']);
  assert.deepEqual(Object.keys(changedFields(before, { ...before, stock: 4 })).sort(), ['inStock', 'stock']);
});

test('a row’s price is the server’s display price, formatted, never worked out on the phone', () => {
  assert.deepEqual(priceLine({ pricePaise: 129950, display: { pricePaise: 99900, mrpPaise: 129950, discountPercent: 23, soldOut: false } }), { price: '₹999', strike: '₹1,299.50', off: '-23%', soldOut: false });
  assert.deepEqual(priceLine({ pricePaise: 50000, inStock: false, display: null }), { price: '₹500', strike: '', off: '', soldOut: true });
  assert.deepEqual(productBadges({ fetchStatus: 'broken', priceChanged: true, active: false, display: { pricePaise: 1, mrpPaise: null, discountPercent: null, soldOut: true } }).map((b) => b.key), ['products.badge.attention', 'products.badge.priceChanged', 'products.badge.soldOut', 'products.badge.archived']);
  assert.deepEqual(recheckBody('12'), { body: { recheckHours: 12 } });
  assert.equal(recheckBody('0').error, 'products.settings.min');
  assert.equal(recheckBody('721').error, 'products.settings.max');
  assert.equal(recheckBody('1.5').error, 'products.settings.whole');
});

test('a draft read from a page keeps an MRP only above the price, and a single plain variant becomes the SKU', () => {
  const form = draftToForm({ name: 'x'.repeat(200), pricePaise: 50000, mrpPaise: 40000, images: ['a', 'a', 'b'], variants: [{ optionValues: [], sku: 'K-1', pricePaise: 50000, mrpPaise: null, inStock: true }], options: [] });
  assert.equal(form.name.length, CATALOG_LIMITS.nameLength);
  assert.equal(form.mrp, '');
  assert.deepEqual(form.images, ['a', 'b']);
  assert.equal(form.sku, 'K-1');
  assert.deepEqual(form.variants, []);
});

// ---- Categories: the reel order, pins, and a move that fails ----

const reel = (pageId, extra = {}) => ({ pageId, pinned: false, pinPosition: null, position: pageId, ...extra });

test('the reel order is pinned first in pin order, then the rest; a move stays within its group', () => {
  const items = [reel(1, { position: 0 }), reel(2, { pinned: true, pinPosition: 1, position: 5 }), reel(3, { pinned: true, pinPosition: 0, position: 1 }), reel(4, { position: 2 })];
  assert.deepEqual(arrange(items).map((i) => i.pageId), [3, 2, 1, 4]);
  const shown = arrange(items);
  assert.deepEqual(reorder(shown, 3, 2).map((i) => i.pageId), [3, 2, 4, 1]);
  assert.deepEqual(reorder(shown, 1, 0).map((i) => i.pageId), [2, 3, 1, 4]);
  assert.deepEqual(reorder(shown, 1, 3).map((i) => i.pageId), [3, 2, 1, 4], 'a pinned reel never drops into the rest');
  const body = saveBody(reorder(shown, 3, 2));
  assert.deepEqual(body, { pinned: [3, 2], order: [4, 1] });
  assert.equal(SequenceSave.safeParse(body).success, true);
  assert.deepEqual(splitSequence(pin(shown, 4)).pinned.map((i) => i.pageId), [3, 2, 4]);
  assert.deepEqual(splitSequence(unpin(shown, 2)).pinned.map((i) => i.pageId), [3]);
  assert.deepEqual(moveItem([1, 2, 3], 0, 9), [2, 3, 1]);
  assert.equal(indexAfterDrag(2, -150, 72, 5), 0);
  assert.equal(indexAfterDrag(2, 30, 72, 5), 2);
  assert.equal(indexAfterDrag(2, 1000, 72, 5), 4);
});

test('a reorder that fails puts the list back as it was, and says why', async () => {
  let shown = ['a', 'b', 'c'];
  const failure = Object.assign(new Error('conflict'), { code: 'conflict' });
  await assert.rejects(optimistic({ read: () => shown, write: (v) => { shown = v; }, next: ['b', 'a', 'c'], send: async () => { assert.deepEqual(shown, ['b', 'a', 'c']); throw failure; } }), failure);
  assert.deepEqual(shown, ['a', 'b', 'c']);
  assert.equal(await optimistic({ read: () => shown, write: (v) => { shown = v; }, next: ['c', 'b', 'a'], send: async () => 'ok' }), 'ok');
  assert.deepEqual(shown, ['c', 'b', 'a']);
});

test('a reel’s window is typed as days and sent as times the schedule route accepts', () => {
  const from = dayToIso('2026-11-05');
  const to = dayToIso('2026-11-20');
  assert.equal(isoToDay(from), '2026-11-05');
  assert.equal(SequenceSchedule.safeParse({ pageId: 1, startsAt: from, endsAt: to }).success, true);
  assert.equal(dayToIso(''), null);
  assert.equal(dayToIso('2026-02-30'), undefined);
  assert.equal(dayToIso('5 Nov'), undefined);
});

// ---- Brand kit and creator page ----

test('the brand kit sends only changed fields, a colour as #RRGGBB, and the server’s schema accepts it', () => {
  const kit = { preset: 'utsav', logoUrl: '', logoDarkUrl: '', faviconUrl: '', colors: { primary: '#7A1F3D', accent: '' }, headingFont: 'Lora', bodyFont: 'Figtree', publicReplyVariants: ['Sent!'] };
  const form = { logoUrl: '/media/logo1', logoDarkUrl: '', faviconUrl: '', colors: { primary: '#7A1F3D', accent: '#D4AF37' }, headingFont: 'Lora', bodyFont: 'Figtree', replies: 'Sent!\nCheck your DMs' };
  const { body } = brandKitBody(kit, form);
  assert.deepEqual(body, { logoUrl: '/media/logo1', colors: { accent: '#D4AF37' }, publicReplyVariants: ['Sent!', 'Check your DMs'] });
  assert.equal(BrandKitUpdate.safeParse(body).success, true);
  assert.equal(brandKitBody(kit, { ...form, colors: { primary: 'red' } }).errors['color.primary'], 'brand-kit.colorBad');
  assert.equal(brandKitBody(kit, { ...form, replies: Array.from({ length: 11 }, (_, i) => `r${i}`).join('\n') }).errors.replies, 'brand-kit.repliesMany');
  assert.deepEqual(brandKitBody(kit, { ...form, logoUrl: '', colors: { primary: '', accent: '' }, replies: 'Sent!' }).body, { colors: { primary: '' } });
});

test('the creator page’s name follows the contract’s rule, and only changes are sent', () => {
  const page = { slug: 'asha', enabled: true, displayName: 'Asha', bio: '', photoUrl: '', websiteUrl: '', showWhatsapp: true, moreShelfTitle: 'More' };
  const { body } = creatorBody(page, { ...page, bio: 'Handmade earrings', slug: 'Asha-Studio ' });
  assert.deepEqual(body, { slug: 'asha-studio', bio: 'Handmade earrings' });
  assert.equal(CreatorPageUpdate.safeParse(body).success, true);
  for (const bad of ['has space', '-start', 'end-', 'x'.repeat(41)]) {
    assert.equal(creatorBody(page, { ...page, slug: bad }).errors?.slug, 'creator.slugBad', bad);
    assert.equal(CreatorPageUpdate.shape.slug.safeParse(bad).success, false, bad);
  }
  assert.equal(creatorBody(page, { ...page, websiteUrl: 'http://example.com' }).errors.websiteUrl, 'creator.websiteBad');
  // A reserved name passes the shape here and the server refuses it with its own sentence (checkSlug and update).
  assert.ok(RESERVED_PATHS.includes('shop'));
  assert.equal(creatorBody(page, { ...page, slug: 'shop' }).errors, undefined);
});
