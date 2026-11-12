// Shared by the shopper app's spec tests (PRD 10.1, 10.7, 10.10 to 10.12). Written from the PRD and the Phase 6 contract only:
// the app is rendered whole, with one brand's constants, and its only network is a fake store that answers the routes of
// APP_ROUTES in src/contracts/store-routes.js and records every call. Nothing here looks inside a screen.
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import App from '../src/App.js';
import { createServices } from '../src/services.js';

export const FIXTURES = path.resolve(__dirname, '../../../tools/build-brand/fixtures');
export const BRANDS = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json'))).sort();
export const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));
export const PLATFORM_NAME = /bhava/i;

/** What app.config.js writes into a build for this brand, as expo-constants hands it to the app. */
export function constantsFor(name, extra = {}) {
  const brand = brandOf(name);
  return {
    expoConfig: {
      version: brand.appVersion,
      extra: {
        brand: {
          tenantId: brand.tenantId, name: brand.name, shortName: brand.shortName, scheme: brand.scheme, shopDomain: brand.shopDomain, supportEmail: brand.supportEmail,
          privacyUrl: brand.privacyUrl, linkHosts: brand.linkHosts, linkPaths: brand.linkPaths, colors: brand.colors, fonts: brand.fonts, fontFamilies: {},
        },
        apiBaseUrl: 'http://localhost:4010',
        appEnv: 'preview',
        payDriver: 'hosted',
        push: { android: true, ios: true },
        ...extra,
      },
    },
  };
}

const product = (id, name, pricePaise, extra = {}) => ({ id, slug: name.toLowerCase().replace(/\s+/g, '-'), name, pricePaise, comparePaise: null, image: '', inStock: true, rating: null, ratingCount: 0, ...extra });
export const PRODUCTS = [product(1, 'Copper Kettle', 129900), product(2, 'Brass Tray', 79900), product(3, 'Clay Mug', 24900)];
export const REELS = [
  { slug: 'brunch-edit', title: 'Brunch edit', image: '', videoUrl: null, pinned: false, productCount: 2 },
  { slug: 'tea-time', title: 'Tea time', image: '', videoUrl: null, pinned: false, productCount: 1 },
  { slug: 'festive-picks', title: 'Festive picks', image: '', videoUrl: null, pinned: true, productCount: 3 },
];
export const CATEGORY = { slug: 'tea', name: 'Tea', image: '' };
export const SHOPPER = { id: 1, name: 'Asha Rao', phoneMasked: '+91 ******3210', email: '', phoneVerified: true, hasGoogle: false, hasApple: false };
const page = (items) => ({ items, nextCursor: null });
export const orderRow = (n, extra = {}) => ({ orderNumber: `ORD-${n}`, token: `tok-${n}`, placedAt: '2026-11-01T10:00:00.000Z', fulfilmentStatus: 'delivered', paymentStatus: 'paid', totalPaise: 129900, itemCount: 1, image: '', ...extra });

/**
 * A fake store. `routes` replaces or adds answers by 'METHOD /path'; a value is a body, or a function (request) => body or
 * { status, body }. Every call is recorded in `calls` as { method, path, url, headers, body }. `state.offline` makes every call
 * fail like a dead network.
 */
export function fakeStore(name, routes = {}, { platform = 'android' } = {}) {
  const brand = brandOf(name);
  const calls = [];
  const state = { offline: false };
  const base = {
    'GET /api/store/app/bootstrap': () => ({
      name: brand.name, minVersion: '', storeUrl: '', signIn: { whatsapp: true, google: true, apple: platform === 'ios' },
      features: { coupons: true, loyalty: true, reviews: true, wishlist: true, returns: true, cod: true },
      theme: { colors: brand.colors, headingFont: brand.fonts.heading, bodyFont: brand.fonts.body, logoUrl: '' },
      links: { privacy: brand.privacyUrl, terms: `https://${brand.shopDomain}/policies/terms`, refund: `https://${brand.shopDomain}/policies/refund`, shipping: `https://${brand.shopDomain}/policies/shipping` },
      supportEmail: brand.supportEmail, push: { android: true, ios: true }, noticeVersion: 1,
    }),
    'POST /api/store/app/session': (r) => ({ accessToken: 'sa_guest', accessExpiresInSeconds: 900, refreshToken: 'sr_guest', guest: r.body?.grant !== 'otp', shopper: r.body?.grant === 'otp' ? SHOPPER : null }),
    'POST /api/store/app/session/refresh': () => ({ accessToken: 'sa_next', accessExpiresInSeconds: 900, refreshToken: 'sr_next' }),
    'POST /api/store/app/session/end': () => ({ accessToken: 'sa_guest', accessExpiresInSeconds: 900, refreshToken: 'sr_guest', guest: true, shopper: null }),
    'GET /api/store/app/me': () => ({ shopper: null, sharedProfile: { available: false, linked: false, consented: false } }),
    'GET /api/store/app/home': () => ({ blocks: [], categories: [CATEGORY], reels: REELS, products: PRODUCTS }),
    'GET /api/store/app/catalog': () => page(PRODUCTS),
    'GET /api/store/app/categories': () => ({ items: [CATEGORY] }),
    'GET /api/store/app/reels': () => ({ chips: [CATEGORY], items: REELS, nextCursor: null }),
    'GET /api/store/app/categories/tea': () => ({ category: CATEGORY, reels: REELS, products: page(PRODUCTS) }),
    'GET /api/store/cart': () => ({ lines: [] }),
    'PUT /api/store/cart': (r) => ({ lines: (r.body?.lines ?? []).map((l) => ({ ...l, name: PRODUCTS.find((p) => p.id === l.productId)?.name ?? 'Item', option: '', image: '', unitPaise: 100, linePaise: 100 * l.qty, state: 'ok' })) }),
    'GET /api/store/app/orders': () => page([orderRow(1), orderRow(2, { totalPaise: 79900 })]),
    'GET /api/store/app/rewards': () => ({
      enabled: true, pointsBalance: 42, pendingPoints: 0, valuePaise: 4200, expiring: null, history: [],
      referral: { code: 'ASHA42', url: `https://${brand.shopDomain}/refer/ASHA42`, text: `Join ${brand.name} with my link` },
    }),
    'GET /api/store/app/push/prefs': () => ({ permission: 'not_asked', orderUpdates: false, offers: false, newReels: false, configured: true }),
    'PUT /api/store/app/push/prefs': (r) => ({ permission: 'granted', orderUpdates: Boolean(r.body?.orderUpdates), offers: Boolean(r.body?.offers), newReels: Boolean(r.body?.newReels), configured: true }),
    'PUT /api/store/app/push/device': () => ({ permission: 'granted', orderUpdates: false, offers: false, newReels: false, configured: true }),
    'POST /api/store/otp/send': () => ({ ok: true }),
    'POST /api/store/app/account/delete': () => ({ status: 'completed', signedOut: true, message: 'Your account was deleted.' }),
    'POST /api/store/app/health': () => null,
    ...routes,
  };
  const find = (method, p) => {
    const exact = base[`${method} ${p}`];
    if (exact !== undefined) return exact;
    for (const [key, value] of Object.entries(base)) {
      const [m, pattern] = key.split(' ');
      if (m === method && pattern.includes(':') && new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(p)) return value;
    }
    return undefined;
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = { method: init.method ?? 'GET', path: parsed.pathname, url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (state.offline) throw new TypeError('Network request failed');
    const route = find(call.method, call.path);
    if (route === undefined) return { ok: false, status: 404, json: async () => ({ error: 'Not found', code: 'not_found' }) };
    const out = typeof route === 'function' ? await route(call) : route;
    const wrapped = out && typeof out === 'object' && 'status' in out && 'body' in out;
    const status = wrapped ? out.status : 200;
    const body = wrapped ? out.body : out;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, calls, state, brand, callsTo: (method, p) => calls.filter((c) => c.method === method && (typeof p === 'string' ? c.path === p : p.test(c.path))) };
}

/** The whole app for one brand on a fake store. */
export async function renderApp(name, { routes, platform = 'android', extra, linking = false, services: serviceOptions = {} } = {}) {
  const store = fakeStore(name, routes, { platform });
  const services = createServices({ constants: constantsFor(name, extra), platform, fetch: store.fetch, ...serviceOptions });
  await render(<App services={services} linking={linking} />);
  return { ...store, services };
}

/** Every string a rendered tree shows or announces. */
export function visibleText() {
  const out = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const key of ['accessibilityLabel', 'placeholder', 'title', 'aria-label', 'testID', 'alt']) if (typeof node.props?.[key] === 'string') out.push(node.props[key]);
    walk(node.children);
  };
  walk(screen.toJSON());
  return out.join('\n');
}

export const tab = async (name) => { await act(async () => { fireEvent.press(screen.getByTestId(`tab-${name}`)); }); };
export const press = async (matcher) => { const node = typeof matcher === 'string' || matcher instanceof RegExp ? await screen.findByText(matcher, undefined, { timeout: 4000 }) : matcher; await act(async () => { fireEvent.press(node); }); };
export const waitText = (matcher, options = { timeout: 4000 }) => screen.findByText(matcher, undefined, options);
export { act, fireEvent, screen, waitFor };

/** Signs in through the screens: a WhatsApp number, then the code. The fake store accepts any. */
export async function signInThroughScreens(phone = '9876543210') {
  await tab('account');
  await press(/sign in|log in|continue with whatsapp|whatsapp/i);
  const number = await screen.findByPlaceholderText(/phone|mobile|whatsapp|number/i, undefined, { timeout: 4000 });
  await act(async () => { fireEvent.changeText(number, phone); });
  await press(/send|get (a |the )?code|continue|next/i);
  const code = await screen.findByPlaceholderText(/code|otp|6/i, undefined, { timeout: 4000 });
  await act(async () => { fireEvent.changeText(code, '123456'); });
  await press(/verify|sign in|continue|confirm/i);
}
