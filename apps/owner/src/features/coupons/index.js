import { MANAGERS } from '@bhava/app-core/access';
import CouponsScreen from './CouponsScreen.js';

/**
 * Coupons. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'coupons',
  access: MANAGERS,
  feature: 'store.coupons',
  routeIds: [],
  screens: [{ name: 'index', path: 'coupons', title: 'coupons.title', component: CouponsScreen }],
  nav: { label: 'coupons.title', order: 25 },
  strings: { en: { 'coupons.title': 'Coupons' }, hi: { 'coupons.title': 'कूपन' } },
};
