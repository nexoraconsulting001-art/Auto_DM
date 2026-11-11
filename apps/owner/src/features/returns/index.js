import { staffWith } from '@bhava/app-core/access';
import ReturnsScreen from './ReturnsScreen.js';

/**
 * Returns. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'returns',
  access: staffWith('orders'),
  feature: 'store.returns',
  routeIds: [],
  screens: [{ name: 'index', path: 'returns', title: 'returns.title', component: ReturnsScreen }],
  nav: { label: 'returns.title', order: 11 },
  strings: { en: { 'returns.title': 'Returns' }, hi: { 'returns.title': 'रिटर्न' } },
};
