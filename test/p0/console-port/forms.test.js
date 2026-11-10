// What each form sends. Everything here is checked against the real contract schemas, so a form can't drift from the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CategoryCreate, CategoryUpdate, BrandKitUpdate, ProductCreate, ProductUpdate, ReelSave, SettingsUpdate } from '../../../src/contracts/api/index.js';
import { COLOR_SLOTS, applyPreset, formToKit, kitToForm } from '../../../console/src/features/brand-kit/options.js';
import { EMPTY_CATEGORY, categoryToForm, formToCategory, nextPosition, positionChanges } from '../../../console/src/features/categories/form.js';
import { describeResult } from '../../../console/src/features/activity/results.js';
import { CHECKLIST_STEPS, checklistView } from '../../../console/src/features/home/checklist.js';
import { orderStatus } from '../../../console/src/features/orders/status.js';
import { EMPTY_PRODUCT, RENAME as PRODUCT_RENAME, formToProduct, productToForm } from '../../../console/src/features/products/form.js';
import { NEW_REEL, addKeywords, formToReel, mergeReelCards, postKind, previewMessage, reelToForm } from '../../../console/src/features/reels/form.js';
import { formToSettings, settingsToForm } from '../../../console/src/features/settings/form.js';
import { describeFailure } from '../../../console/src/lib/forms.js';
import { imageProblem, isWebLink } from '../../../console/src/lib/images.js';
import { moveItem, splitList } from '../../../console/src/lib/lists.js';
import { plural, whatsAppLink } from '../../../console/src/lib/format.js';

const product = (changes) => ({ ...EMPTY_PRODUCT, name: 'Kurta', price: '999', ...changes });

test('a product form becomes exact paise, and passes the contract', () => {
  const { body } = formToProduct(product({ mrp: '1,299.50', images: ['/media/ab-1', 'https://x.test/a.jpg'], optionLabel: ' Size ', optionValues: 'S, M,, L , S', stock: '12', categoryIds: [3, 4], featured: true }));
  assert.deepEqual(body, {
    name: 'Kurta', description: '', pricePaise: 99900, mrpPaise: 129950, images: ['/media/ab-1', 'https://x.test/a.jpg'], optionLabel: 'Size', optionValues: ['S', 'M', 'L'], stock: 12, active: true, featured: true, categoryIds: [3, 4],
  });
  assert.equal(ProductCreate.safeParse(body).success, true);
  assert.equal(ProductUpdate.safeParse(body).success, true);
});

test('a product with no extras: no MRP, unlimited stock, no options', () => {
  const { body } = formToProduct(product());
  assert.equal(body.mrpPaise, null);
  assert.equal(body.stock, null);
  assert.deepEqual(body.optionValues, []);
  assert.equal(body.optionLabel, '', 'a label with no choices is dropped');
  assert.equal(ProductCreate.safeParse(body).success, true);
});

test('a product form says what is wrong next to each field, and sends nothing', () => {
  assert.deepEqual(formToProduct({ ...EMPTY_PRODUCT, name: '   ', price: '' }).errors, { name: 'Name is required', price: 'Price is required' });
  assert.match(formToProduct(product({ price: 'abc' })).errors.price, /like 499/);
  assert.match(formToProduct(product({ price: '1.234' })).errors.price, /like 499/);
  assert.match(formToProduct(product({ price: '100', mrp: '99' })).errors.mrp, /higher than the price/);
  assert.match(formToProduct(product({ mrp: 'x' })).errors.mrp, /MRP/);
  for (const stock of ['1.5', '-1', 'ten']) assert.match(formToProduct(product({ stock })).errors.stock, /whole number/, stock);
  for (const bad of [product({ price: 'abc' }), product({ mrp: 'x' }), product({ stock: '1.5' })]) assert.equal(formToProduct(bad).body, undefined);
});

test('a product round-trips through the form unchanged', () => {
  const saved = { name: 'Pan', description: 'Heavy', pricePaise: 49950, mrpPaise: null, images: ['/media/x'], optionLabel: 'Size', optionValues: ['S', 'M'], stock: 0, active: false, featured: true, categoryIds: [9] };
  assert.deepEqual(formToProduct(productToForm(saved)).body, saved);
  assert.equal(productToForm({ ...saved, stock: null }).stock, '');
});

test('errors the API returns land on the matching field', () => {
  const failure = { message: 'Please check the highlighted details.', fields: { pricePaise: 'That amount is too large', 'images.2': 'Use an uploaded file or a web link', name: 'Name is required', 'images.3': 'second' } };
  assert.deepEqual(describeFailure(failure, PRODUCT_RENAME), { message: failure.message, fields: { price: 'That amount is too large', images: 'Use an uploaded file or a web link', name: 'Name is required' } });
  assert.deepEqual(describeFailure({ message: 'No.' }).fields, {});
});

test('a category form leaves an empty link name to the server and keeps the order number', () => {
  const { body } = formToCategory({ ...EMPTY_CATEGORY, name: ' Kitchen ', position: '3' });
  assert.deepEqual(body, { name: 'Kitchen', description: '', slug: undefined, imageUrl: '', visible: true, position: 3 });
  assert.equal(CategoryCreate.safeParse(body).success, true);
  assert.equal('position' in formToCategory({ ...EMPTY_CATEGORY, name: 'A' }).body, false);
  assert.match(formToCategory({ ...EMPTY_CATEGORY, name: 'A', position: 'first' }).errors.position, /whole number/);
  assert.match(formToCategory(EMPTY_CATEGORY).errors.name, /required/);
  const back = categoryToForm({ name: 'A', description: '', slug: 'a', position: -2, imageUrl: '/media/z', visible: false });
  assert.equal(CategoryUpdate.safeParse(formToCategory(back).body).success, true);
});

test('a new category goes last, and reordering changes only what moved', () => {
  assert.equal(nextPosition([]), 1);
  assert.equal(nextPosition([{ position: 4 }, { position: 9 }]), 10);
  const list = [{ id: 1, position: 1 }, { id: 2, position: 2 }, { id: 3, position: 3 }];
  assert.deepEqual(positionChanges(moveItem(list, 2, -1)), [{ id: 3, position: 2 }, { id: 2, position: 3 }]);
  assert.deepEqual(positionChanges(list), []);
  // Equal or gapped numbers settle down to 1, 2, 3 on the first move.
  assert.deepEqual(positionChanges([{ id: 1, position: 0 }, { id: 2, position: 0 }]), [{ id: 1, position: 1 }, { id: 2, position: 2 }]);
});

const reelForm = (changes) => ({ ...NEW_REEL, headline: 'Brunch', products: [{ id: 5 }, { id: 2 }], ...changes });

test('a new reel starts live with public replies off and no platform name', () => {
  assert.equal(NEW_REEL.active, true);
  assert.equal(NEW_REEL.publicReplyOn, false);
  assert.equal(NEW_REEL.publicReply, '');
  assert.doesNotMatch(JSON.stringify(NEW_REEL), /bhava/i);
  const { body } = formToReel(reelForm());
  assert.equal(body.publicReply, '');
});

test('a reel form keeps the products in order, carries what Instagram said, and passes the contract', () => {
  const caption = 'c'.repeat(900);
  const { body } = formToReel(reelForm({ keywordDraft: 'shop, LINK', publicReplyOn: true, publicReply: ' Sent ' }), { permalink: 'https://instagram.com/reel/x', thumbnailUrl: 'https://cdn.test/t.jpg', caption });
  assert.deepEqual(body.productIds, [5, 2]);
  assert.deepEqual(body.keywords, ['LINK', 'shop'], 'a keyword still being typed counts, without duplicates');
  assert.equal(body.publicReply, 'Sent');
  assert.equal(body.caption.length, 500);
  assert.equal(body.permalink, 'https://instagram.com/reel/x');
  assert.equal(ReelSave.safeParse(body).success, true);
});

test('a reel form refuses what the API would refuse, in the seller\'s words', () => {
  assert.match(formToReel(reelForm({ headline: ' ' })).errors.headline, /headline/);
  assert.match(formToReel(reelForm({ keywords: [], keywordDraft: '' })).errors.keywords, /at least one keyword/);
  assert.match(formToReel(reelForm({ products: [] })).errors.products, /at least 1/);
  assert.match(formToReel(reelForm({ products: Array.from({ length: 21 }, (_, id) => ({ id: id + 1 })) })).errors.products, /at most 20/);
  assert.match(formToReel(reelForm({ buttonText: 'x'.repeat(21) })).errors.buttonText, /20 characters/);
  assert.match(formToReel(reelForm({ publicReplyOn: true, publicReply: ' ' })).errors.publicReply, /turn public replies off/);
});

test('keywords add up without repeats, ignoring case', () => {
  assert.deepEqual(addKeywords(['LINK'], 'link, Shop,shop ,  '), ['LINK', 'Shop']);
  assert.deepEqual(addKeywords([], ''), []);
  assert.deepEqual(splitList(' a ,b,,a'), ['a', 'b']);
});

test('a saved reel opens with its public reply showing', () => {
  const reel = { headline: 'H', slug: 's', keywords: ['A'], dmMessage: 'M', buttonText: 'B', publicReply: '', active: false, products: [] };
  assert.equal(reelToForm(reel).publicReplyOn, false);
  assert.equal(reelToForm({ ...reel, publicReply: 'Hi' }).publicReplyOn, true);
});

test('the DM preview fills in a name, and only a name', () => {
  assert.equal(previewMessage('Hey @{username}! {username}'), 'Hey @asha! asha');
  assert.equal(previewMessage(undefined), '');
});

test('the reels page lists every post once, set up or not, and keeps reels Instagram didn\'t return', () => {
  const posts = [
    { id: '1', caption: 'Brunch look', mediaType: 'REELS', thumbnailUrl: 'https://cdn/1.jpg' },
    { id: '2', caption: '', mediaType: 'IMAGE', thumbnailUrl: '' },
  ];
  const reels = [
    { id: '1', headline: 'Sunday brunch', thumbnailUrl: 'https://cdn/old.jpg', caption: '', slug: 'b' },
    { id: '9', headline: '', thumbnailUrl: 'https://cdn/9.jpg', caption: 'Old one', slug: 'old' },
  ];
  const cards = mergeReelCards(posts, reels);
  assert.deepEqual(cards.map((c) => c.id), ['1', '2', '9']);
  assert.equal(cards[0].title, 'Sunday brunch');
  assert.equal(cards[0].thumbnailUrl, 'https://cdn/1.jpg');
  assert.equal(cards[1].title, 'Post 2');
  assert.equal(cards[1].reel, undefined);
  assert.equal(cards[2].title, 'Old one');
  assert.equal(cards[2].post, null);
  assert.equal(postKind('VIDEO'), 'Reel');
  assert.equal(postKind('CAROUSEL_ALBUM'), 'Post');
  assert.equal(postKind(undefined), 'Post');
});

const settings = {
  storeName: 'Kesar', tagline: 't', instagramHandle: 'kesar', shippingFeePaise: 4950, freeShippingAbovePaise: 0, upiId: 'a@upi', upiPayee: 'A', supportWhatsapp: '919876543210', supportEmail: 'a@b.co',
  heroKicker: '', heroTitle: 'H', heroSubtitle: 'S', trustPoints: 'x\ny', bulkTitle: '', bulkText: '', aboutText: '', gstin: '', checklistDismissed: false,
};

test('settings round-trip and pass the contract; payment details are not in them', () => {
  const { body } = formToSettings(settingsToForm(settings));
  assert.equal(body.shippingFeePaise, 4950);
  assert.equal(body.freeShippingAbovePaise, 0);
  assert.equal('upiId' in body, false, 'where the money goes has its own owner-only route');
  assert.equal('checklistDismissed' in body, false, 'saving the form must not bring a hidden checklist back');
  assert.equal(SettingsUpdate.safeParse(body).success, true);
});

test('settings clean up what people type', () => {
  const form = { ...settingsToForm(settings), instagramHandle: ' @kesar.home ', supportWhatsapp: '+91 98765-43210', shippingFee: '', freeShippingAbove: '999', storeName: ' K ' };
  const { body } = formToSettings(form);
  assert.equal(body.instagramHandle, 'kesar.home');
  assert.equal(body.supportWhatsapp, '919876543210');
  assert.equal(body.shippingFeePaise, 0);
  assert.equal(body.freeShippingAbovePaise, 99900);
  assert.equal(body.storeName, 'K');
  assert.match(formToSettings({ ...form, storeName: ' ' }).errors.storeName, /required/);
  assert.match(formToSettings({ ...form, shippingFee: 'free' }).errors.shippingFee, /Delivery fee/);
});

const preset = { code: 'utsav', colors: Object.fromEntries(COLOR_SLOTS.map(([key]) => [key, key === 'on_primary' ? '#FFFFFF' : '#123456'])), headingFont: 'Lora', bodyFont: 'Inter' };
const kit = { preset: 'utsav', logoUrl: '', logoDarkUrl: '', faviconUrl: '', colors: { ...preset.colors }, headingFont: 'Lora', bodyFont: 'Inter' };

test('a brand kit sends only what differs from its look, and passes the contract', () => {
  const form = kitToForm(kit);
  form.colors.accent = '#abcdef';
  form.colors.primary = '#123456'; // same as the preset: follows the preset
  form.headingFont = 'Manrope';
  const { body } = formToKit(form, preset);
  assert.equal(body.colors.accent, '#abcdef');
  assert.equal(body.colors.primary, '');
  assert.equal(body.headingFont, 'Manrope');
  assert.equal(body.bodyFont, '');
  assert.equal(BrandKitUpdate.safeParse(body).success, true);
});

test('a brand kit colour case difference is not a change', () => {
  const form = kitToForm({ ...kit, colors: { ...kit.colors, ink: '#123456' } });
  form.colors.ink = '#123456'.toLowerCase();
  assert.equal(formToKit(form, preset).body.colors.ink, '');
  form.colors.ink = '#ABCDEF';
  assert.equal(formToKit(form, preset).body.colors.ink, '#ABCDEF');
});

test('picking a look starts from its colours and fonts and keeps the logos', () => {
  const next = { code: 'mitti', colors: Object.fromEntries(COLOR_SLOTS.map(([key]) => [key, '#111111'])), headingFont: 'Lato', bodyFont: 'Jost' };
  const applied = applyPreset({ ...kitToForm(kit), logoUrl: '/media/keep' }, next);
  assert.equal(applied.preset, 'mitti');
  assert.equal(applied.colors.primary, '#111111');
  assert.equal(applied.headingFont, 'Lato');
  assert.equal(applied.logoUrl, '/media/keep');
});

test('F-12: low contrast is blocked before saving, on the field it\'s about', () => {
  const form = kitToForm(kit);
  form.colors.primary = '#777777';
  form.colors.on_primary = '#888888';
  const { errors, body } = formToKit(form, preset);
  assert.equal(body, undefined);
  assert.match(errors.color_on_primary, /Buttons and their text need a contrast of at least 4\.5:1/);
});

test('a malformed colour is caught on its own row', () => {
  const form = kitToForm(kit);
  form.colors.ink = 'blue';
  assert.match(formToKit(form, preset).errors.color_ink, /#234D33/);
});

const step = (key, done) => ({ key, done });

test('the checklist counts, points at the next step, and steps aside when finished or hidden', () => {
  const steps = Object.keys(CHECKLIST_STEPS).map((key, i) => step(key, i === 0));
  const view = checklistView({ dismissed: false, steps });
  assert.equal(view.visible, true);
  assert.equal(view.done, 1);
  assert.equal(view.total, 6);
  assert.deepEqual(view.steps.filter((s) => s.next).map((s) => s.key), ['store_details']);
  assert.equal(checklistView({ dismissed: true, steps }).visible, false);
  assert.equal(checklistView({ dismissed: false, steps: steps.map((s) => ({ ...s, done: true })) }).visible, false);
});

test('a step the console doesn\'t know yet is left out rather than shown blank', () => {
  const view = checklistView({ dismissed: false, steps: [step('instagram', false), step('from_the_future', false)] });
  assert.equal(view.total, 1);
});

test('every checklist step goes somewhere', () => {
  for (const [key, value] of Object.entries(CHECKLIST_STEPS)) {
    assert.ok(value.title && value.text && value.action, key);
    assert.ok(value.to || value.href, key);
  }
});

test('unknown statuses and results are shown as they are, never as a blank', () => {
  assert.deepEqual(orderStatus('held'), { label: 'held', tone: 'neutral' });
  assert.equal(orderStatus('paid').label, 'Paid');
  assert.deepEqual(describeResult('skip:new-reason'), { label: 'skip:new-reason', tone: 'neutral' });
  assert.equal(describeResult('sent').label, 'DM sent');
  assert.equal(describeResult('skip:not-connected').label, 'Instagram not connected');
});

test('moving an item never loses one, and stops at the ends', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(list, 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(list, 2, -2), ['c', 'a', 'b']);
  assert.equal(moveItem(list, 0, -1), list);
  assert.equal(moveItem(list, 2, 1), list);
  assert.equal(moveItem(list, 7, -1), list);
});

test('photos are checked before uploading', () => {
  assert.equal(imageProblem({ name: 'a.png', type: 'image/png', size: 100 }), '');
  assert.match(imageProblem({ name: 'a.svg', type: 'image/svg+xml', size: 100 }), /JPG, PNG, WebP or GIF/);
  assert.match(imageProblem({ name: 'a.jpg', type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }), /5 MB/);
  assert.equal(isWebLink('https://x.test/a.jpg'), true);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://x/y', 'https://a b', '/media/x']) assert.equal(isWebLink(bad), false, bad);
});

test('WhatsApp links go to the person, with the text encoded', () => {
  assert.equal(whatsAppLink('9876543210'), 'https://wa.me/919876543210');
  assert.equal(whatsAppLink('9876543210', 'Hi & bye?'), 'https://wa.me/919876543210?text=Hi%20%26%20bye%3F');
  assert.equal(whatsAppLink('919876543210'), 'https://wa.me/919876543210');
  assert.equal(plural(1, 'order'), '1 order');
  assert.equal(plural(0, 'order'), '0 orders');
});
