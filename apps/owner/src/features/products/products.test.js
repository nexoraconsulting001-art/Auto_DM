import React from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import products from './index.js';

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const at = '2026-11-01T10:00:00.000Z';
const base = {
  slug: 'x', description: '', mrpPaise: null, images: [], optionLabel: '', optionValues: [], stock: null, active: true, featured: false, createdAt: at, updatedAt: at,
  externalUrl: '', inStock: true, source: 'manual', sourceRef: '', fetchStatus: 'none', fetchedAt: null, priceChanged: false, previousPricePaise: null, priceManual: true,
  ownerEdited: [], tags: [], whatsappOrder: null, reelCount: 0, categoryNames: [],
};
const KURTA = { ...base, id: 11, name: 'Block print kurta', pricePaise: 129950, display: { pricePaise: 99900, mrpPaise: 129950, discountPercent: 23, soldOut: false } };
const LAMP = { ...base, id: 12, name: 'Brass lamp', pricePaise: 50000, active: false, fetchStatus: 'broken', source: 'link', display: { pricePaise: 50000, mrpPaise: null, discountPercent: null, soldOut: true } };
const detail = (p) => ({ ...p, categoryIds: [], options: [], variants: [], gallery: [], lastCheck: null });

function api(extra = {}) {
  const server = fakeApi({
    routes: {
      'GET /products': () => ({ items: [KURTA, LAMP], nextCursor: null }),
      'GET /products/:id': (call) => detail([KURTA, LAMP].find((p) => `/products/${p.id}` === call.path)),
      'POST /products': (call) => [201, detail({ ...base, id: 40, ...call.body })],
      'PATCH /products/:id': (call) => detail({ ...KURTA, ...call.body }),
      'GET /categories': () => ({ items: [], nextCursor: null }),
      'POST /media': () => [201, { id: '7d0c1c9e-1111-4111-8111-111111111111', url: '/media/7d0c1c9e-1111-4111-8111-111111111111' }],
      ...extra,
    },
  });
  // The shared stand-in reads every body as JSON; a file goes as FormData, so it is handed on as a note of its parts.
  const inner = server.fetch;
  server.fetch = (url, init = {}) => (init.body instanceof FormData ? inner(url, { ...init, body: JSON.stringify({ file: init.body.get?.('file') ?? null }) }) : inner(url, init));
  return server;
}

async function open(server, path, { network, picker } = {}) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs());
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [products], linking, ...(network ? { network } : {}) });
  return made;
}

test('the list shows the server’s display price from paise with the shared formatter, never a sum made here', async () => {
  const server = api();
  await open(server, '/products');
  expect(await screen.findByTestId('product-11')).toBeTruthy();
  expect(screen.getByText('Block print kurta')).toBeTruthy();
  expect(screen.getByText('₹999')).toBeTruthy(); // display.pricePaise 99900, not the product's own 129950
  expect(within(screen.getByTestId('product-12-badge')).getByText('Needs attention')).toBeTruthy();
});

test('an empty catalog says so and offers to add or import', async () => {
  const server = api({ 'GET /products': () => ({ items: [], nextCursor: null }) });
  await open(server, '/products');
  expect(await screen.findByTestId('products-list-empty')).toBeTruthy();
  expect(screen.getByText('No products yet')).toBeTruthy();
});

test('a failed load shows the error with a retry, and the retry asks again', async () => {
  let fail = true;
  const server = api({ 'GET /products': () => (fail ? [500, { error: 'x', code: 'internal' }] : { items: [KURTA], nextCursor: null }) });
  await open(server, '/products');
  expect(await screen.findByTestId('products-list-error', {}, { timeout: 8000 })).toBeTruthy(); // after the client's two retries
  fail = false;
  await fireEvent.press(screen.getByTestId('products-list-error-retry'));
  expect(await screen.findByTestId('product-11')).toBeTruthy();
}, 20000);

test('a new product is sent in paise; an MRP under the price is caught before anything is sent', async () => {
  const server = api();
  await open(server, '/products/new');
  await fireEvent.changeText(await screen.findByTestId('product-name'), 'Cotton dupatta');
  await fireEvent.changeText(screen.getByTestId('product-price'), '1,299.50');
  await fireEvent.changeText(screen.getByTestId('product-mrp'), '999');
  await fireEvent.press(screen.getByTestId('product-save'));
  expect(screen.getByText('MRP can’t be lower than the price')).toBeTruthy();
  expect(server.calls.some((c) => c.method === 'POST' && c.path === '/products')).toBe(false);
  await fireEvent.changeText(screen.getByTestId('product-mrp'), '1499');
  await fireEvent.press(screen.getByTestId('product-save'));
  await settle();
  const sent = server.calls.find((c) => c.method === 'POST' && c.path === '/products');
  expect(sent.body).toMatchObject({ name: 'Cotton dupatta', pricePaise: 129950, mrpPaise: 149900 });
});

test('options make one variant per combination, each with its own price', async () => {
  const server = api();
  await open(server, '/products/new');
  await fireEvent.changeText(await screen.findByTestId('product-name'), 'Tee');
  await fireEvent.changeText(screen.getByTestId('product-price'), '499');
  await fireEvent.press(screen.getByTestId('product-option-add'));
  await fireEvent.changeText(screen.getByTestId('product-option-0-name'), 'Size');
  await fireEvent.changeText(screen.getByTestId('product-option-0-values'), 'S, M');
  expect(screen.getByTestId('product-variant-1')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('product-variant-1-price'), '549');
  await fireEvent.press(screen.getByTestId('product-save'));
  await settle();
  const sent = server.calls.find((c) => c.method === 'POST' && c.path === '/products');
  expect(sent.body.options).toEqual([{ name: 'Size', values: ['S', 'M'] }]);
  expect(sent.body.variants.map((v) => [v.optionValues, v.pricePaise])).toEqual([[['S'], 49900], [['M'], 54900]]);
});

test('saving an existing product sends only what changed, and shows the server’s refusal in its own words', async () => {
  const server = api({ 'PATCH /products/:id': () => [400, { error: 'Check the highlighted fields', code: 'validation_failed', fields: { name: 'That name is taken' } }] });
  await open(server, '/products/11');
  await fireEvent.changeText(await screen.findByTestId('product-name'), 'Block print kurta, indigo');
  await fireEvent.press(screen.getByTestId('product-save'));
  await settle();
  const sent = server.calls.find((c) => c.method === 'PATCH');
  expect(sent.body).toEqual({ name: 'Block print kurta, indigo' });
  expect(await screen.findByText('That name is taken')).toBeTruthy();
});

test('offline, saving waits for a connection and says why', async () => {
  const network = fakeNetwork(true);
  await open(api(), '/products/11', { network });
  expect(await screen.findByTestId('product-save')).toBeTruthy();
  await act(async () => network.set(false));
  await settle();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('product-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('product-offline')).toBeTruthy();
});

test('a broken imported product says it needs attention and can be checked again', async () => {
  const server = api({ 'POST /products/:id/recheck': () => [202, { queued: true }] });
  await open(server, '/products/12');
  expect(await screen.findByTestId('product-attention')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('product-recheck'));
  expect(await screen.findByTestId('product-recheck-queued')).toBeTruthy();
});

test('catalog re-checks take whole hours from 1 to 720', async () => {
  const server = api({ 'GET /catalog/settings': () => ({ recheckHours: 24, attentionCount: 2, lastRecheckAt: null }), 'PATCH /catalog/settings': (call) => ({ recheckHours: call.body.recheckHours, attentionCount: 2, lastRecheckAt: null }) });
  await open(server, '/catalog/settings');
  await fireEvent.changeText(await screen.findByTestId('products-settings-hours'), '900');
  expect(screen.getByText('At most 720 hours')).toBeTruthy();
  expect(screen.getByTestId('products-settings-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('products-settings-hours'), '12');
  await fireEvent.press(screen.getByTestId('products-settings-save'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PATCH').body).toEqual({ recheckHours: 12 });
});

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
const picker = require('expo-image-picker');
const photo = (over) => ({ canceled: false, assets: [{ uri: 'file:///p/one.jpg', fileName: 'one.jpg', mimeType: 'image/jpeg', fileSize: 120_000, ...over }] });

test('a photo over 5 MB or of the wrong type is refused on the phone and never sent', async () => {
  const server = api();
  await open(server, '/products/new');
  picker.launchImageLibraryAsync.mockResolvedValueOnce(photo({ fileSize: 5 * 1024 * 1024 + 1 }));
  await fireEvent.press(await screen.findByTestId('product-photos-add'));
  expect(await screen.findByText('That photo is over 5 MB. Choose a smaller one.')).toBeTruthy();
  picker.launchImageLibraryAsync.mockResolvedValueOnce(photo({ fileName: 'one.heic', mimeType: 'image/heic' }));
  await fireEvent.press(screen.getByTestId('product-photos-add'));
  expect(await screen.findByText('Use a JPG, PNG, WebP or GIF photo.')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/media')).toBe(false);
});

test('a photo within the limits is uploaded, and a refusal from the server is shown in its words', async () => {
  let refuse = false;
  const server = api({ 'POST /media': () => (refuse ? [413, { error: 'That file is too large for this business', code: 'payload_too_large' }] : [201, { id: '7d0c1c9e-1111-4111-8111-111111111111', url: '/media/7d0c1c9e-1111-4111-8111-111111111111' }]) });
  await open(server, '/products/new');
  picker.launchImageLibraryAsync.mockResolvedValueOnce(photo());
  await fireEvent.press(await screen.findByTestId('product-photos-add'));
  expect(await screen.findByTestId('product-photos-0')).toBeTruthy();
  refuse = true;
  picker.launchImageLibraryAsync.mockResolvedValueOnce(photo({ fileName: 'two.png', mimeType: 'image/png' }));
  await fireEvent.press(screen.getByTestId('product-photos-add'));
  expect(await screen.findByText('That file is too large for this business')).toBeTruthy();
  expect(server.calls.filter((c) => c.path === '/media')).toHaveLength(2);
});
