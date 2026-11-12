import OrdersScreen from './OrdersScreen.js';

/**
 * Past orders, one order, an order by its link, and one-tap reorder (P-64).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'orders',
  screens: [
    { name: 'index', path: 'account/orders', title: 'orders.title', component: OrdersScreen },
    { name: 'order', path: 'account/orders/:orderNumber', title: 'orders.title', component: OrdersScreen, link: true },
    { name: 'byToken', path: 'order/:token', title: 'orders.title', component: OrdersScreen, link: true },
  ],
  nav: null,
  strings: { en: { 'orders.title': 'Orders' }, hi: { 'orders.title': 'ऑर्डर' } },
};
