/** The shell on the rendered app: one brand per build, drawn in that brand's colours, open without signing in. */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import App from './App.js';
import { readBuild } from './brand.js';
import { createServices } from './services.js';

const FIXTURES = path.resolve(__dirname, '../../../tools/build-brand/fixtures');
const brands = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json')));
const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));

/** What app.config.js writes into a build for this brand, as expo-constants hands it to the app. */
function constantsFor(name, extra = {}) {
  const brand = brandOf(name);
  return {
    expoConfig: {
      version: brand.appVersion,
      extra: {
        brand: { tenantId: brand.tenantId, name: brand.name, shortName: brand.shortName, scheme: brand.scheme, shopDomain: brand.shopDomain, supportEmail: brand.supportEmail, privacyUrl: brand.privacyUrl, linkHosts: brand.linkHosts, linkPaths: brand.linkPaths, colors: brand.colors, fonts: brand.fonts, fontFamilies: {} },
        apiBaseUrl: 'http://localhost:4010',
        appEnv: 'preview',
        payDriver: 'hosted',
        push: { android: false, ios: false },
        ...extra,
      },
    },
  };
}

function servicesFor(name, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, status: 200, json: async () => options.answer ?? {} };
  };
  return { calls, services: createServices({ constants: constantsFor(name, options.extra), platform: 'android', fetch, ...options }) };
}

test.each(brands)('%s: the app opens on its tabs with no sign-in screen', async (name) => {
  const { services } = servicesFor(name);
  await render(<App services={services} linking={false} />);
  for (const tab of ['home', 'catalog', 'reels', 'cart', 'account']) expect(screen.getByTestId(`tab-${tab}`)).toBeTruthy();
  expect(screen.getByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-sign-in')).toBeNull();
});

test('P-01 each build is drawn in its own brand’s colours, from one set of screens', () => {
  const [a, b] = brands.map((name) => servicesFor(name).services);
  expect(a.theme.color.primary.toLowerCase()).toBe(brandOf(brands[0]).colors.primary.toLowerCase());
  expect(b.theme.color.primary.toLowerCase()).toBe(brandOf(brands[1]).colors.primary.toLowerCase());
  expect(a.theme.color.primary).not.toBe(b.theme.color.primary);
  expect(a.features).toBe(b.features);
  expect(a.config.brand.name).not.toBe(b.config.brand.name);
});

test('every call goes to the build’s own store with the build’s business id, and to nowhere else', async () => {
  const brand = brandOf(brands[0]);
  const { services, calls } = servicesFor(brands[0]);
  await services.client.call('appHome');
  expect(calls[0].url).toBe('http://localhost:4010/api/store/app/home');
  expect(calls[0].headers).toMatchObject({ 'x-app': 'shopper', 'x-app-tenant': String(brand.tenantId), 'x-app-version': brand.appVersion, 'x-app-platform': 'android' });
  expect(calls[0].headers.authorization).toBeUndefined();
});

test('a feature’s session service supplies the access token', async () => {
  const signIn = { name: 'sign-in', screens: [], nav: null, service: () => ({ getAccessToken: () => 'sa_1' }) };
  const { services, calls } = servicesFor(brands[0], { features: [signIn] });
  await services.client.call('appMe');
  expect(calls[0].headers.authorization).toBe('Shopper sa_1');
});

test('hosted payment opens the order’s page on the store’s own address and comes back by the brand’s link', async () => {
  const brand = brandOf(brands[1]);
  const opened = [];
  const browser = { openAuthSessionAsync: async (...args) => { opened.push(args); return { type: 'dismiss' }; } };
  const { services } = servicesFor(brands[1], { browser, answer: { orderNumber: 'A-1', next: 'done' } });
  expect(services.pay.driver).toBe('hosted');
  const result = await services.pay.pay({ token: 'tok 1', gateway: null });
  expect(opened[0].slice(0, 2)).toEqual(['http://localhost:4010/order/tok%201', `${brand.scheme}://order/tok%201`]);
  expect(result.status).toBe('paid');
});

test('the native driver is used only when the build says so', () => {
  expect(servicesFor(brands[0], { extra: { payDriver: 'native' } }).services.pay.driver).toBe('native');
  expect(servicesFor(brands[0], { extra: { payDriver: 'anything' } }).services.pay.driver).toBe('hosted');
});

test('a build with no brand, or no store address, refuses to guess one', () => {
  expect(() => readBuild({ constants: { expoConfig: { extra: {} } }, platform: 'ios' })).toThrow('no brand');
  expect(() => readBuild({ constants: constantsFor(brands[0], { apiBaseUrl: '' }), platform: 'ios' })).toThrow('no store address');
  expect(readBuild({ constants: constantsFor(brands[0]), platform: 'ios' }).app).toEqual({ name: 'shopper', version: brandOf(brands[0]).appVersion, platform: 'ios' });
});

test('a build made without a brand says so and shows nothing else', async () => {
  await render(<App linking={false} />);
  expect(screen.getByTestId('no-brand')).toBeTruthy();
  expect(screen.queryByTestId('tab-home')).toBeNull();
});
