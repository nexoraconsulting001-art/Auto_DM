import { MANAGERS } from '@bhava/app-core/access';
import StoreSettingsScreen from './StoreSettingsScreen.js';

/**
 * Store settings. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'store-settings',
  access: MANAGERS,
  feature: 'store.checkout',
  routeIds: [],
  screens: [{ name: 'index', path: 'store-settings', title: 'store-settings.title', component: StoreSettingsScreen }],
  nav: { label: 'store-settings.title', order: 72 },
  strings: { en: { 'store-settings.title': 'Store settings' }, hi: { 'store-settings.title': 'स्टोर सेटिंग' } },
};
