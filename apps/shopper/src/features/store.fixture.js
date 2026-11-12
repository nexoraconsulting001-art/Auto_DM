/**
 * A store that answers like the server does, and the app made against it with stand-ins for what only a phone has. Shared by the
 * buying screens' tests. Not part of the app: nothing imports it but tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { QueryClient } from '@tanstack/react-query';
import { screen, fireEvent } from '@testing-library/react-native';
import { features } from './index.js';
import { createServices } from '../services.js';

/** The platform's name, spelled in pieces so this file does not name it: what no seller-facing screen may show. */
export const PLATFORM_WORD = new RegExp(['bha', 'va'].join(''), 'i');

export const FIXTURES = path.resolve(__dirname, '../../../../tools/build-brand/fixtures');
export const brands = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json')));
export const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));
export const ORIGIN = 'http://localhost:4010';
export const PRICE = 129900;
export const TOKEN = 'tok_ABCDEFGH12345678';

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

const guest = (n = 1) => ({ accessToken: `shopa_guest${n}`, accessExpiresInSeconds: 900, refreshToken: `shopr_guest${n}`, guest: true, shopper: null });
export const shopper = { id: 1, name: 'Asha Rao', phoneMasked: '+91 ••••• •3210', email: '', phoneVerified: true, hasGoogle: false, hasApple: false };

/** A store that answers like the server: guest and signed-in sessions, a quote from the lines, orders with their keys, push choices. */
export function makeStore(name, { orderState = {}, over = {} } = {}) {
  const log = [];
  const state = { orders: new Map(), prefs: { permission: 'not_asked', orderUpdates: false, offers: false, newReels: false, configured: true }, signedIn: false, state: { next: 'pay', paymentStatus: 'unpaid', fulfilmentStatus: 'pending', ...orderState }, deleted: false, otps: 0, hold: null };
  const lineOf = (l) => ({ productId: l.productId, variantId: l.variantId ?? null, name: `Item ${l.productId}`, option: '', image: '', qty: l.qty, unitPaise: PRICE, linePaise: PRICE * l.qty, state: 'ok' });
  const quoteOf = (body) => {
    const lines = body.lines.map(lineOf);
    const subtotal = lines.reduce((sum, l) => sum + l.linePaise, 0);
    const cod = body.paymentMode === 'cod' ? 3000 : 0;
    return {
      lines, subtotalPaise: subtotal, discountPaise: 0, loyaltyPaise: 0, shippingPaise: 0, codFeePaise: cod, taxPaise: 0, totalPaise: subtotal + cod, advancePaise: 0, balancePaise: 0,
      paymentModes: [{ mode: 'prepaid', available: true, reason: '' }, { mode: 'cod', available: true, reason: '' }, { mode: 'part_advance', available: false, reason: 'Not offered by this store' }],
      serviceable: true, coupon: null, pointsUsed: 0, notices: [],
    };
  };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    log.push({ method, path: pathname, search, body, headers: init.headers ?? {} });
    const key = `${method} ${pathname}`;
    if (over[key]) return over[key](body, state);
    switch (key) {
      case 'GET /api/store/app/bootstrap': return json({ name: brandOf(name).name, minVersion: '1.0.0', storeUrl: '', theme: { colors: {}, headingFont: '', bodyFont: '', logoUrl: '' }, supportEmail: brandOf(name).supportEmail, links: {}, features: {}, signIn: { whatsapp: true, google: true, apple: false }, push: {}, noticeVersion: 1 });
      case 'GET /api/store/app/home': return json({ blocks: [{ type: 'hero', settings: {} }], categories: [], reels: [], products: [] });
      case 'POST /api/store/app/session':
        if (body.grant === 'otp') { state.signedIn = true; return json({ accessToken: 'shopa_signed', accessExpiresInSeconds: 900, refreshToken: 'shopr_signed', guest: false, shopper }); }
        return json(guest(1), 201);
      case 'POST /api/store/app/session/refresh': return json({ accessToken: 'shopa_refreshed', accessExpiresInSeconds: 900, refreshToken: 'shopr_refreshed' });
      case 'POST /api/store/app/session/end': state.signedIn = false; return json(guest(2));
      case 'GET /api/store/app/me': return json({ shopper: state.signedIn ? shopper : null, sharedProfile: { available: true, linked: false, consented: false } });
      case 'POST /api/store/otp/send': state.otps += 1; return json({ sent: true });
      case 'POST /api/store/otp/verify': return json({ verified: true });
      case 'POST /api/store/checkout/quote': return json(quoteOf(body));
      case 'POST /api/store/checkout': {
        await state.hold;
        const found = state.orders.get(body.idempotencyKey);
        if (found) return json(found);
        const made = { orderNumber: `A-${1000 + state.orders.size}`, token: TOKEN, next: body.paymentMode === 'cod' ? 'done' : 'pay', gateway: null };
        state.orders.set(body.idempotencyKey, made);
        if (made.next === 'done') Object.assign(state.state, { next: 'done', paymentStatus: 'cod_due', fulfilmentStatus: 'new' });
        return json(made, 201);
      }
      case 'POST /api/store/orders/' + TOKEN + '/retry': return json({ orderNumber: 'A-1000', token: TOKEN, next: 'pay', gateway: null });
      case 'GET /api/store/app/push/prefs': return json(state.prefs);
      case 'PUT /api/store/app/push/device': state.prefs = { ...state.prefs, permission: body.permission }; return json(state.prefs);
      case 'PUT /api/store/app/push/prefs': state.prefs = { ...state.prefs, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'source')) }; return json(state.prefs);
      case 'POST /api/store/app/push/orders': return json(null, 204);
      case 'DELETE /api/store/app/push/device': return json(null, 204);
      case 'GET /api/store/addresses': return json({ items: [] });
      case 'POST /api/store/app/account/delete': state.deleted = true; state.signedIn = false; return json({ status: 'completed', signedOut: true, message: 'Your account is deleted.' });
      case 'PUT /api/store/cart': return json({ lines: body.lines.map(lineOf), notices: [] });
      default:
        if (pathname === `/api/store/app/order/${TOKEN}`) return json({ orderNumber: 'A-1000', totalPaise: PRICE, payPath: `/order/${TOKEN}`, ...state.state });
        return json({ error: 'This page is not here', code: 'not_found' }, 404);
    }
  };
  return { fetch, log, state };
}

export function setup(name, store = makeStore(name), extra = {}) {
  const opened = [];
  const browser = extra.browser ?? { openAuthSessionAsync: async (url) => { opened.push(url); return { type: 'cancel' }; } };
  const disk = new Map();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // What a phone has and a test does not: the device's file for the bag, its random bytes, its photo library. They are put on the
  // services before the first buying feature builds its own, which is how this app takes stand-ins.
  const doubles = {
    buyStorage: { getItem: async (k) => disk.get(k) ?? null, setItem: async (k, v) => disk.set(k, v), removeItem: async (k) => disk.delete(k) },
    deviceCrypto: { random: async (n) => crypto.randomBytes(n), sha256: async (t) => crypto.createHash('sha256').update(t).digest('base64'), sha256Hex: async (t) => crypto.createHash('sha256').update(t).digest('hex') },
    newKey: () => `key-${crypto.randomUUID()}`,
    imagePicker: extra.imagePicker,
  };
  const withDoubles = features.map((f) => (f.name === 'cart' ? { ...f, service: (s) => { Object.assign(s, doubles); return f.service(s); } } : f));
  const services = createServices({ constants: constantsFor(name), platform: 'android', fetch: store.fetch, queryClient, browser, features: withDoubles });
  return { services, store, opened, disk, queryClient };
}

export const secure = () => require('expo-secure-store').__dump?.() ?? {};
export const flatText = () => JSON.stringify(screen.toJSON());
export const type = (id, value) => fireEvent.changeText(screen.getByTestId(id), value);

