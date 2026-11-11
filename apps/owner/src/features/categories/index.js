import { staffWith } from '@bhava/app-core/access';
import CategoriesScreen from './CategoriesScreen.js';

/**
 * Categories. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'categories',
  access: staffWith('catalog'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'categories', title: 'categories.title', component: CategoriesScreen }],
  nav: { label: 'categories.title', order: 40 },
  strings: { en: { 'categories.title': 'Categories' }, hi: { 'categories.title': 'कैटेगरी' } },
};
