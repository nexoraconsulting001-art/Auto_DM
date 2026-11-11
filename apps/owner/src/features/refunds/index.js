import { staffWith } from '@bhava/app-core/access';
import RefundsScreen from './RefundsScreen.js';

/**
 * Refunds. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'refunds',
  access: staffWith('orders'),
  feature: 'store.payments',
  routeIds: [],
  screens: [{ name: 'index', path: 'refunds', title: 'refunds.title', component: RefundsScreen }],
  nav: { label: 'refunds.title', order: 12 },
  strings: { en: { 'refunds.title': 'Refunds' }, hi: { 'refunds.title': 'रिफ़ंड' } },
};
