import { staffWith } from '@bhava/app-core/access';
import ImportsScreen from './ImportsScreen.js';

/**
 * Import products. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'imports',
  access: staffWith('catalog'),
  feature: 'catalog.import',
  routeIds: [],
  screens: [{ name: 'index', path: 'imports', title: 'imports.title', component: ImportsScreen }],
  nav: { label: 'imports.title', order: 21 },
  strings: { en: { 'imports.title': 'Import products' }, hi: { 'imports.title': 'प्रोडक्ट इंपोर्ट' } },
};
