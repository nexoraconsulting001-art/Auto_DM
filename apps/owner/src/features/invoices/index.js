import { staffWith } from '@bhava/app-core/access';
import InvoicesScreen from './InvoicesScreen.js';

/**
 * Invoices. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'invoices',
  access: staffWith('orders'),
  feature: 'store.invoices',
  routeIds: [],
  screens: [{ name: 'index', path: 'invoices', title: 'invoices.title', component: InvoicesScreen }],
  nav: { label: 'invoices.title', order: 13 },
  strings: { en: { 'invoices.title': 'Invoices' }, hi: { 'invoices.title': 'इनवॉइस' } },
};
