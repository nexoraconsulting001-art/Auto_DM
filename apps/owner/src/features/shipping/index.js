import { MANAGERS } from '@bhava/app-core/access';
import ShippingScreen from './ShippingScreen.js';

/**
 * Shipping. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'shipping',
  access: MANAGERS,
  feature: 'store.shipping',
  routeIds: [],
  screens: [{ name: 'index', path: 'shipping', title: 'shipping.title', component: ShippingScreen }],
  nav: { label: 'shipping.title', order: 73 },
  strings: { en: { 'shipping.title': 'Shipping' }, hi: { 'shipping.title': 'शिपिंग' } },
};
