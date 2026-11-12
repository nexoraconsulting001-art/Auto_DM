/**
 * What this build was made with: its brand, the store's address, the pay driver. All of it was written into the build by
 * app.config.js from the brand file; nothing at run time can change it, and nothing here is a default for any brand.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const clean = (url) => String(url ?? '').trim().replace(/\/+$/, '');

/** Throws when the build carries no brand, rather than guessing one. */
export function readBuild({ constants = Constants, platform = Platform.OS } = {}) {
  const extra = constants?.expoConfig?.extra ?? {};
  const brand = extra.brand;
  if (!brand || !Number.isInteger(brand.tenantId) || !brand.name || !brand.scheme) throw new Error('This build has no brand: build it with a brand file');
  const origin = clean(extra.apiBaseUrl);
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error('This build has no store address');
  return Object.freeze({
    brand: Object.freeze({ ...brand }),
    /** The store's own address: every API call and every page the app opens goes here. */
    origin,
    app: Object.freeze({ name: 'shopper', version: String(constants?.expoConfig?.version ?? '0.0.0'), platform: platform === 'ios' ? 'ios' : 'android' }),
    payDriver: extra.payDriver === 'native' ? 'native' : 'hosted',
    push: Object.freeze({ android: Boolean(extra.push?.android), ios: Boolean(extra.push?.ios) }),
    env: extra.appEnv ?? 'development',
  });
}

/** The brand kit as @bhava/theme reads it. */
export const brandKitOf = (brand) => ({ colors: brand.colors ?? {}, headingFont: brand.fonts?.heading, bodyFont: brand.fonts?.body });
