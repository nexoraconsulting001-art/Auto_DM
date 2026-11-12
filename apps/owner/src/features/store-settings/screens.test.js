import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { checkCatalogue } from '@bhava/app-core';
import { catalogue } from '../../strings.js';
import { buildNavigation, registryProblems } from '../../shell/menu.js';
import { AT, CATALOG_STAFF, MANAGER, ORDERS_STAFF, everythingHeld, fresh, heldOnDisk, openApp, writes, forgetApps } from '../orders/kit/testing.js';
import orders from '../orders/index.js';
import payments from '../payments/index.js';
import refunds from '../refunds/index.js';
import shipping from '../shipping/index.js';
import inventory from '../inventory/index.js';
import coupons from '../coupons/index.js';
import invoices from '../invoices/index.js';
import returns from '../returns/index.js';
import reviews from '../reviews/index.js';
import loyalty from '../loyalty/index.js';
import customers from '../customers/index.js';
import privacy from '../privacy/index.js';
import storeSettings from './index.js';
import shopify from '../shopify/index.js';
import settings from '../settings/index.js';
import team from '../team/index.js';
import auditLog from '../audit-log/index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const fs = require('node:fs');
const path = require('node:path');

afterEach(forgetApps);

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const ALL = [orders, payments, refunds, shipping, inventory, coupons, invoices, returns, reviews, loyalty, customers, privacy, storeSettings, shopify, settings, team, auditLog];
const page = (items) => ({ items, nextCursor: null });

const COUPON = { id: 5, code: 'DIWALI20', kind: 'percent', percentBp: 2000, amountPaise: null, maxDiscountPaise: 20000, minOrderPaise: 0, startsAt: null, endsAt: null, maxUses: 100, maxUsesPerCustomer: null, usedCount: 3, firstOrderOnly: false, scope: 'all', scopeIds: [], pageId: null, active: true, createdAt: AT };
const RETURN = { id: 9, orderId: 3, orderNumber: 'AT-1003', status: 'requested', resolution: 'refund', reason: 'Cracked', condition: null, restocked: false, items: [{ orderItemId: 11, name: 'Clay pot', qty: 1 }], proofs: [{ id: 1, kind: 'photo', fileUrl: 'https://files.example.com/p/1?sig=x' }, { id: 2, kind: 'video', fileUrl: 'https://files.example.com/p/2?sig=y' }], shipmentId: null, refundId: null, createdAt: AT };

/** One business's store, answered the way the server would. */
function routes() {
  return {
    'GET /inventory': () => page([{ productId: 4, variantId: null, name: 'Clay pot', option: 'Large', sku: 'POT-L', stock: 3, reserved: 1, available: 2, lowStockThreshold: null, low: true }]),
    'GET /inventory/settings': () => ({ lowStockThreshold: 5 }),
    'POST /inventory/adjust': (call) => ({ productId: 4, variantId: null, name: 'Clay pot', option: 'Large', sku: 'POT-L', stock: call.body.stock ?? 3, reserved: 1, available: 4, lowStockThreshold: null, low: false }),
    'GET /inventory/movements': () => page([{ id: 1, productId: 4, variantId: null, delta: -1, reason: 'sale', orderId: 3, actor: 'shopper', at: AT }, { id: 2, productId: 4, variantId: null, delta: 2, reason: 'something_new', orderId: null, actor: 'user:7', at: AT }]),
    'GET /coupons': () => page([COUPON]),
    'GET /coupons/:id': () => COUPON,
    'GET /coupons/:id/stats': () => ({ couponId: 5, orders: 3, discountPaise: 30000, revenuePaise: 300000 }),
    'POST /coupons': (call) => [201, { ...COUPON, id: 6, ...call.body, usedCount: 0, createdAt: AT }],
    'GET /invoices': () => page([{ id: 7, orderId: 3, docType: 'invoice', number: 'INV/26-27/0001', issuedAt: AT, taxablePaise: 95143, cgstPaise: 2379, sgstPaise: 2378, igstPaise: 0, totalPaise: 99900, advancePaise: 0, balancePaise: 0, originalInvoiceId: null, fileUrl: 'https://files.example.com/inv/7.pdf' }]),
    'GET /invoices/:id': () => ({ id: 7, orderId: 3, docType: 'invoice', number: 'INV/26-27/0001', issuedAt: AT, taxablePaise: 95143, cgstPaise: 2379, sgstPaise: 2378, igstPaise: 0, totalPaise: 99900, advancePaise: 0, balancePaise: 0, originalInvoiceId: null, fileUrl: null }),
    'GET /invoice-settings': () => ({ legalName: 'Alpha Traders', gstin: '27AAPFU0939F1ZV', stateCode: '27', address: 'Pune', invoicePrefix: 'AT' }),
    'GET /returns': () => page([RETURN]),
    'GET /returns/:id': () => RETURN,
    'POST /returns/:id/approve': () => ({ ...RETURN, status: 'approved' }),
    'GET /return-settings': () => ({ enabled: true, windowDays: 7, eligibleCategoryIds: [], proof: 'either' }),
    'GET /categories': () => page([{ id: 2, name: 'Pots', slug: 'pots', imageUrl: '', description: '', position: 1, visible: true, productCount: 3, reelCount: 0 }]),
    'GET /products': () => page([]),
    'GET /reviews': () => page([{ id: 3, productId: 4, productName: 'Clay pot', orderId: 3, rating: 4, body: 'Lovely pot', displayName: 'Sunita', photos: [], status: 'pending', reply: '', repliedAt: null, createdAt: AT }]),
    'POST /reviews/:id/approve': () => ({ id: 3 }),
    'GET /wishlist/counts': () => page([{ productId: 4, name: 'Clay pot', saves: 12 }]),
    'GET /loyalty/members': () => page([{ shopperId: 4, name: 'Sunita', balance: 120, pending: 10, updatedAt: AT }]),
    'GET /loyalty/referrals': () => page([]),
    'GET /loyalty/members/:id/ledger': () => page([{ id: 1, kind: 'earn', points: 10, status: 'posted', orderId: 3, availableAt: AT, expiresAt: null, at: AT }]),
    'POST /loyalty/members/:id/adjust': (call) => ({ shopperId: 4, name: 'Sunita', balance: 120 + call.body.points, pending: 10, updatedAt: AT }),
    'GET /loyalty/settings': () => ({ available: true, enabled: true, earnPoints: 1, earnPerPaise: 10000, pointValuePaise: 100, maxRedeemPoints: 500, expiryDays: 365, referralEnabled: true, friendRewardPaise: 5000, referrerPoints: 50 }),
    'GET /shoppers': () => page([{ id: 2, name: 'Sunita', phone: '+919811112222', email: 's@example.in', signedIn: true, orders: 2, spentPaise: 199800, lastOrderAt: AT, marketing: { whatsapp: true, email: false } }]),
    'GET /shoppers/:id': () => ({ id: 2, name: 'Sunita', phone: '+919811112222', email: 's@example.in', signedIn: true, orders: 2, spentPaise: 199800, lastOrderAt: AT, marketing: { whatsapp: true, email: false } }),
    'GET /customers': () => page([{ id: 30, name: 'Old Account', phone: '+919811113333', email: '', role: 'customer', orderCount: 1, spentPaise: 50000, createdAt: AT }]),
    'POST /customers/:id/reset-password': () => ({ temporaryPassword: 'Tmp-pass-4821' }),
    'GET /data-requests': () => page([{ id: 1, shopperId: 2, kind: 'access', status: 'requested', source: 'account', summary: {}, requestedAt: AT, completedAt: null }]),
    'GET /shopper-downloads': () => page([]),
    'GET /privacy': () => ({ grievanceName: 'Asha', grievanceEmail: 'g@alpha.in', grievancePhone: '', grievanceAddress: '' }),
    'GET /consent-notice': () => ({ version: 2, bodyEn: 'We use your details to deliver orders.', bodyHi: 'हम आपकी जानकारी से ऑर्डर पहुँचाते हैं।', createdAt: AT }),
    'GET /policies': () => ({ items: [{ kind: 'privacy', body: 'Our privacy policy', url: 'https://alpha.example.com/privacy', updatedAt: AT }] }),
    'GET /alert-settings': () => ({ channels: ['whatsapp', 'email'], whatsapp: true, email: true, events: ['placed', 'shipped'], emailFrom: 'own', emailFromAddress: 'orders@alpha.example.com', emailReplyTo: '', whatsappCostPaise: { utility: 15, authentication: 13, marketing: null } }),
    'GET /whatsapp-account': () => ({ connected: true, displayNumber: '+91 98000 00001', status: 'active' }),
    'GET /whatsapp-templates': () => ({ items: [{ id: 1, purpose: 'order_shipped', category: 'utility', name: 'order_shipped', language: 'en', status: 'approved', checkedAt: AT }] }),
    'GET /cart-reminders': () => ({ enabled: false, channels: ['whatsapp'], templateStatus: 'pending' }),
    'GET /cart-reminders/stats': () => ({ days: 30, sent: 10, clicked: 4, ordered: 1, revenuePaise: 99900 }),
    'GET /order-alerts': () => page([{ id: 8, orderId: 3, orderNumber: 'AT-1003', event: 'shipped', channel: 'whatsapp', status: 'failed', skipReason: '', attempts: 3, createdAt: AT, sentAt: null }]),
    'GET /shopify': () => ({ connected: true, shopDomain: 'alpha.myshopify.com', mode: 'two_way', status: 'active', lastReconciledAt: AT, pendingOrders: 1, failedOrders: 0, webhookUrl: 'https://alpha.example.com/webhooks/shopify' }),
    'GET /shopify/conflicts': () => page([{ id: 1, kind: 'product', localId: 4, shopifyId: 'gid://1', field: 'price', localValue: '999', remoteValue: '899', winner: 'remote', at: AT }]),
    'GET /settings': () => ({ storeName: 'Alpha Traders', tagline: 'Pots', instagramHandle: 'alpha', shippingFeePaise: 4900, freeShippingAbovePaise: 99900, upiId: '', upiPayee: '', supportWhatsapp: '919800000001', supportEmail: '', heroKicker: '', heroTitle: '', heroSubtitle: '', trustPoints: '', bulkTitle: '', bulkText: '', aboutText: '', gstin: '', checklistDismissed: false }),
    'GET /settings/setup': () => ({ storeUrl: 'https://alpha.example.com', testMode: true, instagram: { connected: true, username: 'alpha' }, checklist: { dismissed: false, steps: [] } }),
    'GET /api-keys': () => page([]),
    'POST /api-keys': (call) => [201, { id: 1, name: call.body.name, prefix: 'bk_12', scope: 'analytics:read', createdAt: AT, lastUsedAt: null, revokedAt: null, key: 'bk_12_ONCE_ONLY_SECRET' }],
    'GET /settlements/summary': () => ({ from: '2026-11-01', to: '2026-11-30', salesPaise: 199800, gatewayFeesPaise: 4000, shippingChargesPaise: 9000, refundsPaise: 0, payablePaise: 186800, recoverablePaise: 0, inReview: 1 }),
    'GET /settlements': () => page([{ id: 1, orderId: 3, orderNumber: 'AT-1003', kind: 'sale', creditPaise: 99900, debitPaise: 0, status: 'ok', at: AT }]),
    'GET /shipping-settings': () => ({ mode: 'managed', pickupName: 'Alpha', pickupPhone: '9800000001', pickupLine1: '1 Main Rd', pickupLine2: '', pickupCity: 'Pune', pickupStateCode: '27', pickupPincode: '411001', pickupRegistered: true, ownEmail: '', ownPasswordSet: false, chargeBilling: 'payout' }),
    'GET /order-downloads': () => page([{ id: 1, status: 'ready', rowCount: 12, fileUrl: 'https://files.example.com/o/1.csv', createdAt: AT, expiresAt: AT }]),
    'GET /shipments/:id': () => ({ id: 5, orderId: 3, kind: 'forward', mode: 'managed', status: 'in_transit', awb: 'AWB123', courierName: 'Delhivery', weightGrams: 500, lengthCm: 10, breadthCm: 10, heightCm: 10, codPaise: 0, chargePaise: 4500, trackingUrl: 'https://alpha.example.com/track/AT-1003', hasLabel: true, events: [{ status: 'picked_up', at: AT, location: 'Pune' }], createdAt: AT, deliveredAt: null }),
  };
}

const open = (screenPath) => openApp({ list: ALL, path: screenPath, routes: routes(), freshUntil: fresh() });

test.each([
  ['/inventory', 'stock-4-0'],
  ['/inventory/movements', 'movement-2'],
  ['/coupons', 'coupon-5'],
  ['/coupons/5', 'coupon-stats'],
  ['/invoices', 'invoice-row-7'],
  ['/invoices/7', 'invoice-making'],
  ['/invoices/settings', 'invoice-settings-save'],
  ['/returns', 'returns-show'],
  ['/returns/settings', 'return-categories-2'],
  ['/reviews', 'review-3'],
  ['/reviews/saves', 'saves-4'],
  ['/loyalty', 'member-4'],
  ['/loyalty/members/4', 'entry-1'],
  ['/loyalty/settings', 'loyalty-friend-reward'],
  ['/customers', 'shopper-2'],
  ['/customers/shoppers/2', 'shopper-consent'],
  ['/customers/data-requests', 'request-1'],
  ['/privacy', 'privacy-save'],
  ['/privacy/notice', 'notice-publish'],
  ['/privacy/policies', 'policy-privacy-view'],
  ['/store-settings', 'store-link-shopify'],
  ['/store-settings/messages', 'failed-8'],
  ['/shopify', 'conflict-1'],
  ['/settings', 'settings-test-mode'],
  ['/payments/statement', 'statement-payable'],
  ['/shipping', 'shipping-registered'],
  ['/orders/files', 'order-file-1-open'],
  ['/shipments/5', 'shipment-journey'],
])('%s opens and shows what the server sent', async (screenPath, testID) => {
  await open(screenPath);
  expect(await screen.findByTestId(testID)).toBeTruthy();
});

test('a return shows the shopper’s photo and video, and approving it sends nothing but the move', async () => {
  const { server, made } = await open('/returns/9');
  expect(await screen.findByTestId('return-proof-1')).toBeTruthy();
  expect(screen.getByTestId('return-proof-2')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('return-approve'));
  await waitFor(() => expect(writes(server).map((c) => [c.method, c.path, c.body])).toEqual([['POST', '/returns/9/approve', undefined]]));
  await made.cache.flush();
  expect(heldOnDisk(made)).toContain('notifications'); // the cache was written
  expect(heldOnDisk(made)).not.toContain('sig=x'); // short-lived proof links never reach the phone's storage
});

test('stock is changed by the line the person picked; a coupon is created from what they typed', async () => {
  const first = await open('/inventory');
  await fireEvent.press(await screen.findByTestId('stock-4-0'));
  await fireEvent.changeText(await screen.findByTestId('inventory-amount'), '9');
  await fireEvent.press(screen.getByTestId('inventory-adjust-save'));
  await waitFor(() => expect(writes(first.server).map((c) => c.body)).toEqual([{ productId: 4, variantId: null, stock: 9 }]));
  first.view.unmount();

  const second = await open('/coupons/new');
  await fireEvent.changeText(await screen.findByTestId('coupon-code'), 'new10');
  await fireEvent.press(screen.getByTestId('coupon-kind-flat'));
  await fireEvent.changeText(screen.getByTestId('coupon-amount'), '100');
  await fireEvent.press(screen.getByTestId('coupon-save'));
  await waitFor(() => expect(writes(second.server).filter((c) => c.path === '/coupons')).toHaveLength(1));
  expect(writes(second.server)[0].body).toMatchObject({ code: 'NEW10', kind: 'flat', amountPaise: 10000, percentBp: null, scope: 'all' });
});

test('a new API key and a reset password are shown once and kept nowhere', async () => {
  const keys = await open('/settings/api-keys');
  await fireEvent.changeText(await screen.findByTestId('api-key-name'), 'Sheets');
  await fireEvent.press(screen.getByTestId('api-key-create'));
  expect(await screen.findByText('bk_12_ONCE_ONLY_SECRET')).toBeTruthy();
  await keys.made.cache.flush();
  expect(everythingHeld(keys.made)).not.toContain('ONCE_ONLY_SECRET');
  keys.view.unmount();

  const people = await open('/customers');
  await fireEvent.press(await screen.findByTestId('customers-tab-accounts'));
  await fireEvent.press(await screen.findByTestId('customer-30-reset'));
  await fireEvent.press(await screen.findByTestId('customers-reset-confirm-confirm'));
  expect(await screen.findByText('Tmp-pass-4821')).toBeTruthy();
  expect(screen.queryByText('+919811113333')).toBeNull(); // numbers are shown masked
  await people.made.cache.flush();
  expect(everythingHeld(people.made)).not.toContain('Tmp-pass-4821');
});

test('every word these screens use is there in English and in Hindi', () => {
  expect(checkCatalogue(catalogue)).toEqual([]);
  const missing = [];
  const dirs = ALL.map((f) => path.join(__dirname, '..', f.name));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.js$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [path.join(dir, e.name)] : []));
  for (const file of dirs.flatMap(walk)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, key] of text.matchAll(/\bt\('([a-z][\w-]*\.[\w.-]+)'/g)) {
      for (const locale of ['en', 'hi']) if (typeof catalogue[locale][key] !== 'string') missing.push(`${locale} ${key} (${path.basename(file)})`);
    }
  }
  expect(missing).toEqual([]);
});

test('P-12 these features have the registry’s shape, and each role sees only what its rules allow', () => {
  expect(registryProblems(ALL)).toEqual([]);
  const names = (user) => buildNavigation(ALL, { user }).screens.map((s) => s.feature).filter((v, i, a) => a.indexOf(v) === i).sort();
  expect(names({ id: 7, role: 'owner', permissions: [] })).toEqual(ALL.map((f) => f.name).sort());
  expect(names(MANAGER)).toEqual(['coupons', 'customers', 'inventory', 'invoices', 'loyalty', 'orders', 'payments', 'privacy', 'refunds', 'returns', 'reviews', 'settings', 'shipping', 'shopify', 'store-settings']);
  expect(names(ORDERS_STAFF)).toEqual(['invoices', 'orders', 'refunds', 'returns']);
  expect(names(CATALOG_STAFF)).toEqual(['inventory', 'reviews']);
  expect(names({ id: 11, role: 'staff', permissions: [] })).toEqual([]);
});
