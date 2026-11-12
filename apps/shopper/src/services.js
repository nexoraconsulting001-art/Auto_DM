/**
 * What every screen of the shopper app shares, made once when the app starts:
 *
 *   config    what the build was made with (src/brand.js): the brand, the store's address, the pay driver
 *   theme     the brand's colours and fonts as a theme (@bhava/theme)
 *   strings   every line by key, English and Hindi (the shell's and each feature's)
 *   client    the store's own API (@bhava/store-client). Its access token comes from services.session, when a feature
 *             registers one (the sign-in feature's `service`); until then every call goes without a token
 *   pay       pay(order) -> paid, failed or cancelled (@bhava/pay), through the driver the build was made with
 *   <name>    whatever a feature's `service(services)` answered, under the feature's name
 *
 * There is no seller API here: the only server is the store's own.
 */
import { createContext, createElement, useContext } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { createStrings } from '@bhava/app-core/strings';
import { createPay } from '@bhava/pay';
import { createStoreClient } from '@bhava/store-client';
import { fromBrandKit } from '@bhava/theme';
import { brandKitOf, readBuild } from './brand.js';
import { features as registered } from './features/index.js';
import { catalogueOf } from './strings.js';

/** Everything here is injectable, for tests: the build's constants, fetch, the browser, the features. */
export function createServices({ constants, platform, locale = 'en', fetch, browser, loadSdk, features = registered, queryClient } = {}) {
  const config = readBuild({ constants, platform });
  const services = { config, features };
  services.theme = fromBrandKit(brandKitOf(config.brand), { fonts: config.brand.fontFamilies ?? {} });
  services.strings = createStrings(catalogueOf(features), { locale });
  services.queryClient = queryClient ?? new QueryClient();
  services.client = createStoreClient({
    origin: config.origin,
    tenantId: config.brand.tenantId,
    version: config.app.version,
    platform: config.app.platform,
    getAccessToken: () => services.session?.getAccessToken?.() ?? null,
    onUnauthorized: (error) => services.session?.onUnauthorized?.(error),
    onUpdateRequired: (error) => services.session?.onUpdateRequired?.(error),
    ...(fetch ? { fetch } : {}),
  });
  services.pay = createPay({
    driver: config.payDriver,
    orderState: (token) => services.client.call('appOrderByToken', { params: { token } }),
    pageUrl: (order) => services.client.pageUrl('order', { token: order.token }),
    returnUrl: (order) => `${config.brand.scheme}://order/${encodeURIComponent(order.token)}`,
    submitReturn: (body) => services.client.call('paymentReturn', { body }),
    ...(browser ? { browser } : {}),
    ...(loadSdk ? { loadSdk } : {}),
  });
  for (const feature of features) {
    if (typeof feature.service === 'function') services[feature.name === 'sign-in' ? 'session' : feature.name] = feature.service(services);
  }
  return services;
}

const ServicesContext = createContext(null);

export const ServicesProvider = ({ value, children }) => createElement(ServicesContext.Provider, { value }, children);

export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices needs a ServicesProvider above it');
  return services;
}
