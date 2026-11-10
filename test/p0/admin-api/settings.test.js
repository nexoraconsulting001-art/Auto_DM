// Settings, the setup checklist, brand kit and dashboard numbers through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../../../src/contracts/api/index.js';
import { REEL_ID, fakeIg, seedReel } from '../../helpers.js';
import { ok, placeOrder, refused, secondBusiness, walk, withApp } from './support.js';

test('settings read with their defaults, as numbers and booleans', withApp(async ({ api }) => {
  const settings = await ok(await api('GET', '/settings'));
  assert.equal(settings.storeName, 'My store');
  assert.equal(settings.shippingFeePaise, 4900);
  assert.equal(settings.freeShippingAbovePaise, 99900);
  assert.equal(settings.upiId, 'demo@upi');
  assert.equal(settings.checklistDismissed, false);
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(routes['settings.get'].response.shape).sort());
}));

test('a settings change touches only what was sent and cleans it the way the old form did', withApp(async ({ api }) => {
  const saved = await ok(await api('PATCH', '/settings', {
    storeName: '  Leaf & Clay ', instagramHandle: '@leafclay', supportWhatsapp: '+91 98765-43210', shippingFeePaise: 0, freeShippingAbovePaise: 150000, supportEmail: 'help@example.com', gstin: '29ABCDE', heroTitle: 'Hi', checklistDismissed: true,
  }));
  assert.equal(saved.storeName, 'Leaf & Clay');
  assert.equal(saved.instagramHandle, 'leafclay');
  assert.equal(saved.supportWhatsapp, '919876543210');
  assert.equal(saved.shippingFeePaise, 0);
  assert.equal(saved.freeShippingAbovePaise, 150000);
  assert.equal(saved.checklistDismissed, true);
  assert.equal(saved.tagline, 'Everything from our reels, in one place.');

  const next = await ok(await api('PATCH', '/settings', { tagline: 'New', checklistDismissed: false }));
  assert.equal(next.tagline, 'New');
  assert.equal(next.storeName, 'Leaf & Clay');
  assert.equal(next.checklistDismissed, false);

  assert.equal((await ok(await api('PATCH', '/settings', {}))).storeName, 'Leaf & Clay');
  await refused(await api('PATCH', '/settings', { storeName: '   ' }), 400, 'validation_failed');
  await refused(await api('PATCH', '/settings', { shippingFeePaise: -1 }), 400, 'validation_failed');
  await refused(await api('PATCH', '/settings', { supportEmail: 'nope' }), 400, 'validation_failed');
}));

test('where shoppers\' money goes changes only through the payment route', withApp(async ({ api }) => {
  const ignored = await ok(await api('PATCH', '/settings', { upiId: 'attacker@upi', upiPayee: 'x', storeName: 'Shop' }));
  assert.equal(ignored.upiId, 'demo@upi');
  assert.equal(ignored.upiPayee, '');
  const paid = await ok(await api('PATCH', '/settings/payment', { upiId: 'leaf@upi', upiPayee: 'Leaf' }));
  assert.equal(paid.upiId, 'leaf@upi');
  assert.equal(paid.upiPayee, 'Leaf');
  assert.equal(paid.storeName, 'Shop');
  const onlyPayee = await ok(await api('PATCH', '/settings/payment', { upiPayee: 'Leaf Ltd' }));
  assert.equal(onlyPayee.upiId, 'leaf@upi');
  // The old settings form treated a blank id the same way.
  assert.equal((await ok(await api('PATCH', '/settings/payment', { upiId: '' }))).upiId, 'demo@upi');
}));

test('one business\'s settings never show up in another\'s', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  await ok(await app.api('PATCH', '/settings', { storeName: 'Mine' }));
  await ok(await leaf.api('PATCH', '/settings', { storeName: 'Theirs' }));
  assert.equal((await ok(await app.api('GET', '/settings'))).storeName, 'Mine');
  assert.equal((await ok(await leaf.api('GET', '/settings'))).storeName, 'Theirs');
}));

test('the setup status follows the business as it sets up, step by step', withApp(async ({ api, repos }) => {
  const done = async () => Object.fromEntries((await ok(await api('GET', '/settings/setup'))).checklist.steps.map((s) => [s.key, s.done]));
  const status = await ok(await api('GET', '/settings/setup'));
  assert.equal(status.storeUrl, 'https://shop.test');
  assert.equal(status.testMode, false);
  assert.deepEqual(status.instagram, { connected: true, username: 'shop' });
  assert.equal(status.checklist.dismissed, false);
  assert.deepEqual(status.checklist.steps.map((s) => s.key), ['instagram', 'store_details', 'products', 'reel', 'comment', 'order']);
  assert.deepEqual(status.checklist.steps[0], { key: 'instagram', done: true });
  assert.deepEqual(await done(), { instagram: true, store_details: false, products: false, reel: false, comment: false, order: false });

  await ok(await api('PATCH', '/settings', { storeName: 'Leaf' }));
  const { products } = await seedReel(repos);
  assert.deepEqual(await done(), { instagram: true, store_details: true, products: true, reel: true, comment: false, order: false });
  await repos.activity.log({ commentId: 'c1', reelId: REEL_ID, result: 'sent' });
  await placeOrder(repos, products[0]);
  assert.deepEqual(await done(), { instagram: true, store_details: true, products: true, reel: true, comment: true, order: true });

  await ok(await api('PATCH', '/settings', { checklistDismissed: true }));
  assert.equal((await ok(await api('GET', '/settings/setup'))).checklist.dismissed, true);
}));

test('a logo alone counts as store details, and test mode is reported', withApp({ overrides: { dryRun: true } }, async ({ api }) => {
  await ok(await api('PATCH', '/brand-kit', { logoUrl: 'https://cdn.example/logo.png' }));
  const status = await ok(await api('GET', '/settings/setup'));
  assert.equal(status.testMode, true);
  assert.deepEqual(status.checklist.steps[1], { key: 'store_details', done: true });
}));

test('a token Instagram refuses shows as not connected, and the answer is cached per business', async () => {
  const ig = fakeIg();
  let checks = 0;
  ig.getAccount = async () => { checks++; throw new Error('expired'); };
  await withApp({ ig }, async ({ api, db, tenant }) => {
    const first = await ok(await api('GET', '/settings/setup'));
    assert.deepEqual(first.instagram, { connected: false, username: '' });
    assert.equal(first.checklist.steps[0].done, false);
    assert.equal(checks, 1);
    await ok(await api('GET', '/settings/setup'));
    assert.equal(checks, 1);
    await db.query(`UPDATE ig_accounts SET access_token_enc = '' WHERE tenant_id = $1`, [tenant.id]);
    assert.deepEqual((await ok(await api('GET', '/settings/setup'))).instagram, { connected: false, username: '' });
    assert.equal(checks, 1);
  })();
});

test('the brand kit saves and the looks are listed', withApp(async ({ api }) => {
  const kit = await ok(await api('GET', '/brand-kit'));
  assert.equal(kit.preset, 'utsav');
  const saved = await ok(await api('PATCH', '/brand-kit', { preset: 'dewdrop', logoUrl: '/media/abc-1' }));
  assert.equal(saved.preset, 'dewdrop');
  assert.equal(saved.logoUrl, '/media/abc-1');
  const cleared = await ok(await api('PATCH', '/brand-kit', { logoUrl: '' }));
  assert.equal(cleared.logoUrl, '');
  assert.equal(cleared.preset, 'dewdrop');

  const { items, sizes } = await walk(api, '/brand-kit/presets', 2);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(items.map((p) => p.code).sort(), ['dewdrop', 'gadget-galli', 'mitti', 'tadka', 'utsav']);
  assert.ok(items[0].colors.primary);
  assert.ok(items[0].headingFont);
  assert.ok(items[0].bodyFont);
  await refused(await api('PATCH', '/brand-kit', { preset: 'nope' }), 400, 'validation_failed');
  await refused(await api('PATCH', '/brand-kit', { logoUrl: 'javascript:alert(1)' }), 400, 'validation_failed');
}));

test('F-12: low-contrast colours are blocked, naming both fields', withApp(async ({ api }) => {
  const error = await refused(await api('PATCH', '/brand-kit', { colors: { primary: '#777777', on_primary: '#888888' } }), 400, 'validation_failed');
  assert.match(error.error, /primary/);
  assert.match(error.error, /on_primary/);
}));

test('the dashboard counts are the business\'s own and revenue is in paise', withApp(async (app) => {
  const { api, repos } = app;
  const leaf = await secondBusiness(app);
  await placeOrder(leaf.repos, await ok(await leaf.api('POST', '/products', { name: 'Other', pricePaise: 5000 }), 201));

  const pot = await ok(await api('POST', '/products', { name: 'Pot', pricePaise: 100000 }), 201);
  const paid = await placeOrder(repos, pot);
  await placeOrder(repos, pot);
  await ok(await api('POST', `/orders/${paid.id}/status`, { status: 'paid' }));
  const { products } = await seedReel(repos, { n: 1 });
  assert.ok(products.length);
  await repos.activity.log({ commentId: 'c1', reelId: REEL_ID, result: 'sent' });
  await repos.reels.recordVisit(REEL_ID, 'dm');

  assert.deepEqual(await ok(await api('GET', '/stats/dashboard')), {
    dms: 1, dmsToday: 1, visits: 1, visitsToday: 1, orders: 2, ordersToday: 2, revenuePaise: 100000, toConfirm: 1, toShip: 1, products: 2,
  });
}));
