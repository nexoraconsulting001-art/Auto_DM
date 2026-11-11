import { MANAGERS } from '@bhava/app-core/access';
import PaymentsScreen from './PaymentsScreen.js';

/**
 * Payments. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'payments',
  access: MANAGERS,
  feature: 'store.payments',
  routeIds: [],
  screens: [{ name: 'index', path: 'payments', title: 'payments.title', component: PaymentsScreen }],
  nav: { label: 'payments.title', order: 71 },
  strings: { en: { 'payments.title': 'Payments' }, hi: { 'payments.title': 'पेमेंट' } },
};
