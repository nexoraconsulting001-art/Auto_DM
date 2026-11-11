/**
 * What a build was made with. The API address is the build setting API_BASE_URL, which app.config.js writes into
 * `extra.apiBaseUrl`; nothing at run time can change it. Version and platform go out on every request as
 * X-App, X-App-Version and X-App-Platform, so the server can ask an old build to update.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const clean = (url) => String(url ?? '').trim().replace(/\/+$/, '');

/** `name` is 'owner' or 'shopper'. Throws when the build has no usable API address, rather than guessing one. */
export function readAppConfig({ name, constants = Constants, platform = Platform.OS } = {}) {
  const extra = constants?.expoConfig?.extra ?? {};
  const origin = clean(extra.apiBaseUrl);
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error('This build has no API address: set API_BASE_URL when building');
  const version = String(constants?.expoConfig?.version ?? '0.0.0');
  return Object.freeze({
    apiOrigin: origin,
    apiBaseUrl: `${origin}/api/v1`,
    app: Object.freeze({ name, version, platform: platform === 'ios' ? 'ios' : 'android' }),
    /** A build setting that hides every buy button for a Bhava plan on iOS until Apple's rule on it is settled. */
    hidePlanPurchase: Boolean(extra.hidePlanPurchase) && platform === 'ios',
  });
}
