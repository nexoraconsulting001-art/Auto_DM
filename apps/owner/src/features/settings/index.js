import { MANAGERS } from '@bhava/app-core/access';
import SettingsScreen from './SettingsScreen.js';

/**
 * Settings. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'settings',
  access: MANAGERS,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'settings', title: 'settings.title', component: SettingsScreen }],
  nav: { label: 'settings.title', order: 70 },
  strings: { en: { 'settings.title': 'Settings' }, hi: { 'settings.title': 'सेटिंग' } },
};
