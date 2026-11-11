import ShoppingBag from 'lucide-react-native/icons/shopping-bag';
import { staffWith } from '@bhava/app-core/access';
import OrdersScreen from './OrdersScreen.js';

/**
 * Orders. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'orders',
  access: staffWith('orders'),
  feature: 'store.checkout',
  routeIds: [],
  screens: [{ name: 'index', path: 'orders', title: 'orders.title', component: OrdersScreen }],
  nav: { label: 'orders.title', order: 10, icon: ShoppingBag, primary: true },
  strings: { en: { 'orders.title': 'Orders' }, hi: { 'orders.title': 'ऑर्डर' } },
};
