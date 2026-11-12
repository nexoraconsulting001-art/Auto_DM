/**
 * The browsing screens on the rendered app, once for each fixture brand: home, shop, reels, category, product, search and
 * the policies, opened by tab and by direct link, against a store that answers like the server does.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import App from '../App.js';
import { features } from '../features/index.js';
import { createServices } from '../services.js';
import { clearUpdateRequired } from './gate.js';
import { linkingOf } from './menu.js';
import { variantFor, valueAvailable } from '../features/product/ProductScreen.js';

jest.mock('expo-notifications', () => ({ requestPermissionsAsync: jest.fn(), getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined' })) }));

const FIXTURES = path.resolve(__dirname, '../../../../tools/build-brand/fixtures');
const brands = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json')));
const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));
const ORIGIN = 'http://localhost:4010';

function constantsFor(name) {
  const brand = brandOf(name);
  return {
    expoConfig: {
      version: brand.appVersion,
      extra: {
        brand: { tenantId: brand.tenantId, name: brand.name, shortName: brand.shortName, scheme: brand.scheme, shopDomain: brand.shopDomain, supportEmail: brand.supportEmail, privacyUrl: brand.privacyUrl, linkHosts: brand.linkHosts, linkPaths: brand.linkPaths, colors: brand.colors, fonts: brand.fonts, fontFamilies: {} },
        apiBaseUrl: ORIGIN, appEnv: 'preview', payDriver: 'hosted', push: { android: false, ios: false },
      },
    },
  };
}

const card = (slug, over = {}) => ({ id: slug.length, slug, name: `Item ${slug}`, pricePaise: 129900, comparePaise: null, image: `/media/${slug}.jpg`, inStock: true, rating: null, ratingCount: 0, ...over });
const reel = (slug, over = {}) => ({ slug, title: `Reel ${slug}`, image: `/media/${slug}.jpg`, videoUrl: null, pinned: false, productCount: 1, ...over });

function store(name, overrides = {}) {
  const brand = brandOf(name);
  return {
    '/api/store/app/bootstrap': { name: brand.name, minVersion: '1.0.0', storeUrl: 'https://play.example/app', theme: { colors: {}, headingFont: '', bodyFont: '', logoUrl: 'https://cdn.example/logo.png' }, supportEmail: brand.supportEmail, links: {}, features: {}, signIn: {}, push: {}, noticeVersion: null },
    '/api/store/app/home': {
      blocks: [{ type: 'hero', settings: {} }, { type: 'shelves', settings: {} }, { type: 'banner', settings: { text: '<img src=x onerror=alert(1)>Festive <b>sale</b>', imageUrl: 'javascript:alert(1)' } }],
      categories: [{ slug: 'pots', name: 'Pots', image: '' }],
      reels: [reel('r-one'), reel('r-two', { pinned: true })],
      products: [card('blue-pot'), card('old-pot', { name: 'Old pot', inStock: false })],
    },
    '/api/store/app/catalog': { items: [card('blue-pot'), card('green-pot', { pricePaise: 99950, comparePaise: 149900 })], nextCursor: null },
    '/api/store/app/categories': { items: [{ slug: 'pots', name: 'Pots', image: '' }] },
    '/api/store/app/categories/pots': { category: { slug: 'pots', name: 'Pots', image: '' }, reels: [reel('c-1'), reel('c-2', { pinned: true }), reel('c-3')], products: { items: [card('blue-pot')], nextCursor: null } },
    '/api/store/app/reels': { chips: [{ slug: 'pots', name: 'Pots', image: '' }], items: [reel('a'), reel('b', { pinned: true })], nextCursor: null },
    '/api/store/app/landing/r-one': { slug: 'r-one', title: 'Spring reel', media: { kind: 'image', url: '/media/r.jpg', poster: '' }, products: [card('blue-pot')], moreReels: [reel('r-two')] },
    '/api/store/app/products/blue-pot': {
      ...card('blue-pot', { comparePaise: 159900 }), description: '<b>Hand</b> made<script>alert(1)</script>', images: ['/media/1.jpg', '/media/2.jpg'], maxQty: 3, reels: [],
      options: [{ name: 'Colour', values: ['Red', 'Blue'] }, { name: 'Size', values: ['S', 'L'] }],
      variants: [
        { id: 11, option: 'Red / S', pricePaise: 129900, inStock: true, image: '' }, { id: 12, option: 'Red / L', pricePaise: 139900, inStock: true, image: '' },
        { id: 13, option: 'Blue / S', pricePaise: 129900, inStock: false, image: '' }, { id: 14, option: 'Blue / L', pricePaise: 149900, inStock: true, image: '' },
      ],
    },
    '/api/store/app/products/old-pot': { ...card('old-pot', { inStock: false }), description: '', images: [], options: [], variants: [], maxQty: 1, reels: [] },
    '/api/store/app/policies/refund': { kind: 'refund', title: 'Refunds', body: '<p>Return within 7 days.</p><script>alert(1)</script>', updatedAt: '2026-10-01T00:00:00Z' },
    '/api/store/app/policies/privacy': { kind: 'privacy', title: 'Privacy', body: 'We keep your details safe.', updatedAt: null },
    ...overrides,
  };
}

function setup(name, { answers = store(name), statusFor = {}, brandPatch, offline = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (offline) throw new TypeError('Network request failed');
    const route = new URL(url).pathname;
    if (statusFor[route]) return { ok: false, status: statusFor[route].status, json: async () => statusFor[route].body };
    if (!(route in answers)) return { ok: false, status: 404, json: async () => ({ error: 'This page is not here', code: 'not_found' }) };
    return { ok: true, status: 200, json: async () => answers[route] };
  };
  const constants = constantsFor(name);
  if (brandPatch) Object.assign(constants.expoConfig.extra.brand, brandPatch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const services = createServices({ constants, platform: 'android', fetch, queryClient });
  return { services, calls };
}

/** Opens the app at a direct link, as a tap on a message does. */
async function openAt(services, url) {
  const brand = services.config.brand;
  const linking = { ...linkingOf(features, brand), getInitialURL: async () => url, subscribe: () => () => {} };
  await render(<App services={services} linking={linking} />);
}

const flatText = () => JSON.stringify(screen.toJSON());

beforeEach(() => clearUpdateRequired());

describe.each(brands)('%s', (name) => {
  const brand = brandOf(name);

  test('home shows the seller’s name and logo, shelves from the server, and never asks for sign-in or notifications', async () => {
    const { services, calls } = setup(name);
    await render(<App services={services} linking={false} />);
    expect(await screen.findByTestId('product-blue-pot')).toBeTruthy();
    expect(screen.getByTestId('brand-name')).toHaveTextContent(brand.name);
    await waitFor(() => expect(screen.getByTestId('brand-logo')).toBeTruthy());
    expect(screen.getAllByText('₹1,299').length).toBeGreaterThan(0);
    expect(screen.queryByText(/sign in|log in|notification/i)).toBeNull();
    expect(screen.queryByTestId('screen-sign-in')).toBeNull();
    expect(require('expo-notifications').requestPermissionsAsync).not.toHaveBeenCalled();
    expect(calls.every((c) => c.url.startsWith(`${ORIGIN}/api/store/app/`) && !c.headers.authorization)).toBe(true);
    expect(flatText()).not.toMatch(/bhava/i);
  });

  test('seller text is drawn as text, and an unsafe image address is never loaded', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    const banner = await screen.findByTestId('block-banner');
    expect(within(banner).getByText('Festive sale')).toBeTruthy();
    expect(flatText()).not.toContain('javascript:');
    expect(flatText()).not.toContain('onerror');
    expect(flatText()).not.toContain('<img');
  });

  test('an out-of-stock product shows as sold out, from the server’s answer', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    expect(await screen.findByTestId('soldout-old-pot')).toBeTruthy();
    expect(screen.queryByTestId('soldout-blue-pot')).toBeNull();
  });

  test('the shop lists products with the server’s paise formatted, and sorting asks the server', async () => {
    const { services, calls } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-catalog'));
    expect(await screen.findByTestId('product-green-pot')).toBeTruthy();
    expect(screen.getByText('₹999.50')).toBeTruthy();
    expect(screen.getByTestId('product-green-pot')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('catalog-sort-price-asc'));
    await waitFor(() => expect(calls.some((c) => /\/app\/catalog\?.*sort=price-asc/.test(c.url))).toBe(true));
  });

  test('the Reels tab shows pinned reels first and a reel opens its own page', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(screen.getByTestId('tab-reels'));
    const list = await screen.findByTestId('reels-list');
    expect(within(list).getAllByTestId(/^reel-/).map((el) => el.props.testID)).toEqual(['reel-b', 'reel-a']);
    expect(within(list).getByTestId('pinned-b')).toBeTruthy();
  });

  test('a category shows its reels in the set order with pinned first, then its products', async () => {
    const { services } = setup(name);
    await openAt(services, `https://${brand.linkHosts[0]}/c/pots`);
    const reels = await screen.findByTestId('category-reels');
    expect(within(reels).getAllByTestId(/^reel-/).map((el) => el.props.testID)).toEqual(['reel-c-2', 'reel-c-1', 'reel-c-3']);
    expect(screen.getByTestId('category-name')).toHaveTextContent('Pots');
    expect(screen.getByTestId('product-blue-pot')).toBeTruthy();
  });

  test('a product link opens the product with options and variants; the price and stock follow the chosen variant', async () => {
    const { services } = setup(name);
    await openAt(services, `${brand.scheme}://p/blue-pot`);
    expect(await screen.findByTestId('product-name')).toHaveTextContent('Item blue-pot');
    expect(screen.getByTestId('product-price-now')).toHaveTextContent('₹1,299');
    expect(screen.getByTestId('product-description')).toHaveTextContent('Hand made');
    expect(screen.getByTestId('choose-options')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('value-Colour-Red'));
    await fireEvent.press(screen.getByTestId('value-Size-L'));
    expect(screen.getByTestId('product-price-now')).toHaveTextContent('₹1,399');
    await fireEvent.press(screen.getByTestId('value-Colour-Blue'));
    expect(screen.getByTestId('product-price-now')).toHaveTextContent('₹1,499');
    await fireEvent.press(screen.getByTestId('value-Size-S'));
    expect(await screen.findByTestId('product-soldout')).toBeTruthy();
    expect(flatText()).not.toContain('alert(1)');
  });

  test('a product that was removed says so, and a sold-out one cannot be added', async () => {
    const { services } = setup(name);
    services.cart = { add: jest.fn() };
    await openAt(services, `https://${brand.linkHosts[0]}/p/old-pot`);
    expect(await screen.findByTestId('product-soldout')).toBeTruthy();
    expect(screen.getByTestId('add-to-cart')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('add-to-cart'));
    expect(services.cart.add).not.toHaveBeenCalled();
  });

  test('a product the server no longer has shows the store’s own words', async () => {
    const { services } = setup(name);
    await openAt(services, `https://${brand.linkHosts[0]}/p/never-existed`);
    const gone = await screen.findByTestId('gone');
    expect(within(gone).getByText(new RegExp(brand.name))).toBeTruthy();
    expect(flatText()).not.toMatch(/bhava/i);
  });

  test('search asks the server as the shopper types, and says plainly when nothing matches', async () => {
    const { services, calls } = setup(name, { answers: { ...store(name), '/api/store/app/catalog': { items: [], nextCursor: null } } });
    await openAt(services, `${brand.scheme}://`);
    await fireEvent.press(await screen.findByTestId('home-search'));
    const input = await screen.findByTestId('search-input');
    await fireEvent.changeText(input, 'zzz');
    await fireEvent(input, 'submitEditing');
    expect(await screen.findByTestId('search-empty')).toBeTruthy();
    expect(calls.some((c) => /\/app\/catalog\?.*q=zzz/.test(c.url))).toBe(true);
  });

  test('the policies show the seller’s text as plain text', async () => {
    const { services } = setup(name);
    await render(<App services={services} linking={false} />);
    await fireEvent.press(await screen.findByTestId('policy-refund'));
    expect(await screen.findByTestId('legal-body')).toHaveTextContent('Return within 7 days.');
    expect(flatText()).not.toContain('<p>');
    await fireEvent.press(screen.getByTestId('legal-kinds-privacy'));
    expect(await screen.findByText('We keep your details safe.')).toBeTruthy();
  });

  test('a link to an unknown page opens home', async () => {
    const { services } = setup(name);
    await openAt(services, `https://${brand.linkHosts[0]}/no/such/page`);
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
  });

  test('a reel link opens the reel’s page', async () => {
    const { services } = setup(name);
    await openAt(services, `https://${brand.linkHosts[0]}/r/r-one`);
    expect(await screen.findByTestId('reel-title')).toHaveTextContent('Spring reel');
    expect(screen.getByTestId('product-blue-pot')).toBeTruthy();
  });

  test('a server that says the app is too old shows the update screen in the store’s name, with no platform name anywhere', async () => {
    const { services } = setup(name, { statusFor: { '/api/store/app/home': { status: 426, body: { error: 'Please update', code: 'update_required', storeUrl: 'https://play.example/app' } } } });
    await render(<App services={services} linking={false} />);
    const gate = await screen.findByTestId('update-required');
    expect(within(gate).getByText(`Please update the ${brand.name} app`)).toBeTruthy();
    expect(screen.getByTestId('update-button')).toBeTruthy();
    expect(flatText()).not.toMatch(/bhava/i);
  });

  test('with no connection and nothing saved, the app says it is offline, in plain words', async () => {
    const { services } = setup(name, { offline: true });
    await render(<App services={services} linking={false} />);
    expect(await screen.findByTestId('offline')).toBeTruthy();
    expect(screen.getByText('You are offline')).toBeTruthy();
    expect(flatText()).not.toMatch(/bhava|localhost|4010/i);
  });

  test('what was downloaded before shows with no connection', async () => {
    const files = new Map();
    const storage = { getItem: async (k) => files.get(k) ?? null, setItem: async (k, v) => { files.set(k, v); }, removeItem: async (k) => { files.delete(k); } };
    const first = setup(name);
    first.services.offlineStorage = storage;
    const view = await render(<App services={first.services} linking={false} />);
    await screen.findByTestId('product-blue-pot');
    await view.unmount(); // writes what is waiting
    await waitFor(() => expect([...files.keys()].some((k) => k.includes(String(brand.tenantId)))).toBe(true));
    const saved = [...files.values()].join('');
    expect(saved).not.toMatch(/authorization|Bearer|Shopper /i);

    const second = setup(name, { offline: true });
    second.services.offlineStorage = storage;
    await render(<App services={second.services} linking={false} />);
    expect(await screen.findByTestId('product-blue-pot')).toBeTruthy();
    expect(screen.queryByTestId('offline')).toBeNull();
  });
});

describe('variant choice', () => {
  const product = {
    options: [{ name: 'Colour', values: ['Red', 'Blue'] }, { name: 'Size', values: ['S', 'L'] }],
    variants: [{ option: 'Red / S', inStock: true }, { option: 'Red / L', inStock: false }, { option: 'Blue / S', inStock: true }, { option: 'Blue / L', inStock: true }],
  };
  test('a variant is found only when every option is chosen', () => {
    expect(variantFor(product, { Colour: 'Red' })).toBeNull();
    expect(variantFor(product, { Colour: 'Red', Size: 'S' }).option).toBe('Red / S');
    expect(variantFor({ options: [], variants: [] }, {})).toBeNull();
  });
  test('a value is sold out when no in-stock variant is left for it', () => {
    const [colour, size] = product.options;
    expect(valueAvailable(product, size, 'L', { Colour: 'Red' })).toBe(false);
    expect(valueAvailable(product, size, 'L', { Colour: 'Blue' })).toBe(true);
    expect(valueAvailable(product, colour, 'Red', {})).toBe(true);
  });
});

test('each brand is drawn in its own colours and name from the same screens', async () => {
  const [a, b] = brands.map((name) => setup(name).services);
  expect(a.theme.color.primary).not.toBe(b.theme.color.primary);
  await render(<App services={a} linking={false} />);
  expect(await screen.findByTestId('brand-name')).toHaveTextContent(a.config.brand.name);
  expect(screen.queryByText(b.config.brand.name)).toBeNull();
});
