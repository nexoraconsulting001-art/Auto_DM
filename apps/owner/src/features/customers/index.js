import { staffWith } from '@bhava/app-core/access';
import CustomersScreen from './CustomersScreen.js';

/**
 * Customers. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'customers',
  access: staffWith('customers'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'customers', title: 'customers.title', component: CustomersScreen }],
  nav: { label: 'customers.title', order: 50 },
  strings: { en: { 'customers.title': 'Customers' }, hi: { 'customers.title': 'ग्राहक' } },
};
