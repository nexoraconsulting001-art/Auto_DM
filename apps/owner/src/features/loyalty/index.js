import { staffWith } from '@bhava/app-core/access';
import LoyaltyScreen from './LoyaltyScreen.js';

/**
 * Loyalty. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'loyalty',
  access: staffWith('customers'),
  feature: 'loyalty',
  routeIds: [],
  screens: [{ name: 'index', path: 'loyalty', title: 'loyalty.title', component: LoyaltyScreen }],
  nav: { label: 'loyalty.title', order: 52 },
  strings: { en: { 'loyalty.title': 'Loyalty' }, hi: { 'loyalty.title': 'लॉयल्टी' } },
};
